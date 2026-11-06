// 供应商结算价格与结算用量来源的仓储：SQL 原样自 vendor-pricing.mjs 迁入，调用方注入数据库句柄；经 DbClient 异步访问（R6 B4）。

// Settlement cost is the immutable supplier fact when present. Detailed logs only
// fill fields the retained fact did not store; successful legacy logs are a fallback.
import { dbClient } from '../../db/db-client.mjs'
export const SETTLEMENT_USAGE_SOURCE = `
 SELECT f.rowid AS watermark,f.id,COALESCE(f.source_request_id,f.id) request_id,f.vendor_id,f.resource_id account_resource_id,
 f.occurred_at created_at,f.created_at recorded_at,f.model,NULL AS pricing_model,f.cost_usd total_cost,
 f.input_tokens,f.output_tokens,l.cache_read_tokens,l.cache_creation_tokens,l.group_id,200 AS status
 FROM vendor_usage_facts f LEFT JOIN usage_logs l ON l.request_id=f.source_request_id
 UNION ALL
 SELECT u.rowid,u.id,COALESCE(NULLIF(u.request_id,''),u.id),a.vendor_id,a.id,u.created_at,u.created_at,
 COALESCE(NULLIF(u.upstream_model,''),u.model),u.pricing_model,u.total_cost,u.input_tokens,u.output_tokens,u.cache_read_tokens,u.cache_creation_tokens,u.group_id,u.status
 FROM usage_logs u JOIN vendor_resources v ON v.resource_type='vm' AND json_extract(v.config_json,'$.runtime_vm_id')=u.vm_id
 JOIN vendor_resources a ON a.resource_type='account' AND a.vendor_id=v.vendor_id AND json_extract(a.config_json,'$.vm_resource_id')=v.id
 WHERE u.status>=200 AND u.status<300 AND NOT EXISTS(SELECT 1 FROM vendor_usage_facts f WHERE f.source_request_id=u.request_id)
`

/** 结算用量明细（原 `iterate` 逐行读取，DbClient 一次取回全部行）。 */
export async function settlementUsageRowsFor(db, ids, period) {
  return dbClient(db).many(
    `SELECT l.*,a.name AS account_name,json_extract(a.config_json,'$.platform') platform,v.name AS vendor_name
 FROM (${SETTLEMENT_USAGE_SOURCE}) l LEFT JOIN vendor_resources a ON a.id=l.account_resource_id LEFT JOIN vendors v ON v.id=l.vendor_id
 WHERE l.vendor_id IN (${ids.length ? ids.map(() => '?').join(',') : 'NULL'}) AND l.created_at>=? AND l.created_at<? ORDER BY l.created_at,l.request_id`,
    ...ids,
    period.start,
    period.end,
  )
}

export async function activeGlobalContracts(db) {
  return dbClient(db).many(
    "SELECT * FROM vendor_contracts WHERE payer_vendor_id IS NULL AND payee_vendor_id IS NULL AND status='active' ORDER BY effective_at DESC,version DESC",
  )
}

export async function globalContractByIdempotencyKey(db, createdBy, idempotencyKey) {
  return dbClient(db).one(
    'SELECT * FROM vendor_contracts WHERE payer_vendor_id IS NULL AND payee_vendor_id IS NULL AND created_by=? AND idempotency_key=?',
    createdBy,
    idempotencyKey,
  )
}

/** 返回 `{ n }` 行：下一个全局价格版本号。 */
export async function nextGlobalContractVersion(db) {
  return dbClient(db).one(
    'SELECT COALESCE(MAX(version),0)+1 n FROM vendor_contracts WHERE payer_vendor_id IS NULL AND payee_vendor_id IS NULL',
  )
}

/**
 * 参数依次为 id,version,effective_at,fx_cny_per_usdt,group_prices_json,created_by,created_at,idempotency_key,input_hash。
 * 同一操作者的保存标识已存在时不写入（竞态 R20）：返回 `changes` 为 0，调用方按标识读回已有价格。
 */
export async function insertGlobalContract(db, ...values) {
  return dbClient(db).run(
    `INSERT INTO vendor_contracts(id,leg,payer_vendor_id,payee_vendor_id,version,effective_at,price_cny_per_usd,fx_cny_per_usdt,multiplier,group_prices_json,status,created_by,created_at,idempotency_key,input_hash)
    VALUES (?,'platform_to_l1',NULL,NULL,?,?,1,?,1,?,'active',?,?,?,?)
    ON CONFLICT(created_by,idempotency_key) WHERE payer_vendor_id IS NULL AND payee_vendor_id IS NULL AND idempotency_key IS NOT NULL DO NOTHING`,
    ...values,
  )
}

export async function contractById(db, id) {
  return dbClient(db).one('SELECT * FROM vendor_contracts WHERE id=?', id)
}

export async function activeLegacyContracts(db, payeeId, payerId) {
  return dbClient(db).many(
    "SELECT * FROM vendor_contracts WHERE payee_vendor_id=? AND payer_vendor_id IS ? AND status='active' ORDER BY effective_at DESC,version DESC",
    payeeId,
    payerId,
  )
}
