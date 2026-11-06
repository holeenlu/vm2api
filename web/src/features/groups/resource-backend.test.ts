import { describe, expect, it } from 'vitest'
import { groupBackendKind } from './resource-backend'

const r = (resource_kind: string, resource_id: string) => ({
  resource_kind,
  resource_id,
  priority: 50,
})

describe('groupBackendKind', () => {
  it('treats Gateway Worker accounts as the VM backend', () => {
    expect(
      groupBackendKind([
        r('gateway_worker_account', 'account_a'),
        r('vm', 'vm-03'),
      ])
    ).toBe('vm')
    expect(groupBackendKind([r('gateway_worker_account', 'account_a')])).toBe(
      'vm'
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
