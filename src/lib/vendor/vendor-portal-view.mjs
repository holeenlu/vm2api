import crypto from 'node:crypto'
import { VendorError } from './vendor-platform.mjs'

const id = (prefix) => `${prefix}_${crypto.randomUUID()}`

// Explicit supplier projection: never return raw VM, credentials or consumer logs.
export function accountPortalRows(platform, resources, { usageAccounts = [], readVm = () => null } = {}) {
  const usageByVm = new Map(usageAccounts.map((row) => [row.vm_id, row]))
  return resources.map((resource) => {
    const linked = platform.db
      .prepare("SELECT config_json FROM vendor_resources WHERE id=? AND vendor_id=? AND resource_type='vm'")
      .get(resource.config?.vm_resource_id || '', resource.vendor_id)
    const runtimeId = linked ? JSON.parse(linked.config_json).runtime_vm_id : null
    const vm = runtimeId ? readVm(runtimeId) : null
    const usage = usageByVm.get(runtimeId)
    const summary = vm?.summary || null
    const available =
      resource.status === 'active' &&
      summary?.has_token === true &&
      summary?.status === 'running' &&
      vm?.schedulable === true
    return {
      ...resource,
      telemetry: {
        vm_id: runtimeId || null,
        state:
          resource.status === 'paused' || resource.status === 'archived'
            ? resource.status
            : !summary
              ? 'provisioning'
              : !summary.has_token
                ? 'unauthorized'
                : available
                  ? 'available'
                  : 'unavailable',
        utilization_5h: usage?.utilization_5h ?? null,
        reset_5h: usage?.reset_5h ?? null,
        utilization_7d: usage?.utilization_7d ?? null,
        reset_7d: usage?.reset_7d ?? null,
        today_cost: usage?.today_cost ?? null,
        total_cost: usage?.total_cost ?? null,
        requests: usage?.requests ?? null,
        total_tokens: usage?.total_tokens ?? null,
        tokens_in: usage?.tokens_in ?? null,
        tokens_out: usage?.tokens_out ?? null,
        cache_read_tokens: usage?.cache_read_tokens ?? null,
        cache_creation_tokens: usage?.cache_creation_tokens ?? null,
        cache_hit_rate: usage?.cache_hit_rate ?? null,
        inflight: usage?.inflight ?? null,
        max_concurrency: usage?.max_concurrency ?? null,
        rpm: usage?.rpm ?? null,
        max_rpm: usage?.max_rpm ?? null,
        tpm: usage?.total_tokens != null && usage?.requests ? usage.total_tokens : null,
        window_5h_cost: usage?.window_5h_cost ?? null,
        window_7d_cost: usage?.window_7d_cost ?? null,
        window_5h_requests: usage?.window_5h_requests ?? null,
        window_7d_requests: usage?.window_7d_requests ?? null,
        window_5h_tokens: usage?.window_5h_tokens ?? null,
        window_7d_tokens: usage?.window_7d_tokens ?? null,
        near_limit: usage?.near_limit ?? null,
        failure_category: usage?.failure_category ?? null,
        error_message: usage?.error_message ?? null,
        email: usage?.email || null,
      },
    }
  })
}

export function supplierStatements(platform, identity, { payable = false } = {}) {
  platform.requireCapability(identity, 'vendor.settlement.read')
  if (payable) {
    platform.requireCapability(identity, 'vendor.create_child')
    if (identity.vendor.tier !== 1) throw new VendorError('child_vendor_forbidden', '二级供应商没有下游应付', 403)
  }
  return platform.db
    .prepare(
      `SELECT s.id,s.period_start,s.period_end,s.status,s.amount_usdt,s.created_at,
      c.leg,c.version AS contract_version,v.name AS vendor_name
    FROM vendor_settlements s JOIN vendor_contracts c ON c.id=s.contract_id
    LEFT JOIN vendors v ON v.id=c.payee_vendor_id
    WHERE ${payable ? "c.payer_vendor_id=? AND c.leg='l1_to_l2' AND EXISTS (SELECT 1 FROM vendors child WHERE child.id=c.payee_vendor_id AND child.parent_id=c.payer_vendor_id)" : 'c.payee_vendor_id=?'}
    ORDER BY s.created_at DESC`,
    )
    .all(identity.vendor.id)
}

