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
