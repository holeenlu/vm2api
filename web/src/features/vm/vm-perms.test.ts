import type { MeResponse, ResourcePermission } from '@/types/panel-auth'
import { describe, expect, it } from 'vitest'
import {
  pickBindTarget,
  visibleTab,
  vmDetailTabs,
  vmPermsFor,
} from './vm-perms'

const ALL: ResourcePermission[] = [
  'resources.read',
  'resources.create',
  'resources.edit',
  'resources.manage',
]
const me = (
  role: MeResponse['role'],
  resource_permissions: ResourcePermission[] = []
): MeResponse => ({ user: 'u', role, resource_permissions })

describe('vmPermsFor follows server-provided resource permissions', () => {
  it('super admin receives every level from the server', () => {
    expect(vmPermsFor(me('super_admin', ALL))).toEqual({
      known: true,
      read: true,
      create: true,
      edit: true,
      manage: true,
      dashboard: true,
    })
  })

  it('a granted admin gets exactly the grant, never the platform dashboard', () => {
    const p = vmPermsFor(me('admin', ['resources.read', 'resources.edit']))
    expect(p).toEqual({
      known: true,
      read: true,
      create: false,
      edit: true,
      manage: false,
      dashboard: false,
    })
  })

  it('customer and ungranted admin have no resource privileges', () => {
    for (const role of ['user', 'admin'] as const) {
      const p = vmPermsFor(me(role))
      expect(p.known).toBe(true)
      expect([p.read, p.create, p.edit, p.manage, p.dashboard]).toEqual([
        false,
        false,
        false,
        false,
        false,
      ])
    }
  })

  it('me still loading grants nothing so no 403 is fired', () => {
    for (const value of [undefined, null]) {
      expect(Object.values(vmPermsFor(value)).every((v) => v === false)).toBe(
        true
      )
    }
  })
})

describe('vmDetailTabs', () => {
  it('test needs edit; ops and seed need manage', () => {
    expect(vmDetailTabs(vmPermsFor(me('super_admin', ALL)))).toEqual([
      'overview',
      'account',
      'proxy',
      'test',
      'ops',
      'seed',
    ])
    expect(
      vmDetailTabs(
        vmPermsFor(me('admin', ['resources.read', 'resources.edit']))
      )
    ).toEqual(['overview', 'account', 'proxy', 'test'])
    expect(vmDetailTabs(vmPermsFor(me('admin', ['resources.read'])))).toEqual([
      'overview',
      'account',
      'proxy',
    ])
    expect(vmDetailTabs(vmPermsFor(me('user')))).toEqual([])
  })

  it('falls back to overview when the remembered tab is hidden', () => {
    const tabs = vmDetailTabs(vmPermsFor(me('admin', ['resources.read'])))
    expect(visibleTab('ops', tabs)).toBe('overview')
    expect(visibleTab('seed', tabs)).toBe('overview')
    expect(visibleTab('test', tabs)).toBe('overview')
    expect(visibleTab('proxy', tabs)).toBe('proxy')
  })
})

describe('pickBindTarget', () => {
  const free = [{ id: 'px-local' }, { id: 'px-2' }]

  it('keeps a still-offered pick', () => {
    expect(pickBindTarget('px-2', free)).toBe('px-2')
  })

  it('falls back to the first candidate when the pick left the list', () => {
    expect(pickBindTarget('px-old', free)).toBe('px-local')
    expect(pickBindTarget('', free)).toBe('px-local')
  })

  it('returns empty when nothing can be bound', () => {
    expect(pickBindTarget('px-old', [])).toBe('')
    expect(pickBindTarget('', [{ id: null }])).toBe('')
  })
})
