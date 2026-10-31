/**
 * Panel RBAC.
 *
 *   super_admin — SA: full console, VM creation/management, platform settings
 *   admin       — AD: user management + user usage records/statistics
 *   user   — U: own API keys, usage, logs, statistics and billing
 *   vendor — supplier portal identity; no ordinary operator-panel pages
 */

export const PANEL_VIEWS = [
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
]

const ROLE_VIEWS = {
  user: ['profile', 'keys', 'subscriptions', 'billing', 'logs', 'statistics'],
  vendor: [],
  admin: ['profile', 'users', 'keys', 'billing', 'logs', 'statistics'],
  super_admin: PANEL_VIEWS.slice(),
}

const ROLE_CAPS = {
  user: ['panel.read', 'keys.write', 'billing.read', 'usage.own', 'groups.catalog'],
  vendor: ['panel.read', 'vendor.portal'],
  admin: ['panel.read', 'users.read', 'users.write', 'keys.write', 'usage.read', 'billing.read'],
  super_admin: ['*'],
}

export function normalizePanelRole(role) {
  const r = String(role || '')
    .trim()
    .toLowerCase()
  if (r === 'super_admin' || r === 'admin' || r === 'user' || r === 'vendor') return r
  return 'user'
}

export function viewsForRole(role) {
  return (ROLE_VIEWS[normalizePanelRole(role)] || ROLE_VIEWS.user).slice()
}

export function capabilitiesForRole(role) {
  return (ROLE_CAPS[normalizePanelRole(role)] || ROLE_CAPS.user).slice()
}

export function hasCapability(role, cap) {
  const caps = capabilitiesForRole(role)
  return caps.includes('*') || caps.includes(cap)
}

export function canViewPage(role, view) {
  return viewsForRole(role).includes(view)
}

export function panelIdentity(req) {
  if (req?.apiKeyKind === 'master') {
    return { user: 'master', role: 'super_admin', source: 'master_key' }
  }
  return {
    user: req?.panelUser || null,
    role: normalizePanelRole(req?.panelRole || 'user'),
    source: 'session',
  }
}

const USER_EXACT_GET = new Set([
  '/api/panel/me',
  '/api/panel/onboarding',
  '/api/panel/api-keys',
  '/api/panel/request-logs',
  '/api/panel/request-logs/export',
  '/api/panel/request-logs/stats',
  '/api/panel/billing',
  '/api/panel/test-schedule/default',
  '/api/panel/groups',
  '/api/panel/subscriptions',
  '/api/panel/usage-logs/ranking',
])

function isRequestLogPath(path) {
  return (
    path === '/api/panel/request-logs' ||
    path === '/api/panel/request-logs/export' ||
    path === '/api/panel/request-logs/stats' ||
    /^\/api\/panel\/request-logs\/[^/]+$/.test(path) ||
    /^\/api\/panel\/request-logs\/[^/]+\/attempts$/.test(path)
  )
}

/** Scrolling log page + statistics: read-only, owner-scoped server-side for `user`. */
const LOG_STATS_GET = new Set([
  '/api/panel/usage-logs',
  '/api/panel/usage-logs/ranking',
  '/api/panel/usage-logs/summary',
  '/api/panel/usage-logs/filter-options',
  '/api/panel/usage-logs/session-suggestions',
  '/api/panel/usage-logs/active-sessions',
  '/api/panel/usage-logs/overview',
  '/api/panel/statistics',
  '/api/panel/statistics/leaderboard',
])

function userKeyPathAllowed(method, path) {
  if (path === '/api/panel/api-keys') return method === 'GET' || method === 'POST'
  if (/^\/api\/panel\/api-keys\/[^/]+$/.test(path)) return method === 'GET' || method === 'PATCH' || method === 'DELETE'
  if (/^\/api\/panel\/api-keys\/[^/]+\/reveal$/.test(path) && method === 'POST') return true
  if (/^\/api\/panel\/api-keys\/[^/]+\/(stats|connection)$/.test(path) && method === 'GET') return true
  if (/^\/api\/panel\/api-keys\/[^/]+\/reset-quota$/.test(path) && method === 'POST') return true
  // The handler already 404s keys the tenant does not own (denyIfUserMissesKey).
  if (/^\/api\/panel\/api-keys\/[^/]+\/rotate$/.test(path) && method === 'POST') return true
  return false
}

