// 供应商用量事实与运营用量视图的仓储：SQL 原样自 vendor-usage.mjs 迁入，调用方注入数据库句柄。
import { vendorAccountLogs, VENDOR_USAGE_SELECT } from './account-usage-repo.mjs'

export function gatewayAccountResource(db, accountResourceId) {
  return db
    .prepare("SELECT id,vendor_id FROM vendor_resources WHERE id=? AND resource_type='account'")
    .get(accountResourceId)
}

export function vmAccountResource(db, vmId) {
  return db
    .prepare(`SELECT a.id,a.vendor_id FROM vendor_resources a
    JOIN vendor_resources vm ON vm.id=json_extract(a.config_json,'$.vm_resource_id') AND vm.vendor_id=a.vendor_id
    WHERE a.resource_type='account' AND vm.resource_type='vm'
      AND json_extract(vm.config_json,'$.runtime_vm_id')=? LIMIT 1`)
    .get(vmId)
}

/**
 * 由使用记录写一条供应商用量事实（Gateway 与 VM 共用；同一请求重复写入时忽略）。
 * resource 为该请求归属的供应商账号资源 `{ id, vendor_id }`。
 */
export function insertUsageFact(db, row, resource, { id, createdAt }) {
  return db
    .prepare(`INSERT OR IGNORE INTO vendor_usage_facts
      (id,vendor_id,resource_id,model,input_tokens,output_tokens,cost_usd,occurred_at,source_request_id,created_at,cache_read_tokens,cache_creation_tokens,execution_kind,gateway_instance_id,dispatch_id,receipt_id,usage_confidence)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(
      id,
      resource.vendor_id,
      resource.id,
      row.model,
      row.input_tokens || 0,
      row.output_tokens || 0,
      Math.max(0, Number(row.total_cost)),
      row.created_at,
      row.request_id,
      createdAt,
      row.cache_read_tokens ?? null,
      row.cache_creation_tokens ?? null,
      row.execution_kind || null,
      row.gateway_instance_id || null,
      row.dispatch_id || null,
      row.receipt_id || null,
      row.usage_confidence || null,
    )
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
export function supplierUsageReportRows(db, source) {
  const { from, params } = source
  const names = 'NULL AS vendor_name,NULL AS account_name,NULL AS resource_status,NULL AS platform'
  return db
    .prepare(`${from}
    SELECT 'summary' AS kind,NULL AS date,NULL AS vendor_id,NULL AS resource_id,${VENDOR_USAGE_SELECT},${names}
      FROM supplier_usage
    UNION ALL
    SELECT 'account',NULL,u.*,v.name,a.name,a.status,json_extract(a.config_json,'$.platform')
    FROM (SELECT vendor_id,account_resource_id AS resource_id,${VENDOR_USAGE_SELECT}
      FROM supplier_usage GROUP BY vendor_id,account_resource_id) u
    LEFT JOIN vendors v ON v.id=u.vendor_id LEFT JOIN vendor_resources a ON a.id=u.resource_id
    UNION ALL
    SELECT 'trend',strftime('%Y-%m-%d',created_at,'+8 hours'),NULL,NULL,${VENDOR_USAGE_SELECT},${names}
      FROM supplier_usage GROUP BY 2`)
    .all(...params)
}
