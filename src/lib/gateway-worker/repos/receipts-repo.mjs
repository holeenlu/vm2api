/**
 * Gateway Worker 回执、结算与额度观测的数据访问（gateway_worker_receipts、usage_logs、billing_charges、死信）。
 * 经 DbClient 异步访问（R6 B5）。
 */
import { dbClient } from '../../db/db-client.mjs'
import { SUCCESS_PRED } from '../../db/repos/usage-log-preds.mjs'

export async function getReceipt(db, gatewayInstanceId, dispatchId) {
  return dbClient(db).one(
    'SELECT * FROM gateway_worker_receipts WHERE gateway_instance_id=? AND dispatch_id=?',
    gatewayInstanceId,
    dispatchId,
  )
}

export async function hasBpsUsageLog(db, dispatchId) {
  return dbClient(db).one(
    "SELECT 1 FROM usage_logs WHERE execution_kind='gateway_worker' AND dispatch_id=? AND authorization_mode='bps' LIMIT 1",
    dispatchId,
  )
}

export async function markUsageUnmetered(db, dispatchId) {
  return dbClient(db).run(
    "UPDATE usage_logs SET billing_status='unmetered' WHERE execution_kind='gateway_worker' AND dispatch_id=? AND billing_status='settlement_pending'",
    dispatchId,
  )
}

export async function settleUsageLog(db, billingStatus, actualCost, receiptId, usageConfidence, dispatchId) {
  return dbClient(db).run(
    "UPDATE usage_logs SET billing_status=?,actual_cost=COALESCE(?,actual_cost),receipt_id=COALESCE(?,receipt_id),usage_confidence=? WHERE execution_kind='gateway_worker' AND dispatch_id=?",
    billingStatus,
    actualCost,
    receiptId,
    usageConfidence,
    dispatchId,
  )
}

export async function linkChargeToReceipt(db, gatewayReceiptId, settlementSource, requestId) {
  return dbClient(db).run(
    'UPDATE billing_charges SET gateway_receipt_id=?,settlement_source=? WHERE request_id=?',
    gatewayReceiptId,
    settlementSource,
    requestId,
  )
}

export async function insertDeadLetter(
  db,
  id,
  kind,
  referenceId,
  payloadJson,
  errorCode,
  errorMessage,
  attempts,
  createdAt,
) {
  return dbClient(db).run(
    `INSERT INTO gateway_worker_dead_letters(id,kind,reference_id,payload_json,error_code,error_message,attempts,created_at)
       VALUES(?,?,?,?,?,?,?,?)`,
    id,
    kind,
    referenceId,
    payloadJson,
    errorCode,
    errorMessage,
    attempts,
    createdAt,
  )
}

export async function accountQuotaReceipts(db, accountResourceId, finishedAt) {
  return dbClient(db).many(
    `SELECT r.finished_at, r.quota_json FROM gateway_worker_receipts r
         JOIN gateway_worker_account_bindings b
           ON b.gateway_instance_id=r.gateway_instance_id AND b.runtime_account_id=r.runtime_account_id
        WHERE b.account_resource_id=? AND r.quota_json IS NOT NULL AND r.finished_at>=?
        ORDER BY r.finished_at LIMIT 5000`,
    accountResourceId,
    finishedAt,
  )
}

export async function accountUsageRows(db, accountResourceId, createdAt) {
  return dbClient(db).many(
    `SELECT created_at, duration_ms, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, total_cost,
              CASE WHEN ${SUCCESS_PRED} THEN 1 ELSE 0 END AS ok
         FROM usage_logs WHERE execution_kind='gateway_worker' AND account_resource_id=? AND created_at>=?`,
    accountResourceId,
    createdAt,
  )
}
