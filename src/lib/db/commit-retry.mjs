/**
 * 推理请求收口（结算 + 使用记录，handle-protocol 的 commitRelayLog）写不进库时的重试（中期技术债 M3 降级演练）。
 *
 * 收口在响应交付之后执行：结算与使用记录写在同一个事务里，写锁被占（SQLITE_BUSY）、只读、磁盘满时整个事务失败。
 * 此前只打一行 `[billing] usage write failed`，这条请求的使用记录与扣费永久丢失。现在交给这里在后台重试：
 *   - 条目只含补写需要的数据（`src/lib/admin/settlement-replay.mjs`），不持有 req / res / 请求体；
 *     结算按 request_id 抢占（billing_charges），使用记录按 request_id 幂等，重复执行不会重复扣费或重复记账；
 *   - 串行重放（M3 复审 P2-2）：每条执行前检查数据库可写，遇到第一笔数据库错误即停，等恢复或退避后再继续；
 *     写入恢复时立即重放；否则按 1、2、5、10、30 秒退避；
 *   - 非数据库错误（数据或代码问题）最多重试 MAX_OTHER_FAILURES 次，之后写入待补写文件并告警（M3 复审 P2-3）；
 *     失败日志限频，每分钟最多一行；
 *   - 停机（closeDatabase）时先尝试排空一次，剩余条目写入数据目录下的 `request-logs/pending-commits.jsonl`（0600），
 *     打出剩余条数与 request_id；`scripts/replay-pending-commits.mjs` 按 request_id 幂等补写（M3 复审 P1-3）；
 *   - 最多同时保留 MAX_PENDING 条，超出的直接写入待补写文件。
 * 计数经 `/api/panel/database/metrics` 的 `write_health.settlement_retry` 可见。
 */
import fs from 'node:fs'
import path from 'node:path'
import { databaseWritable, isDatabaseUnavailableError, onWriteRecovered } from './write-health.mjs'

export const PENDING_COMMITS_FILE = 'pending-commits.jsonl'
export const MAX_OTHER_FAILURES = 5
const DELAYS_MS = [1000, 2000, 5000, 10_000, 30_000]
const MAX_PENDING = 10_000
const LOG_INTERVAL_MS = 60_000
const SHUTDOWN_IDS_SHOWN = 100
const pending = new Map()
const counters = { scheduled: 0, retried: 0, recovered: 0, persisted: 0, abandoned: 0 }
let timer = null
let running = null
let lastLogAt = 0
let quietFailures = 0

function delayAfter(tries) {
  return DELAYS_MS[Math.min(Math.max(tries - 1, 0), DELAYS_MS.length - 1)]
}

// 数据库暂时写不进去（含 SQLite 回滚了整个事务）：等恢复，不计入非数据库错误次数
function databaseError(error) {
  return isDatabaseUnavailableError(error) || error?.code === 'db_tx_aborted'
}

function noteFailure(id, error) {
  const now = Date.now()
  if (now - lastLogAt < LOG_INTERVAL_MS) {
    quietFailures++
    return
  }
  const quiet = quietFailures ? `; ${quietFailures} more failures in the last minute` : ''
  lastLogAt = now
  quietFailures = 0
  console.warn(
    `[billing] settlement retry for ${id} failed: ${error?.message || error} (${pending.size} pending${quiet})`,
  )
}

/** 把条目追加到待补写文件（0600）；返回是否写入。 */
function persist(file, items, reason) {
  if (!file || !items.length) return false
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const at = new Date().toISOString()
    const lines = items.map((item) =>
      JSON.stringify({
        at,
        reason,
        attempts: item.tries || 0,
        error: item.error ? String(item.error).slice(0, 300) : null,
        entry: item.entry,
      }),
    )
    fs.appendFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 })
    try {
      fs.chmodSync(file, 0o600)
    } catch {}
    counters.persisted += items.length
    return true
  } catch (error) {
    console.error(`[billing] cannot write ${file}: ${error?.message || error}`)
    return false
  }
}

function arm() {
  if (timer) clearTimeout(timer)
  timer = null
  if (!pending.size) return
  let next = Infinity
  for (const item of pending.values()) next = Math.min(next, item.next_at)
  timer = setTimeout(() => void pump(), Math.max(0, next - Date.now()))
  timer.unref?.()
}

