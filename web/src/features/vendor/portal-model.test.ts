import { describe, it, expect } from 'vitest'
import { editableGroupOptions } from './portal-model'
import {
  allowedViews,
  accountStatusView,
  accountSummary,
  filterAccounts,
  money,
  time,
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
  it('matches the operator status for revoked unschedulable accounts', () => {
    const view = accountStatusView({
      ...resource,
      telemetry: {
        ...telemetry,
        state: 'error',
        schedulable: false,
        credential_state: 'revoked',
        unschedulable_reason: 'oauth_revoked',
      },
    })
    expect(view.schedulable).toBe(false)
    expect(view.unavailable).toBe(true)
    expect(view.primary).toMatch(/Abnormal|异常/)
    expect(view.title).toMatch(/Credential revoked|凭证吊销/)
    expect(view.credential).toMatch(/Revoked|已吊销/)
  })

  it.each([
    ['organization_disabled', /Organization disabled|组织禁用/],
    ['oauth_expired', /Credential expired|凭证过期/],
    ['terms_not_accepted', /Terms not accepted|未接受条款/],
    ['proxy_unavailable', /Proxy unavailable|代理不可用/],
  ])('shows the shared reason for %s', (reason, expected) => {
    const view = accountStatusView({
      ...resource,
      telemetry: {
        ...telemetry,
        state: 'error',
        schedulable: false,
        unschedulable_reason: reason,
      },
    })
    expect(view.primary).toMatch(/Abnormal|异常/)
    expect(view.title).toMatch(expected)
    expect(view.title).not.toMatch(/异常[:：]|error/i)
  })

  it('requires both capability and tier for all child menus', () => {
    expect(allowedViews(vendor)).toContain('vendors')
    expect(allowedViews({ ...vendor, tier: 2 })).not.toContain('vendors')
    expect(allowedViews({ ...vendor, capabilities: [] })).not.toContain(
      'vendors'
    )
    expect(allowedViews(vendor)).not.toContain('settlements')
    expect(allowedViews(vendor)).not.toContain('audit')
    expect(
      allowedViews({
        ...vendor,
        capabilities: ['vendor.usage.read', 'vendor.settlement.read'],
      })
    ).toContain('billing')
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

it('filters groups, auth, dates and failures and classifies all three quota windows', () => {
  const rows: Resource[] = [
    {
      ...resource,
      id: 'x',
      name: 'first',
      created_at: '2026-10-29T10:00:00Z',
      config: { platform: 'anthropic', auth_method: 'oauth' },
      groups: [{ id: 3, name: 'Coding', platform: 'mixed' }],
      telemetry: {
        ...telemetry,
        state: 'error',
        failure_category: 'authentication',
        utilization_5h: 0.1,
        utilization_7d: 0.95,
        has_fable: true,
        utilization_fable: 1,
      },
    },
    {
      ...resource,
      id: 'y',
      name: 'second',
      created_at: '2026-10-28T10:00:00Z',
      config: { platform: 'openai' },
      telemetry: { ...telemetry, state: 'cooling' },
    },
  ]
  expect(
    filterAccounts(rows, '', 'all', 'all', {
      group: '3',
      method: 'oauth',
      failure: 'authentication',
      from: '2026-10-29',
    }).map((r) => r.id)
  ).toEqual(['x'])
  const summary = accountSummary(rows)
  expect(summary.distributions['5h']).toMatchObject({ normal: 1, unknown: 1 })
  expect(summary.distributions['7d']).toMatchObject({ near: 1, unknown: 1 })
  expect(summary.distributions.fable).toMatchObject({ full: 1, total: 1 })
  expect(summary.cooling).toBe(1)
})

describe('supplier telemetry accuracy', () => {
  it('keeps missing TPM unknown and formats epoch reset timestamps consistently', () => {
    const summary = accountSummary([
      {
        ...resource,
        telemetry: { ...telemetry, total_tokens: 100000, requests: 10 },
      },
    ])
    expect(summary.tpm).toBeNull()
    expect(summary.rpm).toBeNull()
    expect(summary.inflight).toBeNull()
    expect(summary.nearLimit).toBeNull()
    expect(time(1793232000)).toBe(time('2026-10-29T00:00:00.000Z'))
    expect(time('1793232000000')).toBe(time(1793232000))
  })
})

it('keeps revoked selected groups removable without allowing them to be selected again', () => {
  const options = editableGroupOptions(
    [
      { id: 1, name: 'revoked', platform: 'anthropic' },
      { id: 2, name: 'old label', platform: 'anthropic' },
    ],
    [
      { id: 2, name: 'current label', platform: 'anthropic' },
      { id: 3, name: 'available', platform: 'anthropic' },
    ]
  )
  expect(options).toEqual([
    { id: 1, name: 'revoked', platform: 'anthropic', available: false },
    { id: 2, name: 'current label', platform: 'anthropic', available: true },
    { id: 3, name: 'available', platform: 'anthropic', available: true },
  ])
})
