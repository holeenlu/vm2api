import crypto from 'node:crypto'
import { VendorError } from './vendor-platform.mjs'

// Both consoles use the same immutable request facts. Retained pre-upgrade logs
// remain readable without rewriting history or counting a recorded fact twice.
export const VENDOR_USAGE_SOURCE = `
  SELECT f.vendor_id,f.resource_id,f.model,f.input_tokens,f.output_tokens,f.cost_usd,f.occurred_at,f.source_request_id
  FROM vendor_usage_facts f
  UNION ALL
  SELECT a.vendor_id,a.id,u.model,u.input_tokens,u.output_tokens,COALESCE(u.total_cost,0),u.created_at,u.request_id
  FROM usage_logs u
  JOIN vendor_resources vm ON vm.resource_type='vm' AND json_extract(vm.config_json,'$.runtime_vm_id')=u.vm_id
  JOIN vendor_resources a ON a.resource_type='account' AND a.vendor_id=vm.vendor_id
    AND json_extract(a.config_json,'$.vm_resource_id')=vm.id
  WHERE u.status>=200 AND u.status<300 AND u.total_cost IS NOT NULL AND COALESCE(u.pricing_model,'')<>'unpriced'
    AND NOT EXISTS (SELECT 1 FROM vendor_usage_facts f WHERE f.source_request_id=u.request_id)
`

export function recordVendorUsage(db, row) {
  if (row?.pricing_model === 'unpriced') return
  if (!row?.vm_id || !row.request_id || row.status < 200 || row.status >= 300 || row.total_cost == null) return
  const resource = db
    .prepare(`SELECT a.id,a.vendor_id FROM vendor_resources a
    JOIN vendor_resources vm ON vm.id=json_extract(a.config_json,'$.vm_resource_id') AND vm.vendor_id=a.vendor_id
    WHERE a.resource_type='account' AND vm.resource_type='vm'
      AND json_extract(vm.config_json,'$.runtime_vm_id')=? LIMIT 1`)
    .get(row.vm_id)
  if (!resource) return
  db.prepare(`INSERT OR IGNORE INTO vendor_usage_facts
    (id,vendor_id,resource_id,model,input_tokens,output_tokens,cost_usd,occurred_at,source_request_id,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    `usage_${crypto.randomUUID()}`,
    resource.vendor_id,
    resource.id,
    row.model,
    row.input_tokens || 0,
    row.output_tokens || 0,
    Math.max(0, Number(row.total_cost)),
    row.created_at,
    row.request_id,
    new Date().toISOString(),
  )
}

export function usagePeriod(query = {}) {
  const parse = (value, fallback) => {
    if (!value) return fallback
    const text = String(value)
    if (!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(text) || !Number.isFinite(Date.parse(text)))
      throw new VendorError('invalid_period', '日期范围无效')
    const result = new Date(text).toISOString()
    if (result.slice(0, 10) !== text.slice(0, 10) && text.length === 10)
      throw new VendorError('invalid_period', '日期范围无效')
    return result
  }
  const start = parse(query.start_date, new Date(Date.now() - 7 * 86400000).toISOString())
  const end = parse(query.end_date, new Date().toISOString())
  if (start >= end) throw new VendorError('invalid_period', '结束时间必须晚于开始时间')
  return { start, end }
}

export function vendorUsage(db, ids, query = {}) {
  const period = usagePeriod(query)
  const params = [...ids, period.start, period.end]
  let where = `u.vendor_id IN (${ids.map(() => '?').join(',') || 'NULL'}) AND u.occurred_at>=? AND u.occurred_at<?`
  if (query.resource_id) {
    where += ' AND u.resource_id=?'
    params.push(String(query.resource_id))
  }
  if (query.model) {
    where += ' AND u.model=?'
    params.push(String(query.model))
  }
  const from = `WITH supplier_usage AS (${VENDOR_USAGE_SOURCE})`
  const sums = `COUNT(*) AS requests,COALESCE(SUM(u.input_tokens),0) AS input_tokens,
    COALESCE(SUM(u.output_tokens),0) AS output_tokens,COALESCE(SUM(u.cost_usd),0) AS cost_usd`
  const summary = db.prepare(`${from} SELECT ${sums} FROM supplier_usage u WHERE ${where}`).get(...params)
  const accounts = db
    .prepare(`${from} SELECT u.vendor_id,v.name AS vendor_name,u.resource_id,a.name AS account_name,
    u.model,${sums} FROM supplier_usage u LEFT JOIN vendors v ON v.id=u.vendor_id
    LEFT JOIN vendor_resources a ON a.id=u.resource_id WHERE ${where}
    GROUP BY u.vendor_id,u.resource_id,u.model ORDER BY cost_usd DESC`)
    .all(...params)
  const trend = db
    .prepare(`${from} SELECT substr(u.occurred_at,1,10) AS date,${sums}
    FROM supplier_usage u WHERE ${where} GROUP BY substr(u.occurred_at,1,10) ORDER BY date`)
    .all(...params)
  const unpriced = db
    .prepare(`SELECT COUNT(*) AS n FROM usage_logs u
    JOIN vendor_resources vm ON vm.resource_type='vm' AND json_extract(vm.config_json,'$.runtime_vm_id')=u.vm_id
    JOIN vendor_resources a ON a.resource_type='account' AND a.vendor_id=vm.vendor_id AND json_extract(a.config_json,'$.vm_resource_id')=vm.id
    WHERE a.vendor_id IN (${ids.map(() => '?').join(',') || 'NULL'}) AND u.created_at>=? AND u.created_at<?
      AND u.status>=200 AND u.status<300 AND (u.total_cost IS NULL OR u.pricing_model='unpriced')
      ${query.resource_id ? 'AND a.id=?' : ''} ${query.model ? 'AND u.model=?' : ''}`)
    .get(...params).n
  return {
    period,
    summary: { ...summary, unpriced_requests: unpriced, source: 'supplier_request_usage' },
    accounts,
    trend,
    dimensions: ['vendor', 'account', 'date', 'model'],
  }
}
