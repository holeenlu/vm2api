// 供应商下游结算的仓储：SQL 原样自 vendor-settlements.mjs 迁入，调用方注入数据库句柄并负责事务边界；经 DbClient 异步访问（R6 B4）。
import { SETTLEMENT_USAGE_SOURCE } from './pricing-repo.mjs'
import { dbClient } from '../../db/db-client.mjs'
import { moneySql } from '../../db/repos/money-sql.mjs'

/** `usageVendorIds` 是用量归属的供应商（平台账单含一级供应商的直属下级）；占用按付款边 payer/payee 判定，payer 为 null 表示平台。 */
export async function settlementSnapshotRows(
  db,
  payerVendorId,
  payeeVendorId,
  usageVendorIds,
  input,
  watermark,
  snapshotAt,
) {
  return dbClient(db).many(
    `SELECT l.request_id AS id,l.watermark,l.created_at,l.group_id,g.name AS group_name,
    l.model AS model,l.total_cost,l.total_cost_micros,l.pricing_model,l.input_tokens,l.output_tokens,l.cache_read_tokens,l.cache_creation_tokens,
    a.id AS account_id,a.name AS account_name,json_extract(a.config_json,'$.platform') AS platform,
    EXISTS(SELECT 1 FROM vendor_settlement_allocations al WHERE COALESCE(al.payer_vendor_id,'')=? AND al.payee_vendor_id=? AND al.usage_log_id=l.request_id AND al.released_at IS NULL) AS occupied
    FROM (${SETTLEMENT_USAGE_SOURCE}) l LEFT JOIN vendor_resources a ON a.id=l.account_resource_id AND a.vendor_id=l.vendor_id
    LEFT JOIN groups g ON g.id=l.group_id
    WHERE l.vendor_id IN (${usageVendorIds.map(() => '?').join(',') || 'NULL'}) AND l.created_at>=? AND l.created_at<? AND l.watermark<=? AND l.status>=200 AND l.status<300 AND l.recorded_at<=?
    AND (l.total_cost_micros IS NULL OR l.pricing_model='unpriced' OR COALESCE(l.total_cost_micros,0)>0 OR COALESCE(l.input_tokens,0)+COALESCE(l.output_tokens,0)+COALESCE(l.cache_read_tokens,0)+COALESCE(l.cache_creation_tokens,0)>0)
    ${input.account_id ? 'AND a.id=?' : ''} ${input.group_id ? 'AND l.group_id=?' : ''} ${input.platform ? "AND json_extract(a.config_json,'$.platform')=?" : ''}
    ORDER BY l.watermark,l.id LIMIT 50001`,
    payerVendorId || '',
    payeeVendorId,
    ...usageVendorIds,
    input.start_at,
    input.end_at,
    watermark,
    snapshotAt,
    ...(input.account_id ? [input.account_id] : []),
    ...(input.group_id ? [input.group_id] : []),
    ...(input.platform ? [input.platform] : []),
  )
}

export async function legacySettlementPeriods(db, payerVendorId, payeeVendorId) {
  return dbClient(db).many(
    "SELECT s.period_start,s.period_end FROM vendor_settlements s WHERE s.payer_vendor_id IS ? AND s.payee_vendor_id=? AND s.status<>'void' AND COALESCE(json_extract(s.usage_snapshot_json,'$.source'),'')<>'usage_logs_v2'",
    payerVendorId,
    payeeVendorId,
  )
}

export async function deleteExpiredSettlementPreviews(db, stamp) {
  return dbClient(db).run('DELETE FROM vendor_settlement_previews WHERE expires_at<? AND statement_id IS NULL', stamp)
}

/** 返回 `{ value }` 行：usage_logs 与 vendor_usage_facts 的最大 rowid（结算增量水位）。 */
export async function settlementWatermark(db) {
  return dbClient(db).one(
    'SELECT MAX((SELECT COALESCE(MAX(rowid),0) FROM usage_logs),(SELECT COALESCE(MAX(rowid),0) FROM vendor_usage_facts)) value',
  )
}

/** 参数依次为 token_hash,actor_user_id,payer_vendor_id,payee_vendor_id,contract_id,input_json,snapshot_json,data_hash,watermark,expires_at,created_at。 */
export async function insertSettlementPreview(db, ...values) {
  return dbClient(db).run(
    'INSERT INTO vendor_settlement_previews(token_hash,actor_user_id,payer_vendor_id,payee_vendor_id,contract_id,input_json,snapshot_json,data_hash,watermark,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    ...values,
  )
}

