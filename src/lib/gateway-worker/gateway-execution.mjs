import crypto from 'node:crypto'
import { getDb } from '../db/database.mjs'
import { GatewayWorkerRepo } from './gateway-repo.mjs'
import { GatewayWorkerClient } from './gateway-client.mjs'
import { gatewayAccountPatch } from './account-management.mjs'
import { SettingsRepo } from '../db/repos/settings-repo.mjs'
import { compileAccountErrorProtection } from '../pool/account-error-protection.mjs'
import { codexClientScope } from '../db/repos/codex-response-owners-repo.mjs'
import { keyScopeFromRequest } from '../admin/key-scope.mjs'
import {
  activePrivacyPolicy,
  keyClientProfile,
  readClientProfileSetting,
  readPrivacyPolicySetting,
} from './codex-client-profile.mjs'
import { globalRequestLocation } from './request-location.mjs'

// 只把官方 Codex 客户端的会话、特性与 trace 头交给 Worker；调用方的 API Key、Cookie 等凭据
// 不进入 Worker。认证、originator、User-Agent、version、安装 ID 由 Worker 按账号重建。
const FORWARDED_HEADERS = new Set([
  'accept',
  'baggage',
  'openai-beta',
  'sentry-trace',
  'session-id',
  'thread-id',
  'traceparent',
  'tracestate',
  'x-client-request-id',
  'x-openai-fedramp',
  'x-openai-internal-codex-responses-lite',
  'x-openai-memgen-request',
  'x-openai-subagent',
])

// 原生 Responses 请求按 CPR responses/request.rs 的黑名单透传其余入站头：丢弃传输管理头、调用方凭据与
// 客户端身份、部署配套头与非 Codex 环境头（Worker 侧再过滤一次）。转换协议与 Live 仍只转发上面的白名单。
const BLOCKED_PASSTHROUGH_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
  'content-encoding',
  'accept-encoding',
  'x-request-id',
  'authorization',
  'x-api-key',
  'x-openai-actor-authorization',
  'cookie',
  'cookie2',
  'chatgpt-account-id',
  'chatgpt-project-id',
  'openai-organization',
  'openai-project',
  'originator',
  'user-agent',
  'version',
  'x-oai-attestation',
  'x-oai-is',
  'x-oai-is-update',
  'x-codex-installation-id',
  'x-openai-internal-codex-residency',
  'x-openai-account-routing-override',
  'forwarded',
  'via',
  'cdn-loop',
  'x-real-ip',
  'true-client-ip',
  'origin',
  'referer',
])
const BLOCKED_PASSTHROUGH_PREFIXES = ['sec-websocket-', 'cf-', 'x-forwarded-', 'x-stainless-', 'sec-ch-ua', 'sec-fetch-', 'x-kin-']

export function gatewayForwardHeaders(headers = {}, { passthrough = false } = {}) {
  const out = {}
  // Connection 头声明的逐跳头同样不透传
  const hopByHop = new Set(
    String(headers?.connection || headers?.Connection || '')
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  )
  for (const [key, value] of Object.entries(headers || {})) {
    const name = key.toLowerCase()
    if (name === 'x-codex-installation-id') continue
    if (passthrough) {
      if (
        BLOCKED_PASSTHROUGH_HEADERS.has(name) ||
        hopByHop.has(name) ||
        BLOCKED_PASSTHROUGH_PREFIXES.some((prefix) => name.startsWith(prefix))
      )
        continue
    } else if (!FORWARDED_HEADERS.has(name) && !name.startsWith('x-codex-')) continue
    const text = Array.isArray(value) ? value.join(', ') : value
    if (typeof text === 'string' && text.trim()) out[name] = text
  }
  return out
}

const MAX_INSTANCE_HOPS = 2

