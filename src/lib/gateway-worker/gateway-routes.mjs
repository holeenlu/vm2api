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
import { createRefreshLeases } from '../executor/refresh-lease.mjs'
import { GatewayWorkerClient } from './gateway-client.mjs'
import { GatewayWorkerService, gatewayAccountProtection } from './gateway-execution.mjs'
import { readClientProfileSetting, readPrivacyPolicySetting } from './codex-client-profile.mjs'
import { codexSettingsSnapshot, saveCodexSettings } from '../executor/settings-store.mjs'
import { CODEX_SETTINGS_SCHEMA, schemaVersions } from '../executor/settings-schema.mjs'
import { GatewayAccountManagement } from './account-management.mjs'
import { supervisedBootstrap } from './worker-supervisor.mjs'
import { hasGatewaySignatureHeaders, signGatewayResponse, verifyGatewayHeaders } from './gateway-auth.mjs'
import {
  instanceKeyStoreFor,
  instanceKeysMode,
  safeEqual,
  validInstanceId,
  wrapDeliveredSecret,
} from './instance-keys.mjs'
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

// 部署固定为“一个 Node + 一个同机 Worker”（Gateway 事实直读，设计第 19 节）：账号的并发、RPM、冷却与错误计数
// 都在 Worker 进程内，只有一份，与 CPR 单进程语义一致。拒绝第二个接单实例注册；原实例 drain 或失联（45 秒无心跳）
// 后新实例可以接替，滚动替换不受影响。
export async function singleWorkerConflict(
  repo,
  input = {},
  _env = process.env,
  { isNew = false, strict = isNew } = {},
) {
  const id = String(input.id || '').trim()
  // 自身 drain、下线或不健康时不占用执行面，也不阻止其他实例；但表里还没有的新实例 ID 不论自报什么状态，
  // 有在线实例时一律拒绝（中期技术债 M2 复审 P1-1：不能自报 draining 绕过单实例检查）
  const accepting =
    ['healthy', 'degraded'].includes(String(input.health_state || 'healthy')) &&
    String(input.drain_state || 'accepting') === 'accepting'
  if (!accepting && !strict) return null
  // 新实例 ID 连待批准的在线实例也算作占用：先登记的待批准实例要由管理员处理，不能再挤进一个新 ID
  const holder = (await repo.activeInstances({ includePending: isNew })).find((other) => other !== id)
  if (!holder) return null
  return errorPayload('gateway_single_worker', `已有在线实例 ${holder}（只支持单个 Worker）；请先 Drain 或停止它`)
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
      // 实例密钥状态（中期技术债 M2）：issued（Worker 已在用）、pending（已签发、Worker 还没用过）、none；只列指纹
      let keyStatus = new Map()
      try {
        keyStatus = await instanceKeyStoreFor(repo.db).statuses()
      } catch {}
      json(res, 200, {
        ok: true,
        // 托管公钥指纹（SHA-256 前 8 字节）：与 Worker 启动日志、健康接口里的指纹带外核对后再确认替换（R3 复审 N8）
        items: (await repo.listInstances()).map((item) => ({
          ...item,
          instance_key: keyStatus.get(item.id) || { state: 'none', keys: [] },
        })),
        instance_keys_mode: instanceKeysMode(),
        // 控制面托管的同机 Worker 进程状态（external 表示 Worker 由外部管理）
        supervisor: supervisor?.status?.() || null,
        // 开关生效值、事件收件箱与刷新租约状态（审计 U8）
        control_plane: await controlPlaneStatus({ db: repo.db, repo }),
      })
      return true
    }
    // 实例密钥在线轮换与吊销（中期技术债 M2）：轮换后旧密钥在宽限期内仍有效，Worker 下一次心跳拿到新密钥；
    // 吊销立即生效，Worker 收到 instance_key_revoked 后删除本地密钥、用共用令牌重新注册（off 模式下不再签发）
    // 允许引导（审查 P0-1/P0-2）：给外部 Worker 开一个一次性、限时的引导授权窗口；实例可以还没注册过
    const instanceKeyAction =
      /^\/api\/panel\/gateway-workers\/([^/]+)\/instance-key\/(rotate|revoke|allow-bootstrap)$/.exec(path)
    if (instanceKeyAction && req.method === 'POST') {
      const instanceId = decodeURIComponent(instanceKeyAction[1]).trim()
      const actor = String(req.panelUserId || panelIdentity(req).user || 'master')
      const keys = instanceKeyStoreFor(repo.db)
      if (!validInstanceId(instanceId)) {
        json(res, 400, errorPayload('invalid_instance_id', '实例 ID 不合法'))
        return true
      }
      if (instanceKeyAction[2] === 'allow-bootstrap') {
        if (await keys.issued(instanceId)) {
          json(res, 409, errorPayload('instance_key_already_issued', '该实例已有在用的实例密钥，请先吊销'))
          return true
        }
        // 批准与允许引导合并（复审 P1-1）：待批准的实例同时转为已准入
        const bootstrap = await keys.allowBootstrap(instanceId, { actor })
        const approved = await repo.admitPendingInstance(instanceId)
        json(res, 200, { ok: true, bootstrap, approved })
        return true
      }
      if (!(await repo.getInstance(instanceId))) {
        json(res, 404, errorPayload('gateway_instance_not_found', '实例不存在'))
        return true
      }
      if (instanceKeyAction[2] === 'rotate') {
        const rotated = await keys.rotate(instanceId, { actor })
        if (!rotated) {
          json(res, 409, errorPayload('instance_key_not_issued', '该实例还没有签发实例密钥'))
          return true
        }
        json(res, 200, { ok: true, rotated })
        return true
      }
      const revoked = await keys.revoke(instanceId, { actor, reason: 'panel' })
      json(res, 200, { ok: true, revoked })
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

// 实例显示名（审查 P2）：去掉首尾空白，只允许字母、数字、空格与 . _ -，最长 64；不合法时用实例 ID
export function gatewayInstanceName(name, instanceId) {
  const text = typeof name === 'string' ? name.trim() : ''
  return /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,63}$/u.test(text) ? text : String(instanceId ?? '').trim()
}