async function attempt(id, item) {
  counters.retried++
  try {
    await item.replay(item.entry)
    pending.delete(id)
    counters.recovered++
    return true
  } catch (error) {
    item.tries++
    item.error = error?.message || String(error)
    item.next_at = Date.now() + delayAfter(item.tries)
    if (databaseError(error)) {
      noteFailure(id, error)
      return false
    }
    if (++item.failures < MAX_OTHER_FAILURES) {
      noteFailure(id, error)
      return null
    }
    pending.delete(id)
    if (persist(item.file, [item], 'failed')) {
      console.error(
        `[billing] settlement for ${id} failed ${item.failures} times (${item.error}); saved to ${item.file} for scripts/replay-pending-commits.mjs`,
      )
    } else {
      counters.abandoned++
      console.error(`[billing] settlement for ${id} failed ${item.failures} times and was dropped: ${item.error}`)
    }
    return null
  }
}

async function drainDue(force) {
  for (const [id, item] of [...pending]) {
    if (pending.get(id) !== item) continue
    if (!force && item.next_at > Date.now()) continue
    if (!databaseWritable()) break
    if ((await attempt(id, item)) === false) break
  }
}

/** 串行重放到期的条目：数据库不可写或遇到第一笔数据库错误即停。 */
function pump({ force = false } = {}) {
  if (running) return running
  // 队列为空时 drainDue 同步就结束了：在 finally 回调（微任务）里清除，不能写在 async 函数体里
  const current = drainDue(force).finally(() => {
    if (running === current) running = null
    arm()
  })
  running = current
  return current
}

/**
 * 登记一次失败的收口。entry 只含补写数据（settlement-replay.mjs），replay(entry) 必须幂等；
 * file 为停机或放弃时写入的待补写文件。同一 request_id 只保留一条。
 */
export function retryCommit(entry, { replay, file = null } = {}) {
  const key = String(entry?.request_id || '')
  if (!key || typeof replay !== 'function' || pending.has(key)) return false
  const item = { entry, replay, file, tries: 0, failures: 0, error: null, next_at: Date.now() + DELAYS_MS[0] }
  if (pending.size >= MAX_PENDING) {
    if (persist(file, [item], 'queue_full')) {
      console.error(`[billing] settlement retry queue is full (${MAX_PENDING}); request ${key} saved to ${file}`)
      return true
    }
    counters.abandoned++
    console.error(`[billing] settlement retry queue is full (${MAX_PENDING}); request ${key} is not retried`)
    return false
  }
  pending.set(key, item)
  counters.scheduled++
  arm()
  return true
}

onWriteRecovered(() => void pump({ force: true }))

/**
 * 停机前（closeDatabase）：先串行尝试一次全部条目（遇到第一笔数据库错误即停），剩余的写入各自的待补写文件，
 * 打出剩余条数与 request_id。返回 { attempted, recovered, persisted, left }。
 */
export async function flushCommitRetries() {
  if (running) await running
  if (timer) clearTimeout(timer)
  timer = null
  const report = { attempted: 0, recovered: 0, persisted: 0, left: 0 }
  for (const [id, item] of [...pending]) {
    report.attempted++
    const ok = await attempt(id, item)
    if (ok) report.recovered++
    if (ok === false) break
  }
  const left = [...pending]
  pending.clear()
  if (!left.length) return report
  const byFile = new Map()
  for (const [, item] of left) {
    const list = byFile.get(item.file) || []
    list.push(item)
    byFile.set(item.file, list)
  }
  for (const [file, items] of byFile) {
    if (persist(file, items, 'shutdown')) report.persisted += items.length
    else counters.abandoned += items.length
  }
  report.left = left.length
  const ids = left.map(([id]) => id)
  const shown = ids.slice(0, SHUTDOWN_IDS_SHOWN).join(', ')
  const more = ids.length > SHUTDOWN_IDS_SHOWN ? ` … and ${ids.length - SHUTDOWN_IDS_SHOWN} more` : ''
  console.error(
    `[billing] ${left.length} settlements were not committed before shutdown (${report.persisted} saved for scripts/replay-pending-commits.mjs): ${shown}${more}`,
  )
  return report
}

/** 启动时：待补写文件里还有条目时打日志提示（不自动补写，由运维确认后执行脚本）。返回条数。 */
export function reportPendingCommitsFile(file) {
  let lines = 0
  try {
    if (!fs.existsSync(file)) return 0
    lines = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line.trim()).length
  } catch {
    return 0
  }
  if (lines)
    console.warn(
      `[billing] ${lines} settlements are waiting for replay in ${file}; preview with node scripts/replay-pending-commits.mjs --data-dir <data>, then add --apply`,
    )
  return lines
}

export function commitRetryStats() {
  return { pending: pending.size, ...counters }
}
