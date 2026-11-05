import { dbClient } from '../db/db-client.mjs'
import { GroupsRepo } from '../db/repos/groups-repo.mjs'
import { panelIdentity } from './panel-acl.mjs'
import { relayError } from './relay-common.mjs'
import {
  publicEndpointView,
  assertEndpointConnectionAccess,
  fetchUpstreamModels,
  API_ENDPOINT_PRESETS,
} from './api-endpoints.mjs'
import { resolveConsoleProxyUrl, savedEndpointKey } from './anthropic-console.mjs'

/** API endpoint CRUD, upstream model discovery and endpoint-key management. */
export function createPanelApiEndpointRoutes({
  apiEndpointStore,
  apiKeyStore,
  apiScheduler,
  proxyPool,
  cfg,
  ctx,
  json,
  readBody,
  upstreamFetchStatus,
}) {
  const respond = (...args) => {
    json(...args)
    return true
  }

  return async function handlePanelApiEndpoints(req, res, path) {
    if (req.method === 'GET' && path === '/api/panel/api-endpoints') {
      const groups = new GroupsRepo(apiKeyStore.db)
      const items = []
      for (const ep of await apiEndpointStore.list({ reveal: false, role: panelIdentity(req).role }))
        items.push({
          ...ep,
          groups: await groups.forResource('api_endpoint', ep.id),
          groups_version: await groups.resourceVersion('api_endpoint', ep.id),
        })
      return respond(res, 200, {
        ok: true,
        items,
        presets: API_ENDPOINT_PRESETS,
      })
    }

    if (req.method === 'POST' && path === '/api/panel/api-endpoints/fetch-models') {
      const body = await readBody(req, 8192).catch(() => ({}))
      try {
        const saved = await savedEndpointKey(apiEndpointStore, body?.key_id)
        if (body?.key_id && !saved)
          throw Object.assign(new Error('endpoint key not found'), { status: 404, code: 'key_not_found' })
        const proxyUrl = Object.prototype.hasOwnProperty.call(body || {}, 'proxy_id')
          ? resolveConsoleProxyUrl(proxyPool, body.proxy_id)
          : saved?.proxy_url || body?.proxy_url
        if (saved)
          assertEndpointConnectionAccess(saved.endpoint, body, panelIdentity(req).role, saved.key, proxyUrl || '')
        const result = await fetchUpstreamModels({
          cfg,
          kind: body?.kind || saved?.kind,
          protocol: body?.protocol || saved?.protocol,
          base_url: body?.base_url || saved?.base_url,
          api_key: body?.api_key || saved?.api_key,
          proxy_url: proxyUrl,
          headers: body?.headers || saved?.headers,
          auth_scheme: body?.auth_scheme || body?.authScheme || saved?.auth_scheme,
          forward: ctx.forwardApi,
        })
        return respond(res, 200, {
          ok: true,
          ...result,
          base_url: publicEndpointView(result, { role: panelIdentity(req).role }).base_url,
        })
      } catch (e) {
        return respond(res, upstreamFetchStatus(e), {
          ok: false,
          error: { message: String(e.message || e), code: e.code || 'fetch_models_failed' },
        })
      }
    }

    if (req.method === 'POST' && path === '/api/panel/api-endpoints') {
      const body = await readBody(req, 1 << 20).catch(() => ({}))
      try {
        const proxyUrl = body?.proxy_id ? resolveConsoleProxyUrl(proxyPool, body.proxy_id) : ''
        if (Array.isArray(body?.api_key_entries)) {
          for (const entry of body.api_key_entries) {
            if (!entry.proxy_url) entry.proxy_url = proxyUrl
            if (body?.proxy_id != null) entry.proxy_id = String(body.proxy_id || '').trim()
          }
        }
        const rec = await apiEndpointStore.create(body || {})
        apiScheduler.reload(await apiEndpointStore.listRaw())
        return respond(res, 201, {
          ok: true,
          item: publicEndpointView(rec, { reveal: true, role: panelIdentity(req).role }),
        })
      } catch (e) {
        return respond(res, 400, {
          ok: false,
          error: { message: String(e.message || e), code: e.code || 'create_failed' },
        })
      }
    }

    if (req.method === 'PATCH' && /^\/api\/panel\/api-endpoints\/[^/]+$/.test(path)) {
      const id = path.split('/').pop()
      const body = await readBody(req, 1 << 20).catch(() => ({}))
      try {
        const existing = await apiEndpointStore.getRaw(id)
        if (!existing) return respond(res, 404, { ok: false, error: { message: 'endpoint not found' } })
        const keyId = String(body?.key_id || '').trim()
        const key = existing.api_key_entries?.find((entry) => entry.id === keyId)
        if (keyId && !key)
          return respond(res, 404, { ok: false, error: { code: 'key_not_found', message: 'endpoint key not found' } })
        const proxyUrl = body?.proxy_id ? resolveConsoleProxyUrl(proxyPool, body.proxy_id) : ''
        if (existing.api_key_entries?.length || Object.keys(existing.headers || {}).length)
          assertEndpointConnectionAccess(
            existing,
            body,
            panelIdentity(req).role,
            key,
            body?.proxy_id != null ? proxyUrl : undefined,
          )
        const apiKey = String(body?.api_key || '').trim()
        const rec = await dbClient(apiEndpointStore.db).tx(async () => {
          const updated = await apiEndpointStore.update(id, body || {})
          if (Array.isArray(body?.fetched_models)) await apiEndpointStore.mergeFetchedModels(id, body.fetched_models)
          if (keyId) {
            await apiEndpointStore.updateKey(keyId, {
              ...(apiKey ? { api_key: apiKey } : {}),
              ...(body?.proxy_id != null ? { proxy_url: proxyUrl, proxy_id: String(body.proxy_id || '').trim() } : {}),
            })
          } else if (apiKey) {
            await apiEndpointStore.addKey(id, {
              api_key: apiKey,
              proxy_url: proxyUrl,
              proxy_id: String(body?.proxy_id || '').trim(),
            })
          }
          return updated
        })
        apiScheduler.reload(await apiEndpointStore.listRaw())
        const saved = (await apiEndpointStore.getRaw(id)) || rec
        return respond(res, 200, { ok: true, item: publicEndpointView(saved, { role: panelIdentity(req).role }) })
      } catch (e) {
        return respond(res, e.status || 400, { ok: false, error: { message: String(e.message || e), code: e.code } })
      }
    }

    if (req.method === 'DELETE' && /^\/api\/panel\/api-endpoints\/[^/]+$/.test(path)) {
      const id = path.split('/').pop()
      const ok = await apiEndpointStore.remove(id)
      if (ok) {
        const groups = new GroupsRepo(apiKeyStore.db)
        await groups.assignResource(
          'api_endpoint',
          id,
          [],
          await groups.resourceVersion('api_endpoint', id),
          panelIdentity(req).user,
        )
      }
      if (!ok) return respond(res, 404, { ok: false, error: { message: 'endpoint not found' } })
      apiScheduler.reload(await apiEndpointStore.listRaw())
      return respond(res, 200, { ok: true, deleted: id })
    }

    if (req.method === 'POST' && /^\/api\/panel\/api-endpoints\/[^/]+\/fetch-models$/.test(path)) {
      const id = path.split('/')[4]
      const body = await readBody(req, 8192).catch(() => ({}))
      const ep = await apiEndpointStore.getRaw(id)
      if (!ep) return respond(res, 404, { ok: false, error: { message: 'endpoint not found' } })
      const key = (ep.api_key_entries || []).find((k) => !k.disabled && (body?.key_id ? k.id === body.key_id : true))
      if (!key)
        return respond(res, 400, { ok: false, error: { message: '需要上游 key 才能获取模型', code: 'key_required' } })
      try {
        const result = await fetchUpstreamModels({
          cfg,
          kind: ep.kind,
          protocol: ep.protocol,
          base_url: ep.base_url,
          api_key: key.api_key,
          proxy_url: key.proxy_url,
          headers: ep.headers,
          forward: ctx.forwardApi,
        })
        const apply = body?.apply !== false
        const rec = apply ? await apiEndpointStore.mergeFetchedModels(id, result.models) : ep
        if (apply) apiScheduler.reload(await apiEndpointStore.listRaw())
        return respond(res, 200, {
          ok: true,
          fetched: result.models.length,
          item: publicEndpointView(rec, { role: panelIdentity(req).role }),
          models: result.models,
        })
      } catch (e) {
        return respond(res, upstreamFetchStatus(e), {
          ok: false,
          error: { message: String(e.message || e), code: e.code || 'fetch_models_failed' },
        })
      }
    }

    if (req.method === 'POST' && /^\/api\/panel\/api-endpoints\/[^/]+\/keys$/.test(path)) {
      const id = path.split('/')[4]
      const body = await readBody(req, 8192).catch(() => ({}))
      try {
        const key = await apiEndpointStore.addKey(id, body || {})
        apiScheduler.reload(await apiEndpointStore.listRaw())
        const view = publicEndpointView(await apiEndpointStore.getRaw(id), { reveal: true })
        return respond(res, 201, { ok: true, item: view?.api_key_entries?.find((k) => k.id === key.id) || key })
      } catch (e) {
        const status = e.code === 'endpoint_not_found' ? 404 : 400
        return respond(res, status, { ok: false, error: { message: String(e.message || e), code: e.code } })
      }
    }

    // 端点 Key 只能经它所属端点的路径修改或删除
    const keyOfEndpoint = async (endpointId, keyId) =>
      !!(await apiEndpointStore.getRaw(endpointId))?.api_key_entries?.some((key) => key.id === keyId)

    if (req.method === 'DELETE' && /^\/api\/panel\/api-endpoints\/[^/]+\/keys\/[^/]+$/.test(path)) {
      const kid = path.split('/').pop()
      if (!(await keyOfEndpoint(path.split('/')[4], kid)))
        return respond(res, 404, { ok: false, error: { message: 'key not found' } })
      const ok = await apiEndpointStore.removeKey(kid)
      if (!ok) return respond(res, 404, { ok: false, error: { message: 'key not found' } })
      apiScheduler.reload(await apiEndpointStore.listRaw())
      return respond(res, 200, { ok: true, deleted: kid })
    }

    if (req.method === 'PATCH' && /^\/api\/panel\/api-endpoints\/[^/]+\/keys\/[^/]+$/.test(path)) {
      const kid = path.split('/').pop()
      if (!(await keyOfEndpoint(path.split('/')[4], kid)))
        return respond(res, 404, { ok: false, error: { message: 'key not found' } })
      const body = await readBody(req, 8192).catch(() => ({}))
      const rec = await apiEndpointStore.updateKey(kid, body || {})
      if (!rec) return respond(res, 404, { ok: false, error: { message: 'key not found' } })
      apiScheduler.reload(await apiEndpointStore.listRaw())
      const ep = await apiEndpointStore.getRaw(rec.endpoint_id)
      const item = publicEndpointView(ep)?.api_key_entries?.find((k) => k.id === kid)
      return respond(res, 200, { ok: true, item })
    }

    return false
  }
}
