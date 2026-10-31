import { SYSTEM_TIMEZONE, systemDateTimeToIso } from '../../shared/system-time.mjs'
import crypto from 'node:crypto'
import { VendorError } from './vendor-platform.mjs'

import { VENDOR_ACCOUNT_LOGS, VENDOR_USAGE_SELECT, normalizeVendorUsage } from './vendor-account-usage.mjs'

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
    (id,vendor_id,resource_id,model,input_tokens,output_tokens,cost_usd,occurred_at,source_request_id,created_at,cache_read_tokens,cache_creation_tokens)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
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
    row.cache_read_tokens ?? null,
    row.cache_creation_tokens ?? null,
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
    return systemDateTimeToIso(text)
  }
  const start = parse(query.start_date, new Date(Date.now() - 7 * 86400000).toISOString())
  const end = parse(query.end_date, new Date().toISOString())
  if (start >= end) throw new VendorError('invalid_period', '结束时间必须晚于开始时间')
  return { start, end, timezone: SYSTEM_TIMEZONE }
}

// Operations and supplier views share request inclusion, cache completeness and costs.
// Settlement pricing remains on its dedicated immutable pricing projection.
export function vendorUsage(db, ids, query = {}) {
  const period = usagePeriod(query)
  const params = [...ids, period.start, period.end]
  let where = `vendor_id IN (${ids.map(() => '?').join(',') || 'NULL'}) AND created_at>=? AND created_at<?`
  if (query.resource_id) {
    where += ' AND account_resource_id=?'
    params.push(String(query.resource_id))
  }
  if (query.model) {
    where += ' AND model=?'
    params.push(String(query.model))
  }
  const from = `WITH supplier_usage AS (SELECT * FROM (${VENDOR_ACCOUNT_LOGS}) WHERE ${where})`
  const summary = normalizeVendorUsage(
    db.prepare(`${from} SELECT ${VENDOR_USAGE_SELECT} FROM supplier_usage`).get(...params),
  )
  const accounts = db
    .prepare(`${from} SELECT u.*,v.name AS vendor_name,a.name AS account_name,json_extract(a.config_json,'$.platform') AS platform
    FROM (SELECT vendor_id,account_resource_id AS resource_id,model,${VENDOR_USAGE_SELECT}
      FROM supplier_usage GROUP BY vendor_id,account_resource_id,model) u
    LEFT JOIN vendors v ON v.id=u.vendor_id LEFT JOIN vendor_resources a ON a.id=u.resource_id
    ORDER BY cost_usd DESC`)
    .all(...params)
    .map((row) => ({ ...row, ...normalizeVendorUsage(row) }))
  const trend = db
    .prepare(`${from} SELECT strftime('%Y-%m-%d',created_at,'+8 hours') AS date,${VENDOR_USAGE_SELECT}
    FROM supplier_usage GROUP BY date ORDER BY date`)
    .all(...params)
    .map((row) => ({ date: row.date, ...normalizeVendorUsage(row) }))
  return {
    period,
    summary: { ...summary, source: 'supplier_request_usage' },
    accounts,
    trend,
    dimensions: ['vendor', 'account', 'date', 'model'],
  }
}
