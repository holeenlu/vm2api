import { describe, expect, it } from 'vitest'
import { visibleAccountGroups } from './account-create-form'
import type { Vendor } from './portal-model'

const vendor: Vendor = {
  id: 'vendor-1',
  name: 'Supplier',
  tier: 1,
  groups: ['1'],
  views: ['accounts'],
  capabilities: [],
  child_limit: 0,
  account_limit: 0,
  proxy_limit: 0,
}

const groups = [
  {
    id: 1,
    name: 'Claude',
    platform: 'anthropic',
    supported_platforms: ['anthropic'],
  },
  {
    id: 2,
    name: 'Coding',
    platform: 'openai',
    supported_platforms: ['anthropic', 'openai'],
  },
]

describe('supplier account group catalog', () => {
  it('shows only groups granted to the supplier and matching the platform', () => {
    expect(
      visibleAccountGroups(vendor, groups, 'anthropic').map((g) => g.id)
    ).toEqual([1])
    expect(visibleAccountGroups(vendor, groups, 'openai')).toEqual([])
  })

  it('treats an empty grant list as unrestricted for the existing contract', () => {
    expect(
      visibleAccountGroups({ ...vendor, groups: [] }, groups, 'anthropic').map(
        (g) => g.id
      )
    ).toEqual([1, 2])
  })
})
