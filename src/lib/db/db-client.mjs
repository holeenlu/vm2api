/**
 * 异步数据访问接口（数据访问分层 R6，docs/data-access/R6_PLAN.md 1.1）。
 *
 * 仓储改为 async 后统一经此访问数据库。当前底层是单连接 node:sqlite DatabaseSync：语句同步执行，返回已完成的
 * Promise；`await` 只让出给微任务，不让出给其他请求的 I/O 回调。以后换成连接池（PostgreSQL）时只替换本模块。
 *
 * 事务：
 * - `tx(fn)` 打开 BEGIN IMMEDIATE；事务内经任何 DbClient 发出的语句都落在同一连接、同一事务里；嵌套 `tx` 用 SAVEPOINT。
 * - 事务不能跨事件循环：单连接上，事务打开期间其他请求的语句也会落进这个事务。开始时登记 setImmediate 与 0ms 定时器两个守卫，
 *   事务结束前守卫被触发（事务内等待了网络、定时器或文件 I/O），立即回滚，事务内后续语句与提交都抛 `db_tx_yielded`。
 * - 事务外的 async 语句遇到别的调用链正开着事务时排队，等事务结束再执行（不落进对方事务、不读对方未提交数据）。
 * - 连接上已有同步事务（迁移、统计线程的只读事务）时发起 async `tx` 会抛错（同步调用方无法等它结束）。
 * - 同步出口（`oneSync` / `manySync` / `runSync`、主线程上的 `withTransaction`）已在 R6 B8 删除：主线程只经本模块访问数据库。
 *   `transaction()` / `transactionOutcome()` 让内存快照（settings）判断事务内写入最终提交还是回滚；
 *   `detached(fn)` 让后台写入（代理池落盘、VM 文件镜像）脱离调用方的事务上下文，按事务外排队。
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { getDb } from './database.mjs'

const contexts = new WeakMap()
const statementCaches = new WeakMap()
let savepointSeq = 0
// 语句按 SQL 文本缓存，按最近使用保留这么多条（与主库 prepare 缓存同为 512）：仓储里有拼接的 IN (?,…) 与可选过滤条件，
// 不同 SQL 文本数随参数个数增长，不设上限会让预编译语句只增不减
export const DB_CLIENT_STATEMENT_CACHE_SIZE = 512

export class DbTxError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

function statementsOf(database) {
  let cache = statementCaches.get(database)
  if (!cache) {
    cache = new Map()
    statementCaches.set(database, cache)
  }
  return cache
}

function contextOf(database) {
  let context = contexts.get(database)
  if (!context) {
    context = { storage: new AsyncLocalStorage(), open: null }
    contexts.set(database, context)
  }
  return context
}

export function createDbClient(database, { log = console } = {}) {
  if (!database) throw new TypeError('createDbClient: database is required')
  const context = contextOf(database)

  const statement = (sql) => {
    const cache = statementsOf(database)
    let prepared = cache.get(sql)
    if (prepared) {
      cache.delete(sql)
    } else {
      prepared = database.prepare(sql)
      if (cache.size >= DB_CLIENT_STATEMENT_CACHE_SIZE) cache.delete(cache.keys().next().value)
    }
    cache.set(sql, prepared)
    return prepared
  }

  // 语句入口：
  // - 事务内的语句先检查事务是否已因跨事件循环被回滚；
  // - 事务外的语句遇到别的调用链正开着 async 事务时，等它结束再执行。单连接上，否则这些语句会落进对方的事务：
  //   对方回滚时被一并撤销，提交前还会读到对方未提交的数据。事务不跨事件循环，等待只在微任务层面。
  //   快路径（没有打开的事务）同步返回 null，不额外分配 Promise。
  // 事务结束后，从事务体里发起、晚于提交才执行的语句（不等待的后台写入）按事务外处理：
  // 不能借已结束事务的上下文绕过排队、落进别的调用链正开着的事务（R6 B7b）。保存点结束后按所在的外层事务处理。
  // 事务句柄：{ root, parent, done, committed }，根句柄另有 yielded / finished；保存点是子句柄。
  const activeTx = () => {
    let tx = context.storage.getStore()
    while (tx && tx.done) tx = tx.parent
    return tx || null
  }
  const admit = () => {
    const tx = activeTx()
    if (tx) {
      if (tx.root.yielded)
        throw new DbTxError('db_tx_yielded', 'transaction yielded to the event loop and was rolled back')
      return null
    }
    return context.open ? waitForOpenTransaction() : null
  }
  async function waitForOpenTransaction() {
    while (context.open) await context.open.finished
  }

  const client = {
    database,
    async one(sql, ...params) {
      // 等待结束后还要再过一个微任务才执行：期间可能已有排队的事务开始，所以每次都重新判定
      for (let wait = admit(); wait; wait = admit()) await wait
      return statement(sql).get(...params)
    },
    async many(sql, ...params) {
      // 等待结束后还要再过一个微任务才执行：期间可能已有排队的事务开始，所以每次都重新判定
      for (let wait = admit(); wait; wait = admit()) await wait
      return statement(sql).all(...params)
    },
    async run(sql, ...params) {
      // 等待结束后还要再过一个微任务才执行：期间可能已有排队的事务开始，所以每次都重新判定
      for (let wait = admit(); wait; wait = admit()) await wait
      const result = statement(sql).run(...params)
      return { changes: Number(result.changes || 0), lastInsertRowid: result.lastInsertRowid }
    },
    async exec(sql) {
      // 等待结束后还要再过一个微任务才执行：期间可能已有排队的事务开始，所以每次都重新判定
      for (let wait = admit(); wait; wait = admit()) await wait
      database.exec(sql)
    },
    inTransaction() {
      return !!activeTx()
    },
    /** 当前调用链所在的事务（保存点）句柄，事务外为 null；交给 transactionOutcome 判断结果。 */
    transaction() {
      return activeTx()
    },
    /**
     * 在事务上下文之外运行 fn（返回 fn 的结果）：fn 发出的语句不落进调用方正开着的事务，而是排队等它结束。
     * 用于不等待的后台写入；不能在事务里 await 它的结果（会等自己所在的事务结束）。
     */
    detached(fn) {
      return context.storage.exit(() => fn(client))
    },
    async tx(fn) {
      const outer = activeTx()
      if (outer) return nested(outer, fn)
      // 另一个 async 事务还开着（同一轮微任务里先后开启，例如 Promise.all）：排队，等它结束再开始。
      // 事务不能跨事件循环（守卫），所以等待只在微任务层面，不会无限期占用连接。
      while (context.open) await context.open.finished
      if (database.isTransaction)
        throw new DbTxError('db_tx_in_sync_transaction', 'async tx cannot start inside a synchronous transaction')
      database.exec('BEGIN IMMEDIATE')
      let finish
      const tx = {
        root: null,
        parent: null,
        yielded: false,
        done: false,
        committed: false,
        finished: new Promise((resolve) => (finish = resolve)),
      }
      tx.root = tx
      context.open = tx
      const yieldGuard = () => {
        if (tx.done || tx.yielded || !database.isTransaction) return
        tx.yielded = true
        try {
          database.exec('ROLLBACK')
        } catch {}
        // 回滚后立即释放连接（R6 复审 P1-1）：事务体可能还在等那次 I/O，若等到它返回才释放，期间全进程的
        // async 语句与新事务都排在后面；事务体若在等排在它后面的 Promise 则永久挂死。本事务后续语句仍因 yielded 被拒。
        if (context.open === tx) context.open = null
        finish()
        log.warn?.('[db-client] transaction yielded to the event loop; rolled back')
      }
      // 两个守卫：事件循环的 timers 阶段在 check 阶段之前，只用 setImmediate 时，事务里等待的定时器若在
      // 进入 check 前已到期（慢机器、CPU 繁忙），会先于守卫恢复事务并提交。0ms 定时器比事务内登记的任何
      // 定时器都早、同时长时按登记顺序先触发，所以定时器恢复事务前守卫一定先运行；setImmediate 覆盖 poll 阶段的 I/O。
      const immediate = setImmediate(yieldGuard)
      const timeout = setTimeout(yieldGuard, 0)
      timeout.unref?.()
      try {
        const out = await context.storage.run(tx, () => fn(client))
        if (tx.yielded)
          throw new DbTxError('db_tx_yielded', 'transaction yielded to the event loop and was rolled back')
        database.exec('COMMIT')
        tx.committed = true
        return out
      } catch (error) {
        if (!tx.yielded && database.isTransaction) {
          try {
            database.exec('ROLLBACK')
          } catch {}
        }
        throw error
      } finally {
        tx.done = true
        clearImmediate(immediate)
        clearTimeout(timeout)
        if (context.open === tx) context.open = null
        finish()
      }
    },
  }

  async function nested(outer, fn) {
    const root = outer.root
    if (root.yielded) throw new DbTxError('db_tx_yielded', 'transaction yielded to the event loop and was rolled back')
    const name = `r6_sp_${++savepointSeq}`
    database.exec(`SAVEPOINT ${name}`)
    const sp = { root, parent: outer, done: false, committed: false }
    try {
      const out = await context.storage.run(sp, () => fn(client))
      if (root.yielded)
        throw new DbTxError('db_tx_yielded', 'transaction yielded to the event loop and was rolled back')
      database.exec(`RELEASE ${name}`)
      sp.committed = true
      return out
    } catch (error) {
      if (!root.yielded && database.isTransaction) {
        try {
          database.exec(`ROLLBACK TO ${name}`)
          database.exec(`RELEASE ${name}`)
        } catch {}
      }
      throw error
    } finally {
      sp.done = true
    }
  }

  return client
}

/**
 * 事务（保存点）句柄的最终结果：'open'（它或某个外层仍未结束）、'committed'（它与所有外层都已提交）、
 * 'rolledback'（它或某个外层已回滚）。
 */
export function transactionOutcome(handle) {
  // 根事务已被跨事件循环守卫回滚：结果已定，不必等事务体返回（B8 复审 P2-4）
  if (handle?.root?.yielded) return 'rolledback'
  let open = false
  for (let tx = handle; tx; tx = tx.parent) {
    if (tx.done && !tx.committed) return 'rolledback'
    if (!tx.done) open = true
  }
  return open ? 'open' : 'committed'
}

const clients = new WeakMap()

/** 绑定当前打开的数据库（getDb()）的客户端；同一数据库对象复用同一个客户端。 */
export function dbClient(database = getDb()) {
  let client = clients.get(database)
  if (!client) {
    client = createDbClient(database)
    clients.set(database, client)
  }
  return client
}
