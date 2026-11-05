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

/**
 * 内核缓存、许可清单与重装（/api/panel/kernels*）以及按槽 CRAG 激活（/api/panel/vms/:id/crag-license）
 * 只属于 super_admin（上游 1.4.042+ 同样只给运维管理员）。在资源能力放行之前拒绝，
 * 避免 /api/panel/vms/* 的资源能力（resources.read / edit）把许可激活顺带授予 admin。
 */
function superAdminOnlyRoute(path) {
  const p = String(path || '')
  return (
    p === '/api/panel/kernels' ||
    p.startsWith('/api/panel/kernels/') ||
    /^\/api\/panel\/vms\/[^/]+\/crag-license$/.test(p)
  )
}

/** 槽位冷迁移与扩容（上游 1.4.046）同样只给运维角色。 */
function superAdminMigrationRoute(path) {
  return /^\/api\/panel\/vms\/[^/]+\/migration(?:\/|$)/.test(String(path || ''))
}

export function authorizePanelRoute(method, path, role, resourcePermissions = []) {
  const r = normalizePanelRole(role)
  if (r === 'super_admin') return { ok: true, role: r }
  if (superAdminOnlyRoute(path)) return { ok: false, role: r, code: 'forbidden', message: '只有超级管理员可以管理内核' }
  if (superAdminMigrationRoute(path))
    return { ok: false, role: r, code: 'forbidden', message: '只有超级管理员可以迁移槽位' }
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
