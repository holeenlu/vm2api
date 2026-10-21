/**
 * Panel RBAC.
 *
 *   admin  — full console + user management
 *   super  — infrastructure operations without finance, raw credentials or shell access
 *   user   — commercial customer: granted groups, own keys, wallet and caller-scoped usage
 */

export const PANEL_VIEWS = [
  'profile',
  'groups',
  'ops',
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
  'wrap',
  'billing',
]

const ROLE_VIEWS = {
  user: ['profile', 'groups', 'keys', 'billing', 'logs', 'statistics', 'subscriptions'],
  super: ['profile', 'overview', 'ops', 'cluster', 'vm', 'import', 'proxies', 'groups', 'api', 'logs', 'statistics'],
  admin: PANEL_VIEWS.slice(),
}
const ROLE_CAPS = {
  user: ['panel.read', 'groups.catalog', 'keys.write', 'billing.read', 'usage.own'],
  super: [
    'panel.read',
    'vm.read',
    'vm.schedule',
    'vm.create',
    'vm.power',
    'vm.credential_write',
    'vm.delete',
    'proxy.write',
    'groups.resources',
    'ops.read',
  ],
  admin: ['*'],
}

export function normalizePanelRole(role) {
  const r = String(role || '')
    .trim()
    .toLowerCase()
  if (r === 'admin' || r === 'super' || r === 'user') return r
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
    return { user: 'master', role: 'admin', source: 'master_key' }
  }
  return {
    user: req?.panelUser || null,
    role: normalizePanelRole(req?.panelRole || 'user'),
    source: 'session',
  }
}

const USAGE_GET = new Set([
  '/api/panel/request-logs',
  '/api/panel/request-logs/export',
  '/api/panel/request-logs/stats',
  '/api/panel/usage-logs',
  '/api/panel/usage-logs/summary',
  '/api/panel/usage-logs/ranking',
  '/api/panel/usage-logs/filter-options',
  '/api/panel/usage-logs/session-suggestions',
  '/api/panel/usage-logs/active-sessions',
  '/api/panel/usage-logs/overview',
  '/api/panel/statistics',
  '/api/panel/statistics/leaderboard',
])
export function authorizePanelRoute(method, path, role) {
  const r = normalizePanelRole(role)
  const m = String(method || 'GET').toUpperCase()
  const p = String(path || '')
  let ok = r === 'admin'
  if (p === '/api/panel/me' && m === 'GET') ok = true
  if (p === '/api/panel/me/profile' && ['GET', 'PATCH'].includes(m)) ok = true
  if (p === '/api/panel/me/password' && m === 'POST') ok = true
  if (p === '/api/panel/onboarding' && ['GET', 'PUT'].includes(m)) ok = true
  if (m === 'GET' && (USAGE_GET.has(p) || /^\/api\/panel\/request-logs\/[^/]+(?:\/attempts)?$/.test(p))) ok = true
  if (m === 'GET' && /^\/api\/panel\/groups(?:\/\d+)?$/.test(p)) ok = true
  if (r === 'user') {
    if (m === 'GET' && ['/api/panel/billing', '/api/panel/subscriptions'].includes(p)) ok = true
    if (m === 'POST' && p === '/api/panel/redeem') ok = true
    if (p === '/api/panel/api-keys' && ['GET', 'POST'].includes(m)) ok = true
    if (/^\/api\/panel\/api-keys\/[^/]+$/.test(p) && ['GET', 'PATCH', 'DELETE'].includes(m)) ok = true
    if (/^\/api\/panel\/api-keys\/[^/]+\/(reveal|rotate|reset-quota)$/.test(p) && m === 'POST') ok = true
    if (/^\/api\/panel\/api-keys\/[^/]+\/(stats|connection)$/.test(p) && m === 'GET') ok = true
  }
  if (r === 'super') {
    if (p === '/api/panel/api-endpoints' && ['GET', 'POST'].includes(m)) ok = true
    if (/^\/api\/panel\/api-endpoints\/[^/]+$/.test(p) && ['PATCH', 'DELETE'].includes(m)) ok = true
    if (m === 'PUT' && /^\/api\/panel\/api-endpoints\/[^/]+\/groups$/.test(p)) ok = true
    if (m === 'POST' && /^\/api\/panel\/api-endpoints(?:\/[^/]+)?\/fetch-models$/.test(p)) ok = true
    if (m === 'GET' && /^\/api\/panel\/vms\/[^/]+\/(stats|test-models|test-schedule|telemetry|runtime)$/.test(p))
      ok = true
    if (m === 'POST' && p === '/api/panel/test-schedule/sync') ok = true
    if (m === 'DELETE' && /^\/api\/panel\/vms\/[^/]+\/test-schedule$/.test(p)) ok = true
    if (m === 'GET' && p === '/api/panel/test-schedule/default') ok = true
    if (m === 'PUT' && /^\/api\/panel\/vms\/[^/]+\/test-schedule$/.test(p)) ok = true
    if (
      m === 'POST' &&
      /^\/api\/panel\/vms\/[^/]+\/(oauth\/import|openai-quota\/refresh|limits\/refresh|reset)$/.test(p)
    )
      ok = true
    if (
      m === 'GET' &&
      [
        '/api/panel/dashboard',
        '/api/panel/test-models',
        '/api/panel/usage',
        '/api/panel/ops',
        '/api/panel/vms',
        '/api/panel/vms/create-options',
        '/api/panel/pool/stream',
        '/api/panel/cluster/nodes',
        '/api/panel/cluster/local',
        '/api/panel/proxies',
        '/api/panel/proxies/config',
      ].includes(p)
    )
      ok = true
    if (/^\/api\/panel\/vms\/[^/]+$/.test(p) && ['GET', 'PATCH', 'DELETE'].includes(m)) ok = true
    if (
      m === 'POST' &&
      [
        '/api/panel/vms/create',
        '/api/panel/vms/import',
        '/api/panel/proxies/import',
        '/api/panel/vms/groups/batch',
      ].includes(p)
    )
      ok = true
    if (
      m === 'POST' &&
      /^\/api\/panel\/vms\/[^/]+\/(schedulable|cooldown\/clear|circuit\/reset|start|stop|probe|recover|test-chat|oauth\/(refresh|generate-auth-url|exchange-code))$/.test(
        p,
      )
    )
      ok = true
    if (m === 'PUT' && /^\/api\/panel\/vms\/[^/]+\/(groups|oauth\/credential)$/.test(p)) ok = true
    if (m === 'PUT' && /^\/api\/panel\/groups\/\d+\/resources$/.test(p)) ok = true
    if (m === 'PUT' && /^\/api\/panel\/proxies\/(?!config$)[^/]+$/.test(p)) ok = true
    if (m === 'DELETE' && /^\/api\/panel\/proxies\/[^/]+$/.test(p)) ok = true
    if (m === 'POST' && /^\/api\/panel\/proxies\/[^/]+\/(bind|unbind|enable|disable|probe|geo|quality-check)$/.test(p))
      ok = true
  }
  if (r === 'super' && p === '/api/panel/request-logs/export') ok = false
  return ok ? { ok: true, role: r } : { ok: false, role: r, code: 'forbidden', message: '当前权限无法执行此操作' }
}

export function mePayload(req) {
  const ident = panelIdentity(req)
  return {
    user: ident.user,
    role: ident.role,
    views: viewsForRole(ident.role),
    capabilities: capabilitiesForRole(ident.role),
  }
}
