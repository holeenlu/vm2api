import crypto from 'node:crypto'
import { getDb } from '../db/database.mjs'
import { GatewayWorkerRepo } from './gateway-repo.mjs'
import { GatewayWorkerClient } from './gateway-client.mjs'
import { SettingsRepo } from '../db/repos/settings-repo.mjs'
import { compileAccountErrorProtection } from '../pool/account-error-protection.mjs'
import { codexClientScope } from '../db/repos/codex-response-owners-repo.mjs'
import { keyScopeFromRequest } from '../admin/key-scope.mjs'
import { activePrivacyPolicy, readClientProfileSetting, readPrivacyPolicySetting } from './codex-client-profile.mjs'
import { globalRequestLocation } from './request-location.mjs'
import { createCredentialCustody } from '../executor/credential-custody.mjs'
import { codexSettings } from '../executor/settings-store.mjs'
import { groupHasGatewayAccounts, groupHasVms, recordBindingCredentialSeen } from './repos/accounts-repo.mjs'

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
const BLOCKED_PASSTHROUGH_PREFIXES = [
  'sec-websocket-',
  'cf-',
  'x-forwarded-',
  'x-stainless-',
  'sec-ch-ua',
  'sec-fetch-',
  'x-kin-',
]

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
// 截断（incomplete）按“确定失败不计量”不等回执。
export function awaitsGatewayReceipt(bag = {}) {
  if (bag.execution_kind !== 'gateway_worker') return false
  if (bag.usage_confidence === 'complete') return false
  return (
    bag.final_state === 'verified' ||
    bag.final_state === 'ambiguous' ||
    (bag.final_state === 'cancelled' && bag.gateway_await_receipt === true)
  )
}

/**
 * 请求尝试仓储已改 async（R6 B7b）：各行在本次调用里依次发起（没有打开的事务时语句当场执行，返回时各行已写入），
 * 写入失败只吞掉，返回的 Promise 不会拒绝（调用方不必等待）。
 */
export async function recordGatewayAttempts(
  attemptsRepo,
  { requestId, model, result, accountId, final, settingsRevision = null },
) {
  if (!attemptsRepo || !requestId) return
  const attempts = gatewayAttempts(result?.headers)
  const rows = attempts.length ? attempts : [{ account: accountId || null, status: result?.status || 0 }]
  const writes = []
  for (const [index, item] of rows.entries()) {
    const lastRow = index === rows.length - 1
    try {
      const write = attemptsRepo.record({
        requestId,
        attemptNo: index + 1,
        vmId: null,
        accountId: item.account || accountId || null,
        model,
        // 没有 Worker 尝试摘要时写一行控制面观察的占位行，用显式标记识别（R2 复审 N2），由事件补齐时重写（result-writer.mjs）
        selectionReason: attempts.length
          ? index
            ? 'gateway_worker_retry'
            : 'gateway_worker'
          : 'gateway_worker_observed',
        upstreamStatus: item.status || (lastRow ? result?.status : 0) || 0,
        terminalState: lastRow ? final.terminalState : 'upstream_error',
        action: lastRow ? final.errorCode || null : item.category || null,
        downstreamCommitted: lastRow ? !!final.downstreamCommitted : false,
        usage: lastRow ? final.usage || null : null,
        upstreamRequestId: item.upstream_request_id || null,
        cfRay: item.cf_ray || null,
        // 执行通道（迁移 101）：Worker 尝试恒为原生 native（BPS 通道 2026-11-07 移除），占位行为空
        route: attempts.length ? 'native' : null,
        // 失败尝试的上游错误原文（迁移 117）
        errorMessage: item.message,
        credentialRevision: Number.isSafeInteger(item.credential_revision) ? item.credential_revision : null,
        // 本次请求依据的 Codex 设置版本（与信封、回执同一快照，P4.3）
        settingsRevision,
      })
      writes.push(Promise.resolve(write).catch(() => {}))
    } catch {}
  }
  await Promise.all(writes)
}

