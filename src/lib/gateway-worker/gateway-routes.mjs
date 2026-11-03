import { getDb } from '../db/database.mjs'
import { panelIdentity } from '../admin/panel-acl.mjs'
import { GatewayWorkerRepo } from './gateway-repo.mjs'
import { GatewayWorkerClient } from './gateway-client.mjs'
import { GatewayWorkerService, gatewayAccountProtection } from './gateway-execution.mjs'
import { readClientProfileSetting, readPrivacyPolicySetting } from './codex-client-profile.mjs'
import { normalizeCodexWarmup } from '../protocol/codex-route.mjs'
import { GatewayAccountManagement } from './account-management.mjs'
import { verifyGatewayHeaders } from './gateway-auth.mjs'
import { runGatewayAccountTestChat } from './gateway-test-chat.mjs'
import { quotaForecastForAccount } from './quota-forecast.mjs'
import { readVendorUsage } from '../vendor/vendor-account-usage.mjs'
import { projectVendorUsage } from '../vendor/projections/usage-projection.mjs'

function errorPayload(code, message) {
  return { ok: false, error: { code, message } }
}

function requireOperator(req, role = 'super_admin') {
  const actual = panelIdentity(req).role
  if (actual === role || (role === 'admin' && actual === 'super_admin')) return null
  return errorPayload('forbidden', '当前权限无法执行此操作')
}

const internalNonceCache = new Map()
function consumeInternalNonce(nonce, now = Date.now()) {
  for (const [key, seenAt] of internalNonceCache) {
    if (now - seenAt > 10 * 60 * 1000) internalNonceCache.delete(key)
  }
  if (!nonce || internalNonceCache.has(nonce)) return false
  internalNonceCache.set(nonce, now)
  // Bound memory if a misconfigured worker floods the control plane.
  if (internalNonceCache.size > 20_000) {
    const oldest = internalNonceCache.keys().next().value
    if (oldest) internalNonceCache.delete(oldest)
  }
  return true
}

// 部署收敛为“一个 Node + 一个 Worker”（同机侧车）：账号的并发、RPM、冷却与错误计数都在 Worker 进程内，
// 单实例时只有一份，与 CPR 单进程语义一致。默认拒绝第二个接单实例注册；原实例 drain 或失联（45 秒无心跳）
// 后新实例可以接替，滚动替换不受影响。确需多 Worker（出口分布在多台机器等）时设置
// KIN_CODEX_GATEWAY_MULTI_WORKER=1，此时账号限额按实例各算一份、冻结经心跳共享。
export function gatewayMultiWorkerEnabled(env = process.env) {
  return ['1', 'true', 'yes', 'on'].includes(
    String(env.KIN_CODEX_GATEWAY_MULTI_WORKER || '')
      .trim()
      .toLowerCase(),
  )
}

export function singleWorkerConflict(repo, input = {}, env = process.env) {
  if (gatewayMultiWorkerEnabled(env)) return null
  const id = String(input.id || '').trim()
  // 自身 drain、下线或不健康时不占用执行面，也不阻止其他实例
  const accepting =
    ['healthy', 'degraded'].includes(String(input.health_state || 'healthy')) &&
    String(input.drain_state || 'accepting') === 'accepting'
  if (!accepting) return null
  const holder = repo.activeInstances().find((other) => other !== id)
  if (!holder) return null
  return errorPayload(
    'gateway_single_worker',
    `单 Worker 模式下已有在线实例 ${holder}；请先 Drain 或停止它，或设置 KIN_CODEX_GATEWAY_MULTI_WORKER=1 启用多 Worker`,
  )
}

