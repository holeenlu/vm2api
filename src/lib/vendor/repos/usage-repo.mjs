// 供应商用量事实与运营用量视图的仓储：SQL 原样自 vendor-usage.mjs 迁入，调用方注入数据库句柄；经 DbClient 异步访问（R6 B4）。
import { vendorAccountLogs, VENDOR_USAGE_SELECT } from './account-usage-repo.mjs'
import { dbClient } from '../../db/db-client.mjs'
import { fromMicros, rowMicros } from '../../core/money.mjs'

const GATEWAY_ACCOUNT_RESOURCE_SQL = "SELECT id,vendor_id FROM vendor_resources WHERE id=? AND resource_type='account'"

export async function gatewayAccountResource(db, accountResourceId) {
  return dbClient(db).one(GATEWAY_ACCOUNT_RESOURCE_SQL, accountResourceId)
}

const VM_ACCOUNT_RESOURCE_SQL = `SELECT a.id,a.vendor_id FROM vendor_resources a
    JOIN vendor_resources vm ON vm.id=json_extract(a.config_json,'$.vm_resource_id') AND vm.vendor_id=a.vendor_id
    WHERE a.resource_type='account' AND vm.resource_type='vm'
      AND json_extract(vm.config_json,'$.runtime_vm_id')=? LIMIT 1`

export async function vmAccountResource(db, vmId) {
  return dbClient(db).one(VM_ACCOUNT_RESOURCE_SQL, vmId)
}

const INSERT_USAGE_FACT_SQL = `INSERT OR IGNORE INTO vendor_usage_facts
      (id,vendor_id,resource_id,model,input_tokens,output_tokens,cost_usd,occurred_at,source_request_id,created_at,cache_read_tokens,cache_creation_tokens,execution_kind,gateway_instance_id,dispatch_id,receipt_id,usage_confidence,cost_usd_micros)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`

// 金额（M6）：整数微单位是权威值，cost_usd 是由它派生的 REAL 镜像
const factMicros = (row) => Math.max(0, rowMicros(row, 'total_cost') || 0)

const usageFactParams = (row, resource, { id, createdAt }) => [
  id,
  resource.vendor_id,
  resource.id,
  row.model,
  // 供应商事实记上游原始消耗（118：主列是客户计费口径，不同时原始值在 upstream_*）
  (row.upstream_input_tokens ?? row.input_tokens) || 0,
  row.output_tokens || 0,
  fromMicros(factMicros(row)),
  row.created_at,
  row.request_id,
  createdAt,
  row.upstream_cache_read_tokens ?? row.cache_read_tokens ?? null,
  row.upstream_cache_creation_tokens ?? row.cache_creation_tokens ?? null,
  row.execution_kind || null,
  row.gateway_instance_id || null,
  row.dispatch_id || null,
  row.receipt_id || null,
  row.usage_confidence || null,
  factMicros(row),
]

/**
 * 供应商用量事实的计入口径（SQL 版，供每日对账 `admin/billing-reconcile.mjs` 核对“该有事实的使用记录”）：
 * 与写入方 `vendor-usage.mjs` 的 `usageFactOwner` 与本文件的 `gatewayAccountResource` / `vmAccountResource` 同一口径，
 * 两边必须一起改（审计阶段 2 W10 调整供应商结算口径时从这里改）。`l` 为 usage_logs 的别名。
 */
export function vendorFactEligibleSql(l = 'l') {
  return `COALESCE(${l}.pricing_model,'')<>'unpriced' AND COALESCE(${l}.request_id,'')<>''
    AND ${l}.status>=200 AND ${l}.status<300 AND ${l}.total_cost IS NOT NULL
    AND ${l}.billing_status='settled' AND COALESCE(${l}.actual_cost_micros,0)>0`
}

/**
 * 使用记录归属的供应商账号资源 ID（无归属为 NULL）：Gateway 记录按 account_resource_id，其余按 VM 绑定。
 * VM 绑定可能在请求之后才建立或改过：只认请求时刻已存在的绑定（两条资源的 updated_at 都不晚于请求），避免把改绑前的记录算成漏记。
 */
