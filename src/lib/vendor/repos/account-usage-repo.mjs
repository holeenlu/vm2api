// 供应商账号用量的仓储：SQL 片段与查询原样自 vendor-account-usage.mjs 迁入，调用方注入数据库句柄；经 DbClient 异步访问（R6 B4）。
import {
  ERROR_PRED,
  SUCCESS_PRED,
  PROMPT_TOKENS_SQL,
  TOTAL_TOKENS_SQL,
  upstreamTokenSql,
} from '../../db/repos/usage-log-preds.mjs'
import { dbClient } from '../../db/db-client.mjs'
import { moneySql } from '../../db/repos/money-sql.mjs'

// Retained supplier facts cover periods whose detailed request logs have expired.
// Prefer the detailed row when present so a request is never counted twice.
// `usageScope` / `factsScope` narrow each arm before its joins; callers keep their outer filter.
// Resource JSON is extracted once per query instead of once per log row.
// Gateway Worker 账号的请求没有 VM，按 `gateway:<账号资源>` 归入对应账号。
export const vendorAccountLogs = (usageScope = '', factsScope = '') => `
  WITH vm_map AS MATERIALIZED (SELECT id,vendor_id,json_extract(config_json,'$.runtime_vm_id') AS runtime_vm_id
    FROM vendor_resources WHERE resource_type='vm'),
  account_map AS MATERIALIZED (SELECT id,vendor_id,json_extract(config_json,'$.vm_resource_id') AS vm_resource_id,
    json_extract(config_json,'$.execution_kind') AS execution_kind FROM vendor_resources WHERE resource_type='account')
  SELECT u.rowid AS watermark,u.id,COALESCE(NULLIF(u.request_id,''),u.id) AS request_id,
    COALESCE(u.vm_id,CASE WHEN u.execution_kind='gateway_worker' THEN 'gateway:'||COALESCE(u.account_resource_id,ga.id) END) AS vm_id,u.group_id,u.created_at,
    CASE WHEN f.id IS NULL THEN u.status ELSE 200 END AS status,CASE WHEN f.id IS NULL THEN u.error_code ELSE NULL END AS error_code,u.model,u.upstream_model,CASE WHEN f.id IS NULL THEN u.pricing_model ELSE NULL END AS pricing_model,COALESCE(f.cost_usd,u.total_cost) AS total_cost,${upstreamTokenSql('input_tokens', 'u')} AS input_tokens,u.output_tokens,
    ${upstreamTokenSql('cache_read_tokens', 'u')} AS cache_read_tokens,${upstreamTokenSql('cache_creation_tokens', 'u')} AS cache_creation_tokens,u.duration_ms,u.first_token_ms,COALESCE(f.vendor_id,a.vendor_id,ga.vendor_id) AS vendor_id,COALESCE(f.resource_id,a.id,ga.id) AS account_resource_id,
    u.authorization_mode,COALESCE(${moneySql('cost_usd', 'f.')},${moneySql('total_cost', 'u.')}) AS total_cost_micros
  FROM usage_logs u LEFT JOIN vm_map v ON v.runtime_vm_id=u.vm_id
  LEFT JOIN account_map a ON a.vendor_id=v.vendor_id AND a.vm_resource_id=v.id
  LEFT JOIN account_map ga ON ga.id=u.account_resource_id
  LEFT JOIN vendor_usage_facts f ON f.source_request_id=u.request_id
  ${usageScope ? `WHERE ${usageScope}` : ''}
  UNION ALL
  SELECT f.rowid AS watermark,f.id,COALESCE(NULLIF(f.source_request_id,''),f.id),COALESCE(v.runtime_vm_id,CASE WHEN a.execution_kind='gateway_worker' THEN 'gateway:'||a.id ELSE 'vendor-history:'||f.vendor_id END),NULL,f.occurred_at,
    200,NULL,f.model,NULL,NULL,f.cost_usd,f.input_tokens,f.output_tokens,f.cache_read_tokens,f.cache_creation_tokens,NULL,NULL,f.vendor_id,f.resource_id,NULL,
    ${moneySql('cost_usd', 'f.')}
  FROM vendor_usage_facts f LEFT JOIN account_map a ON a.id=f.resource_id AND a.vendor_id=f.vendor_id
  LEFT JOIN vm_map v ON v.id=a.vm_resource_id AND v.vendor_id=a.vendor_id
  WHERE ${factsScope ? `${factsScope} AND ` : ''}NOT EXISTS(SELECT 1 FROM usage_logs u WHERE u.request_id=f.source_request_id)
`