// 账号错误保护策略随信封下发，Worker 按尝试计数、冻结与探测；关闭的策略也下发，让 Worker 停止到期探测。
// 配置无效时不下发（Worker 本次请求按关闭处理）。
export function gatewayAccountProtection(db = null) {
  try {
    const compiled = compileAccountErrorProtection(new SettingsRepo(db || getDb()).get('account_error_protection', {}))
    return { ...compiled.policy, fingerprint: compiled.fingerprint }
  } catch {
    return null
  }
}

async function drainBody(result) {
  if (!result?.stream || !result.body) return
  let text = ''
  try {
    const reader = result.body.getReader()
    const decoder = new TextDecoder()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
    }
  } catch {}
  result.release?.()
  try {
    result.body = text ? JSON.parse(text) : null
  } catch {
    result.body = null
  }
  result.stream = false
}

/** Worker 回传的逐次尝试（X-Kin-Gateway-Attempts）。 */
export function gatewayAttempts(headers = {}) {
  try {
    const parsed = JSON.parse(headers?.['x-kin-gateway-attempts'] || '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/**
 * 把 Worker 内的每次上游尝试写成 request_attempts 行；最后一行承载最终交付结果。
 * Worker 未回传尝试（未发送）时写一行控制面观察。实例、dispatch 与回执由 Gateway 自有表记录；
 * 发送状态只用于换实例判定，不写入尝试表（与上游 request-attempts-repo 一致）。
 */
// Gateway 请求是否等 Receipt 补齐用量再结算。只有成功或结果不明的请求等；已确定失败、截断或提交前取消的
// 请求与 VM 路径一样不计量。提交后调用方中途断开（cancelled 且 gateway_await_receipt）同样等回执：
// Worker 已收到终态时按回执的实际用量结算，回执终态为 cancelled 时由对账直接记为不计量。
export function awaitsGatewayReceipt(bag = {}) {
  if (bag.execution_kind !== 'gateway_worker' || bag.usage_confidence === 'complete') return false
  return (
    bag.final_state === 'verified' ||
    bag.final_state === 'ambiguous' ||
    (bag.final_state === 'cancelled' && bag.gateway_await_receipt === true)
  )
}

export function recordGatewayAttempts(attemptsRepo, { requestId, model, result, accountId, final }) {
  if (!attemptsRepo || !requestId) return
  const attempts = gatewayAttempts(result?.headers)
  const rows = attempts.length ? attempts : [{ account: accountId || null, status: result?.status || 0 }]
  rows.forEach((item, index) => {
    const lastRow = index === rows.length - 1
    try {
      attemptsRepo.record({
        requestId,
        attemptNo: index + 1,
        vmId: null,
        accountId: item.account || accountId || null,
        model,
        selectionReason: index ? 'gateway_worker_retry' : 'gateway_worker',
        upstreamStatus: item.status || (lastRow ? result?.status : 0) || 0,
        terminalState: lastRow ? final.terminalState : 'upstream_error',
        action: lastRow ? final.errorCode || null : item.category || null,
        downstreamCommitted: lastRow ? !!final.downstreamCommitted : false,
        usage: lastRow ? final.usage || null : null,
        upstreamRequestId: item.upstream_request_id || null,
        cfRay: item.cf_ray || null,
      })
    } catch {}
  })
}

// 正在投影的实例（模块级：心跳路由与面板手动注册路由各有服务实例）
const projectingInstances = new Set()

export class GatewayWorkerService {
  constructor({ repo = new GatewayWorkerRepo(), secret = process.env.KIN_CODEX_GATEWAY_INTERNAL_TOKEN || '' } = {}) {
    this.repo = repo
    this.client = new GatewayWorkerClient({ repo, secret })
  }

  hasGroupScope(req) {
    const groupId = req?.apiKeyRecord?.group_id
    if (!groupId) return false
    try {
      const row = getDb()
        .prepare(`SELECT 1 FROM group_resources WHERE group_id=? AND resource_kind='gateway_worker_account' LIMIT 1`)
        .get(groupId)
      return !!row
    } catch {
      return false
    }
  }

  // 分组也绑定了 Codex VM：Gateway 未发出请求时可回退 VM
  hasVmScope(req) {
    const groupId = req?.apiKeyRecord?.group_id
    if (!groupId) return false
    try {
      return !!getDb()
        .prepare(`SELECT 1 FROM group_resources WHERE group_id=? AND resource_kind='vm' LIMIT 1`)
        .get(groupId)
    } catch {
      return false
    }
  }

  // 分组绑定了 Gateway 账号才走 Worker；preference=vm 强制保持 Codex VM
  shouldUse(req, routing = {}) {
    const preference = String(routing?.codex?.gateway_worker?.preference || 'auto')
    if (preference === 'vm') return false
    const scoped = this.hasGroupScope(req)
    if (preference === 'gateway_worker') return scoped
    return scoped
  }

  // 账号重试与换号在 Worker 内完成；控制面只在 Worker 明确未发送（容量满、无账号、
  // 未连上）时换一个实例，已发送或结果不明的请求不跨实例重放。
  async execute({
    req,
    protocol,
    operation = 'responses',
    model,
    body,
    headers = {},
    requestId,
    attemptId,
    scope = {},
    scheduling = null,
    connectionKey = null,
    upstreamTransport = null,
    replayBody = null,
    preferInstance = null,
    signal = null,
  }) {
    const exclude = new Set()
    const forwarded = gatewayForwardHeaders(headers, { passthrough: protocol === 'openai.responses' })
    const id = requestId || req?._kinRequestId || crypto.randomUUID()
    const accountProtection = gatewayAccountProtection()
    // Guardian 父响应归属按调用方隔离（与续接归属同一范围哈希）
    const clientScope = codexClientScope(req)
    // 分组 Fast 三态由 Worker 在选号后按账号套餐目录执行
    let fastMode = null
    try {
      fastMode = req?.apiKeyRecord ? keyScopeFromRequest(req)?.codex_fast_mode || null : null
    } catch {}
    // 上游客户端画像：Key 覆盖优先，否则通用设置；部署配套头与隐私规则随请求冻结
    const profileSetting = readClientProfileSetting()
    const clientProfile = keyClientProfile(req?.apiKeyRecord) || profileSetting.selection
    const privacy = activePrivacyPolicy(readPrivacyPolicySetting())
    const requestLocation = globalRequestLocation()
    let last = null
    for (let hop = 0; hop < MAX_INSTANCE_HOPS; hop++) {
      const instance = this.repo.pickInstance({ operation, model, exclude, prefer: preferInstance })
      if (!instance) break
      exclude.add(instance.id)
      const unsynced = this.repo.unsyncedRuntimeAccounts(instance.id)
      const expiresAt = new Date(Date.now() + 120_000).toISOString()
      let result
      try {
        result = await this.client.execute({
          instanceId: instance.id,
          requestId: id,
          attemptId,
          protocol,
          operation,
          model,
          scope: unsynced.length ? { ...scope, exclude_accounts: unsynced } : scope,
          body,
          headers: forwarded,
          expiresAt,
          scheduling,
          connectionKey,
          upstreamTransport,
          replayBody,
          accountProtection,
          clientScope,
          fastMode,
          clientProfile,
          profileDeployment: profileSetting.deployment,
          privacy,
          requestLocation,
          signal,
        })
      } catch (error) {
        if (error?.send_state !== 'not_sent') throw Object.assign(error, { instance_id: instance.id })
        last = {
          ok: false,
          status: 503,
          send_state: 'not_sent',
          instance_id: instance.id,
          dispatch_id: error.dispatch_id,
          body: {
            error: { type: 'server_error', code: 'gateway_worker_unavailable', message: 'Gateway Worker 暂不可用' },
          },
        }
        continue
      }
      const sendState = result.headers?.['x-kin-gateway-send-state'] || null
      const out = {
        ...result,
        send_state: sendState,
        body: result.stream ? result.body : result.data,
        instance_id: instance.id,
      }
      if (!result.ok && sendState === 'not_sent' && result.status >= 500 && result.status !== 501) {
        await drainBody(out)
        last = out
        continue
      }
      return out
    }
    return (
      last || {
        ok: false,
        status: 503,
        send_state: 'not_sent',
        body: {
          error: { type: 'server_error', code: 'gateway_worker_unavailable', message: 'Gateway Worker 暂不可用' },
        },
      }
    )
  }

  async internal(path, options = {}) {
    const instance = this.repo.pickInstance()
    if (!instance)
      return {
        ok: false,
        status: 503,
        data: { error: { code: 'gateway_worker_unavailable', message: 'Gateway Worker 暂不可用' } },
      }
    return this.client.internal(instance.id, path, options)
  }

  async upsertAccount(account, instanceId = null) {
    const instance = instanceId ? this.repo.getInstance(instanceId) : this.repo.pickInstance()
    if (!instance) return { ok: false, status: 503, data: { error: { code: 'gateway_worker_unavailable' } } }
    return this.client.upsertAccount(instance.id, account)
  }

  async oauthStart(body = {}, instanceId = null) {
    const instance = instanceId ? this.repo.getInstance(instanceId) : this.repo.pickInstance()
    if (!instance) return { ok: false, status: 503, data: { error: { code: 'gateway_worker_unavailable' } } }
    return this.client.oauthStart(instance.id, body)
  }

  async oauthComplete(body = {}, instanceId = null) {
    const instance = instanceId ? this.repo.getInstance(instanceId) : this.repo.pickInstance()
    if (!instance) return { ok: false, status: 503, data: { error: { code: 'gateway_worker_unavailable' } } }
    return this.client.oauthComplete(instance.id, body)
  }

  async projectAccountToAll(account, sourceInstanceId = null) {
    const instances = this.repo
      .listInstances()
      .filter((item) => ['healthy', 'degraded'].includes(item.health_state) && item.drain_state === 'accepting')
    if (!instances.length) return { ok: false, status: 503, data: { error: { code: 'gateway_worker_unavailable' } } }
    const source = sourceInstanceId ? this.repo.getInstance(sourceInstanceId) : null
    const results = []
    for (const instance of instances) {
      try {
        let result
        if (source && account.id) {
          const exported = await this.client.exportAccount(source.id, account.id)
          if (!exported.ok)
            throw Object.assign(new Error('source account export failed'), {
              status: exported.status,
              code: exported.data?.error?.code,
            })
          result =
            instance.id === source.id
              ? { ok: true, status: 200, data: { account: exported.data?.account || {} } }
              : await this.client.importAccount(instance.id, account.id, {
                  ...(exported.data?.account || {}),
                  ...(exported.data?.credential_bundle ? { credential_bundle: exported.data.credential_bundle } : {}),
                })
        } else {
          result = await this.client.projectAccount(instance.id, account)
        }
        const ok = !!result?.ok
        if (account.account_resource_id)
          this.repo.recordProjection({
            accountResourceId: account.account_resource_id,
            instanceId: instance.id,
            runtimeAccountId: account.id,
            projectionRevision: Number(account.projection_revision || 1),
            credentialRevision: Number(account.credential_revision || result?.data?.account?.credential_revision || 0),
            status: ok ? 'synced' : 'drifted',
            error: ok ? null : result?.data?.error?.code || result?.error || 'projection_failed',
          })
        results.push({ instance_id: instance.id, ...result })
      } catch (error) {
        results.push({
          instance_id: instance.id,
          ok: false,
          status: error.status || 502,
          error: error.code || error.message,
        })
      }
    }
    return { ok: results.every((item) => item.ok), results, status: results.every((item) => item.ok) ? 200 : 207 }
  }

  accountPatch(account, projectionRevision) {
    return gatewayAccountPatch(this.repo.db, account, projectionRevision)
  }

  projectableAccount(accountResourceId) {
    return this.repo.listProjectableAccounts({ id: accountResourceId })[0] || null
  }

  // Worker 心跳（含首次注册）带回各账号的凭据代次、投影版本与配置指纹（account_revisions）时，只投影与期望不一致的账号；
  // 没有回报（手动触发或旧版 Worker）时按全量投影。同一实例的投影在进程内不并发执行（心跳与手动注册路由各有服务实例）。
  async projectAllAccountsTo(instanceId, { revisions = null } = {}) {
    const target = this.repo.getInstance(instanceId)
    if (!target) return { ok: false, status: 404 }
    if (projectingInstances.has(instanceId)) return { ok: true, skipped: 'projection_in_progress', results: [] }
    projectingInstances.add(instanceId)
    try {
      return await this.projectAccountsTo(instanceId, revisions)
    } finally {
      projectingInstances.delete(instanceId)
    }
  }

  async projectAccountsTo(instanceId, revisions) {
    const reported = Array.isArray(revisions)
      ? new Map(revisions.filter((item) => item?.account_id).map((item) => [String(item.account_id), item]))
      : null
    const bindingsByAccount = new Map()
    for (const binding of this.repo.listAllAccountBindings()) {
      const list = bindingsByAccount.get(binding.account_resource_id) || []
      list.push(binding)
      bindingsByAccount.set(binding.account_resource_id, list)
    }
    const results = []
    for (const account of this.repo.listProjectableAccounts()) {
      const bindings = bindingsByAccount.get(account.id) || []
      // 最近更新的绑定作为投影失败时记录的运行账号（与账号列表的取值一致）
      account.runtime_account_id = bindings[0]?.runtime_account_id || null
      account.credential_revision = bindings[0]?.credential_revision || 0
      bindings.sort((a, b) => b.credential_revision - a.credential_revision)
      // 从未进入任何 Worker 的账号（如开户中途失败）既无凭据来源，也不在本实例运行；
      // 写入 drifted 只会让本实例整体拒绝推理，因此跳过
      if (!bindings.length) {
        results.push({ account_id: account.id, ok: true, skipped: 'no_projection_source' })
        continue
      }
      if (account.status === 'archived') {
        results.push(await this.retireArchivedAccount(account, bindings, instanceId, reported))
        continue
      }
      const patch = this.accountPatch(account)
      const local = bindings.find((binding) => binding.gateway_instance_id === instanceId)
      const current = local && reported?.get(String(local.runtime_account_id))
      if (
        current &&
        local.projection_status === 'synced' &&
        current.config_fingerprint === patch.config_fingerprint &&
        Number(current.credential_revision || 0) >= Number(bindings[0].credential_revision || 0) &&
        Number(current.projection_revision || 0) >= Number(account.config?.projection_revision || 1)
      ) {
        results.push({ account_id: account.id, ok: true, skipped: 'projection_current' })
        continue
      }
      const preferred = bindings.find(
        (binding) =>
          binding.gateway_instance_id === instanceId &&
          binding.credential_revision === bindings[0]?.credential_revision,
      )
      const candidates = [
        preferred,
        ...bindings.filter(
          (binding) => binding !== preferred && ['synced', 'drifted'].includes(binding.projection_status),
        ),
      ].filter(Boolean)
      // 来源仍在首个实例上同步、本实例也没有旧副本时，本实例不可能用旧配置接单，等下次心跳
      if (!candidates.length && !bindings.some((binding) => binding.gateway_instance_id === instanceId)) {
        results.push({ account_id: account.id, ok: true, skipped: 'projection_source_pending' })
        continue
      }
      let source = candidates[0]
      try {
        let result
        if (source) {
          // 本实例丢失账号（数据目录重建等）时改从其他实例的绑定恢复
          let exported = null
          for (const candidate of candidates) {
            source = candidate
            exported = await this.client
              .exportAccount(candidate.gateway_instance_id, candidate.runtime_account_id)
              .catch(() => null)
            if (exported?.ok) break
          }
          if (!exported?.ok) throw new Error('source export failed')
          result =
            instanceId === source.gateway_instance_id
              ? { ok: true, data: exported.data }
              : await this.client.importAccount(instanceId, source.runtime_account_id, {
                  ...(exported.data?.account || {}),
                  ...(exported.data?.credential_bundle ? { credential_bundle: exported.data.credential_bundle } : {}),
                })
        } else {
          result = { ok: false, status: 409, data: { error: { code: 'gateway_projection_source_missing' } } }
        }
        if (result.ok && source) {
          result = await this.client.patchAccount(
            instanceId,
            source.runtime_account_id,
            this.accountPatch(account, account.config?.projection_revision || source.projection_revision || 1),
          )
        }
        if (account.id)
          this.repo.recordProjection({
            accountResourceId: account.id,
            instanceId,
            runtimeAccountId: source?.runtime_account_id || account.runtime_account_id || account.id,
            projectionRevision: Number(account.config?.projection_revision || source?.projection_revision || 1),
            credentialRevision: Number(result.data?.account?.credential_revision || account.credential_revision || 0),
            status: result.ok ? 'synced' : 'drifted',
            error: result.ok ? null : result.data?.error?.code || 'projection_failed',
          })
        results.push({ account_id: account.id, ...result })
      } catch (error) {
        this.repo.recordProjection({
          accountResourceId: account.id,
          instanceId,
          runtimeAccountId: source?.runtime_account_id || account.runtime_account_id || account.id,
          projectionRevision: Number(account.config?.projection_revision || source?.projection_revision || 1),
          credentialRevision: source?.credential_revision || 0,
          status: 'drifted',
          error: 'projection_failed',
        })
        results.push({ account_id: account.id, ok: false, status: 502, error: error.message })
      }
    }
    return { ok: results.every((item) => item.ok), results }
  }

  // 归档账号不导入新实例；本实例已有的绑定只需确认停用。实例上已不存在等同已停用，
  // 两者都记为 archived（不阻塞实例接单），停用失败才记 drifted 以免旧配置继续接流量
  async retireArchivedAccount(account, bindings, instanceId, reported = null) {
    const local = bindings.find((binding) => binding.gateway_instance_id === instanceId)
    if (!local) return { account_id: account.id, ok: true, skipped: 'archived_not_projected' }
    const projectionRevision = Number(account.config?.projection_revision || local.projection_revision || 1)
    // 已确认停用的归档绑定：心跳回报该账号已不在实例上，或投影版本不旧于归档版本时不再重复停用；
    // 没有回报（注册、手动触发）或实例回到旧版本（如从旧备份恢复）时照常停用
    const current = reported?.get(String(local.runtime_account_id))
    if (
      local.projection_status === 'archived' &&
      reported &&
      (!current || Number(current.projection_revision || 0) >= projectionRevision)
    )
      return { account_id: account.id, ok: true, skipped: 'archived' }
    let result
    try {
      result = await this.client.patchAccount(instanceId, local.runtime_account_id, {
        groups: [],
        enabled: false,
        paused: true,
        projection_revision: projectionRevision,
      })
    } catch (error) {
      result = {
        ok: false,
        status: 502,
        data: { error: { code: 'gateway_worker_unavailable', message: error.message } },
      }
    }
    const retired = result.ok || result.status === 404
    this.repo.recordProjection({
      accountResourceId: account.id,
      instanceId,
      runtimeAccountId: local.runtime_account_id,
      projectionRevision,
      credentialRevision: Number(result.data?.account?.credential_revision || local.credential_revision || 0),
      status: retired ? 'archived' : 'drifted',
      error: retired ? null : result.data?.error?.code || 'projection_failed',
    })
    return { account_id: account.id, ok: retired, status: retired ? 200 : result.status || 502 }
  }

  // 个人资料、订阅与头像属于上游账号：在一个健康绑定上只读查询
  async accountInsight(accountResourceId, kind) {
    if (!['profile', 'subscription', 'avatar'].includes(kind))
      return { ok: false, status: 400, data: { error: { code: 'unsupported_account_action' } } }
    const bindings = this.repo.listAccountBindings(accountResourceId)
    if (!bindings.length)
      return { ok: false, status: 404, data: { error: { code: 'gateway_account_binding_not_found' } } }
    const source =
      bindings.find((binding) => this.repo.getInstance(binding.gateway_instance_id)?.health_state === 'healthy') ||
      bindings[0]
    return this.client.accountInsight(
      source.gateway_instance_id,
      encodeURIComponent(source.runtime_account_id),
      kind,
    )
  }

  async accountAction(accountResourceId, action, body = {}) {
    const allowed = new Set([
      'pause',
      'resume',
      'refresh',
      'recover',
      'reauthorize',
      'test',
      'quota',
      'reset-credits',
      'status',
    ])
    if (!allowed.has(action)) return { ok: false, status: 400, data: { error: { code: 'unsupported_account_action' } } }
    const bindings = this.repo.listAccountBindings(accountResourceId)
    if (!bindings.length)
      return { ok: false, status: 404, data: { error: { code: 'gateway_account_binding_not_found' } } }
    if (['test', 'quota', 'reset-credits'].includes(action)) {
      // 额度与重置卡属于上游账号而非 Worker 实例：只在一个在线实例上执行一次，再把快照写回所有绑定
      const source =
        bindings.find((binding) => this.repo.getInstance(binding.gateway_instance_id)?.health_state === 'healthy') ||
        bindings[0]
      const payload =
        action === 'reset-credits'
          ? { credit_id: body?.credit_id || undefined, redeem_request_id: body?.redeem_request_id || undefined }
          : {}
      const result = await this.client.accountAction(
        source.gateway_instance_id,
        encodeURIComponent(source.runtime_account_id),
        action,
        payload,
      )
      if (result.ok && result.data?.quota) this.repo.recordAccountQuota(accountResourceId, result.data.quota)
      return { ...result, status: result.ok ? 200 : result.status || 502 }
    }
    if (['refresh', 'reauthorize'].includes(action)) {
      const source = bindings[0]
      const refreshed = await this.client.accountAction(
        source.gateway_instance_id,
        encodeURIComponent(source.runtime_account_id),
        action,
        body,
      )
      if (!refreshed.ok) return refreshed
      const projected = await this.projectAccountToAll(
        {
          id: source.runtime_account_id,
          account_resource_id: accountResourceId,
          credential_revision: Number(refreshed.data?.account?.credential_revision || 0),
          projection_revision: Number(source.projection_revision || 1) + 1,
        },
        source.gateway_instance_id,
      )
      const revision = Number(refreshed.data?.account?.credential_revision || 0)
      for (const binding of bindings) {
        this.repo.db
          .prepare(
            'UPDATE gateway_worker_account_bindings SET credential_revision=CASE WHEN ? > credential_revision THEN ? ELSE credential_revision END,projection_status=?,last_seen_at=?,updated_at=? WHERE account_resource_id=? AND gateway_instance_id=?',
          )
          .run(
            revision,
            revision,
            projected.ok ? 'synced' : 'drifted',
            new Date().toISOString(),
            new Date().toISOString(),
            accountResourceId,
            binding.gateway_instance_id,
          )
      }
      return projected.ok
        ? refreshed
        : {
            ok: false,
            status: 207,
            data: {
              error: { code: 'gateway_account_projection_pending' },
              source: refreshed.data,
              projection: projected,
            },
          }
    }
    const results = []
    for (const binding of bindings) {
      const instance = this.repo.getInstance(binding.gateway_instance_id)
      if (!instance) {
        results.push({ ok: false, status: 503, instance_id: binding.gateway_instance_id })
        continue
      }
      const result = await this.client.accountAction(
        instance.id,
        encodeURIComponent(binding.runtime_account_id),
        action,
        body,
      )
      results.push({ instance_id: instance.id, ...result })
    }
    const ok = results.every((item) => item.ok)
    if (ok && action === 'pause') this.markAccountProjection(accountResourceId, 'paused')
    if (ok && action === 'resume') this.markAccountProjection(accountResourceId, 'active')
    return { ok, status: ok ? 200 : 207, results, data: results.find((item) => item.ok)?.data || results[0]?.data }
  }

  // 面板「额度探测」：逐个查询在用 Gateway 账号的上游额度并写回（与单账号额度查询同一路径）
  async probeAccountQuotas({ concurrency = 4 } = {}) {
    const accounts = this.repo
      .listCodexAccounts()
      .filter(
        (account) =>
          account.status === 'active' && account.runtime_account_id && Number(account.credential_revision || 0) > 0,
      )
    const items = []
    let next = 0
    const probe = async () => {
      while (next < accounts.length) {
        const account = accounts[next++]
        try {
          const result = await this.accountAction(account.id, 'quota')
          const error = result.data?.error
          items.push(
            result.ok
              ? { id: account.name, ok: true }
              : { id: account.name, ok: false, error: error?.message || error?.code || `HTTP ${result.status}` },
          )
        } catch (error) {
          items.push({ id: account.name, ok: false, error: error?.message || String(error) })
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, accounts.length) }, probe))
    return items
  }

  async cancel(instanceId, dispatchId) {
    return this.client.cancel(instanceId, dispatchId)
  }

  // 没有 Codex VM 槽时的上游目录来源：依次尝试支持 models 的在线 Worker
  async fetchModelCatalog(clientVersion) {
    const exclude = new Set()
    let last = { ok: false, error: 'gateway_worker_unavailable' }
    for (let hop = 0; hop < MAX_INSTANCE_HOPS; hop++) {
      const instance = this.repo.pickInstance({ operation: 'models', exclude })
      if (!instance) break
      exclude.add(instance.id)
      try {
        const result = await this.client.modelCatalog(instance.id, clientVersion)
        if (result.ok && result.data?.catalog)
          return { ok: true, instance_id: instance.id, catalog: result.data.catalog }
        last = { ok: false, error: result.data?.error?.code || 'model_catalog_unavailable' }
      } catch (error) {
        last = { ok: false, error: error?.code || 'gateway_worker_unavailable' }
      }
    }
    return last
  }

  async wsFrame(instanceId, connectionKey, frame) {
    return this.client.wsFrame(instanceId, connectionKey, frame)
  }

  async wsClose(instanceId, connectionKey) {
    return this.client.wsClose(instanceId, connectionKey)
  }

  async patchAccount(accountResourceId, patch = {}) {
    const bindings = this.repo.listAccountBindings(accountResourceId)
    if (!bindings.length)
      return { ok: false, status: 404, data: { error: { code: 'gateway_account_binding_not_found' } } }
    const results = []
    for (const binding of bindings) {
      const result = await this.client.patchAccount(
        binding.gateway_instance_id,
        encodeURIComponent(binding.runtime_account_id),
        patch,
      )
      results.push({ instance_id: binding.gateway_instance_id, ...result })
    }
    return {
      ok: results.every((item) => item.ok),
      status: results.every((item) => item.ok) ? 200 : 207,
      results,
      data: results.find((item) => item.ok)?.data || results[0]?.data,
    }
  }

  markAccountProjection(accountResourceId, status) {
    try {
      this.repo.db
        .prepare('UPDATE vendor_resources SET status=?,updated_at=? WHERE id=?')
        .run(status, new Date().toISOString(), accountResourceId)
    } catch {}
  }
}
