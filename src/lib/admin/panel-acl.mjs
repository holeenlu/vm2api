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
import { RESOURCE_VIEWS, hasResourcePermission, resourcePermissionsFor } from './resource-permissions.mjs'

export function panelIdentity(req) {
  if (req?.apiKeyKind === 'master') {
    return {
      user: 'master',
      role: 'super_admin',
      source: 'master_key',
      resource_permissions: resourcePermissionsFor('super_admin'),
    }
  }
  const role = normalizePanelRole(req?.panelRole || 'user')
  return {
    user: req?.panelUser || null,
    role,
    source: 'session',
    resource_permissions: resourcePermissionsFor(role, req?.panelResourcePermissions),
  }
}

/** 身份（panelIdentity 的结果）是否拥有某级资源能力；super_admin 始终拥有。 */
export function identityCanResource(ident, level) {
  if (ident?.role === 'super_admin') return true
  return hasResourcePermission(ident?.resource_permissions, level)
}

/** 当前请求是否拥有某级资源能力（read / create / edit / manage）。 */
export function canResource(req, level) {
  return identityCanResource(panelIdentity(req), level)
}

/**
 * 资源页面的数据投影角色。拥有 resources.read 的 admin 在虚拟机、Codex 账号与
 * 账号池页面看到与 super_admin 相同的资源数据（供应商归属、节点、代理绑定），
 * 所以资源路由把这个角色传给按角色裁剪的投影函数；平台级页面仍用真实角色。
 */
export function resourceViewRole(ident) {
  if (ident?.role === 'admin' && hasResourcePermission(ident.resource_permissions, 'read')) return 'super_admin'
  return ident?.role
}

export function mePayload(req) {
  const ident = panelIdentity(req)
  const resourceViews = ident.resource_permissions.includes('resources.read') ? RESOURCE_VIEWS : []
  return {
    user: ident.user,
    role: ident.role,
    views: [...new Set([...viewsForRole(ident.role), ...resourceViews])],
    capabilities: [...new Set([...capabilitiesForRole(ident.role), ...ident.resource_permissions])],
    resource_permissions: ident.resource_permissions,
  }
}

/** 改变资源归属（供应商 / 所属用户）的字段；修改它们需要「管理」能力。 */
export const RESOURCE_OWNER_FIELDS = Object.freeze(['vendor_id', 'owner_user_id', 'vendor_account_resource_id'])

/** 请求体要改资源归属但当前身份没有「管理」能力时返回 true。 */
export function ownerChangeDenied(ident, body) {
  if (!body || typeof body !== 'object') return false
  return !identityCanResource(ident, 'manage') && RESOURCE_OWNER_FIELDS.some((key) => Object.hasOwn(body, key))
}
