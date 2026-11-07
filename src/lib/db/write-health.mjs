/**
 * 控制面数据库写入健康（中期技术债 M3 降级演练）。
 *
 * SQLite 与控制面同进程，单个写连接在主线程上同步执行。数据库“写不进去”的现实形态：
 *   - 其他进程长时间持有写锁（运维脚本、手工 sqlite3 会话）：SQLITE_BUSY，每次写入先在主线程上等满 busy_timeout（5 秒）；
 *   - 文件或挂载只读：SQLITE_READONLY；磁盘满：SQLITE_FULL；I/O 错误：SQLITE_IOERR。
 * 演练发现：写锁被占住时每次写入都把事件循环冻住 5 秒，整个进程（推理流、面板、/healthz）停摆到锁释放；
 * 推理请求的结算写不进去时只打一行日志、整条使用记录与扣费丢失；/healthz 与面板的数据库探测（只读）照常显示正常。
 *
 * 这里按写连接上写路径的错误码（BUSY、READONLY、FULL、IOERR、CANTOPEN）判定“写入失败中”，进入降级状态；
 * LOCKED（同连接内的表锁冲突）与 CORRUPT 等不触发降级，读语句失败不计（M3 复审 P2-6）：
 *   - busy_timeout 降到 DEGRADED_BUSY_TIMEOUT_MS：后续写入快速失败，不再冻住事件循环；
 *   - 计费请求在准入时拒绝（503 database_unavailable，带 Retry-After；数据访问第 3 节“计费写不进去时拒绝请求”）；
 *   - 写回队列停止重试，等恢复后再排空；推理请求的收口（结算 + 使用记录）进入重试（commit-retry.mjs）；
 *   - 就绪接口 /readyz 返回 503（/healthz 仍是存活检查，返回 200 与 degraded 标志），面板数据库页显示详情；
 *   - 每 PROBE_INTERVAL_MS 做一次写探测（专用单行表 upsert 并提交）；连续 RECOVERY_PROBES 次探测成功才恢复：
 *     busy_timeout 复原，通知写回队列与收口重试。普通语句成功不改变降级状态（空操作的 exec、只读事务也会“成功”）。
 * 只跟踪 armWriteHealth 登记的主连接（控制面进程）；单元测试与脚本各自打开的连接不受影响。
 */
import { dbClient } from './db-client.mjs'

// SQLite 主错误码：BUSY 5、LOCKED 6、READONLY 8、IOERR 10、FULL 13、CANTOPEN 14。
// 触发降级的只有写路径上的“数据库写不进去”；LOCKED 是暂时性的（可重试、不算毒事件），但不触发降级；
// CORRUPT、NOTADB 等不可恢复，不算“不可用”，按各调用方原逻辑处理
const DEGRADING_CODES = new Map([
  [5, 'SQLITE_BUSY'],
  [8, 'SQLITE_READONLY'],
  [10, 'SQLITE_IOERR'],
  [13, 'SQLITE_FULL'],
  [14, 'SQLITE_CANTOPEN'],
])
const TRANSIENT_CODES = new Map([[6, 'SQLITE_LOCKED']])
export const DEGRADED_BUSY_TIMEOUT_MS = 100
export const NORMAL_BUSY_TIMEOUT_MS = 5000
const PROBE_INTERVAL_MS = 1000
// 连续这么多次写探测成功才恢复：一次成功可能只是 WAL 复用了已有空间
export const RECOVERY_PROBES = 2
const LOG_INTERVAL_MS = 60_000

let armed = null
let probeTimer = null
let probing = false
let probeStreak = 0
let lastLogAt = 0
let quietTransitions = 0
const listeners = new Set()
const state = {
  failing: false,
  since: null,
  last_error: null,
  last_error_code: null,
  last_failure_at: null,
  failures: 0,
  recovered_at: null,
  recoveries: 0,
}

function primaryCode(error) {
  const code = Number(error?.errcode)
  return Number.isInteger(code) ? code & 0xff : null
}

/** 触发降级的 SQLite 错误（写路径上的 BUSY、READONLY、FULL、IOERR、CANTOPEN）的主错误码名称；其他为 null。 */
export function databaseUnavailableCode(error) {
  return DEGRADING_CODES.get(primaryCode(error)) || null
}

/** 数据库暂时写不进去（降级类错误或 LOCKED）：可重试、不是事件或请求本身的问题。CORRUPT 等不可恢复错误为 false。 */
export function isDatabaseUnavailableError(error) {
  const code = primaryCode(error)
  return DEGRADING_CODES.has(code) || TRANSIENT_CODES.has(code)
}