// 命中率只取缓存读、写都已上报的请求，分子分母同一批；未上报用量的中断/搜索/图片请求不再让整段命中率变成未知。
const CACHE_KNOWN = 'cache_read_tokens IS NOT NULL AND cache_creation_tokens IS NOT NULL'
const CACHE_KNOWN_SELECT = `COALESCE(SUM(CASE WHEN ${CACHE_KNOWN} THEN cache_read_tokens END),0) AS cache_known_read_tokens,
  COALESCE(SUM(CASE WHEN ${CACHE_KNOWN} THEN ${PROMPT_TOKENS_SQL} END),0) AS cache_known_prompt_tokens`

export const VENDOR_USAGE_SELECT = `COUNT(*) AS requests,
  COALESCE(SUM(CASE WHEN ${SUCCESS_PRED} THEN 1 ELSE 0 END),0) AS success,
  COALESCE(SUM(CASE WHEN ${ERROR_PRED} THEN 1 ELSE 0 END),0) AS errors,
  COALESCE(SUM(input_tokens),0) AS input_tokens, COALESCE(SUM(output_tokens),0) AS output_tokens,
  COALESCE(SUM(cache_read_tokens),0) AS cache_read_tokens, COALESCE(SUM(cache_creation_tokens),0) AS cache_creation_tokens,
  COALESCE(SUM(${TOTAL_TOKENS_SQL}),0) AS total_tokens,
  COALESCE(SUM(CASE WHEN status>=200 AND status<300 THEN total_cost_micros ELSE 0 END),0) / 1000000.0 AS cost_usd,
  COALESCE(SUM(CASE WHEN status>=200 AND status<300 AND (total_cost_micros IS NULL OR pricing_model='unpriced') THEN 1 ELSE 0 END),0) AS unpriced_requests,
  COALESCE(SUM(CASE WHEN status>=200 AND status<300 AND LOWER(COALESCE(NULLIF(upstream_model,''),NULLIF(pricing_model,''),model,'')) LIKE '%fable%' THEN total_cost_micros ELSE 0 END),0) / 1000000.0 AS fable_cost_usd,
  COALESCE(SUM(CASE WHEN status>=200 AND status<300 AND LOWER(COALESCE(NULLIF(upstream_model,''),NULLIF(pricing_model,''),model,'')) LIKE '%opus%' THEN total_cost_micros ELSE 0 END),0) / 1000000.0 AS opus_cost_usd,
  COUNT(cache_read_tokens) AS cache_read_known_requests, COUNT(cache_creation_tokens) AS cache_creation_known_requests,
  SUM(CASE WHEN cache_read_tokens IS NULL OR cache_creation_tokens IS NULL THEN 1 ELSE 0 END) AS cache_unknown_requests,
  ${CACHE_KNOWN_SELECT},
  AVG(duration_ms) AS avg_duration_ms, AVG(first_token_ms) AS avg_ttft_ms`

// The outer filter on the derived vm_id cannot use an index, so `from` also narrows both arms to the
// same accounts and period (usage_logs through idx_reqlog_vm); the outer filter stays authoritative.
export function accountUsageCondition(ids, since, until, mode = null) {
  const keys = [...new Set(ids.filter(Boolean))]
  const marks = (values) => values.map(() => '?').join(',')
  const prefixed = (prefix) => keys.filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length))
  const gateways = prefixed('gateway:')
  const history = prefixed('vendor-history:')
  const vms = keys.filter((key) => !key.startsWith('gateway:') && !key.startsWith('vendor-history:'))
  const any = (terms) => terms.filter(Boolean).join(' OR ') || '0'
  const usageAccounts = any([
    vms.length && `u.vm_id IN (${marks(vms)})`,
    gateways.length && `(u.execution_kind='gateway_worker' AND u.account_resource_id IN (${marks(gateways)}))`,
  ])
  const factAccounts = any([
    vms.length &&
      `f.resource_id IN (SELECT a.id FROM account_map a JOIN vm_map v ON v.id=a.vm_resource_id AND v.vendor_id=a.vendor_id
        WHERE v.runtime_vm_id IN (${marks(vms)}))`,
    gateways.length && `f.resource_id IN (${marks(gateways)})`,
    history.length && `f.vendor_id IN (${marks(history)})`,
  ])
  const period = (column) => `${column}<?${since ? ` AND ${column}>=?` : ''}`
  const periodParams = [until, ...(since ? [since] : [])]
  return {
    from: vendorAccountLogs(
      `(${usageAccounts}) AND ${period('u.created_at')}`,
      `(${factAccounts}) AND ${period('f.occurred_at')}`,
    ),
    sql: `vm_id IN (${keys.length ? marks(keys) : 'NULL'}) AND ${period('created_at')}${mode ? ' AND authorization_mode=?' : ''}`,
    params: [
      ...vms,
      ...gateways,
      ...periodParams,
      ...vms,
      ...gateways,
      ...history,
      ...periodParams,
      ...keys,
      ...periodParams,
      ...(mode ? [mode] : []),
    ],
  }
}
export async function usageSummaryRow(db, where) {
  return dbClient(db).one(
    `SELECT ${VENDOR_USAGE_SELECT} FROM (${where.from}) usage_logs WHERE ${where.sql}`,
    ...where.params,
  )
}

