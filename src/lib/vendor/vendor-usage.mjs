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
import { rowMicros } from '../core/money.mjs'

/**
 * 计入供应商用量事实的使用记录：返回归属查询（Gateway 账号或 VM），不计入时返回 null。
 * 每日对账按同一口径的 SQL 版（repos/usage-repo.mjs `vendorFactEligibleSql` / `vendorFactOwnerSql`）核对漏记，改口径时两边一起改。
 * 供应商只按客户已扣费的请求结算（审计阶段 2 W10，用户决定 2026-11-07）：客户取消、免费分组、不计量、待结算的请求
 * 不写事实；Gateway 请求在对账结算完成后补写（receipt-reconciler）。
 */
function usageFactOwner(row) {
  if (row?.pricing_model === 'unpriced') return null
  if (!row?.request_id || row.status < 200 || row.status >= 300 || row.total_cost == null) return null
  if (!customerCharged(row)) return null
  if (row.execution_kind === 'gateway_worker' && row.account_resource_id)
    return { gateway: true, key: row.account_resource_id }
  if (!row?.vm_id) return null
  return { gateway: false, key: row.vm_id }
}
/** 客户已为该请求实际扣费：结算状态为 settled 且实扣金额（整数微单位，权威值）大于 0。 */
export function customerCharged(row) {
  return row?.billing_status === 'settled' && Number(row.actual_cost_micros) > 0
}

const factMeta = () => ({ id: `usage_${crypto.randomUUID()}`, createdAt: new Date().toISOString() })

export async function recordVendorUsage(db, row) {
  const owner = usageFactOwner(row)
  if (!owner) return
  const resource = owner.gateway ? await gatewayAccountResource(db, owner.key) : await vmAccountResource(db, owner.key)
  if (!resource) return
  await insertUsageFact(db, row, resource, factMeta())
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
export async function vendorUsage(db, ids, query = {}) {
  const period = usagePeriod(query)
  const rows = await supplierUsageReportRows(db, supplierUsageSource(ids, period, query))
  const of = (kind) => rows.filter((row) => row.kind === kind)
  const summary = normalizeVendorUsage(of('summary')[0])
  const accounts = of('account')
    .sort((a, b) => (rowMicros(b, 'cost_usd') || 0) - (rowMicros(a, 'cost_usd') || 0))
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
