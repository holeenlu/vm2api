import { SYSTEM_TIMEZONE, systemDateTimeToIso } from '../../shared/system-time.mjs'
import crypto from 'node:crypto'
import { VendorError } from './vendor-platform.mjs'

import { normalizeVendorUsage } from './vendor-account-usage.mjs'
import {
  gatewayAccountResource,
  insertUsageFact,
  supplierUsageReportRows,
  supplierUsageSource,
  vmAccountResource,
} from './repos/usage-repo.mjs'

export function recordVendorUsage(db, row) {
  if (row?.pricing_model === 'unpriced') return
  if (!row?.request_id || row.status < 200 || row.status >= 300 || row.total_cost == null) return
  if (row.execution_kind === 'gateway_worker' && row.account_resource_id) {
    const resource = gatewayAccountResource(db, row.account_resource_id)
    if (!resource) return
    insertUsageFact(db, row, resource, { id: `usage_${crypto.randomUUID()}`, createdAt: new Date().toISOString() })
    return
  }
  if (!row?.vm_id) return
  const resource = vmAccountResource(db, row.vm_id)
  if (!resource) return
  insertUsageFact(db, row, resource, { id: `usage_${crypto.randomUUID()}`, createdAt: new Date().toISOString() })
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
  const rows = supplierUsageReportRows(db, supplierUsageSource(ids, period, query))
  const of = (kind) => rows.filter((row) => row.kind === kind)
  const summary = normalizeVendorUsage(of('summary')[0])
  const accounts = of('account')
    .sort((a, b) => b.cost_usd - a.cost_usd)
    .map(({ kind, date, ...row }) => ({ ...row, ...normalizeVendorUsage(row) }))
  const trend = of('trend')
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .map((row) => ({ date: row.date, ...normalizeVendorUsage(row) }))
  return {
    period,
    summary: { ...summary, source: 'supplier_request_usage' },
    accounts,
    trend,
    dimensions: ['vendor', 'account', 'date'],
  }
}
