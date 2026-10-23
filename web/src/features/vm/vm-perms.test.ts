import { describe, expect, it } from 'vitest'
import {
  pickBindTarget,
  visibleTab,
  vmDetailTabs,
  vmPermsFor,
} from './vm-perms'

describe('vmPermsFor follows panel-acl roles', () => {
  it('admin can do everything', () => {
    expect(vmPermsFor('admin')).toEqual({
      known: true,
      admin: true,
      dashboard: true,
      power: true,
      test: true,
      testModels: true,
      credential: true,
      remove: true,
    })
  })

  it('customer has no infrastructure privileges', () => {
    const p = vmPermsFor('user')
    expect(p.known).toBe(true)
    expect(p.admin).toBe(false)
    expect(p.dashboard).toBe(false)
    expect(p.power).toBe(false)
    expect(p.test).toBe(false)
    // The backend only serves GET /api/panel/test-models to admins.
    expect(p.testModels).toBe(false)
    expect(p.credential).toBe(false)
    expect(p.remove).toBe(false)
  })

  it('super maintains resources without administrator-only powers', () => {
    const p = vmPermsFor('super')
    expect(p).toMatchObject({
      known: true,
      admin: false,
      dashboard: true,
      power: true,
      test: true,
      credential: true,
      remove: true,
    })
  })

  it('unknown role (me still loading) grants nothing so no 403 is fired', () => {
    for (const role of [undefined, null, '', 'root']) {
      expect(Object.values(vmPermsFor(role)).every((v) => v === false)).toBe(
        true
      )
    }
  })
})

describe('vmDetailTabs', () => {
  it('ops and seed are admin only; test needs test permission', () => {
    expect(vmDetailTabs(vmPermsFor('admin'))).toEqual([
      'overview',
      'account',
      'proxy',
      'test',
      'ops',
      'seed',
    ])
    expect(vmDetailTabs(vmPermsFor('user'))).toEqual([])
    expect(vmDetailTabs(vmPermsFor('super'))).toEqual([
      'overview',
      'account',
      'proxy',
      'test',
    ])
  })

  it('falls back to overview when the remembered tab is hidden', () => {
    const tabs = vmDetailTabs(vmPermsFor('user'))
    expect(visibleTab('ops', tabs)).toBe('overview')
    expect(visibleTab('seed', tabs)).toBe('overview')
    expect(visibleTab('test', tabs)).toBe('overview')
    expect(visibleTab('proxy', tabs)).toBe('overview')
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