export function createGatewayWorkerRoutes({
  json: sendJson,
  readBody,
  proxyPool,
  supervisor = null,
  secret = process.env.KIN_CODEX_GATEWAY_INTERNAL_TOKEN || '',
} = {}) {
  // Worker 会把上游账号的 401（令牌过期、刷新失败）原样返回；面板 401 只表示面板会话失效，
  // 前端 panelFetch 收到后会清会话并跳回登录页，所以这里与 panel-routes 的 upstreamFetchStatus 一致改为 502。
  const json = (res, status, body) => sendJson(res, status === 401 ? 502 : status, body)
  const repo = new GatewayWorkerRepo()
  const client = new GatewayWorkerClient({ repo, secret })

  const service = new GatewayWorkerService({ repo, secret })
  const accounts = new GatewayAccountManagement({ repo, service, proxyPool })

  return async function handleGatewayWorkerRoutes(req, res, url) {
    const path = url.pathname
    if (
      !path.startsWith('/api/panel/gateway-workers') &&
      !path.startsWith('/api/panel/codex-accounts') &&
      path !== '/api/panel/gateway-execution-policies'
    )
      return false
    const operatorError = requireOperator(req, 'super_admin')
    if (operatorError) {
      json(res, 403, operatorError)
      return true
    }

    if (req.method === 'GET' && path === '/api/panel/gateway-workers') {
      json(res, 200, {
        ok: true,
        items: repo.listInstances(),
        multi_worker: gatewayMultiWorkerEnabled(),
        // 控制面托管的同机 Worker 进程状态（external 表示 Worker 由外部管理）
        supervisor: supervisor?.status?.() || null,
      })
      return true
    }
    if (req.method === 'POST' && path === '/api/panel/gateway-workers/register') {
      const body = await readBody(req, 64 * 1024)
      const conflict = singleWorkerConflict(repo, { health_state: 'healthy', drain_state: 'accepting', ...body })
      if (conflict) return json(res, 409, conflict)
      const row = repo.upsertInstance({
        ...body,
        health_state: body.health_state || 'unknown',
      })
      json(res, 200, { ok: true, instance: row })
      return true
    }
    const instanceMatch = path.match(
      /^\/api\/panel\/gateway-workers\/([^/]+)(?:\/(health|capabilities|drain|resume))?$/,
    )
    if (instanceMatch) {
      const instanceId = decodeURIComponent(instanceMatch[1])
      const action = instanceMatch[2]
      if (req.method === 'GET' && !action) {
        const row = repo.getInstance(instanceId)
        if (!row) return json(res, 404, errorPayload('gateway_instance_not_found', 'Gateway Worker 实例不存在'))
        json(res, 200, { ok: true, instance: row })
        return true
      }
      if (req.method === 'POST' && action) {
        try {
          const body = action === 'drain' ? await readBody(req, 8 * 1024) : {}
          const result =
            action === 'health'
              ? await client.health(instanceId)
              : action === 'capabilities'
                ? await client.capabilities(instanceId)
                : await client.control(instanceId, action, body)
          json(res, result.ok ? 200 : result.status || 502, result)
        } catch (error) {
          json(
            res,
            error.status || 502,
            errorPayload(error.code || 'gateway_worker_unavailable', error.message || String(error)),
          )
        }
        return true
      }
    }

    if (path.startsWith('/api/panel/codex-accounts/')) {
      const base = '/api/panel/codex-accounts'
      const actor = String(req.panelUserId || panelIdentity(req).user || 'master')
      const draft = path.match(
        /^\/api\/panel\/codex-accounts\/drafts\/([^/]+)\/(oauth\/(generate-auth-url|exchange-code)|import)$/,
      )
      const edit = path.match(/^\/api\/panel\/codex-accounts\/([^/]+)(?:\/(catalog|drafts))?$/)
      try {
        let result
        if (path === base + '/catalog' && req.method === 'GET') result = accounts.catalog()
        else if (path.endsWith('/test-chat') && req.method === 'POST') {
          const account = accounts.account(decodeURIComponent(path.slice(base.length + 1, -'/test-chat'.length)))
          result = await runGatewayAccountTestChat({ service, account, body: await readBody(req, 64 * 1024) })
          json(res, 200, { ok: true, data: result })
          return true
        } else if (path.endsWith('/usage') && req.method === 'GET') {
          // Same report as the supplier account usage dialog; Gateway rows are keyed gateway:<account>.
          const account = accounts.account(decodeURIComponent(path.slice(base.length + 1, -'/usage'.length)))
          const report = readVendorUsage(repo.db, [`gateway:${account.id}`], Object.fromEntries(url.searchParams))
          json(res, 200, {
            ok: true,
            data: projectVendorUsage({ account_id: account.id, name: account.name, ...report }),
          })
          return true
        } else if (path === base + '/bulk-edit' && req.method === 'POST')
          result = await accounts.bulkUpdate(actor, await readBody(req, 256 * 1024))
        else if (path === base + '/drafts' && req.method === 'POST')
          result = { draft: accounts.createDraft(actor, await readBody(req, 64 * 1024)) }
        else if (draft && req.method === 'POST') {
          const id = decodeURIComponent(draft[1])
          if (draft[3] === 'generate-auth-url') result = await accounts.start(actor, id)
          else if (draft[3] === 'exchange-code')
            result = await accounts.complete(actor, id, await readBody(req, 16 * 1024))
          else result = await accounts.import(actor, id, await readBody(req, 1024 * 1024))
        } else if (edit?.[2] === 'catalog' && req.method === 'GET')
          result = accounts.catalog(accounts.account(decodeURIComponent(edit[1])))
        else if (edit?.[2] === 'drafts' && req.method === 'POST')
          result = { draft: accounts.createDraft(actor, await readBody(req, 64 * 1024), decodeURIComponent(edit[1])) }
        else if (edit && !edit[2] && req.method === 'PATCH')
          result = await accounts.update(actor, decodeURIComponent(edit[1]), await readBody(req, 64 * 1024))
        if (result) {
          json(res, 200, { ok: true, ...result })
          return true
        }
      } catch (error) {
        json(res, error.status || 502, errorPayload(error.code || 'gateway_account_failed', error.message))
        return true
      }
    }

    if (req.method === 'GET' && path === '/api/panel/codex-accounts') {
      json(res, 200, {
        ok: true,
        items: repo.listCodexAccounts({ includeArchived: url.searchParams.get('archived') === 'all' }),
      })
      return true
    }
    if (path === '/api/panel/gateway-execution-policies') {
      const vendorId = String(url.searchParams.get('vendor_id') || '').trim()
      if (req.method === 'GET') {
        const rows = getDb()
          .prepare('SELECT * FROM vendor_execution_policies WHERE vendor_id=? ORDER BY platform,execution_kind')
          .all(vendorId)
        json(res, 200, { ok: true, items: rows })
        return true
      }
      if (req.method === 'PUT') {
        const body = await readBody(req, 64 * 1024)
        const stamp = new Date().toISOString()
        const platform = String(body.platform || 'openai')
        const executionKind = String(body.execution_kind || 'gateway_worker')
        getDb()
          .prepare(
            `INSERT INTO vendor_execution_policies(vendor_id,platform,execution_kind,allow_create,allow_runtime,revision,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(vendor_id,platform,execution_kind) DO UPDATE SET allow_create=excluded.allow_create,allow_runtime=excluded.allow_runtime,revision=vendor_execution_policies.revision+1,updated_by=excluded.updated_by,updated_at=excluded.updated_at`,
          )
          .run(
            vendorId,
            platform,
            executionKind,
            body.allow_create ? 1 : 0,
            body.allow_runtime ? 1 : 0,
            1,
            req.panelUserId || 'master',
            stamp,
            stamp,
          )
        const row = getDb()
          .prepare('SELECT * FROM vendor_execution_policies WHERE vendor_id=? AND platform=? AND execution_kind=?')
          .get(vendorId, platform, executionKind)
        json(res, 200, { ok: true, policy: row })
        return true
      }
    }
    const forecastMatch = path.match(/^\/api\/panel\/codex-accounts\/([^/]+)\/quota-forecast$/)
    if (forecastMatch && req.method === 'GET') {
      const accountId = decodeURIComponent(forecastMatch[1])
      const item = repo.listCodexAccounts({ includeArchived: true }).find((row) => row.id === accountId)
      if (!item) return json(res, 404, errorPayload('account_not_found', 'Codex 账号不存在'))
      json(res, 200, { ok: true, ...quotaForecastForAccount(getDb(), item) })
      return true
    }
    const accountMatch = path.match(/^\/api\/panel\/codex-accounts\/([^/]+)$/)
    if (accountMatch && req.method === 'GET') {
      const accountId = decodeURIComponent(accountMatch[1])
      const item = repo.listCodexAccounts({ includeArchived: true }).find((row) => row.id === accountId)
      if (!item) return json(res, 404, errorPayload('account_not_found', 'Codex 账号不存在'))
      json(res, 200, { ok: true, account: item, receipts: repo.listAccountReceipts(accountId) })
      return true
    }
    const insightMatch = path.match(/^\/api\/panel\/codex-accounts\/([^/]+)\/(profile|subscription|avatar)$/)
    if (insightMatch && req.method === 'GET') {
      const accountId = decodeURIComponent(insightMatch[1])
      const item = repo.listCodexAccounts({ includeArchived: true }).find((row) => row.id === accountId)
      if (!item) return json(res, 404, errorPayload('account_not_found', 'Codex 账号不存在'))
      const kind = insightMatch[2]
      try {
        const query =
          kind === 'avatar' ? new URLSearchParams({ source: url.searchParams.get('source') || '' }).toString() : ''
        const result = await service.accountInsight(accountId, kind, query)
        if (kind === 'avatar' && result.ok && result.body) {
          // 头像正文流式透传，不在控制面累积；只转发类型、长度与 ETag
          const headers = { 'cache-control': 'private, max-age=300' }
          for (const name of ['content-type', 'content-length', 'etag'])
            if (result.headers?.[name]) headers[name] = result.headers[name]
          res.writeHead(200, headers)
          const reader = result.body.getReader()
          res.once('close', () => result.cancel?.())
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            if (!res.write(value)) await new Promise((resolve) => res.once('drain', resolve))
          }
          result.release?.()
          res.end()
          return true
        }
        if (kind === 'avatar') {
          result.cancel?.()
          return json(res, result.status || 502, errorPayload('avatar_unavailable', '头像暂不可用'))
        }
        if (!result.ok) {
          const error = result.data?.error || {}
          return json(
            res,
            result.status || 502,
            errorPayload(error.code || 'gateway_worker_unavailable', error.message || 'Gateway Worker 账号查询失败'),
          )
        }
        json(res, 200, result.data)
      } catch (error) {
        if (!res.headersSent)
          json(
            res,
            error.status || 502,
            errorPayload(error.code || 'gateway_worker_unavailable', error.message || String(error)),
          )
        else res.destroy(error)
      }
      return true
    }
    const accountActionMatch = path.match(
      /^\/api\/panel\/codex-accounts\/([^/]+)\/(pause|resume|refresh|recover|reauthorize|test|quota|reset-credits|status)$/,
    )
    if (accountActionMatch && req.method === 'POST') {
      const accountId = decodeURIComponent(accountActionMatch[1])
      const item = repo.listCodexAccounts({ includeArchived: true }).find((row) => row.id === accountId)
      if (!item) return json(res, 404, errorPayload('account_not_found', 'Codex 账号不存在'))
      try {
        const body = await readBody(req, 64 * 1024)
        const action = accountActionMatch[2]
        if (['pause', 'resume'].includes(action)) {
          const result = await accounts.update(String(req.panelUserId || 'master'), accountId, {
            status: action === 'pause' ? 'paused' : 'active',
          })
          json(res, 200, { ok: true, ...result })
          return true
        }
        if (action === 'reauthorize') {
          json(res, 400, errorPayload('oauth_draft_required', '请通过账号授权对话框完成重新授权'))
          return true
        }
        const result = await service.accountAction(accountId, action, body)
        if (!result.ok) {
          // 把 Worker 的错误提到顶层，前端才能显示真实原因；重置卡的幂等键随错误返回供重试复用
          const error = result.data?.error || result.results?.find((item) => !item.ok)?.data?.error || {}
          json(res, result.status && result.status !== 207 ? result.status : 502, {
            ok: false,
            error: {
              code: error.code || 'gateway_worker_unavailable',
              message: error.message || 'Gateway Worker 账号操作失败',
            },
            data: { redeem_request_id: result.data?.redeem_request_id, outcome: result.data?.outcome },
          })
          return true
        }
        const { headers: _internalHeaders, ...visible } = result
        json(res, 200, visible)
      } catch (error) {
        json(
          res,
          error.status || 502,
          errorPayload(error.code || 'gateway_worker_unavailable', error.message || String(error)),
        )
      }
      return true
    }
    return json(res, 404, errorPayload('not_found', 'Gateway Worker 路由不存在'))
  }
}

