/**
 * Hot-path writes are recorded here and committed later, on the same
 * connection, in short batches. The request's finish listener returns
 * without touching SQLite, so RPM is not capped by index updates.
 *
 * One writer only. A second connection would make the next quota save
 * block the event loop on SQLITE_BUSY. setImmediate runs after the
 * current I/O batch, so the next request is accepted before the flush.
 *
 * R6 B8: queued closures are async and run through DbClient. Each batch is one
 * `db.tx` in which the closures are awaited in order; nested `tx` calls inside a
 * closure become SAVEPOINTs. Closures may only await database work: the batch
 * transaction must not cross the event loop (DbClient rolls it back and every
 * remaining statement of the batch fails with db_tx_yielded).
 *
 * Failure semantics are the original ones:
 *   - a closure that throws is logged and skipped; the batch goes on, and the
 *     statements that closure already ran stay in the batch (no per-closure
 *     savepoint, same as the synchronous version);
 *   - BEGIN fails (SQLITE_BUSY, …): the batch is put back at the head of the
 *     queue and draining stops until the next enqueue or flush;
 *   - COMMIT fails or the transaction is rolled back: the whole batch is dropped
 *     and logged.
 *
 * Other deferred persistence (proxy pool write-back, VM file mirror, request
 * log rows written without the queue) registers its in-flight Promise with
 * trackBackgroundWrite, so flushWrites() — and therefore closeDatabase() and
 * the backup snapshot — waits for it too.
 *
 * Bounded queue（技术债 M5，数据访问文档第 3 节“观测写不进去时放行并计数；计费写不进去时拒绝”）：
 * 队列最多 MAX_QUEUE 个闭包（环境变量 KIN_WRITE_BEHIND_MAX_QUEUE，默认 10000）。满了以后按写入类别处理：
 *   - observation（观测：请求尝试台账 request_attempts 等，不影响计费与对账）：丢弃并计数，请求照常完成；
 *   - billing（计费相关：使用记录 usage_logs，以及随它写的供应商用量事实）：不入队、不丢弃，enqueueWrite 返回 false，
 *     调用方改为直接 await 写库（与写回队列未启用时相同），由该请求承担背压。
 * 未标类别的写入按 billing 处理。计数由 writeBehindStats() 给出，经 `/api/panel/database/metrics` 的 `write_behind` 可见。
 */
import { dbClient } from './db-client.mjs'

const BATCH = 32
const DEFAULT_MAX_QUEUE = 10_000
const DROP_WARN_INTERVAL_MS = 60_000
export const WRITE_KIND = Object.freeze({ BILLING: 'billing', OBSERVATION: 'observation' })
const queue = []
const background = new Set()
let client = null
let timer = null
let inflight = null
let maxQueue = queueLimit(process.env.KIN_WRITE_BEHIND_MAX_QUEUE)
let lastDropWarn = 0
const counters = { enqueued: 0, dropped_observation: 0, billing_direct: 0, billing_failed: 0, peak: 0 }

function queueLimit(raw) {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_QUEUE
}

/** 调整队列上限（测试与运维工具）；非正整数恢复默认值。 */
export function setWriteBehindLimit(limit) {
  maxQueue = queueLimit(limit)
}

/** 计费类写入（使用记录落库）失败一次：计入 billing_failed，在数据库指标页可见（M5 复审 P1-3）。 */
export function recordBillingWriteFailure() {
  counters.billing_failed++
}

/** 队列深度、上限与丢弃 / 直写计数（进程启动以来累计）。 */
export function writeBehindStats() {
  return { queued: queue.length, max_queue: maxQueue, ...counters }
}

export function armWriteBehind(database) {
  client = database ? dbClient(database) : null
}

export function writeBehindArmed() {
  return !!client
}

/**
 * Queue an async closure; it runs later inside a write-behind batch transaction.
 * Returns false when the queue is full: an observation write is then dropped (counted), a billing write is left to the
 * caller, which must await it directly.
 */
