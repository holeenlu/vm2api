/**
 * VM 槽位额度观测历史（quota_observations）及配对的 usage_logs 读取。只做数据访问；
 * 去重、保留期判断与容量估算在 quota-observations.mjs、vm-quota-forecast.mjs。
 */
import { SUCCESS_PRED } from '../../db/repos/usage-log-preds.mjs'

const FABLE_SQL = "instr(lower(COALESCE(NULLIF(trim(upstream_model), ''), trim(model), '')), 'fable') > 0"

export function latestObservation(db, vmId, window) {
  return db
    .prepare(
      'SELECT used_percent, reset_at FROM quota_observations WHERE vm_id = ? AND quota_window = ? ORDER BY observed_at DESC LIMIT 1',
    )
    .get(vmId, window)
}

export function insertObservation(db, { vmId, window, usedPercent, resetAt, windowSeconds, observedAt }) {
  db.prepare(
    'INSERT INTO quota_observations(vm_id, quota_window, used_percent, reset_at, window_seconds, observed_at) VALUES(?,?,?,?,?,?)',
  ).run(vmId, window, usedPercent, resetAt, windowSeconds, observedAt)
}

export function pruneObservationsBefore(db, observedBefore) {
  db.prepare('DELETE FROM quota_observations WHERE observed_at < ?').run(observedBefore)
}

/** 最新一条观测（含 id 与窗口长度），预测用 */
export function latestObservationWithId(db, vmId, window) {
  return db
    .prepare(
      `SELECT id, used_percent, reset_at, window_seconds, observed_at FROM quota_observations
        WHERE vm_id = ? AND quota_window = ? ORDER BY observed_at DESC, id DESC LIMIT 1`,
    )
    .get(vmId, window)
}

export function observationsSince(db, vmId, window, since, excludeId) {
  return db
    .prepare(
      `SELECT observed_at, used_percent, reset_at FROM quota_observations
        WHERE vm_id = ? AND quota_window = ? AND observed_at >= ? AND id != ? ORDER BY observed_at`,
    )
    .all(vmId, window, since, excludeId)
}

/** 槽位在 [since, until] 内的使用记录；window 为 '7d_oi' 时只取 Fable 模型 */
export function slotUsageRows(db, vmId, window, since, until) {
  return db
    .prepare(
      `SELECT created_at, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, total_cost, pricing_model,
              CASE WHEN ${SUCCESS_PRED} THEN 1 ELSE 0 END AS ok
         FROM usage_logs
        WHERE vm_id = ? AND created_at >= ? AND created_at <= ? ${window === '7d_oi' ? `AND ${FABLE_SQL}` : ''}`,
    )
    .all(vmId, since, until)
}