const REGISTER_PATHS = new Set(['/internal/v1/gateway/workers/register', '/internal/v1/gateway/workers/heartbeat'])

// 请求正文里声明的实例：注册与心跳是 id，回执是 gateway_instance_id，租约是 instance_id（首尾空白一律去掉）
function claimedInstance(path, body) {
  if (REGISTER_PATHS.has(path)) return String(body?.id ?? '').trim()
  if (path === '/internal/v1/gateway/receipts') return String(body?.gateway_instance_id ?? '').trim()
  return String(body?.instance_id ?? '').trim()
}

/**
 * 预过滤（审查 P2、复审 P2-5）：签名头必须齐全；带实例密钥头时，key_id 必须存在且属于声明的实例（按主键查表，
 * 不解密）；否则必须带与共用令牌一致的 x-kin-gateway-token（常量时间比较）。不通过时不读正文。
 * 返回 null 表示通过，否则是对外的错误码（实例密钥路径统一为 instance_key_invalid，不暴露 key_id 是否存在）。
 */
async function internalPrefilter(req, token, keys) {
  if (!hasGatewaySignatureHeaders(req.headers)) return 'invalid_internal_auth'
  const keyId = String(req.headers['x-kin-gateway-key'] || '').trim()
  const instance = String(req.headers['x-kin-gateway-instance'] || '').trim()
  if (instance && keyId && keyId !== 'default') {
    if (!keys) return 'instance_key_invalid'
    const owner = await keys.keyOwner(keyId)
    if (owner !== instance) {
      warnRateLimited(`gateway instance key ${keyId.slice(0, 32)} for ${instance.slice(0, 64)} rejected: unknown`)
      return 'instance_key_invalid'
    }
    return null
  }
  return token && safeEqual(req.headers['x-kin-gateway-token'], token) ? null : 'invalid_internal_auth'
}

