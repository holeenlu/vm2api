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