function isUserAllowed(method, path) {
  const m = String(method || 'GET').toUpperCase()
  const p = String(path || '')
  if (m === 'GET' && (USER_EXACT_GET.has(p) || isRequestLogPath(p) || LOG_STATS_GET.has(p))) return true
  if (m === 'GET' && /^\/api\/panel\/groups\/\d+$/.test(p)) return true
  if (m === 'PUT' && p === '/api/panel/onboarding') return true
  if (p.startsWith('/api/panel/api-keys')) return userKeyPathAllowed(m, p)
  return false
}

function isPanelUserRoute(method, path) {
  if (path === '/api/panel/users') return method === 'GET' || method === 'POST'
  if (/^\/api\/panel\/users\/[^/]+\/balance$/.test(path)) return method === 'POST'
  if (/^\/api\/panel\/users\/[^/]+\/balance-history$/.test(path)) return method === 'GET'
  return (
    (/^\/api\/panel\/users\/[^/]+$/.test(path) && (method === 'PATCH' || method === 'DELETE')) ||
    ((method === 'GET' || method === 'PUT') && /^\/api\/panel\/users\/[^/]+\/groups$/.test(path))
  )
}

export function authorizePanelRoute(method, path, role) {
  const r = normalizePanelRole(role)
  if (r === 'super_admin') return { ok: true, role: r }
  const m = String(method || 'GET').toUpperCase()
  const p = String(path || '')

  if (p === '/api/panel/me' && m === 'GET') return { ok: true, role: r }
  if (p === '/api/panel/me/profile' && ['GET', 'PATCH'].includes(m)) return { ok: true, role: r }
  if (p === '/api/panel/me/password' && m === 'POST') return { ok: true, role: r }

  if (p === '/api/panel/test-schedule/default' && m === 'PUT') {
    return { ok: false, role: r, code: 'forbidden', message: '当前权限无法执行此操作' }
  }

  if (r === 'vendor') {
    if (m === 'GET' && p === '/api/panel/groups') return { ok: true, role: r }
    if (m === 'POST' && p === '/api/panel/vms/import') return { ok: true, role: r }
    if (
      m === 'POST' &&
      /^\/api\/panel\/vms\/[^/]+\/(start|shell-ticket|oauth\/generate-auth-url|oauth\/exchange-code)$/.test(p)
    )
      return { ok: true, role: r }
  }

  if (/^\/api\/panel\/request-logs\/[^/]+\/attempts$/.test(p)) {
    return { ok: false, role: r, code: 'forbidden', message: '当前权限无法执行此操作' }
  }
  if (r === 'user' && isUserAllowed(m, p)) return { ok: true, role: r }
  if (p === '/api/panel/onboarding' && (m === 'GET' || m === 'PUT')) return { ok: true, role: r }
  if (r === 'admin' && isPanelUserRoute(m, p)) return { ok: true, role: r }
  if (r === 'admin' && p === '/api/panel/groups' && m === 'GET') return { ok: true, role: r }
  if (r === 'admin' && p.startsWith('/api/panel/groups/') && m === 'GET') return { ok: true, role: r }
  if (r === 'admin' && p.startsWith('/api/panel/api-keys')) return { ok: true, role: r }
  if (r === 'admin' && m === 'GET' && (p === '/api/panel/billing' || isRequestLogPath(p) || LOG_STATS_GET.has(p))) {
    return { ok: true, role: r }
  }

  return {
    ok: false,
    role: r,
    code: 'forbidden',
    message: '当前权限无法执行此操作',
  }
}

export function mePayload(req) {
  const ident = panelIdentity(req)
  return {
    user: ident.user,
    role: ident.role,
    views: viewsForRole(ident.role),
    capabilities: capabilitiesForRole(ident.role),
    vm_create_quota: Number(req?.panelVmCreateQuota) || 0,
  }
}