// 认证失败的告警限速（复审 P2-5）：每分钟最多一条，期间被压下的条数记在下一条里
let warnWindowStart = 0
let warnSuppressed = 0
function warnRateLimited(line, log = console, now = Date.now()) {
  if (now - warnWindowStart < 60_000) {
    warnSuppressed += 1
    return
  }
  const suppressed = warnSuppressed
  warnWindowStart = now
  warnSuppressed = 0
  log.warn?.(suppressed ? `${line} (${suppressed} similar warnings suppressed)` : line)
}

const requestTarget = (url) => `${url.pathname}${url.search || ''}`

/**
 * Worker → 控制面内部请求的认证（中期技术债 M2）。
 * - 带实例密钥头的请求按实例密钥校验（v2 签名串覆盖方法与请求目标），正文声明的实例必须是这个实例；
 * - 否则按共用内部令牌校验。KIN_CODEX_GATEWAY_INSTANCE_KEYS 不是 off 时：
 *   - 已签发实例密钥的实例不能再用共用令牌（instance_key_required）；
 *   - 注册或心跳只有带引导授权（托管器的一次性引导令牌，或管理员开的授权窗口）时才签发密钥；
 *     required 下没有授权的共用令牌请求一律拒绝（instance_key_bootstrap_not_allowed），不吊销任何已有密钥；
 * 返回 { ok, nonce, instanceId, keyId, secret, bootstrap, responseSecret, responseKey } 或
 * { ok: false, status, code, message, responseSecret?, responseKey? }。responseSecret 用来给响应签名（Worker 据此确认响应来自控制面）。
 * 确认密钥（confirmed_at）由调用方在 nonce 检查通过后进行。
 */