export async function settlementById(db, id) {
  return dbClient(db).one('SELECT * FROM vendor_settlements WHERE id=?', id)
}

/** 返回 `{ n }` 行：账单已付款合计。 */
export async function settlementPaidTotal(db, settlementId) {
  return dbClient(db).one(
    `SELECT COALESCE(SUM(${moneySql('amount_usdt')}),0) / 1000000.0 n FROM vendor_payments WHERE settlement_id=? AND action='payment'`,
    settlementId,
  )
}

export async function settlementPayments(db, settlementId) {
  return dbClient(db).many(
    'SELECT id,amount_usdt,action,reason,created_at FROM vendor_payments WHERE settlement_id=? ORDER BY created_at,id',
    settlementId,
  )
}

export async function settlementByIdempotencyKey(db, createdBy, idempotencyKey) {
  return dbClient(db).one(
    'SELECT id,input_hash,contract_id FROM vendor_settlements WHERE created_by=? AND idempotency_key=?',
    createdBy,
    idempotencyKey,
  )
}

export async function settlementPreviewForActor(db, tokenHash, actorUserId, payerVendorId) {
  return dbClient(db).one(
    'SELECT * FROM vendor_settlement_previews WHERE token_hash=? AND actor_user_id=? AND payer_vendor_id IS ?',
    tokenHash,
    actorUserId,
    payerVendorId,
  )
}

/**
 * 参数依次为 id,contract_id,period_start,period_end,status,amount_usdt_micros,amount_usdt,usage_snapshot_json,created_by,created_at,updated_at,idempotency_key,input_hash,payer_vendor_id,payee_vendor_id。
 * 金额（M6）：amount_usdt_micros 为整数微单位（权威值），amount_usdt 是由它派生的 REAL 镜像，两者同时写。
 * 同一操作者的幂等标识已存在时不写入（竞态 R20）：返回 `changes` 为 0，调用方按标识读回已有账单。
 */
export async function insertSettlement(db, ...values) {
  return dbClient(db).run(
    `INSERT INTO vendor_settlements(id,contract_id,period_start,period_end,status,amount_usdt_micros,amount_usdt,usage_snapshot_json,created_by,created_at,updated_at,idempotency_key,input_hash,payer_vendor_id,payee_vendor_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(created_by,idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
    ...values,
  )
}

/** 批量写结算分摊：每条 `rows[i]` 写入 usage_log_id=row.id 与冻结的行快照；分块避免单语句参数过多。 */
export async function insertSettlementAllocations(db, statementId, payerVendorId, payeeVendorId, rows) {
  const client = dbClient(db)
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500)
    await client.run(
      `INSERT INTO vendor_settlement_allocations(statement_id,usage_log_id,payer_vendor_id,payee_vendor_id,snapshot_json) VALUES ${chunk.map(() => '(?,?,?,?,?)').join(',')}`,
      ...chunk.flatMap((row) => [statementId, row.id, payerVendorId, payeeVendorId, JSON.stringify(row)]),
    )
  }
}

export async function linkSettlementPreview(db, statementId, tokenHash) {
  return dbClient(db).run(
    'UPDATE vendor_settlement_previews SET statement_id=? WHERE token_hash=?',
    statementId,
    tokenHash,
  )
}

export async function settlementPaymentExists(db, settlementId) {
  return dbClient(db).one('SELECT 1 FROM vendor_payments WHERE settlement_id=?', settlementId)
}

export async function updateSettlementStatus(db, status, confirmedAt, updatedAt, id) {
  return dbClient(db).run(
    'UPDATE vendor_settlements SET status=?,confirmed_at=?,updated_at=? WHERE id=?',
    status,
    confirmedAt,
    updatedAt,
    id,
  )
}

export async function releaseSettlementAllocations(db, releasedAt, statementId) {
  return dbClient(db).run(
    'UPDATE vendor_settlement_allocations SET released_at=? WHERE statement_id=? AND released_at IS NULL',
    releasedAt,
    statementId,
  )
}

export async function supplierSettlementRows(db, vendorId) {
  return dbClient(db).many(
    `SELECT s.id,s.payer_vendor_id,s.payee_vendor_id,v.name AS vendor_name,p.name AS payer_name
    FROM vendor_settlements s JOIN vendors v ON v.id=s.payee_vendor_id LEFT JOIN vendors p ON p.id=s.payer_vendor_id
    WHERE s.payee_vendor_id=? OR (s.payer_vendor_id=? AND v.parent_id=?) ORDER BY s.created_at DESC,s.id DESC`,
    vendorId,
    vendorId,
    vendorId,
  )
}