async function readSignedJson(req, { readBody, readRawBody }, maxBytes) {
  // Verify the exact bytes that the worker signed. Parsing first and then
  // serializing lets object key order (and escaping) change the HMAC input.
  if (typeof readRawBody === 'function') {
    const raw = await readRawBody(req, maxBytes)
    const text = Buffer.from(raw).toString('utf8')
    if (!text) return { raw, body: {} }
    try {
      return { raw, body: JSON.parse(text) }
    } catch (error) {
      throw Object.assign(new Error(`Request body is not valid JSON: ${error.message || 'parse error'}`), {
        status: 400,
        code: 'invalid_json',
      })
    }
  }
  const body = await readBody(req, maxBytes)
  return { raw: body, body }
}

export function createGatewayInternalReceiptRoute({ json, readBody, readRawBody } = {}) {
  const repo = new GatewayWorkerRepo()
  const token = process.env.KIN_CODEX_GATEWAY_INTERNAL_TOKEN || ''
  const client = new GatewayWorkerClient({ repo, secret: token })
  return async function handleGatewayInternalReceipt(req, res, url) {
    if (url.pathname !== '/internal/v1/gateway/receipts') return false
    if (req.method !== 'POST') return json(res, 405, errorPayload('method_not_allowed', 'method not allowed'))
    if (!token || req.headers['x-kin-gateway-token'] !== token)
      return json(res, 401, errorPayload('invalid_internal_auth', '内部凭据无效'))
    let signed
    try {
      signed = await readSignedJson(req, { readBody, readRawBody }, 4 * 1024 * 1024)
    } catch (error) {
      return json(res, error.status || 400, errorPayload(error.code || 'invalid_json', error.message || String(error)))
    }
    const { body, raw } = signed
    const signature = verifyGatewayHeaders({ secret: token, headers: req.headers, body: raw })
    if (!signature.ok) return json(res, 401, errorPayload('invalid_internal_auth', 'Receipt 签名无效'))
    if (!consumeInternalNonce(signature.nonce))
      return json(res, 409, errorPayload('dispatch_replayed', 'Receipt 请求已重放'))
    const result = repo.ingestReceipt(body)
    if (result.rejected) return json(res, 400, errorPayload(result.code, result.message))
    if (body.gateway_instance_id && body.dispatch_id) {
      try {
        await client.ackReceipt(body.gateway_instance_id, body.dispatch_id, result.receipt_id)
      } catch {}
    }
    json(res, 200, { ok: true, ...result })
    return true
  }
}

