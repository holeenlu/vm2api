import { firstAllowedPath } from '@/config/nav'
import { i18n } from '@/i18n'
import { beforeEach, describe, expect, it } from 'vitest'
import { navGroupsFor } from './sidebar-data'

beforeEach(async () => {
  await i18n.changeLanguage('zh-CN')
})

describe('sidebar permissions', () => {
  it('lands each role on an allowed business page without a workbench', () => {
    expect(firstAllowedPath(['profile', 'groups', 'overview', 'users'])).toBe(
      '/overview'
    )
    expect(firstAllowedPath(['profile', 'users', 'billing', 'logs'])).toBe(
      '/users'
    )
    expect(
      firstAllowedPath(['profile', 'groups', 'subscriptions', 'keys'])
    ).toBe('/keys')
    expect(firstAllowedPath(['home'])).toBe('/welcome')
    expect(firstAllowedPath([])).toBe('/welcome')
  })

  it('does not treat an explicit empty view list as unrestricted', () => {
    expect(navGroupsFor([])).toEqual([])
  })

  it('shows only routes named by the panel capability list', () => {
    const groups = navGroupsFor(['overview', 'logs'])
    const urls = groups.flatMap((group) => group.items.map((item) => item.url))

    expect(urls).toEqual(['/overview', '/logs'])
  })

  it('renders exactly two admin sections with distinct personal links', () => {
    const groups = navGroupsFor(
      ['users', 'statistics', 'logs', 'billing', 'keys'],
      'admin'
    )
    expect(groups.map((group) => group.title)).toEqual(['', '我的账户'])
    expect(groups.map((group) => group.items.map((item) => item.url))).toEqual([
      ['/statistics', '/logs', '/users', '/billing'],
      ['/keys?scope=mine', '/logs?scope=mine'],
    ])
  })

  it('does not add duplicate links or empty account sections for users', () => {
    const groups = navGroupsFor(
      ['statistics', 'keys', 'logs', 'billing'],
      'user'
    )
    expect(
      groups.flatMap((group) => group.items.map((item) => item.url))
    ).toEqual(['/statistics', '/billing', '/keys', '/logs'])
    expect(groups).toHaveLength(1)
    expect(groups[0].title).toBe('')
    expect(
      navGroupsFor(['users'], 'admin').map((group) => group.title)
    ).toEqual([''])
    expect(navGroupsFor(['/keys'], 'admin')[0].items[0].url).toBe(
      '/keys?scope=mine'
    )
  })

  it('keeps the monitoring pages together in hub order', () => {
    // A stale `usage` capability from an older server must not resurrect the removed page.
    const groups = navGroupsFor([
      'usage',
      'home',
      'logs',
      'statistics',
      'overview',
      'vm',
    ])

    expect(groups[0].title).toBe('运营管理')
    expect(groups[0].items.map((item) => item.url)).toEqual([
      '/overview',
      '/statistics',
      '/logs',
    ])
    expect(groups[1].items.map((item) => item.url)).toEqual(['/vm'])
  })
})