export async function authenticateGatewayInternal(
  req,
  { path, target = path, raw, body, token, keys, env = process.env, log = console },
) {
  const fail = (status, code, message, extra = {}) => ({ ok: false, status, code, message, ...extra })
  const headerInstance = String(req.headers['x-kin-gateway-instance'] || '').trim()
  const keyId = String(req.headers['x-kin-gateway-key'] || '').trim()
  const claimed = claimedInstance(path, body)
  if (claimed && !validInstanceId(claimed)) return fail(400, 'invalid_instance_id', '实例 ID 不合法')
  if (headerInstance && keyId && keyId !== 'default') {
    // 正文必须声明同一个实例（注册不带 id 时控制面会生成新实例，实例密钥不能用来登记别的实例）
    if (claimed !== headerInstance)
      return fail(403, 'instance_mismatch', `实例密钥属于 ${headerInstance}，不能代表 ${claimed || '未声明的实例'}`)
    if (!keys) return fail(503, 'instance_keys_unavailable', '实例密钥暂不可用')
    const verified = await keys.verify({
      instanceId: headerInstance,
      keyId,
      headers: req.headers,
      body: raw,
      method: req.method || 'POST',
      path: target,
      verifyHeaders: verifyGatewayHeaders,
    })
    if (!verified.ok) {
      // 未知、已吊销、过期与签名不符对外统一为 instance_key_invalid（复审 P2-5）；具体原因只写日志（限速）
      warnRateLimited(
        `gateway instance key ${keyId} for ${headerInstance} rejected: ${verified.reason || verified.code}`,
        log,
      )
      return fail(
        401,
        'instance_key_invalid',
        '实例密钥无效',
        verified.responseSecret ? { responseSecret: verified.responseSecret, responseKey: keyId } : {},
      )
    }
    // 续接只能经注册或心跳换取新密钥，租约与回执一律拒绝
    if (verified.renewOnly && !REGISTER_PATHS.has(path))
      return fail(401, 'instance_key_invalid', '实例密钥无效', {
        responseSecret: verified.secret,
        responseKey: verified.keyId,
      })
    return {
      ok: true,
      renewOnly: !!verified.renewOnly,
      nonce: verified.nonce,
      instanceId: headerInstance,
      keyId: verified.keyId,
      secret: verified.secret,
      bootstrap: null,
      responseSecret: verified.secret,
      responseKey: verified.keyId,
    }
  }
  if (!token || !safeEqual(req.headers['x-kin-gateway-token'], token))
    return fail(401, 'invalid_internal_auth', '内部凭据无效')
  const signature = verifyGatewayHeaders({ secret: token, headers: req.headers, body: raw })
  if (!signature.ok) return fail(401, 'invalid_internal_auth', '内部请求签名无效')
  // 托管器的引导令牌：只要有效，不论什么模式都用它给响应签名（第三轮复审 P1-A：off 模式下托管 Worker 也要能验签策略）
  const presented =
    REGISTER_PATHS.has(path) && claimed && typeof body?.bootstrap_token === 'string' ? body.bootstrap_token : ''
  const supervised = presented ? supervisedBootstrap(claimed, presented) : null
  const shared = supervised
    ? { responseSecret: presented, responseKey: 'bootstrap' }
    : { responseSecret: token, responseKey: 'shared' }
  const mode = instanceKeysMode(env)
  const supports = REGISTER_PATHS.has(path) && Number(body?.instance_key_support) >= 1 && !!claimed
  if (mode !== 'off' && claimed && !keys) return fail(503, 'instance_keys_unavailable', '实例密钥暂不可用', shared)
  if (mode !== 'off' && claimed && (await keys.issued(claimed)))
    return fail(401, 'instance_key_required', `实例 ${claimed} 已签发实例密钥，不再接受共用令牌`, shared)
  // 引导授权：托管器的一次性引导令牌优先，其次管理员开的授权窗口（只读判断；签发时在事务内消耗）
  let bootstrap = null
  if (mode !== 'off' && supports) {
    if (supervised) bootstrap = { authorization: supervised, holderSecret: presented, responseKey: 'bootstrap' }
    else if (await keys.bootstrapGrant(claimed))
      bootstrap = { authorization: { kind: 'grant' }, holderSecret: token, responseKey: 'shared' }
  }
  if (mode === 'required' && !bootstrap)
    return fail(401, 'instance_key_bootstrap_not_allowed', '没有引导授权，共用令牌不能使用', shared)
  // 已签发、Worker 还没用过密钥的实例：共用令牌只能用于带新授权的引导，不能改写它的登记（审查 R1：抢先心跳改派发地址）
  if (mode !== 'off' && claimed && !bootstrap && (await keys.hasLiveKey(claimed)))
    return fail(401, 'instance_key_required', `实例 ${claimed} 已签发实例密钥，不再接受共用令牌`, shared)
  return {
    ok: true,
    nonce: signature.nonce,
    instanceId: claimed,
    keyId: null,
    secret: token,
    bootstrap,
    responseSecret: bootstrap?.holderSecret || shared.responseSecret,
    responseKey: bootstrap?.responseKey || shared.responseKey,
  }
}

function safeKeys(repo) {
  try {
    return instanceKeyStoreFor(repo.db)
  } catch {
    return null
  }
}

/**
 * 内部接口的 JSON 响应（审查 P2）：有 responseSecret 时对正文签名（作用域含状态码与请求目标、绑定本次请求的随机串），
 * 并用 x-kin-gateway-response-key 说明用的是哪把（实例密钥 key_id、bootstrap 或 shared）。Worker 只有在签名校验通过后
 * 才接受下发的新密钥、或因 401 删除本地密钥。
 */
function signedInternalJson(json, res, status, body, { auth, req, url }) {
  if (auth?.responseSecret && req?.headers?.['x-kin-gateway-nonce']) {
    const text = JSON.stringify(body)
    const { hash, signature } = signGatewayResponse({
      secret: auth.responseSecret,
      status,
      path: requestTarget(url),
      nonce: String(req.headers['x-kin-gateway-nonce']),
      text,
    })
    const headers = {
      'x-kin-gateway-response-key': auth.responseKey,
      'x-kin-gateway-response-sha256': hash,
      'x-kin-gateway-response-signature': signature,
    }
    if (typeof res.setHeader === 'function')
      for (const [name, value] of Object.entries(headers)) res.setHeader(name, value)
    else res.headers = { ...(res.headers || {}), ...headers }
  }
  return json(res, status, body)
}

