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
 */
import { dbClient } from './db-client.mjs'

const BATCH = 32
const queue = []
const background = new Set()
let client = null
let timer = null
let inflight = null

export function armWriteBehind(database) {
  client = database ? dbClient(database) : null
}

export function writeBehindArmed() {
  return !!client
}

/** Queue an async closure; it runs later inside a write-behind batch transaction. */
export function enqueueWrite(fn) {
  queue.push(fn)
  scheduleDrain()
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

async function drain() {
  timer = null
  if (inflight) return
  if (await runBatch()) scheduleDrain()
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