function billingRows(platform, identity, { payable = false } = {}) {
  platform.requireCapability(identity, 'vendor.settlement.read')
  if (payable) {
    platform.requireCapability(identity, 'vendor.create_child')
    if (identity.vendor.tier !== 1) throw new VendorError('child_vendor_forbidden', '二级供应商没有下游结算权限', 403)
  }
  const edge = payable
    ? "c.payer_vendor_id=? AND c.leg='l1_to_l2' AND v.parent_id=?"
    : "c.payee_vendor_id=? AND c.leg='platform_to_l1'"
  const args = payable ? [identity.vendor.id, identity.vendor.id] : [identity.vendor.id]
  return platform.db
    .prepare(`
    SELECT s.id,s.period_start,s.period_end,s.status,s.amount_usdt,s.created_at,s.updated_at,
      c.leg,c.version AS contract_version,c.price_cny_per_usd,c.fx_cny_per_usdt,c.multiplier,
      v.id AS counterparty_id,v.name AS counterparty_name,v.tier AS counterparty_tier,
      s.usage_snapshot_json
    FROM vendor_settlements s
    JOIN vendor_contracts c ON c.id=s.contract_id
    LEFT JOIN vendors v ON v.id=${payable ? 'c.payee_vendor_id' : 'c.payer_vendor_id'}
    WHERE ${edge}
    ORDER BY s.period_end DESC,s.created_at DESC
  `)
    .all(...args)
    .map((row) => ({
      ...row,
      direction: payable ? 'downstream' : 'upstream',
      usage: (() => {
        try {
          return JSON.parse(row.usage_snapshot_json || '{}')
        } catch {
          return {}
        }
      })(),
    }))
}

export function supplierBilling(platform, identity) {
  return {
    upstream: billingRows(platform, identity),
    downstream:
      identity.vendor.tier === 1 && identity.vendor.capabilities.includes('vendor.create_child')
        ? billingRows(platform, identity, { payable: true })
        : [],
    profile: {
      contact_name: identity.vendor.contact_name,
      settlement_email: identity.vendor.settlement_email,
      binance_id: identity.vendor.binance_id,
      default_price_cny_per_usd: identity.vendor.default_price_cny_per_usd,
      group_prices: identity.vendor.group_prices,
      fx_cny_per_usdt: identity.vendor.fx_cny_per_usdt,
      default_multiplier: identity.vendor.default_multiplier,
      contract_version: identity.vendor.contract_version,
    },
  }
}

export function createDownstreamSettlement(platform, identity, body = {}) {
  platform.requireCapability(identity, 'vendor.settlement.read')
  platform.requireCapability(identity, 'vendor.create_child')
  if (identity.vendor.tier !== 1) throw new VendorError('child_vendor_forbidden', '二级供应商没有下游结算权限', 403)
  const childId = String(body.vendor_id || '')
  const child = platform.vendorRow(childId)
  if (!child || child.parent_id !== identity.vendor.id)
    throw new VendorError('vendor_scope_forbidden', '下游供应商不属于当前范围', 403)
  const start = cleanDate(body.start_date)
  const end = cleanDate(body.end_date)
  if (!start || !end || start >= end) throw new VendorError('invalid_settlement_period', '结算周期无效')
  const contract = platform.db
    .prepare(`
    SELECT * FROM vendor_contracts WHERE leg='l1_to_l2' AND payer_vendor_id=? AND payee_vendor_id=? AND status='active'
    ORDER BY version DESC LIMIT 1
  `)
    .get(identity.vendor.id, childId)
  if (!contract) throw new VendorError('contract_not_found', '下游供应商尚未配置结算合同', 409)
  const usage = platform.db
    .prepare(`
    SELECT COUNT(*) AS requests,COALESCE(SUM(input_tokens),0) AS input_tokens,
      COALESCE(SUM(output_tokens),0) AS output_tokens,COALESCE(SUM(cost_usd),0) AS cost_usd
    FROM vendor_usage_facts WHERE vendor_id=? AND occurred_at>=? AND occurred_at<?
  `)
    .get(childId, start, end)
  const amount =
    (Number(usage.cost_usd || 0) * Number(contract.price_cny_per_usd) * Number(contract.multiplier)) /
    Number(contract.fx_cny_per_usdt)
  const settlementId = id('settlement')
  const stamp = new Date().toISOString()
  platform.db
    .prepare(`
    INSERT INTO vendor_settlements
      (id,contract_id,period_start,period_end,status,amount_usdt,usage_snapshot_json,created_by,created_at,updated_at)
    VALUES (?,?,?,?, 'review', ?, ?, ?, ?, ?)
  `)
    .run(
      settlementId,
      contract.id,
      start,
      end,
      amount,
      JSON.stringify({ ...usage, amount_usdt: amount, source: 'vendor_usage_facts' }),
      identity.user_id,
      stamp,
      stamp,
    )
  platform.audit({
    actorUserId: identity.user_id,
    vendorId: identity.vendor.id,
    action: 'settlement.downstream_created',
    resourceType: 'settlement',
    resourceId: settlementId,
    payload: { child_vendor_id: childId, start_date: start, end_date: end },
  })
  return platform.db.prepare('SELECT * FROM vendor_settlements WHERE id=?').get(settlementId)
}

