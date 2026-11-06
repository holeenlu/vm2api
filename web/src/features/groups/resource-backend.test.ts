import { describe, expect, it } from 'vitest'
import { groupBackendKind, mixesBackends } from './resource-backend'

const r = (resource_kind: string, resource_id: string) => ({
  resource_kind,
  resource_id,
  priority: 50,
})

describe('groupBackendKind', () => {
  it('treats VMs and Codex (Gateway) accounts as one account pool', () => {
    expect(
      groupBackendKind([
        r('gateway_worker_account', 'account_a'),
        r('vm', 'vm-03'),
      ])
    ).toBe('pool')
    expect(groupBackendKind([r('gateway_worker_account', 'account_a')])).toBe(
      'pool'
    )
  })

  it('keeps API endpoint groups on the API backend', () => {
    expect(groupBackendKind([r('api_endpoint', 'ep_1')])).toBe('api_endpoint')
  })

  it('leaves empty groups unlocked', () => {
    expect(groupBackendKind([])).toBeUndefined()
    expect(groupBackendKind(undefined)).toBeUndefined()
  })
})

describe('mixesBackends', () => {
  it('allows VMs with Codex accounts but not with API endpoints', () => {
    expect(
      mixesBackends({
        vm: ['vm-1'],
        gateway_worker_account: ['a'],
        api_endpoint: [],
      })
    ).toBe(false)
    expect(
      mixesBackends({
        vm: [],
        gateway_worker_account: ['a'],
        api_endpoint: ['ep'],
      })
    ).toBe(true)
    expect(
      mixesBackends({
        vm: [],
        gateway_worker_account: [],
        api_endpoint: ['ep'],
      })
    ).toBe(false)
  })
})
