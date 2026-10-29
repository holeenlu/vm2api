import { describe, it, expect } from 'vitest'
import {
  allowedViews,
  accountSummary,
  filterAccounts,
  money,
  type Vendor,
  type Resource,
  type Telemetry,
} from './portal-model'

const vendor: Vendor = {
  id: 'a',
  name: 'A',
  tier: 1,
  child_limit: 0,
  account_limit: 0,
  proxy_limit: 0,
  views: ['vendors'],
  capabilities: ['vendor.create_child', 'vendor.usage.read'],
}
const telemetry: Telemetry = {
  vm_id: null,
  state: 'unauthorized',
  email: null,
  utilization_5h: null,
  utilization_7d: null,
  reset_5h: null,
  reset_7d: null,
  today_cost: null,
  total_cost: null,
  total_tokens: null,
  requests: null,
  cache_hit_rate: null,
  inflight: null,
  max_concurrency: null,
  rpm: null,
}
const resource: Resource = {
  id: '',
  name: '',
  vendor_id: 'a',
  resource_type: 'account',
  created_at: '2026-10-29T00:00:00Z',
  status: 'active',
  config: {},
}
describe('supplier portal scope and data semantics', () => {
  it('requires both capability and tier for all child menus', () => {
    expect(allowedViews(vendor)).toContain('vendors')
    expect(allowedViews({ ...vendor, tier: 2 })).not.toContain('vendors')
    expect(allowedViews({ ...vendor, capabilities: [] })).not.toContain(
      'vendors'
    )
    expect(allowedViews(vendor)).not.toContain('settlements')
    expect(allowedViews({ ...vendor, capabilities: ['vendor.usage.read', 'vendor.settlement.read'] })).toContain('billing')
  })
  it('does not count unauthorised accounts as usable or invent zero costs', () => {
    const rows = [
      {
        ...resource,
        id: 'a',
        name: 'alpha',
        status: 'active',
        config: { platform: 'anthropic' },
        telemetry: { ...telemetry, state: 'unauthorized', total_cost: null },
      },
      {
        ...resource,
        id: 'b',
        name: 'beta',
        status: 'active',
        config: { platform: 'openai' },
        telemetry: { ...telemetry, state: 'available', total_cost: 3 },
      },
    ] satisfies Resource[]
    expect(accountSummary(rows).available).toBe(1)
    expect(accountSummary(rows).reported).toBe(1)
    expect(
      filterAccounts(rows, 'beta', 'openai', 'available').map((r) => r.id)
    ).toEqual(['b'])
    expect(money(null)).toBe('—')
    expect(money(0)).toBe('$0.00')
  })
})
