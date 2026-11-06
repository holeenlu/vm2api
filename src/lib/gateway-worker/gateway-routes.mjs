import crypto from 'node:crypto'
import { audit } from '../admin/relay-common.mjs'
import { getDb } from '../db/database.mjs'
import { dbClient } from '../db/db-client.mjs'
import { identityCanResource, ownerChangeDenied, panelIdentity } from '../admin/panel-acl.mjs'
import { resourceRouteRequirement } from '../admin/resource-permissions.mjs'
import { VendorPlatform } from '../vendor/vendor-platform.mjs'
import { assertVendorOwnedWritable } from '../vendor/vendor-admin.mjs'
import { GatewayWorkerRepo } from './gateway-repo.mjs'
import { executorEventsMode } from '../executor/contract.mjs'
import { controlPlaneStatus, logControlPlaneSwitches } from '../executor/control-plane-status.mjs'
import { createRefreshLeases, designatedRefreshAccounts } from '../executor/refresh-lease.mjs'
import { GatewayWorkerClient } from './gateway-client.mjs'
import { GatewayWorkerService, gatewayAccountProtection } from './gateway-execution.mjs'
import { readClientProfileSetting, readPrivacyPolicySetting } from './codex-client-profile.mjs'
import { codexSettingsSnapshot, saveCodexSettings } from '../executor/settings-store.mjs'
import { CODEX_SETTINGS_SCHEMA, schemaVersions } from '../executor/settings-schema.mjs'
import { GatewayAccountManagement } from './account-management.mjs'
import { supervisedCustodyIdentity } from './worker-supervisor.mjs'
import { verifyGatewayHeaders } from './gateway-auth.mjs'
import { runGatewayAccountTestChat } from './gateway-test-chat.mjs'
import { attachListForecasts, pooledQuotaForecast } from './quota-forecast.mjs'
import { readVendorUsagePooled } from '../vendor/vendor-account-usage.mjs'
import { projectVendorUsage } from '../vendor/projections/usage-projection.mjs'
import {
  getVendorExecutionPolicy,
  listVendorExecutionPolicies,
  upsertVendorExecutionPolicy,
} from './repos/execution-policies-repo.mjs'
import { eventCursor, recentAccountStateProblem } from './repos/event-health-repo.mjs'

function errorPayload(code, message) {
  return { ok: false, error: { code, message } }
}

function requireOperator(req, role = 'super_admin') {
  const actual = panelIdentity(req).role
  if (actual === role || (role === 'admin' && actual === 'super_admin')) return null
  return errorPayload('forbidden', '当前权限无法执行此操作')
}

/** Codex 账号路由按资源能力校验（与面板路由层同一份 resourceRouteRequirement）；super_admin 拥有全部能力。 */
function requireResource(req, path) {
  const level = resourceRouteRequirement(req.method, path)
  if (level && identityCanResource(panelIdentity(req), level)) return null
  return errorPayload('forbidden', '当前权限无法执行此操作')
}

