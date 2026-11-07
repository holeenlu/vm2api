/**
 * VM 槽位额度观测历史（quota_observations）及配对的 usage_logs 读取。只做数据访问；
 * 去重、保留期判断与容量估算在 quota-observations.mjs、vm-quota-forecast.mjs。
 * 经 DbClient 异步访问（R6 B7c），db 由调用方注入（主库或统计线程的连接）。
 */
import { dbClient } from '../../db/db-client.mjs'
import { SUCCESS_PRED, upstreamTokenSql } from '../../db/repos/usage-log-preds.mjs'

const FABLE_SQL = "instr(lower(COALESCE(NULLIF(trim(upstream_model), ''), trim(model), '')), 'fable') > 0"

export async function latestObservation(db, vmId, window) {
  return dbClient(db).one(
    'SELECT used_percent, reset_at FROM quota_observations WHERE vm_id = ? AND quota_window = ? ORDER BY observed_at DESC LIMIT 1',
    vmId,
    window,
  )
}

export async function insertObservation(db, { vmId, window, usedPercent, resetAt, windowSeconds, observedAt }) {
  await dbClient(db).run(
    'INSERT INTO quota_observations(vm_id, quota_window, used_percent, reset_at, window_seconds, observed_at) VALUES(?,?,?,?,?,?)',
    vmId,
    window,
    usedPercent,
    resetAt,
    windowSeconds,
    observedAt,
  )
}

export async function pruneObservationsBefore(db, observedBefore) {
  await dbClient(db).run('DELETE FROM quota_observations WHERE observed_at < ?', observedBefore)
}

/** 最新一条观测（含 id 与窗口长度），预测用 */
export async function latestObservationWithId(db, vmId, window) {
  return dbClient(db).one(
    `SELECT id, used_percent, reset_at, window_seconds, observed_at FROM quota_observations
        WHERE vm_id = ? AND quota_window = ? ORDER BY observed_at DESC, id DESC LIMIT 1`,
    vmId,
    window,
  )
}

export async function observationsSince(db, vmId, window, since, excludeId) {
  return dbClient(db).many(
    `SELECT observed_at, used_percent, reset_at FROM quota_observations
        WHERE vm_id = ? AND quota_window = ? AND observed_at >= ? AND id != ? ORDER BY observed_at`,
    vmId,
    window,
    since,
    excludeId,
  )
}

/** 槽位在 [since, until] 内的使用记录；window 为 '7d_oi' 时只取 Fable 模型 */
export async function slotUsageRows(db, vmId, window, since, until) {
  return dbClient(db).many(
    `SELECT created_at, ${upstreamTokenSql('input_tokens')} AS input_tokens, output_tokens,
              ${upstreamTokenSql('cache_read_tokens')} AS cache_read_tokens,
              ${upstreamTokenSql('cache_creation_tokens')} AS cache_creation_tokens, total_cost, total_cost_micros, pricing_model,
              CASE WHEN ${SUCCESS_PRED} THEN 1 ELSE 0 END AS ok
         FROM usage_logs
        WHERE vm_id = ? AND created_at >= ? AND created_at <= ? ${window === '7d_oi' ? `AND ${FABLE_SQL}` : ''}`,
    vmId,
    since,
    until,
  )
}

/** 指定窗口在 `since` 之后的全部观测（同号检测用），按槽位、时间排序 */
export async function windowObservationsSince(db, window, since) {
  return dbClient(db).many(
    `SELECT vm_id, used_percent, reset_at, observed_at FROM quota_observations
        WHERE quota_window = ? AND observed_at >= ? ORDER BY vm_id, observed_at`,
    window,
    since,
  )
}
