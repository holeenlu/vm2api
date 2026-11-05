import { getDb } from '../db/database.mjs'
import { dbClient } from '../db/db-client.mjs'
import { GroupsRepo } from '../db/repos/groups-repo.mjs'
import { extractPanelToken, revokePanelSessionsForUser } from '../core/security.mjs'
import { panelIdentity } from './panel-acl.mjs'
import { publicUserView } from './panel-users.mjs'
import { updateAdminVendor, syncVendorUserGroups } from '../vendor/vendor-admin.mjs'
import { rejectInlinePricing, VendorError } from '../vendor/vendor-platform.mjs'
import { findPrimaryActiveVendor, revokeUserMemberships } from '../vendor/repos/members-repo.mjs'
import * as panel from './panel-api.mjs'

/**
 * User administration routes extracted from the panel aggregate.
 *
 * The factory receives the live stores and response/body adapters so the
 * existing handler context, transaction boundaries and response envelopes
 * remain unchanged while additional route domains are split out.
 */
export function createPanelUserRoutes({ panelUsers, json, readBody, vendorPlatform }) {
  const respond = (...args) => {
    json(...args)
    return true
  }

  /**
   * 资源能力只能由 super_admin（或主密钥）授予，且只对 admin 角色生效。
   * 返回错误响应参数；可以继续时返回 null。
   */
  const resourceGrantError = (req, body, targetRole) => {
    if (!body || !Object.hasOwn(body, 'resource_permissions')) return null
    if (panelIdentity(req).role !== 'super_admin')
      return [403, { code: 'forbidden', message: '只有超级管理员可以授予资源权限' }]
    const list = body.resource_permissions
    if (targetRole !== 'admin' && !(Array.isArray(list) && list.length === 0))
      return [400, { code: 'invalid_resource_permissions', message: '资源权限只能授予管理员角色' }]
    return null
  }

  return async function handlePanelUsers(req, res, path) {
    if (req.method === 'GET' && path === '/api/panel/users') {
      return respond(
        res,
        200,
        panel.ok({
          items: await panelUsers.list({ actorId: req.panelUserId, role: panelIdentity(req).role }),
        }),
      )
    }

    if (req.method === 'POST' && path === '/api/panel/users') {
      const body = await readBody(req, 8192).catch(() => ({}))
      const requestedRole = body.role || 'user'
      const grantError = resourceGrantError(req, body, requestedRole)
      if (grantError) return respond(res, grantError[0], { ok: false, error: grantError[1] })
      if (
        panelIdentity(req).role === 'admin' &&
        ((requestedRole && !['user', 'admin'].includes(requestedRole)) ||
          Object.keys(body).some((key) => !['username', 'user', 'password', 'pass', 'role', 'enabled'].includes(key)))
      )
        return respond(res, 403, {
          ok: false,
          error: { code: 'forbidden', message: '管理员只能创建普通用户或管理员账号' },
        })
      if (requestedRole === 'vendor' && panelIdentity(req).role !== 'super_admin')
        return respond(res, 403, {
          ok: false,
          error: { code: 'forbidden', message: '只有超级管理员可以创建供应商账号' },
        })
      let rec = null
      try {
        rejectInlinePricing(body)
        rec = await panelUsers.create({
          username: body.username || body.user,
          password: body.password || body.pass,
          role: requestedRole,
          enabled: body.enabled !== false,
          concurrency: body.concurrency,
          rpm_limit: body.rpm_limit,
          restrict_public_groups: body.restrict_public_groups,
          resource_permissions: body.resource_permissions,
          groups: body.groups,
          actor: panelIdentity(req).user,
          actorId: req.panelUserId,
        })
        let vendor = null
        if (requestedRole === 'vendor') {
          const createChild = body.vendor_create_child === true
          vendor = await vendorPlatform().createRoot({
            actorUserId: req.panelUserId || 'master',
            userId: rec.id,
            body: {
              groups: Array.isArray(body.groups)
                ? (await new GroupsRepo(getDb()).grants(rec.id)).map((g) => String(g.group_id))
                : Array.isArray(body.vendor_groups)
                  ? body.vendor_groups
                  : [],
              platforms: Array.isArray(body.vendor_platforms) ? body.vendor_platforms : [],
              account_limit: Number(body.vendor_account_limit || 0),
              proxy_limit: Number(body.vendor_proxy_limit || 0),
              child_limit: createChild ? Number(body.vendor_child_limit ?? 1) : 0,
              capabilities: [
                'vendor.resource.manage',
                'vendor.vm.create',
                'vendor.usage.read',
                'vendor.settlement.read',
                ...(createChild ? ['vendor.create_child'] : []),
              ],
            },
          })
        }
        return respond(res, 201, panel.ok({ item: { ...publicUserView(rec), vendor } }))
      } catch (e) {
        if (rec?.id) {
          try {
            await panelUsers.remove(rec.id, { actorId: req.panelUserId })
          } catch {}
        }
        const status = e.code === 'username_exists' ? 409 : 400
        return respond(res, status, {
          ok: false,
          error: { message: String(e.message || e), code: e.code || 'create_failed' },
        })
      }
    }

    if (req.method === 'PATCH' && /^\/api\/panel\/users\/[^/]+$/.test(path)) {
      const id = path.split('/').pop()
      const body = await readBody(req, 8192).catch(() => ({}))
      try {
        const before = await panelUsers.getById(id)
        if (
          panelIdentity(req).role === 'admin' &&
          !(await panelUsers.canAccess(id, { actorId: req.panelUserId, role: 'admin' }))
        )
          return respond(res, 403, { ok: false, error: { code: 'forbidden', message: '当前权限无法修改该账号' } })
        const grantError = resourceGrantError(req, body, body?.role || before?.role)
        if (grantError) return respond(res, grantError[0], { ok: false, error: grantError[1] })
        if (before?.role === 'vendor' && body.role && body.role !== 'vendor')
          return respond(res, 409, {
            ok: false,
            error: { code: 'vendor_role_requires_reconciliation', message: '供应商角色需要先处理供应商身份绑定' },
          })
        if (before?.role !== 'vendor' && body.role === 'vendor')
          return respond(res, 409, {
            ok: false,
            error: { code: 'vendor_role_create_only', message: '供应商角色请通过新建用户流程创建' },
          })
        if (
          panelIdentity(req).role === 'admin' &&
          (!['user', 'admin'].includes(before?.role) ||
            Object.keys(body).some((key) => !['password', 'enabled', 'role'].includes(key)) ||
            (body.role && !['user', 'admin'].includes(body.role)))
        )
          return respond(res, 403, {
            ok: false,
            error: { code: 'forbidden', message: '管理员只能修改所属用户或管理员的密码、状态和角色' },
          })
        const rec = await dbClient(getDb()).tx(async () => {
          const updated = await panelUsers.update(id, body || {}, { actorId: req.panelUserId })
          if (updated?.role === 'vendor' && Object.hasOwn(body, 'groups'))
            await syncVendorUserGroups(vendorPlatform(), id, body.groups, req.panelUserId || 'master')
          if (
            updated?.role === 'vendor' &&
            (Object.hasOwn(body, 'vendor_create_child') || Object.hasOwn(body, 'vendor_child_limit'))
          ) {
            const patch = {}
            if (Object.hasOwn(body, 'vendor_create_child')) {
              if (typeof body.vendor_create_child !== 'boolean')
                throw new VendorError('invalid_capability', '下级供应商开关须为布尔值')
              patch.create_child = body.vendor_create_child
            }
            if (Object.hasOwn(body, 'vendor_child_limit')) patch.child_limit = body.vendor_child_limit
            const member = await findPrimaryActiveVendor(getDb(), id)
            if (!member) throw new VendorError('vendor_forbidden', '当前账号没有有效的供应商身份', 403)
            await updateAdminVendor(vendorPlatform(), member.id, patch, req.panelUserId || 'master')
          }
          return updated
        })
        if (!rec) return respond(res, 404, { ok: false, error: { message: 'user not found' } })
        if (before && (before.role !== rec.role || !!before.enabled !== !!rec.enabled)) {
          revokePanelSessionsForUser(rec.username)
        } else if (body?.password) {
          revokePanelSessionsForUser(rec.username, { exceptToken: extractPanelToken(req) })
        }
        return respond(res, 200, panel.ok({ item: publicUserView(rec) }))
      } catch (e) {
        const status = e.code === 'last_admin' || e.code === 'self_disable' ? 409 : 400
        return respond(res, status, {
          ok: false,
          error: { message: String(e.message || e), code: e.code || 'update_failed' },
        })
      }
    }

    if (req.method === 'DELETE' && /^\/api\/panel\/users\/[^/]+$/.test(path)) {
      const id = path.split('/').pop()
      const existing = await panelUsers.getById(id)
      if (
        panelIdentity(req).role === 'admin' &&
        !(await panelUsers.canAccess(id, { actorId: req.panelUserId, role: 'admin' }))
      )
        return respond(res, 403, { ok: false, error: { code: 'forbidden', message: '当前权限无法删除该账号' } })
      try {
        if (existing?.role === 'vendor') await revokeUserMemberships(getDb(), new Date().toISOString(), id)
        const ok = await panelUsers.remove(id, { actorId: req.panelUserId })
        if (!ok) return respond(res, 404, { ok: false, error: { message: 'user not found' } })
        if (existing?.username) revokePanelSessionsForUser(existing.username)
        return respond(res, 200, { ok: true, deleted: id })
      } catch (e) {
        const status = e.code === 'last_admin' || e.code === 'self_delete' ? 409 : 400
        return respond(res, status, {
          ok: false,
          error: { message: String(e.message || e), code: e.code || 'delete_failed' },
        })
      }
    }

    return false
  }
}