// 心跳响应携带后台策略：账号错误保护对所有实例下发；预热只交给一个在线实例（按实例 ID 最小者），
// 避免同一账号被多个 Worker 重复预热。
export function gatewayHeartbeatPolicy(repo, instanceId, routing = {}) {
  const warmup = normalizeCodexWarmup(routing?.codex?.warmup)
  const online = repo
    .listInstances()
    .filter(
      (row) =>
        ['healthy', 'degraded'].includes(row.health_state) &&
        row.drain_state === 'accepting' &&
        (!row.last_heartbeat_at || Date.now() - Date.parse(row.last_heartbeat_at) < 45_000),
    )
    .map((row) => row.id)
    .sort()
  const designated = online[0] === instanceId
  const profile = readClientProfileSetting(repo.db)
  return {
    account_protection: gatewayAccountProtection(repo.db),
    warmup: designated ? warmup : { enabled: false, times: [], model: '' },
    // 后台请求（额度、目录、探测、预热）使用通用画像；隐私规则作为信封未携带时的回退
    client_profile: profile.selection,
    profile_deployment: profile.deployment,
    privacy: readPrivacyPolicySetting(repo.db),
    // 其他实例冻结的同一上游账号：本实例也暂停接单（来源实例负责探测与解冻）
    account_freezes: repo.peerAccountFreezes(instanceId),
  }
}