export function createGatewayInternalReceiptRoute({ json, readBody, readRawBody } = {}) {
  const repo = new GatewayWorkerRepo()
  const token = process.env.KIN_CODEX_GATEWAY_INTERNAL_TOKEN || ''
  const client = new GatewayWorkerClient({ repo, secret: token })
  return async function handleGatewayInternalReceipt(req, res, url) {
    if (url.pathname !== '/internal/v1/gateway/receipts') return false
    if (req.method !== 'POST') return json(res, 405, errorPayload('method_not_allowed', 'method not allowed'))
    const keys = safeKeys(repo)
    const rejected = await internalPrefilter(req, token, keys)
    if (rejected) return json(res, 401, errorPayload(rejected, '内部凭据无效'))
    let signed
    try {
      signed = await readSignedJson(req, { readBody, readRawBody }, 4 * 1024 * 1024)
    } catch (error) {
      return json(res, error.status || 400, errorPayload(error.code || 'invalid_json', error.message || String(error)))
    }
    const { body, raw } = signed
    const auth = await authenticateGatewayInternal(req, {
      path: url.pathname,
      target: requestTarget(url),
      raw,
      body,
      token,
      keys,
    })
    const reply = (status, payload, withAuth = auth) =>
      signedInternalJson(json, res, status, payload, { auth: withAuth, req, url })
    if (!auth.ok) return reply(auth.status, errorPayload(auth.code, auth.message))
    if (!consumeInternalNonce(auth.nonce))
      return json(res, 409, errorPayload('dispatch_replayed', 'Receipt 请求已重放'))
    if (auth.keyId) await keys.confirm(auth.instanceId, auth.keyId)
    // 待批准的实例不采信其回执（复审 P1-1）
    if (auth.instanceId && (await repo.getInstance(auth.instanceId))?.approval_state === 'pending')
      return reply(403, errorPayload('instance_pending_approval', '实例待管理员批准'))
    // 回执只能写已认证实例自己的派发（审查 P0-4）：ingestReceipt 按派发所属实例校验
    // （认证已保证 gateway_instance_id 就是已认证的实例）
    const result = await repo.ingestReceipt(body)
    if (result.rejected) return reply(result.status || 400, errorPayload(result.code, result.message))
    if (body.gateway_instance_id && body.dispatch_id) {
      try {
        await client.ackReceipt(body.gateway_instance_id, body.dispatch_id, result.receipt_id)
      } catch {}
    }
    reply(200, { ok: true, ...result })
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
        row.approval_state !== 'pending' &&
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
    // BPS 总开关：请求按信封里的开关选通道；关闭时 Worker 的后台 BPS 探测（403 恢复、模型无权复核）也暂停
    bps_enabled: settings.bps_enabled !== false,
    // 本次策略依据的 Codex 设置版本（与上面的值同一快照）：Worker 记录已应用的版本，在健康接口与心跳中报告
    settings_revision: snapshot.revision,
    // 后台请求（额度、目录、探测、预热）使用通用画像；隐私规则作为信封未携带时的回退
    client_profile: profile.selection,
    profile_deployment: profile.deployment,
    privacy: readPrivacyPolicySetting(repo.db),
    // 控制面是否消费事件发件箱：不消费时 Worker 自行确认、不因事件积压拒单（R1 审查 P0-1）；
    // enforce 只在 primary 为真：shadow 只比对，日志故障不让 Worker 拒单（终审 A5）
    executor_events: { required: executorEventsMode() !== 'off', enforce: executorEventsMode() === 'primary' },
    // 凭据刷新租约（P3.1，恒开）：Worker 刷新前必须先取得租约（替换实例的接替窗口内新旧两个实例都可能持有账号）
    refresh_lease: { required: true },
  }
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

export function createGatewayInternalRegistrationRoute({ json, readBody, readRawBody, env = process.env } = {}) {
  const repo = new GatewayWorkerRepo()
  const token = env.KIN_CODEX_GATEWAY_INTERNAL_TOKEN || ''
  const service = new GatewayWorkerService({ repo, secret: token })
  const leases = createRefreshLeases({ db: repo.db, repo })
  // 心跳写入账号状态后处理 BPS 403 自动移组（事件不是主来源时；事件路径见 receipt-reconciler 的 onAccountState）
  let accountManager = null
  const accounts = () => (accountManager ||= new GatewayAccountManagement({ repo, service }))
  // 凭据刷新租约（P3.1）：Worker 刷新前申请、刷新后报告；成功轮换的新凭据在释放租约的事务里写库，Worker 从库里读回
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
    return { status: result.ok ? 200 : result.status || 409, payload: result }
  }
  const handleGatewayInternalRegistration = async function handleGatewayInternalRegistration(req, res, url) {
    const leasePath = LEASE_PATHS[url.pathname]
    if (
      !leasePath &&
      !['/internal/v1/gateway/workers/register', '/internal/v1/gateway/workers/heartbeat'].includes(url.pathname)
    )
      return false
    if (req.method !== 'POST') return json(res, 405, errorPayload('method_not_allowed', 'method not allowed'))
    const keys = safeKeys(repo)
    const rejected = await internalPrefilter(req, token, keys)
    if (rejected) return json(res, 401, errorPayload(rejected, '内部凭据无效'))
    let signed
    try {
      signed = await readSignedJson(req, { readBody, readRawBody }, 512 * 1024)
    } catch (error) {
      return json(res, error.status || 400, errorPayload(error.code || 'invalid_json', error.message || String(error)))
    }
    const { body, raw } = signed
    const signature = await authenticateGatewayInternal(req, {
      path: url.pathname,
      target: requestTarget(url),
      raw,
      body,
      token,
      keys,
      env,
    })
    const reply = (status, payload) => signedInternalJson(json, res, status, payload, { auth: signature, req, url })
    if (!signature.ok) return reply(signature.status, errorPayload(signature.code, signature.message))
    if (!consumeInternalNonce(signature.nonce))
      return json(res, 409, errorPayload('dispatch_replayed', 'Worker 请求已重放'))
    // mTLS 与 nonce 都通过之后才记下 Worker 已用过这把密钥（审查 P2）
    if (signature.keyId) await keys.confirm(signature.instanceId, signature.keyId)
    let existing = signature.instanceId ? await repo.getInstance(signature.instanceId) : null
    // 用确认过的实例密钥签名即视为批准（复审 P1-1）
    if (signature.keyId && existing?.approval_state === 'pending') {
      await repo.admitPendingInstance(existing.id)
      existing = await repo.getInstance(existing.id)
    }
    // 轮换后离线超过宽限期：过期的上一把密钥只能换取新密钥，不处理其他内容（复审 P2-7）
    if (signature.renewOnly) {
      const renewed = await keys.delivery(signature.instanceId, signature.keyId, signature.secret, signature.nonce)
      return reply(200, { ok: true, ...(renewed ? { instance_key: renewed } : {}) })
    }
    if (leasePath) {
      // 待批准的实例不参与刷新租约（复审 P1-1）
      if (!existing) return reply(404, errorPayload('gateway_instance_not_found', '实例未注册'))
      if (existing.approval_state === 'pending')
        return reply(403, errorPayload('instance_pending_approval', '实例待管理员批准'))
      const handled = await handleRefreshLease(leasePath, body)
      return reply(handled.status, handled.payload)
    }
    // 准入状态由控制面决定，不接受 Worker 自报（终审 B2）；引导令牌不入库
    const { admission_state: _selfReported, bootstrap_token: _bootstrapToken, ...reported } = body || {}
    // 显示名限制长度与字符（审查 P2），不合法时用实例 ID；面板同时显示实例 ID
    reported.name = gatewayInstanceName(reported.name, reported.id)
    // on 模式下没有已确认密钥的实例（升级前遗留、已吊销）也不能靠自报 draining 绕过单 Worker 检查（第三轮复审 P2-1）
    const unkeyed = !signature.keyId && keys && keys.mode() !== 'off' && !(await keys.issued(signature.instanceId))
    const conflict = await singleWorkerConflict(repo, reported, env, { isNew: !existing, strict: !existing || unkeyed })
    if (conflict) return reply(409, conflict)
    // 引导先于登记（复审 P2-1）：在事务里消耗授权并签发，失败就直接拒绝、不写登记
    let instanceKey = null
    let instanceKeyStatus = null
    if (signature.bootstrap) {
      let issued
      try {
        issued = await keys.bootstrap(signature.instanceId, { authorization: signature.bootstrap.authorization })
      } catch (error) {
        // 签发出错（数据库、包裹密钥）按引导失败处理，不让整个心跳 500（第三轮复审 P2-4）
        console.warn(`gateway instance key bootstrap for ${signature.instanceId} failed: ${error?.message || error}`)
        return reply(503, errorPayload('instance_key_bootstrap_failed', '实例密钥签发失败，请稍后重试'))
      }
      if (!issued.ok)
        return reply(
          401,
          errorPayload(
            issued.code === 'instance_key_already_issued' ? 'instance_key_required' : issued.code,
            '引导被拒绝',
          ),
        )
      signature.bootstrap.authorization.commit?.(issued.key_id)
      instanceKey = {
        instance_id: signature.instanceId,
        key_id: issued.key_id,
        wrapped: wrapDeliveredSecret(
          signature.bootstrap.holderSecret,
          { instanceId: signature.instanceId, keyId: issued.key_id, nonce: signature.nonce },
          issued.secret,
        ),
        fingerprint: issued.fingerprint,
      }
    }
    // on 模式下表里还没有的新实例 ID 用共用令牌登记时记为待批准（复审 P1-1）：管理员批准（允许引导）或完成引导前
    // 不投影、不派发、不采信它上报的冻结、凭据、额度、事件与租约
    const pendingNew = !signature.bootstrap && !existing && !signature.keyId && keys && keys.mode() !== 'off'
    // 引导即批准：管理员授权或托管器的引导令牌
    if (signature.bootstrap && existing?.approval_state === 'pending') await repo.admitPendingInstance(existing.id)
    // 心跳时间记控制面收到的时刻，不用 Worker 自报（最终审计 I1）：在线判定（45 秒）只依赖控制面时钟，
    // 不受 Worker 时钟偏差影响（签名时间窗另行把偏差限制在 30 秒内）
    const instance = await repo.upsertInstance({
      ...reported,
      ...(pendingNew ? { approval_state: 'pending' } : {}),
      last_heartbeat_at: new Date().toISOString(),
    })
    if (instance?.id) warnSchemaMismatch(instance.id, body?.capabilities)
    // 待批准的实例：只登记（仍需管理员批准），其余一概不采信
    if (instance?.approval_state === 'pending')
      // 不带登记与策略：Worker 据此不把额度与探测记录当作已送达（第三轮复审 P2-2）
      return reply(200, { ok: true, instance_key_status: 'instance_pending_approval' })
    // Gateway 事实直读（设计第 19 节）：Worker 自己从库里读账号；绑定的同步状态按它上报的读取进度标记
    if (instance?.id) {
      try {
        await repo.markFactsSynced(instance.id, body?.facts)
      } catch {}
    }
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
    // 用旧密钥签名时下发轮换后的新密钥（用旧密钥包裹）；没有引导授权时提示管理员允许引导
    if (instance?.id && keys && !instanceKey) {
      try {
        if (signature.keyId)
          instanceKey = await keys.delivery(instance.id, signature.keyId, signature.secret, signature.nonce)
        else if (!signature.bootstrap && keys.mode() !== 'off' && Number(body?.instance_key_support) >= 1)
          instanceKeyStatus = 'instance_key_bootstrap_not_allowed'
      } catch (error) {
        console.warn(`gateway instance key for ${instance.id} was not delivered: ${error?.message || error}`)
      }
    }
    return reply(200, {
      ok: true,
      instance,
      ...(policy ? { policy } : {}),
      ...(instanceKey ? { instance_key: instanceKey } : {}),
      ...(instanceKeyStatus ? { instance_key_status: instanceKeyStatus } : {}),
    })
  }
  return handleGatewayInternalRegistration
}