function forbidUnlessManage(req, message) {
  if (identityCanResource(panelIdentity(req), 'manage')) return
  throw Object.assign(new Error(message), { status: 403, code: 'resource_manage_required' })
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

export async function singleWorkerConflict(repo, input = {}, env = process.env) {
  if (gatewayMultiWorkerEnabled(env)) return null
  const id = String(input.id || '').trim()
  // 自身 drain、下线或不健康时不占用执行面，也不阻止其他实例
  const accepting =
    ['healthy', 'degraded'].includes(String(input.health_state || 'healthy')) &&
    String(input.drain_state || 'accepting') === 'accepting'
  if (!accepting) return null
  const holder = (await repo.activeInstances()).find((other) => other !== id)
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
  // 启动时打印一次生效的开关值，拼错的值告警（审计 U8）
  logControlPlaneSwitches()

  const service = new GatewayWorkerService({ repo, secret })
  const accounts = new GatewayAccountManagement({ repo, service, proxyPool })
  let vendorPlatform = null
  // 供应商自有的 Gateway 账号与供应商 VM 同一规则：供应商及父级须为启用状态。
  // 账号池的字段白名单约束的是供应商身份；平台运营仍可调整并发、权重等调度参数。
  const guardVendorAccount = async (account, actor) => {
    if (!account?.vendor_id) return
    vendorPlatform ||= new VendorPlatform(repo.db)
    await assertVendorOwnedWritable(vendorPlatform, account.vendor_id, actor)
  }

  return async function handleGatewayWorkerRoutes(req, res, url) {
    const path = url.pathname
    if (
      !path.startsWith('/api/panel/gateway-workers') &&
      !path.startsWith('/api/panel/codex-accounts') &&
      !path.startsWith('/api/panel/gateway-execution-policies')
    )
      return false
    // Worker 实例与执行策略仍只属于 super_admin；Codex 账号按授予的资源能力放行
    const operatorError = path.startsWith('/api/panel/codex-accounts')
      ? requireResource(req, path)
      : requireOperator(req, 'super_admin')
    if (operatorError) {
      json(res, 403, operatorError)
      return true
    }

    if (req.method === 'GET' && path === '/api/panel/gateway-workers') {
      json(res, 200, {
        ok: true,
        // 托管公钥指纹（SHA-256 前 8 字节）：与 Worker 启动日志、健康接口里的指纹带外核对后再确认替换（R3 复审 N8）
        items: (await repo.listInstances()).map((item) => ({
          ...item,
          custody_key_fingerprint: custodyKeyFingerprint(item.custody_public_key),
          custody_key_pending_fingerprint: custodyKeyFingerprint(item.custody_key_pending),
        })),
        multi_worker: gatewayMultiWorkerEnabled(),
        // 控制面托管的同机 Worker 进程状态（external 表示 Worker 由外部管理）
        supervisor: supervisor?.status?.() || null,
        // 开关生效值、事件收件箱与刷新租约状态（审计 U8）
        control_plane: await controlPlaneStatus({ db: repo.db, repo }),
      })
      return true
    }
    // 确认替换实例托管公钥（R3 审查 P1-5）：只接受与待确认公钥一致的请求
    const custodyAccept = /^\/api\/panel\/gateway-workers\/([^/]+)\/custody-key\/accept$/.exec(path)
    if (custodyAccept && req.method === 'POST') {
      const body = await readBody(req, 4 * 1024)
      const instanceId = decodeURIComponent(custodyAccept[1])
      // 替换公钥与审计在同一事务：审计写不进去时公钥保持待确认（数据访问分层 R3）
      const accepted = await dbClient(repo.db).tx(async () => {
        if (!(await repo.acceptCustodyKey(instanceId, body?.public_key))) return false
        await audit(
          repo.db,
          String(req.panelUserId || panelIdentity(req).user || 'master'),
          'gateway.instance.custody_key_accepted',
          instanceId,
          null,
          {
            public_key: body.public_key,
          },
        )
        return true
      })
      if (!accepted) {
        json(res, 409, errorPayload('custody_key_not_pending', '没有与之一致的待确认托管公钥'))
        return true
      }
      json(res, 200, { ok: true, instance: await repo.getInstance(instanceId) })
      return true
    }
    // Codex 本地设置（P4.2、P4.4）：值、配置版本与设置描述；保存按描述在服务端校验
    if (path === '/api/panel/gateway-workers/settings') {
      if (req.method === 'GET') {
        const snapshot = codexSettingsSnapshot(repo.db)
        json(res, 200, {
          ok: true,
          values: snapshot.values,
          revision: snapshot.revision,
          schema: CODEX_SETTINGS_SCHEMA,
        })
        return true
      }
      if (req.method === 'PUT') {
        const body = await readBody(req, 64 * 1024)
        try {
          const actor = String(req.panelUserId || panelIdentity(req).user || 'master')
          // expected_revision：乐观锁，期间有人改过设置时返回 409（R4 审查 P2-3）
          const saved = await saveCodexSettings(repo.db, body?.values ?? body, actor, {
            expectedRevision: body?.values ? (body.expected_revision ?? null) : null,
          })
          json(res, 200, { ok: true, values: saved.values, revision: saved.revision, changed: saved.changed })
        } catch (error) {
          if (error?.code === 'settings_revision_conflict') {
            json(res, 409, { ok: false, error: { code: error.code, message: error.message, revision: error.revision } })
            return true
          }
          if (error?.code === 'settings_unavailable') {
            json(res, 503, errorPayload(error.code, error.message))
            return true
          }
          if (!error?.errors) throw error
          json(res, 400, {
            ok: false,
            error: { code: error.code, message: error.message, fields: error.errors || [] },
          })
        }
        return true
      }
      json(res, 405, errorPayload('method_not_allowed', 'method not allowed'))
      return true
    }
    if (req.method === 'POST' && path === '/api/panel/gateway-workers/register') {
      const body = await readBody(req, 64 * 1024)
      const conflict = await singleWorkerConflict(repo, { health_state: 'healthy', drain_state: 'accepting', ...body })
      if (conflict) return json(res, 409, conflict)
      // 心跳时间由控制面记录（最终审计 I1）：手动登记不接受请求里带的时间
      const { last_heartbeat_at: _given, ...registered } = body || {}
      const row = await repo.upsertInstance({
        ...registered,
        health_state: registered.health_state || 'unknown',
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
        const row = await repo.getInstance(instanceId)
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
      const edit = path.match(/^\/api\/panel\/codex-accounts\/([^/]+)(?:\/(catalog|drafts|pool-proxy))?$/)
      const bps = path.match(
        /^\/api\/panel\/codex-accounts\/([^/]+)\/bps(?:\/(import|models|unblock|recovery\/stop))?$/,
      )
      try {
        let result
        if (path === base + '/catalog' && req.method === 'GET') result = await accounts.catalog()
        else if (path.endsWith('/test-chat') && req.method === 'POST') {
          const account = await accounts.account(decodeURIComponent(path.slice(base.length + 1, -'/test-chat'.length)))
          const body = await readBody(req, 64 * 1024)
          result = await runGatewayAccountTestChat({ service, account, body })
          // BPS 严格探测的结果作为验证证据记在账号上（模型、通道、时间、是否通过）
          if (body?.verify_tools === true && body?.route === 'bps')
            await accounts.recordBpsVerification(account.id, result)
          json(res, 200, { ok: true, data: result })
          return true
        } else if (path.endsWith('/usage') && req.method === 'GET') {
          // Same report as the supplier account usage dialog; Gateway rows are keyed gateway:<account>.
          const account = await accounts.account(decodeURIComponent(path.slice(base.length + 1, -'/usage'.length)))
          const report = await readVendorUsagePooled(
            repo.db,
            [`gateway:${account.id}`],
            Object.fromEntries(url.searchParams),
          )
          json(res, 200, {
            ok: true,
            data: projectVendorUsage({ account_id: account.id, name: account.name, ...report }),
          })
          return true
        } else if (path === base + '/export' && req.method === 'POST')
          result = await accounts.exportAccounts(actor, (await readBody(req, 256 * 1024))?.ids)
        else if (path === base + '/import-file' && req.method === 'POST')
          result = await accounts.importAccounts(actor, await readBody(req, 16 * 1024 * 1024))
        else if (path === base + '/bulk-edit' && req.method === 'POST') {
          const input = await readBody(req, 256 * 1024)
          if (ownerChangeDenied(panelIdentity(req), input?.patch)) forbidUnlessManage(req, '修改归属需要资源管理权限')
          const ids = new Set(Array.isArray(input?.ids) ? input.ids : [])
          for (const account of await repo.listCodexAccounts({ includeArchived: true }))
            if (ids.has(account.id)) await guardVendorAccount(account, actor)
          result = await accounts.bulkUpdate(actor, input)
        } else if (bps && bps[2] === 'import' && req.method === 'POST')
          result = await accounts.importBps(actor, decodeURIComponent(bps[1]), await readBody(req, 1024 * 1024))
        else if (bps && (bps[2] === 'unblock' || bps[2] === 'recovery/stop') && req.method === 'POST')
          result = await accounts.bpsRecoveryAction(
            actor,
            decodeURIComponent(bps[1]),
            bps[2] === 'unblock' ? 'unblock' : 'stop',
          )
        else if (bps && bps[2] === 'models' && req.method === 'GET')
          result = await accounts.bpsModels(decodeURIComponent(bps[1]), {
            refresh: url.searchParams.get('refresh') === '1',
          })
        else if (bps && !bps[2] && req.method === 'DELETE')
          result = await accounts.revokeBps(actor, decodeURIComponent(bps[1]))
        else if (path === base + '/drafts' && req.method === 'POST')
          result = { draft: await accounts.createDraft(actor, await readBody(req, 64 * 1024)) }
        else if (draft && req.method === 'POST') {
          const id = decodeURIComponent(draft[1])
          if (draft[3] === 'generate-auth-url') result = await accounts.start(actor, id)
          else if (draft[3] === 'exchange-code')
            result = await accounts.complete(actor, id, await readBody(req, 16 * 1024))
          else result = await accounts.import(actor, id, await readBody(req, 1024 * 1024))
        } else if (edit?.[2] === 'catalog' && req.method === 'GET')
          result = await accounts.catalog(await accounts.account(decodeURIComponent(edit[1])))
        else if (edit?.[2] === 'drafts' && req.method === 'POST')
          result = {
            draft: await accounts.createDraft(actor, await readBody(req, 64 * 1024), decodeURIComponent(edit[1])),
          }
        else if (edit?.[2] === 'pool-proxy' && req.method === 'POST')
          result = await accounts.poolInlineProxy(actor, decodeURIComponent(edit[1]))
        else if (edit && !edit[2] && req.method === 'PATCH') {
          const id = decodeURIComponent(edit[1])
          const body = await readBody(req, 64 * 1024)
          // 归档与改归属属于「管理」；其余字段「编辑」即可
          if (body?.status === 'archived') forbidUnlessManage(req, '归档账号需要资源管理权限')
          if (ownerChangeDenied(panelIdentity(req), body)) forbidUnlessManage(req, '修改归属需要资源管理权限')
          await guardVendorAccount(await accounts.account(id), actor)
          result = await accounts.update(actor, id, body)
        } else if (edit && !edit[2] && req.method === 'DELETE') {
          // 永久删除：路由层已要求「管理」；供应商自有账号同样要求供应商及父级启用
          const id = decodeURIComponent(edit[1])
          await guardVendorAccount(await accounts.account(id), actor)
          result = await accounts.remove(actor, id)
        }
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
        items: await attachListForecasts(
          getDb(),
          await repo.listCodexAccounts({ includeArchived: url.searchParams.get('archived') === 'all' }),
        ),
      })
      return true
    }
    if (path === '/api/panel/gateway-execution-policies') {
      const vendorId = String(url.searchParams.get('vendor_id') || '').trim()
      if (req.method === 'GET') {
        const rows = await listVendorExecutionPolicies(getDb(), vendorId)
        json(res, 200, { ok: true, items: rows })
        return true
      }
      if (req.method === 'PUT') {
        const body = await readBody(req, 64 * 1024)
        const stamp = new Date().toISOString()
        const platform = String(body.platform || 'openai')
        const executionKind = String(body.execution_kind || 'gateway_worker')
        await upsertVendorExecutionPolicy(
          getDb(),
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
        const row = await getVendorExecutionPolicy(getDb(), vendorId, platform, executionKind)
        json(res, 200, { ok: true, policy: row })
        return true
      }
    }
    const forecastMatch = path.match(/^\/api\/panel\/codex-accounts\/([^/]+)\/quota-forecast$/)
    if (forecastMatch && req.method === 'GET') {
      const accountId = decodeURIComponent(forecastMatch[1])
      const item = (await repo.listCodexAccounts({ includeArchived: true })).find((row) => row.id === accountId)
      if (!item) return json(res, 404, errorPayload('account_not_found', 'Codex 账号不存在'))
      json(res, 200, { ok: true, ...(await pooledQuotaForecast(getDb(), item)) })
      return true
    }
    const accountMatch = path.match(/^\/api\/panel\/codex-accounts\/([^/]+)$/)
    if (accountMatch && req.method === 'GET') {
      const accountId = decodeURIComponent(accountMatch[1])
      const item = (await repo.listCodexAccounts({ includeArchived: true })).find((row) => row.id === accountId)
      if (!item) return json(res, 404, errorPayload('account_not_found', 'Codex 账号不存在'))
      json(res, 200, {
        ok: true,
        account: item,
        receipts: await repo.listAccountReceipts(accountId),
        bps_probes: await repo.listBpsProbes(accountId),
      })
      return true
    }
    const insightMatch = path.match(/^\/api\/panel\/codex-accounts\/([^/]+)\/(profile|subscription|avatar)$/)
    if (insightMatch && req.method === 'GET') {
      const accountId = decodeURIComponent(insightMatch[1])
      const item = (await repo.listCodexAccounts({ includeArchived: true })).find((row) => row.id === accountId)
      if (!item) return json(res, 404, errorPayload('account_not_found', 'Codex 账号不存在'))
      const kind = insightMatch[2]
      try {
        // 头像地址由 Worker 取自账号自己的资料（CPR），不接受调用方指定的来源
        const result = await service.accountInsight(accountId, kind)
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
      const item = (await repo.listCodexAccounts({ includeArchived: true })).find((row) => row.id === accountId)
      if (!item) return json(res, 404, errorPayload('account_not_found', 'Codex 账号不存在'))
      try {
        const body = await readBody(req, 64 * 1024)
        const action = accountActionMatch[2]
        if (['pause', 'resume'].includes(action)) {
          await guardVendorAccount(item, String(req.panelUserId || 'master'))
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
    const result = await repo.ingestReceipt(body)
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

// 心跳响应携带后台策略：账号错误保护对所有实例下发；预热与自动重置卡只交给一个在线实例（按实例 ID 最小者），
// 避免同一账号被多个 Worker 重复执行。
const LEASE_PATHS = {
  '/internal/v1/gateway/workers/credentials/lease': 'acquire',
  '/internal/v1/gateway/workers/credentials/release': 'release',
}

// 事件链路健康：控制面为 primary、Worker 已知控制面在消费且日志健康、控制面在 60 秒内成功拉取过该实例当前事件流
export async function eventsChannelHealthy(repo, instanceId, events, nowMs = Date.now()) {
  if (executorEventsMode() !== 'primary') return false
  if (!events?.stream_id || events.healthy !== true || events.required !== true) return false
  const cursor = await eventCursor(repo.db, instanceId, String(events.stream_id))
  if (!cursor || nowMs - Date.parse(cursor.updated_at) >= 60_000) return false
  // 游标超过 Worker 的事件头：Worker 数据目录回滚，事件可能被跳过，心跳继续兜底写入（终审 A3）
  if (Number.isFinite(Number(events.head)) && Number(cursor.last_seq) > Number(events.head)) return false
  // 最近 5 分钟有账号终态快照无效或被判过时：快照可能长期缺失，心跳继续兜底写入（R1 复审 N5）
  const skipped = await recentAccountStateProblem(repo.db, instanceId, new Date(nowMs - 5 * 60_000).toISOString())
  return !skipped
}

// Codex 本地设置（预热、重置卡、点数超额）来自控制面设置存储（P4.2），连同配置版本一起下发（P4.3）
export async function gatewayHeartbeatPolicy(repo, instanceId) {
  const snapshot = codexSettingsSnapshot(repo.db)
  const settings = snapshot.values
  const warmup = settings.warmup
  const online = (await repo.listInstances())
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
    // 自动重置卡同样只交给一个实例执行，避免同一账号被多个 Worker 重复消费
    reset_credit: { enabled: designated, ...settings.reset_credit },
    // 点数超额开关对所有实例下发；默认关闭时 Worker 把窗口用尽、只靠点数出量的账号停放到窗口重置
    credit_overage: settings.credit_overage === true,
    // 本次策略依据的 Codex 设置版本（与上面的值同一快照）：Worker 记录已应用的版本，在健康接口与心跳中报告
    settings_revision: snapshot.revision,
    // 后台请求（额度、目录、探测、预热）使用通用画像；隐私规则作为信封未携带时的回退
    client_profile: profile.selection,
    profile_deployment: profile.deployment,
    privacy: readPrivacyPolicySetting(repo.db),
    // 其他实例冻结的同一上游账号：本实例也暂停接单（来源实例负责探测与解冻）
    account_freezes: await repo.peerAccountFreezes(instanceId),
    // 控制面是否消费事件发件箱：不消费时 Worker 自行确认、不因事件积压拒单（R1 审查 P0-1）；
    // enforce 只在 primary 为真：shadow 只比对，日志故障不让 Worker 拒单（终审 A5）
    executor_events: { required: executorEventsMode() !== 'off', enforce: executorEventsMode() === 'primary' },
    // 凭据刷新租约（P3.1，恒开）：Worker 刷新前必须先取得租约；
    // designated 是指派给本实例做定时预刷新的运行账号（P3.3），未指派的账号本实例不做定时刷新
    refresh_lease: {
      required: true,
      designated: designatedRefreshAccounts(await repo.listAllAccountBindings(), online, instanceId),
    },
  }
}

export function custodyKeyFingerprint(publicKey) {
  if (typeof publicKey !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(publicKey)) return null
  return crypto.createHash('sha256').update(Buffer.from(publicKey, 'base64url')).digest('hex').slice(0, 16)
}

const schemaWarnings = new Set()
export function warnSchemaMismatch(instanceId, capabilities = {}, log = console) {
  const local = schemaVersions()
  const remote = {
    settings: Number(capabilities?.settings_schema?.version || 0),
    account: Number(capabilities?.account_schema?.version || 0),
  }
  if (!remote.settings && !remote.account) return false
  if (remote.settings === local.settings && remote.account === local.account) return false
  const key = `${instanceId}:${remote.settings}:${remote.account}`
  if (!schemaWarnings.has(key)) {
    schemaWarnings.add(key)
    log.warn?.(
      `gateway worker ${instanceId}: settings schema ${remote.settings}/${remote.account} differs from control plane ${local.settings}/${local.account}; upgrade the Worker and control plane together`,
    )
  }
  return true
}

export function createGatewayInternalRegistrationRoute({ json, readBody, readRawBody } = {}) {
  const repo = new GatewayWorkerRepo()
  const token = process.env.KIN_CODEX_GATEWAY_INTERNAL_TOKEN || ''
  const service = new GatewayWorkerService({ repo, secret: token })
  const leases = createRefreshLeases({ db: repo.db, repo })
  // 心跳写入账号状态后处理 BPS 403 自动移组（事件不是主来源时；事件路径见 receipt-reconciler 的 onAccountState）
  let accountManager = null
  const accounts = () => (accountManager ||= new GatewayAccountManagement({ repo, service }))
  const resyncAt = new Map()
  function resyncDue(accountResourceId) {
    const last = resyncAt.get(accountResourceId) || 0
    if (Date.now() - last < 30_000) return false
    resyncAt.set(accountResourceId, Date.now())
    return true
  }
  // 凭据刷新租约（P3.1）：Worker 刷新前申请、刷新后报告；成功轮换后把新凭据从持有者投影到其他实例
  async function handleRefreshLease(kind, body = {}) {
    const instanceId = String(body.instance_id || '')
    if (!instanceId || !(await repo.getInstance(instanceId)))
      return { status: 404, payload: errorPayload('gateway_instance_not_found', '实例未注册') }
    const input = {
      instanceId,
      runtimeAccountId: body.runtime_account_id,
      grant: String(body.grant || 'native'),
      credentialRevision: body.credential_revision,
      tokenFingerprint: body.token_fingerprint,
    }
    if (kind === 'acquire') {
      const result = await leases.acquire(input)
      // 申请者的令牌已被轮换：把新凭据从轮换后的持有者投影过去（同一账号 30 秒内只触发一次）
      if (result.resync?.holder && resyncDue(result.account_resource_id))
        void service
          .projectAccountToAll(
            { id: String(result.resync.runtime_account_id), account_resource_id: result.account_resource_id },
            result.resync.holder,
          )
          .catch(() => {})
      return { status: result.granted ? 200 : result.status || 409, payload: { ok: result.granted, ...result } }
    }
    // rotated：在释放租约的同一事务里按代次 CAS 写入凭据库（P3.6、G1）；写不进去时租约不释放，Worker 重试报告
    await service.custody.prepare()
    let result
    try {
      result = await leases.release({
        ...input,
        leaseToken: body.lease_token,
        outcome: body.outcome,
        onRotated: ({ accountResourceId }) =>
          service.custody.recordRotation({
            accountResourceId,
            runtimeAccountId: String(body.runtime_account_id),
            grant: input.grant,
            credentialBundle: body.credential_bundle,
            revision: body.credential_revision,
            previousRevision: body.previous_revision,
            sourceInstanceId: instanceId,
          }),
      })
    } catch (error) {
      console.warn(
        `refresh lease: rotation of ${body.runtime_account_id}/${input.grant} not recorded: ${error?.code || ''} ${error?.message || error}`,
      )
      return {
        status: 503,
        payload: errorPayload(error?.code || 'rotation_not_recorded', '新凭据未能写入凭据库，请重试报告'),
      }
    }
    if (result.ok && result.propagate)
      void service
        .projectAccountToAll(
          { id: String(body.runtime_account_id), account_resource_id: result.account_resource_id },
          instanceId,
        )
        .catch(() => {})
    return { status: result.ok ? 200 : result.status || 409, payload: result }
  }
  return async function handleGatewayInternalRegistration(req, res, url) {
    const leasePath = LEASE_PATHS[url.pathname]
    if (
      !leasePath &&
      !['/internal/v1/gateway/workers/register', '/internal/v1/gateway/workers/heartbeat'].includes(url.pathname)
    )
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
    if (leasePath) {
      const handled = await handleRefreshLease(leasePath, body)
      return json(res, handled.status, handled.payload)
    }
    // 准入状态由控制面决定，不接受 Worker 自报（终审 B2）
    const { admission_state: _selfReported, ...reported } = body || {}
    const conflict = await singleWorkerConflict(repo, reported)
    if (conflict) return json(res, 409, conflict)
    // 心跳时间记控制面收到的时刻，不用 Worker 自报（最终审计 I1）：在线判定（45 秒）只依赖控制面时钟，
    // 不受 Worker 时钟偏差影响（签名时间窗另行把偏差限制在 30 秒内）
    const instance = await repo.upsertInstance({ ...reported, last_heartbeat_at: new Date().toISOString() })
    // 设置描述版本与控制面不一致时告警（同一实例、同一组版本只告警一次，P4.4）
    if (instance?.id) warnSchemaMismatch(instance.id, body?.capabilities)
    // 先记录托管公钥再投影：数据目录重建后的第一轮投影就按新状态处理（R3 审查 P2-1）
    if (instance?.id) {
      try {
        const local = supervisedCustodyIdentity()
        await repo.recordCustodyKey(instance.id, body?.custody_public_key, {
          trusted: !!local && local.instanceId === instance.id && local.publicKey === body?.custody_public_key,
        })
      } catch {}
    }
    if (instance?.id)
      void service.projectAllAccountsTo(instance.id, { revisions: body?.account_revisions }).catch(() => {})
    if (instance?.id && Array.isArray(body?.protection_freezes)) {
      try {
        await repo.recordAccountFreezes(instance.id, body.protection_freezes)
      } catch {}
    }
    // 执行事件为主来源、且该实例的事件链路健康时，账号终态、额度与探测只由事件写入；否则仍按心跳写入（R1 审查 P1-3）
    const eventsPrimary = instance?.id ? await eventsChannelHealthy(repo, instance.id, body?.events) : false
    if (instance?.id) {
      try {
        await repo.recordRuntimeLoad(instance.id, body || {})
      } catch {}
      try {
        await repo.recordRuntimeEvents(instance.id, body?.events)
      } catch {}
      try {
        await repo.recordSharedState(instance.id, body?.shared_state)
      } catch {}
      try {
        await repo.recordFacts(instance.id, body?.facts)
      } catch {}
      if (!eventsPrimary) {
        try {
          await repo.recordRuntimeCredentials(instance.id, body?.account_credentials)
          await accounts().reconcileBpsBlocks()
        } catch {}
        try {
          await repo.recordBpsProbes(instance.id, body?.bps_probes)
        } catch {}
      }
    }
    if (instance?.id && !eventsPrimary && Array.isArray(body?.account_quotas)) {
      try {
        await repo.recordRuntimeQuotas(instance.id, body.account_quotas)
      } catch {}
    }
    let policy
    try {
      policy = instance?.id ? await gatewayHeartbeatPolicy(repo, instance.id) : undefined
    } catch {}
    return json(res, 200, { ok: true, instance, ...(policy ? { policy } : {}) })
  }
}