// 降级与恢复日志限频（M3 复审 P2-6）：抖动时每分钟最多一行，附上期间未打印的切换次数
function transitionLog(level, message) {
  const now = Date.now()
  if (now - lastLogAt < LOG_INTERVAL_MS) {
    quietTransitions++
    return
  }
  const quiet = quietTransitions ? ` (${quietTransitions} more transitions in the last minute)` : ''
  lastLogAt = now
  quietTransitions = 0
  console[level](`${message}${quiet}`)
}

/** 登记控制面主连接（openDatabase 的单例）；传 null 解除并清空状态。 */
export function armWriteHealth(database) {
  // openDatabase 对已打开的单例会再次登记：同一连接不重置状态
  if (database && database === armed) return
  if (armed && state.failing) setBusyTimeout(NORMAL_BUSY_TIMEOUT_MS)
  stopProbe()
  armed = database || null
  probeStreak = 0
  lastLogAt = 0
  quietTransitions = 0
  Object.assign(state, {
    failing: false,
    since: null,
    last_error: null,
    last_error_code: null,
    last_failure_at: null,
    failures: 0,
    recovered_at: null,
    recoveries: 0,
  })
}

function setBusyTimeout(ms) {
  if (!armed) return
  try {
    dbClient(armed).setBusyTimeout(ms)
  } catch {}
}

/** 写连接上写路径的一次失败；只有触发降级的错误才计入。 */
export function noteWriteFailure(database, error) {
  if (!armed || database !== armed) return
  const code = databaseUnavailableCode(error)
  if (!code) return
  probeStreak = 0
  const now = new Date().toISOString()
  state.failures++
  state.last_error = String(error?.message || error).slice(0, 300)
  state.last_error_code = code
  state.last_failure_at = now
  if (state.failing) return
  state.failing = true
  state.since = now
  setBusyTimeout(DEGRADED_BUSY_TIMEOUT_MS)
  transitionLog(
    'error',
    `[db] database writes are failing (${code}: ${state.last_error}); degraded: metered requests are rejected, writes fail fast, queued writes and settlements wait for recovery`,
  )
  startProbe()
}

function recover() {
  probeStreak = 0
  const since = state.since
  state.failing = false
  state.since = null
  state.recovered_at = new Date().toISOString()
  state.recoveries++
  stopProbe()
  setBusyTimeout(NORMAL_BUSY_TIMEOUT_MS)
  transitionLog('warn', `[db] database writes recovered (failing since ${since})`)
  for (const listener of listeners) {
    try {
      listener()
    } catch {}
  }
}

function startProbe() {
  if (probeTimer) return
  probeTimer = setInterval(() => void probeOnce(), PROBE_INTERVAL_MS)
  probeTimer.unref?.()
}

function stopProbe() {
  if (probeTimer) clearInterval(probeTimer)
  probeTimer = null
}

/**
 * 做一次写探测（真正提交一次小写入）；降级中连续 RECOVERY_PROBES 次成功即恢复。返回本次探测是否提交成功：
 * 连接上已有事务、本次没有探测时为 false（M3 复审 P2-5）。
 */
export async function probeOnce() {
  if (!armed || probing) return false
  probing = true
  const database = armed
  try {
    if (!(await dbClient(database).probeWrite())) return false
    if (database === armed && state.failing && ++probeStreak >= RECOVERY_PROBES) recover()
    return true
  } catch {
    probeStreak = 0
    return false
  } finally {
    probing = false
  }
}

/** 数据库当前可写（没有处于写入失败中）。 */
export function databaseWritable() {
  return !state.failing
}

/** 恢复时回调（写回队列排空、收口重试）；返回取消函数。 */
export function onWriteRecovered(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** 面板（已鉴权）：是否可写、失败开始时间、最近一次错误与累计次数。未鉴权的 /healthz、/readyz 只用 databaseWritable()。 */
export function writeHealthStats() {
  return { writable: !state.failing, ...state }
}

/** 503 database_unavailable 与 /readyz 503 的 Retry-After（秒）。 */
export const DATABASE_RETRY_AFTER_SECONDS = 5

/** 计费准入：数据库写不进去时拒绝（503，请求未发往上游，客户端可稍后重试；带 Retry-After，M3 复审 P2-8）。 */
export function assertBillingWritable(res = null) {
  if (!state.failing) return
  try {
    if (res && !res.headersSent) res.setHeader('Retry-After', String(DATABASE_RETRY_AFTER_SECONDS))
  } catch {}
  const error = new Error('Billing records cannot be written right now; retry shortly')
  error.code = 'database_unavailable'
  error.status = 503
  throw error
}
