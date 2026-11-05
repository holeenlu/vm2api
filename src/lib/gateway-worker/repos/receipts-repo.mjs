/**
 * Gateway Worker 回执、结算与额度观测的数据访问（gateway_worker_receipts、usage_logs、billing_charges、死信）。
 */
import { SUCCESS_PRED } from '../../db/repos/usage-log-preds.mjs'

export function getReceipt(db, gatewayInstanceId, dispatchId) {
  return db
    .prepare('SELECT * FROM gateway_worker_receipts WHERE gateway_instance_id=? AND dispatch_id=?')
    .get(gatewayInstanceId, dispatchId)
}

export function hasBpsUsageLog(db, dispatchId) {
  return db
    .prepare(
      "SELECT 1 FROM usage_logs WHERE execution_kind='gateway_worker' AND dispatch_id=? AND authorization_mode='bps' LIMIT 1",
    )
    .get(dispatchId)
}

export function markUsageUnmetered(db, dispatchId) {
  return db
    .prepare(
      "UPDATE usage_logs SET billing_status='unmetered' WHERE execution_kind='gateway_worker' AND dispatch_id=? AND billing_status='settlement_pending'",
    )
    .run(dispatchId)
}

export function settleUsageLog(db, billingStatus, actualCost, receiptId, usageConfidence, dispatchId) {
  return db
    .prepare(
      "UPDATE usage_logs SET billing_status=?,actual_cost=COALESCE(?,actual_cost),receipt_id=COALESCE(?,receipt_id),usage_confidence=? WHERE execution_kind='gateway_worker' AND dispatch_id=?",
    )
    .run(billingStatus, actualCost, receiptId, usageConfidence, dispatchId)
}

export function linkChargeToReceipt(db, gatewayReceiptId, settlementSource, requestId) {
  return db
    .prepare('UPDATE billing_charges SET gateway_receipt_id=?,settlement_source=? WHERE request_id=?')
    .run(gatewayReceiptId, settlementSource, requestId)
}

export function insertDeadLetter(db, id, kind, referenceId, payloadJson, errorCode, errorMessage, attempts, createdAt) {
  return db
    .prepare(`INSERT INTO gateway_worker_dead_letters(id,kind,reference_id,payload_json,error_code,error_message,attempts,created_at)
       VALUES(?,?,?,?,?,?,?,?)`)
    .run(id, kind, referenceId, payloadJson, errorCode, errorMessage, attempts, createdAt)
}

export function accountQuotaReceipts(db, accountResourceId, finishedAt) {
  return db
    .prepare(`SELECT r.finished_at, r.quota_json FROM gateway_worker_receipts r
         JOIN gateway_worker_account_bindings b
           ON b.gateway_instance_id=r.gateway_instance_id AND b.runtime_account_id=r.runtime_account_id
        WHERE b.account_resource_id=? AND r.quota_json IS NOT NULL AND r.finished_at>=?
        ORDER BY r.finished_at LIMIT 5000`)
    .all(accountResourceId, finishedAt)
}

export function accountUsageRows(db, accountResourceId, createdAt) {
  return db
    .prepare(`SELECT created_at, duration_ms, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, total_cost,
              CASE WHEN ${SUCCESS_PRED} THEN 1 ELSE 0 END AS ok
         FROM usage_logs WHERE execution_kind='gateway_worker' AND account_resource_id=? AND created_at>=?`)
    .all(accountResourceId, createdAt)
}