export function vendorFactOwnerSql(l = 'l') {
  return `CASE WHEN ${l}.execution_kind='gateway_worker' AND ${l}.account_resource_id IS NOT NULL
    THEN (SELECT id FROM vendor_resources WHERE id=${l}.account_resource_id AND resource_type='account')
    WHEN COALESCE(${l}.vm_id,'')<>'' THEN (SELECT a.id FROM vendor_resources a
      JOIN vendor_resources vm ON vm.id=json_extract(a.config_json,'$.vm_resource_id') AND vm.vendor_id=a.vendor_id
      WHERE a.resource_type='account' AND vm.resource_type='vm' AND json_extract(vm.config_json,'$.runtime_vm_id')=${l}.vm_id
        AND a.updated_at<=${l}.created_at AND vm.updated_at<=${l}.created_at LIMIT 1) END`
}

/**
 * 由使用记录写一条供应商用量事实（Gateway 与 VM 共用；同一请求重复写入时忽略）。
 * resource 为该请求归属的供应商账号资源 `{ id, vendor_id }`。
 */
export async function insertUsageFact(db, row, resource, meta) {
  return dbClient(db).run(INSERT_USAGE_FACT_SQL, ...usageFactParams(row, resource, meta))
}

/** 供应商用量视图的公共 CTE 与参数；结果与原 vendorUsage 内联拼接逐字一致。 */
export function supplierUsageSource(ids, period, query) {
  const vendors = ids.map(() => '?').join(',') || 'NULL'
  // A row's vendor comes from its VM link or its retained fact, so this index-backed superset
  // keeps every row the outer vendor filter accepts without joining the whole usage_logs table.
  const scope = `(u.vm_id IN (SELECT json_extract(config_json,'$.runtime_vm_id') FROM vendor_resources
      WHERE resource_type='vm' AND vendor_id IN (${vendors}))
    OR u.request_id IN (SELECT source_request_id FROM vendor_usage_facts WHERE vendor_id IN (${vendors})))`
  // A retained fact's vendor is its own vendor_id, so this facts scope is exact.
  const factsScope = `f.vendor_id IN (${vendors}) AND f.occurred_at>=? AND f.occurred_at<?`
  const params = [...ids, ...ids, ...ids, period.start, period.end, ...ids, period.start, period.end]
  let where = `vendor_id IN (${vendors}) AND created_at>=? AND created_at<?`
  if (query.resource_id) {
    where += ' AND account_resource_id=?'
    params.push(String(query.resource_id))
  }
  if (query.model) {
    where += ' AND model=?'
    params.push(String(query.model))
  }
  const from = `WITH supplier_usage AS MATERIALIZED (SELECT * FROM (${vendorAccountLogs(scope, factsScope)}) WHERE ${where})`
  return { from, params }
}

// 汇总、账号、每日三种聚合共用一次物化的 supplier_usage：联表 CTE 只执行一次（原先每种聚合各跑一遍）。
// 各分支列序一致：kind、date、vendor_id、resource_id、聚合列、账号展示列；调用方按 kind 拆分并排序。
export async function supplierUsageReportRows(db, source) {
  const { from, params } = source
  const names = 'NULL AS vendor_name,NULL AS account_name,NULL AS resource_status,NULL AS platform'
  return dbClient(db).many(
    `${from}
    SELECT 'summary' AS kind,NULL AS date,NULL AS vendor_id,NULL AS resource_id,${VENDOR_USAGE_SELECT},${names}
      FROM supplier_usage
    UNION ALL
    SELECT 'account',NULL,u.*,v.name,a.name,a.status,json_extract(a.config_json,'$.platform')
    FROM (SELECT vendor_id,account_resource_id AS resource_id,${VENDOR_USAGE_SELECT}
      FROM supplier_usage GROUP BY vendor_id,account_resource_id) u
    LEFT JOIN vendors v ON v.id=u.vendor_id LEFT JOIN vendor_resources a ON a.id=u.resource_id
    UNION ALL
    SELECT 'trend',strftime('%Y-%m-%d',created_at,'+8 hours'),NULL,NULL,${VENDOR_USAGE_SELECT},${names}
      FROM supplier_usage GROUP BY 2`,
    ...params,
  )
}