export function enqueueWrite(fn, { kind = WRITE_KIND.BILLING } = {}) {
  if (queue.length >= maxQueue) {
    if (kind === WRITE_KIND.OBSERVATION) {
      counters.dropped_observation++
      const now = Date.now()
      if (now - lastDropWarn >= DROP_WARN_INTERVAL_MS) {
        lastDropWarn = now
        console.warn(
          `[write-behind] queue full (${maxQueue}); dropping observation writes (dropped so far: ${counters.dropped_observation})`,
        )
      }
    } else counters.billing_direct++
    // 满了也要确保有排空在跑（M5 复审 P1-1）：否则上一次排空失败后不再有人启动它，队列一直停在满的状态
    scheduleDrain()
    return false
  }
  queue.push(fn)
  counters.enqueued++
  if (queue.length > counters.peak) counters.peak = queue.length
  scheduleDrain()
  return true
}

/** Register a deferred write that runs outside the queue; flushWrites waits until it settles. */
export function trackBackgroundWrite(promise) {
  const tracked = Promise.resolve(promise).finally(() => background.delete(tracked))
  tracked.catch(() => {})
  background.add(tracked)
  return promise
}

/** Nothing queued, no batch running, no tracked background write. */
export function writesIdle() {
  return !queue.length && !inflight && !background.size
}

/**
 * Commit every queued closure and wait for tracked background writes. Must not
 * be awaited inside a DbClient transaction: the batch waits for that
 * transaction to end, so awaiting it there never resolves.
 */
/**
 * Fail fast instead of hanging (R6 B8 review P2-5): waiting for background writes inside a transaction never
 * resolves (they queue behind that transaction), and the stuck transaction then blocks every other statement.
 */
export function assertOutsideTransaction(what, database = null) {
  const c = database ? dbClient(database) : client
  if (c?.inTransaction()) throw new Error(`${what} cannot be awaited inside a database transaction`)
}

export async function flushWrites() {
  assertOutsideTransaction('flushWrites()')
  if (timer) {
    clearImmediate(timer)
    timer = null
  }
  for (;;) {
    if (inflight) {
      await inflight
      continue
    }
    if (queue.length && client) {
      if (!(await runBatch())) return
      continue
    }
    if (background.size) {
      await Promise.allSettled([...background])
      continue
    }
    return
  }
}

export function pendingWrites() {
  return queue.length
}

function scheduleDrain() {
  if (timer || inflight || !queue.length) return
  timer = setImmediate(drain)
}

// BEGIN 失败（连接被别的写入方占住等）后的重试退避：不只等下一次入队（M5 复审 P1-1）
const RETRY_MIN_MS = 100
const RETRY_MAX_MS = 1000
let retryTimer = null
let retryDelay = RETRY_MIN_MS

async function drain() {
  timer = null
  if (inflight) return
  if (await runBatch()) {
    retryDelay = RETRY_MIN_MS
    scheduleDrain()
  } else scheduleRetry()
}

function scheduleRetry() {
  if (retryTimer || !queue.length) return
  retryTimer = setTimeout(() => {
    retryTimer = null
    scheduleDrain()
  }, retryDelay)
  retryTimer.unref?.()
  retryDelay = Math.min(RETRY_MAX_MS, retryDelay * 2)
}

function runBatch() {
  inflight = drainBatch().finally(() => {
    inflight = null
  })
  return inflight
}

async function drainBatch() {
  const db = client
  const batch = queue.splice(0, BATCH)
  if (!batch.length || !db) return true
  let begun = false
  let current = -1
  try {
    await db.tx(async (tx) => {
      begun = true
      for (current = 0; current < batch.length; current++) {
        const fn = batch[current]
        try {
          // 每个闭包一个保存点（B8 复审 P2-8）：闭包失败只撤销它自己的语句，其余照常提交
          await tx.tx(() => fn())
        } catch (err) {
          if (err?.code === 'db_tx_yielded') throw err
          console.warn('[write-behind]', err?.message || err)
        }
      }
    })
  } catch (err) {
    console.warn('[write-behind]', err?.message || err)
    if (!begun) {
      queue.unshift(...batch)
      return false
    }
    if (err?.code === 'db_tx_yielded' && current >= 0 && current < batch.length) {
      // 某个闭包等待了真实 I/O，整批随事务回滚：丢弃这个闭包，其余（已执行的也已回滚）放回队首重写，不整批丢失
      console.warn('[write-behind] dropped a write that waited for I/O inside the batch transaction')
      queue.unshift(...batch.slice(0, current), ...batch.slice(current + 1))
    }
  }
  return true
}
