/**
 * HTTP capability policy for panel routes.
 *
 * The role catalog stays in panel-role-policy; which non-super-admin roles may pass the panel role gate for
 * each method and path is declared in route-table.mjs. super_admin passes every route; routes that are not
 * registered (or registered without roles) are super_admin only.
 *
 * 账号资源（虚拟机、Codex 账号、供应商账号池）另按 super_admin 授予 admin 的能力放行：
 * 所需等级由 resource-permissions.mjs 的 resourceRouteRequirement 给出（docs/RESOURCE_WORKBENCH.md）。
 */
import { normalizePanelRole } from './panel-role-policy.mjs'
import { hasResourcePermission, resourcePermissionsFor, resourceRouteRequirement } from './resource-permissions.mjs'
import { matchRoute } from './route-table.mjs'

export function authorizePanelRoute(method, path, role, resourcePermissions = []) {
  const r = normalizePanelRole(role)
  if (r === 'super_admin') return { ok: true, role: r }
  if (matchRoute(method, path)?.roles.includes(r)) return { ok: true, role: r }
  if (r === 'admin') {
    const level = resourceRouteRequirement(method, path)
    if (level && hasResourcePermission(resourcePermissionsFor(r, resourcePermissions), level))
      return { ok: true, role: r, resource: level }
  }
  return {
    ok: false,
    role: r,
    code: 'forbidden',
    message: '当前权限无法执行此操作',
  }
}
