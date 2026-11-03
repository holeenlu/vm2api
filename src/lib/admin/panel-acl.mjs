/**
 * Panel RBAC.
 *
 *   super_admin — SA: full console, VM creation/management, platform settings
 *   admin       — AD: user management + user usage records/statistics
 *   user   — U: own API keys, usage, logs, statistics and billing
 *   vendor — supplier portal identity; no ordinary operator-panel pages
 */
import {
  PANEL_VIEWS,
  canViewPage,
  capabilitiesForRole,
  hasCapability,
  normalizePanelRole,
  viewsForRole,
} from './panel-role-policy.mjs'
export {
  PANEL_VIEWS,
  canViewPage,
  capabilitiesForRole,
  hasCapability,
  normalizePanelRole,
  viewsForRole,
} from './panel-role-policy.mjs'
export { authorizePanelRoute } from './capability-policy.mjs'

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