export async function usageSummaryRowsByVm(db, where) {
  return dbClient(db).many(
    `SELECT vm_id,${VENDOR_USAGE_SELECT} FROM (${where.from}) usage_logs WHERE ${where.sql} GROUP BY vm_id`,
    ...where.params,
  )
}

/** 返回 `{ at }` 行：范围内最早的请求时间。 */
export async function firstUsageRow(db, where) {
  return dbClient(db).one(
    `SELECT MIN(created_at) at FROM (${where.from}) usage_logs WHERE ${where.sql}`,
    ...where.params,
  )
}

export async function usageSlotRows(db, where) {
  return dbClient(db).many(
    `SELECT substr(created_at,1,14)||printf('%02d',(CAST(substr(created_at,15,2) AS INTEGER)/15)*15) slot,
    COUNT(*) requests,COALESCE(SUM(input_tokens),0) input_tokens,COALESCE(SUM(output_tokens),0) output_tokens,
    COALESCE(SUM(cache_read_tokens),0) cache_read_tokens,COALESCE(SUM(cache_creation_tokens),0) cache_creation_tokens,
    COALESCE(SUM(${TOTAL_TOKENS_SQL}),0) total_tokens,COALESCE(SUM(CASE WHEN status>=200 AND status<300 THEN total_cost_micros ELSE 0 END),0) cost_usd_micros,
    SUM(CASE WHEN status>=200 AND status<300 AND (total_cost_micros IS NULL OR pricing_model='unpriced') THEN 1 ELSE 0 END) unpriced,
    COUNT(cache_read_tokens) cache_read_known_requests, COUNT(cache_creation_tokens) cache_creation_known_requests,
    SUM(CASE WHEN cache_read_tokens IS NULL OR cache_creation_tokens IS NULL THEN 1 ELSE 0 END) cache_unknown,
    ${CACHE_KNOWN_SELECT}
    FROM (${where.from}) usage_logs WHERE ${where.sql} GROUP BY slot ORDER BY slot`,
    ...where.params,
  )
}

export async function usageModelRows(db, where) {
  return dbClient(db).many(
    `SELECT COALESCE(NULLIF(upstream_model,''),NULLIF(model,''),'unknown') model,${VENDOR_USAGE_SELECT}
    FROM (${where.from}) usage_logs WHERE ${where.sql} GROUP BY 1 ORDER BY requests DESC,model`,
    ...where.params,
  )
}

export async function usageAccountRows(db, where) {
  return dbClient(db).many(
    `SELECT u.*,a.name AS account_name FROM (
      SELECT account_resource_id,${VENDOR_USAGE_SELECT} FROM (${where.from}) usage_logs
      WHERE ${where.sql} GROUP BY account_resource_id) u
      LEFT JOIN vendor_resources a ON a.id=u.account_resource_id ORDER BY cost_usd DESC`,
    ...where.params,
  )
}

export async function latestGatewayBinding(db, accountResourceId) {
  return dbClient(db).one(
    'SELECT * FROM gateway_worker_account_bindings WHERE account_resource_id=? ORDER BY updated_at DESC LIMIT 1',
    accountResourceId,
  )
}

export async function supplierAccountResources(db, ids) {
  return dbClient(db).many(
    `SELECT a.id,a.name,a.vendor_id,a.config_json,v.config_json AS vm_config_json FROM vendor_resources a
    LEFT JOIN vendor_resources v ON v.id=json_extract(a.config_json,'$.vm_resource_id') AND v.vendor_id=a.vendor_id AND v.resource_type='vm'
    WHERE a.resource_type='account' AND a.vendor_id IN (${ids.map(() => '?').join(',')})`,
    ...ids,
  )
}
