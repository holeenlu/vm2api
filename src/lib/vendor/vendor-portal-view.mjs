import { VendorError } from './vendor-platform.mjs'
import { vendorUsage } from './vendor-usage.mjs'
import { createSettlement, settlementPreview, settlementAction } from './vendor-admin.mjs'

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
        tpm: usage?.tpm ?? null,
        window_5h_cost: usage?.window_5h_cost ?? null,
        window_7d_cost: usage?.window_7d_cost ?? null,
        window_5h_requests: usage?.window_5h_requests ?? null,
        window_7d_requests: usage?.window_7d_requests ?? null,
        window_5h_tokens: usage?.window_5h_tokens ?? null,
        window_7d_tokens: usage?.window_7d_tokens ?? null,
        near_limit: usage?.near_limit ?? null,
        failure_category: usage?.failure_category ?? null,

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
  const edge = payable ? "c.payer_vendor_id=? AND c.leg='l1_to_l2' AND v.parent_id=?" : 'c.payee_vendor_id=?'
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
      paid_usdt: platform.db
        .prepare(
          "SELECT COALESCE(SUM(amount_usdt),0) AS n FROM vendor_payments WHERE settlement_id=? AND action='payment'",
        )
        .get(row.id).n,
      payments: platform.db
        .prepare(
          'SELECT id,amount_usdt,action,reason,created_at FROM vendor_payments WHERE settlement_id=? ORDER BY created_at,id',
        )
        .all(row.id),
      direction: payable ? 'downstream' : 'upstream',
      usage: (() => {
        try {
          const snapshot = JSON.parse(row.usage_snapshot_json || '{}')
          return snapshot.usage || snapshot
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

export function createDownstreamSettlement(platform, identity, body = {}, { preview = false } = {}) {
  platform.requireActive(identity)
  platform.requireCapability(identity, 'vendor.settlement.read')
  platform.requireCapability(identity, 'vendor.create_child')
  if (identity.vendor.tier !== 1) throw new VendorError('child_vendor_forbidden', '二级供应商没有下游结算权限', 403)
  const childId = String(body.vendor_id || '')
  const child = platform.vendorRow(childId)
  if (!child || child.parent_id !== identity.vendor.id)
    throw new VendorError('vendor_scope_forbidden', '下游供应商不属于当前范围', 403)
  return preview
    ? settlementPreview(platform, childId, body, identity.vendor.id)
    : createSettlement(platform, childId, body, identity.user_id, identity.vendor.id)
}

export function supplierUsage(platform, identity, { query = {} } = {}) {
  platform.requireCapability(identity, 'vendor.usage.read')
  const ids = platform.resourceScope(identity, query.vendor_id || '')
  return vendorUsage(platform.db, ids, query)
}

export function downstreamSettlementAction(platform, identity, id, action, body) {
  platform.requireActive(identity)
  platform.requireCapability(identity, 'vendor.create_child')
  platform.requireCapability(identity, 'vendor.settlement.pay')
  if (identity.vendor.tier !== 1) throw new VendorError('child_vendor_forbidden', '二级供应商没有下游付款权限', 403)
  const row = platform.db
    .prepare(
      `SELECT c.payer_vendor_id,c.payee_vendor_id FROM vendor_settlements s JOIN vendor_contracts c ON c.id=s.contract_id WHERE s.id=?`,
    )
    .get(id)
  if (
    !row ||
    row.payer_vendor_id !== identity.vendor.id ||
    platform.vendorRow(row.payee_vendor_id)?.parent_id !== identity.vendor.id
  )
    throw new VendorError('settlement_payer_scope', '结算单不属于当前付款方', 403)
  return settlementAction(platform, id, action, body, identity.user_id, identity.vendor.id)
}