// 订阅到期：查到后 12 小时内不再补查；查不到（上游失败）的账号 6 小时后再试
const SUBSCRIPTION_STALE_MS = 12 * 60 * 60_000
const SUBSCRIPTION_RETRY_MS = 6 * 60 * 60_000

export class GatewayWorkerService {
  // env：解开实例密钥所用的环境（数据库字段密钥或内部令牌，运维脚本传入只读加载的密钥）
  constructor({
    repo = new GatewayWorkerRepo(),
    secret = process.env.KIN_CODEX_GATEWAY_INTERNAL_TOKEN || '',
    env = process.env,
  } = {}) {
    this.repo = repo
    this.client = new GatewayWorkerClient({ repo, secret, env })
  }

  // 凭据托管（P3.5–P3.9）：以凭据库为准投影令牌。
  // 首次使用时才创建（服务可能在数据库打开前构造），凭据库也按需打开
  get custody() {
    this._custody ||= createCredentialCustody({ db: this.repo.db })
    return this._custody
  }

  async hasGroupScope(req) {
    const groupId = req?.apiKeyRecord?.group_id
    if (!groupId) return false
    try {
      const row = await groupHasGatewayAccounts(getDb(), groupId)
      return !!row
    } catch {
      return false
    }
  }

  // 分组也绑定了 Codex VM：Gateway 未发出请求时可回退 VM
  async hasVmScope(req) {
    const groupId = req?.apiKeyRecord?.group_id
    if (!groupId) return false
    try {
      return !!(await groupHasVms(getDb(), groupId))
    } catch {
      return false
    }
  }

  // 分组绑定了 Gateway 账号才走 Worker；preference=vm 强制保持 Codex VM
  async shouldUse(req, routing = {}) {
    const preference = String(codexSettings().gateway_worker?.preference || 'auto')
    if (preference === 'vm') return false
    const scoped = await this.hasGroupScope(req)
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
      fastMode = req?.apiKeyRecord ? (await keyScopeFromRequest(req))?.codex_fast_mode || null : null
    } catch {}
    // 上游客户端画像：通用设置；部署配套头与隐私规则随请求冻结
    const profileSetting = readClientProfileSetting()
    const clientProfile = profileSetting.selection
    const privacy = activePrivacyPolicy(readPrivacyPolicySetting())
    const requestLocation = globalRequestLocation()
    let last = null
    for (let hop = 0; hop < MAX_INSTANCE_HOPS; hop++) {
      const instance = await this.repo.pickInstance({ operation, model, exclude, prefer: preferInstance })
      if (!instance) break
      exclude.add(instance.id)
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
          scope,
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
    const instance = await this.repo.pickInstance()
    if (!instance)
      return {
        ok: false,
        status: 503,
        data: { error: { code: 'gateway_worker_unavailable', message: 'Gateway Worker 暂不可用' } },
      }
    return this.client.internal(instance.id, path, options)
  }

  async accountInsight(accountResourceId, kind) {
    if (!['profile', 'subscription', 'avatar'].includes(kind))
      return { ok: false, status: 400, data: { error: { code: 'unsupported_account_action' } } }
    const target = await this.accountTarget(accountResourceId)
    if (!target.ok) return target
    const result = await this.client.accountInsight(
      target.instance.id,
      encodeURIComponent(target.binding.runtime_account_id),
      kind,
    )
    // 查到的订阅到期写回账号，列表与卡片直接展示，不为每行再查上游
    if (kind === 'subscription' && result.ok && result.data?.subscription)
      await this.repo.recordAccountSubscription(accountResourceId, result.data.subscription)
    return result
  }

