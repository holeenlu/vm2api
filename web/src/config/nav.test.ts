import { describe, expect, it } from 'vitest'
import { navGroupsFor } from '@/components/layout/data/sidebar-data'
import {
  ROUTE_VIEWS,
  canOpenPath,
  hasPanelView,
  viewForPath,
  type ViewId,
} from './nav'

// Every page file under _authenticated, as the path the router serves.
const PAGE_PATHS = Object.keys(
  import.meta.glob('/src/routes/_authenticated/**/*.tsx')
)
  .map((file) =>
    file.replace('/src/routes/_authenticated', '').replace(/\.tsx$/, '')
  )
  .filter((path) => !path.endsWith('/route'))
  .map((path) => path.replace(/\/index$/, '') || '/')
  .sort()

// Mirror of PANEL_VIEWS / ROLE_VIEWS in src/lib/admin/panel-role-policy.mjs.
const PANEL_VIEWS: ViewId[] = [
  'profile',
  'groups',
  'subscriptions',
  'overview',
  'cluster',
  'vm',
  'import',
  'specs',
  'proxies',
  'models',
  'risk',
  'system',
  'keys',
  'api',
  'anthropic',
  'logs',
  'statistics',
  'database',
  'settings',
  'users',
  'suppliers',
  'wrap',
  'billing',
  'gateway-workers',
  'codex-accounts',
  'supplier-accounts',
]
const ROLE_VIEWS: Record<'super_admin' | 'admin' | 'user', ViewId[]> = {
  super_admin: PANEL_VIEWS,
  admin: ['profile', 'users', 'keys', 'billing', 'logs', 'statistics'],
  user: ['profile', 'keys', 'subscriptions', 'billing', 'logs', 'statistics'],
}

const concrete = (path: string) =>
  path
    .replace('$id', 'vm-01')
    .replace('$tab', 'about')
    .replace('$page', 'suppliers')
const openPages = (views: string[] | null) =>
  PAGE_PATHS.filter((path) => canOpenPath(views, concrete(path)))

describe('route ↔ view table', () => {
  it('finds the page files', () => {
    expect(PAGE_PATHS).toContain('/')
    expect(PAGE_PATHS).toContain('/vm/$id')
    expect(PAGE_PATHS).toContain('/settings/$tab')
    expect(PAGE_PATHS).toContain('/codex-accounts/$id')
    expect(PAGE_PATHS).toContain('/suppliers/$page')
    expect(PAGE_PATHS).not.toContain('/route')
  })

  it('assigns every page under _authenticated to a view', () => {
    expect(
      PAGE_PATHS.filter((path) => viewForPath(path) === undefined)
    ).toEqual([])
  })

  it('has no entry without a page', () => {
    const heads = new Set(PAGE_PATHS.map((path) => `/${path.split('/')[1]}`))
    expect(Object.keys(ROUTE_VIEWS).filter((key) => !heads.has(key))).toEqual(
      []
    )
  })

  it('only names views the backend defines', () => {
    const named = Object.values(ROUTE_VIEWS).filter((view) => view !== null)
    expect(named.filter((view) => !PANEL_VIEWS.includes(view))).toEqual([])
    // supplier-accounts is a sub-page of /suppliers (see viewForPath).
    expect([...new Set([...named, 'supplier-accounts'])].sort()).toEqual(
      [...PANEL_VIEWS].sort()
    )
  })

  it('maps every sidebar link through the same table', () => {
    const urls = navGroupsFor(null).flatMap((group) =>
      group.items.map((item) => String(item.url))
    )
    expect(urls.filter((url) => !viewForPath(url))).toEqual([])
  })
})

describe('nested pages follow their parent view', () => {
  it.each([
    ['/vm/vm-01', 'vm'],
    ['/vm/vm-01?tab=usage', 'vm'],
    ['/vm/', 'vm'],
    ['/settings/about', 'settings'],
    ['/settings/', 'settings'],
    ['/codex-accounts/acc-01', 'codex-accounts'],
    ['/suppliers/settlements', 'suppliers'],
    ['/suppliers/accounts', 'supplier-accounts'],
    ['/suppliers/accounts?vendor_id=all', 'supplier-accounts'],
    ['/', null],
  ] as const)('%s → %s', (path, view) => {
    expect(viewForPath(path)).toBe(view)
  })

  it('leaves unknown paths to the not-found page', () => {
    expect(viewForPath('/nope')).toBeUndefined()
    expect(canOpenPath(ROLE_VIEWS.user, '/nope')).toBe(true)
  })

  it('blocks a child exactly when its parent is blocked', () => {
    for (const views of Object.values(ROLE_VIEWS)) {
      expect(canOpenPath(views, '/vm/vm-01')).toBe(canOpenPath(views, '/vm'))
      expect(canOpenPath(views, '/settings/about')).toBe(
        canOpenPath(views, '/settings')
      )
      expect(canOpenPath(views, '/codex-accounts/acc-01')).toBe(
        canOpenPath(views, '/codex-accounts')
      )
    }
  })
})

describe('pages each role can open', () => {
  it('super_admin opens every page', () => {
    expect(openPages(ROLE_VIEWS.super_admin)).toEqual(PAGE_PATHS)
  })

  it('admin opens its user, key and usage pages only', () => {
    expect(openPages(ROLE_VIEWS.admin)).toEqual([
      '/',
      '/billing',
      '/keys',
      '/logs',
      '/profile',
      '/statistics',
      '/users',
    ])
  })

  it('user opens its tenant pages only', () => {
    expect(openPages(ROLE_VIEWS.user)).toEqual([
      '/',
      '/billing',
      '/keys',
      '/logs',
      '/profile',
      '/statistics',
      '/subscriptions',
    ])
  })

  it('opens only the supplier account pool with the resource grant', () => {
    const views = [
      ...ROLE_VIEWS.admin,
      'vm',
      'codex-accounts',
      'supplier-accounts',
    ]
    expect(canOpenPath(views, '/suppliers/accounts')).toBe(true)
    expect(canOpenPath(views, '/suppliers/settlements')).toBe(false)
    expect(canOpenPath(views, '/vm/vm-01')).toBe(true)
  })

  it('never shows a sidebar link the guard would refuse', () => {
    for (const [role, views] of Object.entries(ROLE_VIEWS)) {
      const shown = navGroupsFor(views, role).flatMap((group) =>
        group.items.map((item) => String(item.url))
      )
      expect(shown.filter((url) => !canOpenPath(views, url))).toEqual([])
    }
  })

  it('treats a missing view list as unrestricted and an empty one as none', () => {
    expect(openPages(null)).toEqual(PAGE_PATHS)
    expect(openPages([])).toEqual(['/'])
    expect(hasPanelView(['/keys'], 'keys')).toBe(true)
  })
})
