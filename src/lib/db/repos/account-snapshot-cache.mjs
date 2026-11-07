/**
 * 账号调度快照的进程内副本（R6 B7b，竞态 R9）。
 *
 * `PoolScheduler.reserve()` 必须在一个同步段内完成“复核 + 预占”，不能等数据库；排队授予（`SeatPlanner.pump` →
 * `tryGrant`）又发生在同步的释放回调里。复核用的账号行（`accounts`）与运行态行（`account_runtime`）因此读这里：
 * 每次经仓储读到这两张表的行都写进来（`AccountsRepo` 的读与写后读回、`AccountRuntimeRepo` 的快照与写后读回），
 * 删除时清掉。这两张表只经这两个仓储写入（运行期没有别的写入方），所以副本等于“最近一次读到的数据库状态 +
 * 本进程之后的所有写入”。调度每轮的候选资格计算都会重读候选账号，副本不会比上一轮更旧。
 *
 * 按数据库对象分开保存（备份恢复换连接后自然清空）。只存原始行，读取方每次重新解析，拿到的是新对象。
 */

const caches = new WeakMap()

function cacheOf(database) {
  let cache = caches.get(database)
  if (!cache) {
    cache = new Map()
    caches.set(database, cache)
  }
  return cache
}

function entryOf(database, accountId) {
  const cache = cacheOf(database)
  let entry = cache.get(accountId)
  if (!entry) {
    entry = { account: undefined, runtime: undefined }
    cache.set(accountId, entry)
  }
  return entry
}

/** `accounts` 行（SELECT * 或调度快照里的 a.* 列）；null 表示已确认不存在。 */
export function rememberAccountRow(database, accountId, row) {
  if (!database || !accountId) return
  entryOf(database, accountId).account = row ? { ...row } : null
}

/** `account_runtime` 行（调度快照里的 rt_* 与运行态列）；null 表示已确认不存在。 */
export function rememberRuntimeRow(database, accountId, row) {
  if (!database || !accountId) return
  entryOf(database, accountId).runtime = row ? { ...row } : null
}

/** 已缓存的两部分行；还没有经调度快照（两表联查）读过时返回 undefined。 */
export function cachedAccountRows(database, accountId) {
  if (!database || !accountId) return undefined
  const entry = caches.get(database)?.get(accountId)
  if (!entry || entry.runtime === undefined || entry.account === undefined) return undefined
  return entry
}

/** 只取 accounts 行：最近一次经仓储读到（或写后读回）的行；从未读过时返回 undefined，null 表示已确认不存在。 */
export function cachedAccountRow(database, accountId) {
  if (!database || !accountId) return undefined
  return caches.get(database)?.get(accountId)?.account
}

export function forgetAccountRows(database, accountId) {
  caches.get(database)?.delete(accountId)
}
