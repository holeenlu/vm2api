import { dbClient } from '../db/db-client.mjs'
import { validateBulkKeyEdit } from './api-key-bulk-edit.mjs'
import { GroupsRepo } from '../db/repos/groups-repo.mjs'
import { panelIdentity } from './panel-acl.mjs'
import { denyIfUserMissesKey } from './panel-tenant.mjs'
import { keyConnection } from './key-connection.mjs'
import { publicKeyView } from './api-keys.mjs'
import { relayError, audit } from './relay-common.mjs'
import { normalizeOwnerId } from './resource-owner.mjs'
import * as panel from './panel-api.mjs'
import { projectPanelUsage } from '../usage/public-usage-projection.mjs'

// 管理员替用户创建的 Key（created_by_user_id 不是本人；主密钥或迁移 064 之前创建的为 null，同样按受管处理），
// 用户只能改名称与 IP 白名单/黑名单；额度、限速、分组、状态、有效期与重置额度由创建它的管理员管理。
export const USER_EDITABLE_MANAGED_KEY_FIELDS = Object.freeze(['name', 'ip_whitelist', 'ip_blacklist'])

/** 操作者是 user 且这把 Key 不是本人创建时返回 true。 */
export function keyManagedForUser(req, rec) {
  if (panelIdentity(req).role !== 'user' || !rec) return false
  return normalizeOwnerId(rec.created_by_user_id) !== normalizeOwnerId(req.panelUserId)
}

function denyManagedKeyFields(req, rec, fields) {
  if (!keyManagedForUser(req, rec)) return
  if (fields.some((field) => !USER_EDITABLE_MANAGED_KEY_FIELDS.includes(field)))
    throw relayError('key_managed_by_admin', '该 API 密钥由管理员创建，只能修改名称和 IP 名单', 403)
}

