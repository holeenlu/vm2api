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
 * - 在同步 `withTransaction` 里发起 async `tx` 会抛错（同步调用方无法等它结束）；async 事务里调用同步 `withTransaction`
 *   按嵌套执行（同步代码一次跑完，安全）。
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
  //   快路径（没有打开的事务）同步返回 null，不额外分配 Promise。同步出口（`…Sync`）无法等待，仍会落进打开的事务（B8 删除）。
  // 事务结束后，从事务体里发起、晚于提交才执行的语句（不等待的后台写入）按事务外处理：
  // 不能借已结束事务的上下文绕过排队、落进别的调用链正开着的事务（R6 B7b）。
  const activeTx = () => {
    const tx = context.storage.getStore()
    return tx && !tx.done ? tx : null
  }
  const admit = () => {
    const tx = activeTx()
    if (tx) {
      if (tx.yielded) throw new DbTxError('db_tx_yielded', 'transaction yielded to the event loop and was rolled back')
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
    /** 同步读：只给尚未改造的同步调用方与临时同步出口使用（R6 B8 删除）。 */
    oneSync(sql, ...params) {
      return statement(sql).get(...params)
    },
    manySync(sql, ...params) {
      return statement(sql).all(...params)
    },
    runSync(sql, ...params) {
      const result = statement(sql).run(...params)
      return { changes: Number(result.changes || 0), lastInsertRowid: result.lastInsertRowid }
    },
    inTransaction() {
      return !!activeTx()
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
      const tx = { yielded: false, done: false, finished: new Promise((resolve) => (finish = resolve)) }
      context.open = tx
      const yieldGuard = () => {
        if (tx.done || tx.yielded || !database.isTransaction) return
        tx.yielded = true
        try {
          database.exec('ROLLBACK')
        } catch {}
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
    if (outer.yielded) throw new DbTxError('db_tx_yielded', 'transaction yielded to the event loop and was rolled back')
    const name = `r6_sp_${++savepointSeq}`
    database.exec(`SAVEPOINT ${name}`)
    try {
      const out = await fn(client)
      if (outer.yielded)
        throw new DbTxError('db_tx_yielded', 'transaction yielded to the event loop and was rolled back')
      database.exec(`RELEASE ${name}`)
      return out
    } catch (error) {
      if (!outer.yielded && database.isTransaction) {
        try {
          database.exec(`ROLLBACK TO ${name}`)
          database.exec(`RELEASE ${name}`)
        } catch {}
      }
      throw error
    }
  }

  return client
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