export function supplierUsage(platform, identity, { usageAccounts = [], query = {} } = {}) {
  platform.requireCapability(identity, 'vendor.usage.read')
  const start = cleanDate(query.start_date) || new Date(Date.now() - 7 * 86400000).toISOString()
  const end = cleanDate(query.end_date) || new Date().toISOString()
  const scope = platform.visibleVendorIds(identity, { aggregate: query.vendor_id === 'all' })
  const vendorId = query.vendor_id && query.vendor_id !== 'all' ? String(query.vendor_id) : null
  const ids = vendorId && scope.includes(vendorId) ? [vendorId] : scope
  const placeholders = ids.map(() => '?').join(',')
  const summary = platform.db
    .prepare(`
    SELECT COUNT(*) AS requests,COALESCE(SUM(input_tokens),0) AS input_tokens,
      COALESCE(SUM(output_tokens),0) AS output_tokens,COALESCE(SUM(cost_usd),0) AS cost_usd
    FROM vendor_usage_facts WHERE vendor_id IN (${placeholders}) AND occurred_at>=? AND occurred_at<?
  `)
    .get(...ids, start, end)
  const accounts = platform.db
    .prepare(`
    SELECT vendor_id,resource_id,model,COUNT(*) AS requests,COALESCE(SUM(input_tokens),0) AS input_tokens,
      COALESCE(SUM(output_tokens),0) AS output_tokens,COALESCE(SUM(cost_usd),0) AS cost_usd
    FROM vendor_usage_facts WHERE vendor_id IN (${placeholders}) AND occurred_at>=? AND occurred_at<?
    GROUP BY vendor_id,resource_id,model ORDER BY cost_usd DESC
  `)
    .all(...ids, start, end)
  const trend = platform.db
    .prepare(`
    SELECT substr(occurred_at,1,10) AS date,COUNT(*) AS requests,
      COALESCE(SUM(input_tokens),0) AS input_tokens,COALESCE(SUM(output_tokens),0) AS output_tokens,
      COALESCE(SUM(cost_usd),0) AS cost_usd
    FROM vendor_usage_facts WHERE vendor_id IN (${placeholders}) AND occurred_at>=? AND occurred_at<?
    GROUP BY substr(occurred_at,1,10) ORDER BY date
  `)
    .all(...ids, start, end)
  const runtimeVendors = new Map()
  platform.db
    .prepare("SELECT vendor_id,config_json FROM vendor_resources WHERE resource_type='account'")
    .all()
    .forEach((row) => {
      const config = (() => {
        try {
          return JSON.parse(row.config_json || '{}')
        } catch {
          return {}
        }
      })()
      const vm = config.vm_resource_id
        ? platform.db
            .prepare("SELECT config_json FROM vendor_resources WHERE id=? AND resource_type='vm'")
            .get(config.vm_resource_id)
        : null
      const vmConfig = (() => {
        try {
          return JSON.parse(vm?.config_json || '{}')
        } catch {
          return {}
        }
      })()
      if (vmConfig.runtime_vm_id) runtimeVendors.set(String(vmConfig.runtime_vm_id), String(row.vendor_id))
    })
  const live = usageAccounts
    .map((row) => ({ row, vendorId: runtimeVendors.get(String(row.vm_id || row.account_id || '')) }))
    .filter(({ vendorId }) => vendorId && ids.includes(vendorId))
    .map(({ row, vendorId }) => ({
      vendor_id: vendorId,
      resource_id: row.vm_id || row.account_id,
      model: null,
      requests: row.requests ?? null,
      input_tokens: row.tokens_in ?? null,
      output_tokens: row.tokens_out ?? null,
      cost_usd: row.total_cost ?? null,
    }))
  const liveSummary = live.reduce(
    (sum, row) => ({
      requests: (sum.requests || 0) + (row.requests || 0),
      input_tokens: (sum.input_tokens || 0) + (row.input_tokens || 0),
      output_tokens: (sum.output_tokens || 0) + (row.output_tokens || 0),
      cost_usd: (sum.cost_usd || 0) + (row.cost_usd || 0),
    }),
    { requests: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 },
  )
  return {
    period: { start, end },
    summary: {
      ...(accounts.length || trend.length ? summary : liveSummary),
      source: accounts.length || trend.length ? 'vendor_usage_facts' : 'live_account_snapshot',
    },
    trend,
    accounts: accounts.length ? accounts : live,
    dimensions: ['vendor', 'account', 'date', 'model', 'request'],
  }
}

function cleanDate(value) {
  const text = String(value || '').trim()
  return /^\d{4}-\d{2}-\d{2}(?:T[^ ]+)?$/.test(text) ? text : ''
}