/** API key CRUD and diagnostics extracted from the panel route aggregate. */
export function createPanelApiKeyRoutes({ apiKeyStore, requestLog, json, readBody, ctx, normalizeInput }) {
  const respond = (...args) => {
    json(...args)
    return true
  }

  async function prepareUpdate(id, input) {
    const owner = await apiKeyStore.users.getById((await apiKeyStore.getById(id))?.user_id)
    if (Object.hasOwn(input, 'group_id')) {
      if (!input.group_id && ['admin', 'user'].includes(owner?.role))
        throw relayError('group_required', '请选择授权分组')
      if (input.group_id) {
        const groups = new GroupsRepo(apiKeyStore.db)
        await groups.access(owner || { id: null, role: 'super_admin', status: 'active' }, Number(input.group_id))
        input.category = (await groups.resources(Number(input.group_id))).some(
          (r) => r.resource_kind === 'api_endpoint',
        )
          ? 'api'
          : 'oauth'
      }
    }
    return input
  }

  return async function handlePanelApiKeys(req, res, path, url) {
    if (req.method === 'GET' && path === '/api/panel/api-keys') {
      const snap = await apiKeyStore.snapshot()
      if (panelIdentity(req).role === 'user') {
        const mine = (snap.keys || [])
          .filter((k) => normalizeOwnerId(k.user_id) === normalizeOwnerId(req.panelUserId))
          .map((k) => ({ ...k, managed_by_admin: keyManagedForUser(req, k) }))
        return respond(res, 200, {
          ok: true,
          total: mine.length,
          active: mine.filter((k) => k.status === 'active').length,
          keys: mine,
        })
      }
      if (panelIdentity(req).role === 'admin') {
        const managed = new Set(await apiKeyStore.users.scopeIds(req.panelUserId))
        const mine = url.searchParams.get('scope') === 'mine'
        const keys = (snap.keys || []).filter((k) =>
          mine
            ? normalizeOwnerId(k.created_by_user_id) === normalizeOwnerId(req.panelUserId)
            : managed.has(normalizeOwnerId(k.user_id)),
        )
        return respond(res, 200, {
          ok: true,
          total: keys.length,
          active: keys.filter((k) => k.status === 'active').length,
          keys,
        })
      }
      return respond(res, 200, { ok: true, ...snap })
    }

    if (req.method === 'GET' && /^\/api\/panel\/api-keys\/[^/]+\/stats$/.test(path)) {
      const id = path.split('/')[4]
      if (await denyIfUserMissesKey(req, res, { apiKeyStore, json, keyId: id })) return true
      const rec = await apiKeyStore.getById(id)
      if (!rec) return respond(res, 404, { ok: false, error: { message: 'api key not found' } })
      // Key 路由拿到的是未投影的 ctx.json：按调用者角色投影，非超管不返回槽位排行等私有字段
      const usage_stats = projectPanelUsage(
        req,
        path,
        (await requestLog?.keyUsageStats?.({ apiKeyId: id, days: 30 })) || null,
      )
      return respond(res, 200, { ok: true, item: publicKeyView(rec, { reveal: false }), usage_stats })
    }

    if (req.method === 'POST' && path === '/api/panel/api-keys') {
      const body = await readBody(req, 8192).catch(() => ({}))
      const input = normalizeInput(body)
      try {
        const groups = new GroupsRepo(apiKeyStore.db)
        const role = panelIdentity(req).role
        const userId = role === 'super_admin' ? body?.user_id || req.panelUserId || null : req.panelUserId
        if ((role !== 'super_admin' && !userId) || (role === 'admin' && body?.user_id && body.user_id !== userId))
          return respond(res, 403, {
            ok: false,
            error: { code: 'forbidden', message: '只能创建归属当前账号的 API 密钥' },
          })
        const owner = userId ? await apiKeyStore.users.getById(userId) : null
        if (['admin', 'user'].includes(owner?.role) && !body.group_id)
          throw relayError('group_required', '请选择授权分组')
        if (body.group_id)
          await groups.access(owner || { id: null, role: 'super_admin', status: 'active' }, Number(body.group_id))
        const defaultConc = Number(
          ctx.routingConfig?.concurrency?.default_key_concurrency ??
            ctx.routingConfig?.concurrency?.default_max_per_account ??
            20,
        )
        const category = body?.group_id
          ? (await groups.resources(Number(body.group_id))).some((r) => r.resource_kind === 'api_endpoint')
            ? 'api'
            : 'oauth'
          : body?.category
        const rec = await apiKeyStore.create({
          name: body?.name,
          key: body?.key || body?.custom_key || undefined,
          category,
          user_id: userId,
          group_id: body?.group_id || null,
          ip_whitelist: body?.ip_whitelist,
          ip_blacklist: body?.ip_blacklist,
          max_concurrency: body?.max_concurrency ?? defaultConc,
          default_concurrency: defaultConc,
          quota_requests: input.quota_requests,
          quota: input.quota,
          rate_limit_5h: body?.rate_limit_5h,
          rate_limit_1d: body?.rate_limit_1d,
          rate_limit_7d: body?.rate_limit_7d,
          rpm: body?.rpm ?? body?.rate_limit_rpm,
          created_by_user_id: req.panelUserId || null,
          expires_at:
            body?.expires_at ||
            (body?.expires_in_days
              ? new Date(Date.now() + Number(body.expires_in_days) * 86400_000).toISOString()
              : null),
        })
        await audit(apiKeyStore.db, panelIdentity(req).user, 'key.create', rec.id, null, {
          user_id: rec.user_id,
          group_id: rec.group_id,
        })
        return respond(res, 201, {
          ok: true,
          item: publicKeyView(rec, { reveal: true }),
          note: 'plaintext stays recoverable via POST /api/panel/api-keys/:id/reveal',
        })
      } catch (e) {
        const status = e.status || 400
        return respond(res, status, {
          ok: false,
          error: { message: String(e.message || e), code: e.code || 'create_failed' },
        })
      }
    }

    if (req.method === 'PATCH' && path === '/api/panel/api-keys/bulk') {
      try {
        const { ids, patch } = validateBulkKeyEdit(await readBody(req, 128 * 1024))
        for (const id of ids) if (await denyIfUserMissesKey(req, res, { apiKeyStore, json, keyId: id })) return true
        for (const id of ids) denyManagedKeyFields(req, await apiKeyStore.getById(id), Object.keys(patch))
        // Only database work inside the transaction: authorization, owner group
        // grants, key changes and audit records succeed or roll back together.
        await dbClient(apiKeyStore.db).tx(async () => {
          for (const id of ids) {
            const input = await prepareUpdate(id, normalizeInput(patch))
            await apiKeyStore.update(id, input)
            await audit(apiKeyStore.db, panelIdentity(req).user, 'key.bulk_update', id, null, patch)
          }
        })
        return respond(res, 200, { ok: true, updated: ids.length })
      } catch (e) {
        return respond(res, e.status || 400, {
          ok: false,
          error: { message: String(e.message || e), code: e.code || 'bulk_update_failed' },
        })
      }
    }

    if (req.method === 'PATCH' && /^\/api\/panel\/api-keys\/[^/]+$/.test(path)) {
      const id = path.split('/').pop()
      if (await denyIfUserMissesKey(req, res, { apiKeyStore, json, keyId: id })) return true
      const body = await readBody(req, 16384).catch(() => ({}))
      try {
        const input = normalizeInput(body || {})
        denyManagedKeyFields(req, await apiKeyStore.getById(id), Object.keys(input))
        await prepareUpdate(id, input)
        const rec = await apiKeyStore.update(id, input)
        if (!rec) return respond(res, 404, { ok: false, error: { message: 'api key not found' } })
        return respond(res, 200, { ok: true, item: publicKeyView(rec, { reveal: false }) })
      } catch (e) {
        return respond(res, e.status || 400, {
          ok: false,
          error: { message: String(e.message || e), code: e.code },
        })
      }
    }

    if (req.method === 'GET' && /^\/api\/panel\/api-keys\/[^/]+\/connection$/.test(path)) {
      const id = path.split('/')[4]
      if (await denyIfUserMissesKey(req, res, { apiKeyStore, json, keyId: id })) return true
      const rec = await apiKeyStore.getById(id)
      if (!rec) return respond(res, 404, { ok: false, error: { message: 'api key not found' } })
      try {
        return respond(res, 200, { ok: true, data: await keyConnection(rec, ctx) })
      } catch (e) {
        return respond(res, e.status || 400, { ok: false, error: { code: e.code, message: e.message } })
      }
    }

    if (req.method === 'POST' && /^\/api\/panel\/api-keys\/[^/]+\/reveal$/.test(path)) {
      const id = path.split('/')[4]
      if (await denyIfUserMissesKey(req, res, { apiKeyStore, json, keyId: id })) return true
      const out = await apiKeyStore.reveal(id)
      if (out?.ok) await audit(apiKeyStore.db, panelIdentity(req).user, 'key.reveal', id, null, null)
      if (!out) return respond(res, 404, { ok: false, error: { message: 'api key not found' } })
      if (!out.ok) {
        return respond(res, 409, {
          ok: false,
          error: {
            message:
              out.code === 'key_decryption_failed'
                ? '密钥密文解密失败，请恢复原数据库加密密钥；不要直接轮换正在使用的密钥'
                : '此历史密钥仅存哈希。使用原密钥成功调用后可恢复复制；原密钥丢失时需手动轮换',
            code: out.code,
          },
        })
      }
      return respond(res, 200, { ok: true, id: out.id, name: out.name, key: out.key })
    }

    if (req.method === 'POST' && /^\/api\/panel\/api-keys\/[^/]+\/rotate$/.test(path)) {
      const id = path.split('/')[4]
      if (await denyIfUserMissesKey(req, res, { apiKeyStore, json, keyId: id })) return true
      try {
        const rec = await apiKeyStore.rotate(id)
        if (rec) await audit(apiKeyStore.db, panelIdentity(req).user, 'key.rotate', id, null, null)
        if (!rec) return respond(res, 404, { ok: false, error: { message: 'api key not found' } })
        return respond(res, 200, { ok: true, item: publicKeyView(rec, { reveal: true }) })
      } catch (e) {
        return respond(res, 400, {
          ok: false,
          error: { message: String(e.message || e), code: e.code || 'rotate_failed' },
        })
      }
    }

    if (req.method === 'POST' && /^\/api\/panel\/api-keys\/[^/]+\/reset-quota$/.test(path)) {
      const id = path.split('/')[4]
      if (await denyIfUserMissesKey(req, res, { apiKeyStore, json, keyId: id })) return true
      try {
        denyManagedKeyFields(req, await apiKeyStore.getById(id), ['reset_quota'])
      } catch (e) {
        return respond(res, e.status, { ok: false, error: { message: e.message, code: e.code } })
      }
      const rec = await apiKeyStore.update(id, { reset_quota: true })
      if (!rec) return respond(res, 404, { ok: false, error: { message: 'api key not found' } })
      return respond(res, 200, { ok: true, item: publicKeyView(rec, { reveal: false }) })
    }

    if (req.method === 'DELETE' && /^\/api\/panel\/api-keys\/[^/]+$/.test(path)) {
      const id = path.split('/').pop()
      if (await denyIfUserMissesKey(req, res, { apiKeyStore, json, keyId: id })) return true
      const ok = await apiKeyStore.remove(id)
      if (ok) await audit(apiKeyStore.db, panelIdentity(req).user, 'key.delete', id, null, null)
      if (!ok) return respond(res, 404, { ok: false, error: { message: 'api key not found' } })
      return respond(res, 200, { ok: true, deleted: id })
    }

    return false
  }
}