export function createGatewayInternalRegistrationRoute({
  json,
  readBody,
  readRawBody,
  getRoutingConfig = () => ({}),
} = {}) {
  const repo = new GatewayWorkerRepo()
  const token = process.env.KIN_CODEX_GATEWAY_INTERNAL_TOKEN || ''
  const service = new GatewayWorkerService({ repo, secret: token })
  return async function handleGatewayInternalRegistration(req, res, url) {
    if (!['/internal/v1/gateway/workers/register', '/internal/v1/gateway/workers/heartbeat'].includes(url.pathname))
      return false
    if (req.method !== 'POST') return json(res, 405, errorPayload('method_not_allowed', 'method not allowed'))
    if (!token || req.headers['x-kin-gateway-token'] !== token)
      return json(res, 401, errorPayload('invalid_internal_auth', '内部凭据无效'))
    let signed
    try {
      signed = await readSignedJson(req, { readBody, readRawBody }, 512 * 1024)
    } catch (error) {
      return json(res, error.status || 400, errorPayload(error.code || 'invalid_json', error.message || String(error)))
    }
    const { body, raw } = signed
    const signature = verifyGatewayHeaders({ secret: token, headers: req.headers, body: raw })
    if (!signature.ok) return json(res, 401, errorPayload('invalid_internal_auth', 'Worker 注册签名无效'))
    if (!consumeInternalNonce(signature.nonce))
      return json(res, 409, errorPayload('dispatch_replayed', 'Worker 请求已重放'))
    const conflict = singleWorkerConflict(repo, body)
    if (conflict) return json(res, 409, conflict)
    const instance = repo.upsertInstance(body)
    if (instance?.id)
      void service.projectAllAccountsTo(instance.id, { revisions: body?.account_revisions }).catch(() => {})
    if (instance?.id && Array.isArray(body?.protection_freezes)) {
      try {
        repo.recordAccountFreezes(instance.id, body.protection_freezes)
      } catch {}
    }
    if (instance?.id) {
      try {
        repo.recordRuntimeLoad(instance.id, body || {})
      } catch {}
      try {
        repo.recordRuntimeCredentials(instance.id, body?.account_credentials)
      } catch {}
    }
    if (instance?.id && Array.isArray(body?.account_quotas)) {
      try {
        repo.recordRuntimeQuotas(instance.id, body.account_quotas)
      } catch {}
    }
    let policy
    try {
      policy = instance?.id ? gatewayHeartbeatPolicy(repo, instance.id, getRoutingConfig()) : undefined
    } catch {}
    return json(res, 200, { ok: true, instance, ...(policy ? { policy } : {}) })
  }
}