  // 订阅到期低频补查：逐个账号查询并写回；查不到的账号退避，结果不影响账号状态与调度
  async refreshAccountSubscriptions({
    staleMs = SUBSCRIPTION_STALE_MS,
    retryMs = SUBSCRIPTION_RETRY_MS,
    at = Date.now(),
  } = {}) {
    if (this.subscriptionRefreshing) return 0
    this.subscriptionRefreshing = true
    this.subscriptionAttempts ??= new Map()
    let saved = 0
    try {
      for (const id of await this.repo.listSubscriptionRefreshCandidates(new Date(at - staleMs).toISOString())) {
        if (at - (this.subscriptionAttempts.get(id) || 0) < retryMs) continue
        this.subscriptionAttempts.set(id, at)
        try {
          const result = await this.accountInsight(id, 'subscription')
          if (result.ok && result.data?.subscription) {
            this.subscriptionAttempts.delete(id)
            saved += 1
          }
        } catch {}
      }
    } finally {
      this.subscriptionRefreshing = false
    }
    return saved
  }

  startSubscriptionRefresh({ delayMs = 60_000, intervalMs = 60 * 60_000 } = {}) {
    if (this.subscriptionTimers) return
    const run = () => void this.refreshAccountSubscriptions().catch(() => {})
    const first = setTimeout(run, delayMs)
    const every = setInterval(run, intervalMs)
    first.unref?.()
    every.unref?.()
    this.subscriptionTimers = [first, every]
  }

  stopSubscriptionRefresh() {
    for (const timer of this.subscriptionTimers || []) clearTimeout(timer)
    this.subscriptionTimers = null
  }

  async accountAction(accountResourceId, action, body = {}) {
    // 暂停与恢复只改控制面账号状态（account-management.update），Worker 直读生效，不经这里。
    // 重新授权只走授权草稿（OAuth 或账号文件，经校验与审计）：这里不接受 reauthorize，避免调用方正文直接改写
    // Worker 本地账号并被收录进凭据库
    const allowed = new Set(['refresh', 'recover', 'test', 'quota', 'reset-credits', 'status'])
    if (!allowed.has(action)) return { ok: false, status: 400, data: { error: { code: 'unsupported_account_action' } } }
    const target = await this.accountTarget(accountResourceId)
    if (!target.ok) return target
    const { instance, binding } = target
    const payload =
      action === 'reset-credits'
        ? { credit_id: body?.credit_id || undefined, redeem_request_id: body?.redeem_request_id || undefined }
        : ['test', 'quota', 'refresh'].includes(action)
          ? {}
          : body
    const result = await this.client.accountAction(
      instance.id,
      encodeURIComponent(binding.runtime_account_id),
      action,
      payload,
    )
    if (!result.ok) return action === 'refresh' ? result : { ...result, status: result.status || 502 }
    // 额度与重置卡属于上游账号：查到的快照写回绑定
    if (['test', 'quota', 'reset-credits'].includes(action) && result.data?.quota)
      await this.repo.recordAccountQuota(accountResourceId, result.data.quota)
    if (action === 'refresh') {
      // 刷新出的令牌由 Worker 按代次直接写回凭据库（S1b），这里只记下代次
      const revision = Number(result.data?.account?.credential_revision || 0)
      const at = new Date().toISOString()
      await recordBindingCredentialSeen(this.repo.db, revision, revision, 'synced', at, at, accountResourceId)
    }
    return { ...result, status: 200 }
  }

  // 账号管理动作的目标：账号绑定（运行账号 ID）与当前接单的 Worker 实例（只支持同机单个 Worker，迁移 130 起绑定不记实例）
  async accountTarget(accountResourceId) {
    const binding = await this.repo.getAccountBinding(accountResourceId)
    if (!binding) return { ok: false, status: 404, data: { error: { code: 'gateway_account_binding_not_found' } } }
    const instance = await this.repo.pickInstance()
    if (!instance)
      return {
        ok: false,
        status: 503,
        data: { error: { code: 'gateway_worker_unavailable', message: 'Gateway Worker 暂不可用' } },
      }
    return { ok: true, binding, instance }
  }

  // 面板「额度探测」：逐个查询在用 Gateway 账号的上游额度并写回（与单账号额度查询同一路径）
  async probeAccountQuotas({ concurrency = 4 } = {}) {
    const accounts = (await this.repo.listCodexAccounts()).filter(
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
      const instance = await this.repo.pickInstance({ operation: 'models', exclude })
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
}
