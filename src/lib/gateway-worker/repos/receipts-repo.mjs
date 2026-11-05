/**
 * Gateway Worker 回执、结算与额度观测的数据访问（gateway_worker_receipts、usage_logs、billing_charges、死信）。
 */
import { SUCCESS_PRED } from '../../db/repos/usage-log-preds.mjs'

export function getReceipt(db, ...params) {
  return db
    .prepare('SELECT * FROM gateway_worker_receipts WHERE gateway_instance_id=? AND dispatch_id=?')
    .get(...params)
}

export function hasBpsUsageLog(db, ...params) {
  return db
    .prepare(
      "SELECT 1 FROM usage_logs WHERE execution_kind='gateway_worker' AND dispatch_id=? AND authorization_mode='bps' LIMIT 1",
    )
    .get(...params)
}

export function markUsageUnmetered(db, ...params) {
  return db
    .prepare(
      "UPDATE usage_logs SET billing_status='unmetered' WHERE execution_kind='gateway_worker' AND dispatch_id=? AND billing_status='settlement_pending'",
    )
    .run(...params)
}

export function settleUsageLog(db, ...params) {
  return db
    .prepare(
      "UPDATE usage_logs SET billing_status=?,actual_cost=COALESCE(?,actual_cost),receipt_id=COALESCE(?,receipt_id),usage_confidence=? WHERE execution_kind='gateway_worker' AND dispatch_id=?",
    )
    .run(...params)
}

export function linkChargeToReceipt(db, ...params) {
  return db
    .prepare('UPDATE billing_charges SET gateway_receipt_id=?,settlement_source=? WHERE request_id=?')
    .run(...params)
}

export function insertDeadLetter(db, ...params) {
  return db
    .prepare(`INSERT INTO gateway_worker_dead_letters(id,kind,reference_id,payload_json,error_code,error_message,attempts,created_at)
       VALUES(?,?,?,?,?,?,?,?)`)
    .run(...params)
}

export function accountQuotaReceipts(db, ...params) {
  return db
    .prepare(`SELECT r.finished_at, r.quota_json FROM gateway_worker_receipts r
         JOIN gateway_worker_account_bindings b
           ON b.gateway_instance_id=r.gateway_instance_id AND b.runtime_account_id=r.runtime_account_id
        WHERE b.account_resource_id=? AND r.quota_json IS NOT NULL AND r.finished_at>=?
        ORDER BY r.finished_at LIMIT 5000`)
    .all(...params)
}

export function accountUsageRows(db, ...params) {
  return db
    .prepare(`SELECT created_at, duration_ms, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, total_cost,
              CASE WHEN ${SUCCESS_PRED} THEN 1 ELSE 0 END AS ok
         FROM usage_logs WHERE execution_kind='gateway_worker' AND account_resource_id=? AND created_at>=?`)
    .all(...params)
}
