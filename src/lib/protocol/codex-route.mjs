import { normalizeCodexScheduling } from '../pool/codex-scheduling-policy.mjs'
/**
 * Codex hop routing. Claude traffic never reads this object.
 */
import { isCodexVm } from '../vm/vm-kind.mjs'
import { normalizeOpenAIQuotaPolicy } from '../pool/openai-quota-policy.mjs'
import { normalizeCodexModelMappings, validateCodexModelMappingsPatch } from './codex-model-mapping.mjs'

export { isCodexVm, normalizeVmKind } from '../vm/vm-kind.mjs'

export const DEFAULT_CODEX_USER_AGENT = 'codex_cli_rs/0.160.0 (linux x86_64)'
export const CODEX_UPSTREAM_TRANSPORTS = Object.freeze(['prefer_websocket', 'http'])

export const DEFAULT_INFERENCE_WEBSOCKET = Object.freeze({ enabled: true })

// BPS 图片策略（对齐 sub2api Excel BPS 图片设置）：auto_compact 由 Gateway Worker 在同一账号上压缩历史图片后继续生成
// （仅官方 Codex 客户端，其他客户端超限改走原生）；warn 接近上限提醒一次、超限要求先 compact；off 不限张数。
// 单张与合计上限受 BPS 原生附件上限（32 MiB / 64 MiB）约束；提醒与预留必须小于张数上限。
export const BPS_IMAGE_POLICIES = Object.freeze(['auto_compact', 'warn', 'off'])
export const BPS_IMAGE_LIMITS = Object.freeze({ maxImages: 200, maxImageMiB: 32, maxTotalMiB: 64 })

function boundedInt(value, min, max, fallback) {
  const n = Number(value)
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback
}

export function normalizeCodexBpsImages(raw) {
  const src = asObject(raw) || {}
  const maxImages = boundedInt(src.max_images, 1, BPS_IMAGE_LIMITS.maxImages, 20)
  return {
    policy: BPS_IMAGE_POLICIES.includes(src.policy) ? src.policy : 'auto_compact',
    max_images: maxImages,
    max_image_mib: boundedInt(src.max_image_mib, 1, BPS_IMAGE_LIMITS.maxImageMiB, 32),
    max_total_mib: boundedInt(src.max_total_mib, 1, BPS_IMAGE_LIMITS.maxTotalMiB, 64),
    warning_remaining: boundedInt(src.warning_remaining, 0, maxImages - 1, Math.min(8, maxImages - 1)),
    compact_reserve: boundedInt(src.compact_reserve, 0, maxImages - 1, Math.min(3, maxImages - 1)),
  }
}

// BPS 默认设置模板（对齐 sub2api 可编辑的 Excel BPS 默认值）：账号首次添加 BPS 授权时套用；
// 403 移组按账号单独设置，不进模板。未配置时与内置默认一致。
export const BPS_DEFAULT_TEMPLATE = Object.freeze({
  enabled: true,
  models: [],
  omit_unsupported_tools: false,
  ignore_encrypted_content: false,
  auto_disable_on_403: true,
  auto_recover_on_403: false,
  recovery_interval_minutes: 60,
  cache_creation_as_input: true,
})

export function normalizeCodexBpsDefaults(raw) {
  const src = asObject(raw) || {}
  const out = { ...BPS_DEFAULT_TEMPLATE }
  for (const key of Object.keys(BPS_DEFAULT_TEMPLATE))
    if (typeof BPS_DEFAULT_TEMPLATE[key] === 'boolean' && typeof src[key] === 'boolean') out[key] = src[key]
  out.recovery_interval_minutes = boundedInt(src.recovery_interval_minutes, 1, 10080, 60)
  out.models = [
    ...new Set(
      (Array.isArray(src.models) ? src.models : []).filter(
        (model) =>
          typeof model === 'string' && model && model === model.trim() && !model.includes('*') && model.length <= 256,
      ),
    ),
  ].slice(0, 100)
  if (!out.auto_disable_on_403) out.auto_recover_on_403 = false
  return out
}

export const DEFAULT_CODEX_ROUTING = Object.freeze({
  enabled: true,
  // `auto` resolves the official Codex catalog client version at sync time,
  // falling back to 0.160.0 when the registry is unavailable.
  catalog_client_version: 'auto',
  user_agent: DEFAULT_CODEX_USER_AGENT,
  upstream_transport: 'prefer_websocket',
  websocket: { enabled: true },
  client_features: { enabled: false },
  analytics: { enabled: false },
  protocols: {
    'openai.responses': { mode: 'native', enabled: true },
    'openai.chat': { mode: 'convert', enabled: true },
    'openai.completions': { mode: 'convert', enabled: true },
    'anthropic.messages': { mode: 'reject', enabled: false },
  },
  convert: {
    chat_to_codex: true,
    completions_to_codex: true,
    anthropic_to_codex: false,
  },
  clients: {
    official_codex: 'allow',
    openai_compatible: 'allow',
    claude_code: 'reject',
    unknown: 'allow',
  },
  quota: normalizeOpenAIQuotaPolicy(),
  gateway_worker: { preference: 'auto' },
  warmup: { enabled: false, times: [], model: '' },
  reset_credit: { lead_minutes: 10, max_weekly_remaining_percent: null },
  credit_overage: false,
  bps_enabled: true,
  bps_images: normalizeCodexBpsImages(),
  bps_defaults: normalizeCodexBpsDefaults(),
})

// Gateway Worker 账号预热（对齐 CPR warmup 策略）：在本地时刻（UTC+8，"HH:MM"）对 OAuth 账号发起最小请求，
// 提前激活 5h 额度窗口。缺少模型或时刻时视为关闭。
export function normalizeCodexWarmup(raw) {
  const src = asObject(raw) || {}
  const times = [
    ...new Set(
      (Array.isArray(src.times) ? src.times : [])
        .map((value) => String(value || '').trim())
        .filter((value) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value)),
    ),
  ]
    .sort()
    .slice(0, 24)
  const model = typeof src.model === 'string' ? src.model.trim().slice(0, 128) : ''
  return { enabled: src.enabled === true && times.length > 0 && !!model, times, model }
}

// Gateway 账号自动使用重置卡（对齐 CPR runtime_settings.reset_credit_*）：到期前 lead 分钟消费，
// 可选“剩余周额度上限”（null 不限）。是否开启按账号配置 reset_credit_auto 决定。
export function normalizeCodexResetCredit(raw) {
  const src = asObject(raw) || {}
  const lead = Number(src.lead_minutes)
  const max = src.max_weekly_remaining_percent
  return {
    lead_minutes: Number.isInteger(lead) && lead >= 1 && lead <= 1440 ? lead : 10,
    max_weekly_remaining_percent:
      max !== null && max !== '' && Number.isInteger(Number(max)) && Number(max) >= 0 && Number(max) <= 100
        ? Number(max)
        : null,
  }
}

function typedError(message, code) {
  const error = new TypeError(message)
  error.code = code
  return error
}

function asObject(raw) {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null
}

function normalizeEnabledToggle(raw, defaultEnabled) {
  const src = asObject(raw) || {}
  return { enabled: defaultEnabled ? src.enabled !== false : src.enabled === true }
}

export function normalizeInferenceWebsocket(raw = {}) {
  return normalizeEnabledToggle(raw, true)
}

function normalizeUserAgent(raw) {
  return typeof raw === 'string' && raw.trim() ? raw.trim() : DEFAULT_CODEX_USER_AGENT
}

function normalizeUpstreamTransport(raw) {
  return CODEX_UPSTREAM_TRANSPORTS.includes(raw) ? raw : 'prefer_websocket'
}

function validateEnabledToggle(raw, path, code) {
  if (!asObject(raw)) throw typedError(`${path} 必须是对象`, code)
  if (Object.prototype.hasOwnProperty.call(raw, 'enabled') && typeof raw.enabled !== 'boolean') {
    throw typedError(`${path}.enabled 必须是布尔`, code)
  }
}

/** PUT /api/panel/routing strict checks. Loaded files still go through normalize. */
export function validateInferenceWebsocketPatch(body = {}) {
  if (!asObject(body)) return
  if (Object.prototype.hasOwnProperty.call(body, 'websocket')) {
    validateEnabledToggle(body.websocket, 'websocket', 'invalid_websocket')
  }
  if (!Object.prototype.hasOwnProperty.call(body, 'codex')) return
  if (!asObject(body.codex)) throw typedError('codex 必须是对象', 'invalid_codex_websocket')
  const codex = body.codex
  if (Object.hasOwn(codex, 'scheduling')) normalizeCodexScheduling(codex.scheduling, { strict: true })
  if (Object.prototype.hasOwnProperty.call(codex, 'websocket')) {
    validateEnabledToggle(codex.websocket, 'codex.websocket', 'invalid_codex_websocket')
  }
  if (Object.prototype.hasOwnProperty.call(codex, 'upstream_transport')) {
    if (!CODEX_UPSTREAM_TRANSPORTS.includes(codex.upstream_transport)) {
      throw typedError('codex.upstream_transport 必须是 prefer_websocket 或 http', 'invalid_upstream_transport')
    }
  }
  if (Object.prototype.hasOwnProperty.call(codex, 'user_agent')) {
    if (typeof codex.user_agent !== 'string' || !codex.user_agent.trim()) {
      throw typedError('codex.user_agent 必须是非空字符串', 'invalid_user_agent')
    }
  }
  if (Object.prototype.hasOwnProperty.call(codex, 'client_features')) {
    validateEnabledToggle(codex.client_features, 'codex.client_features', 'invalid_client_features')
  }
  if (Object.prototype.hasOwnProperty.call(codex, 'analytics')) {
    validateEnabledToggle(codex.analytics, 'codex.analytics', 'invalid_codex_analytics')
  }
  if (Object.prototype.hasOwnProperty.call(codex, 'model_mappings')) {
    validateCodexModelMappingsPatch(codex.model_mappings)
  }
}

export function inferenceWebsocketEnabled(routing = {}) {
  return asObject(routing.websocket)?.enabled !== false && asObject(routing.codex?.websocket)?.enabled !== false
}

export function computedUpstreamTransport(routing = {}) {
  return inferenceWebsocketEnabled(routing) ? normalizeUpstreamTransport(routing.codex?.upstream_transport) : 'http'
}

export function normalizeCodexRouting(raw = {}) {
  const src = asObject(raw) || {}
  const protocols = { ...DEFAULT_CODEX_ROUTING.protocols, ...(src.protocols || {}) }
  for (const key of Object.keys(protocols)) {
    const item = protocols[key] || {}
    const mode = ['native', 'convert', 'reject'].includes(item.mode) ? item.mode : 'reject'
    protocols[key] = { mode, enabled: item.enabled !== false && mode !== 'reject' }
  }
  const clients = { ...DEFAULT_CODEX_ROUTING.clients, ...(src.clients || {}) }
  for (const [key, value] of Object.entries(clients)) {
    clients[key] = value === 'allow' ? 'allow' : 'reject'
  }
  return {
    enabled: src.enabled !== false,
    catalog_client_version:
      typeof src.catalog_client_version === 'string' && src.catalog_client_version.trim()
        ? src.catalog_client_version.trim()
        : 'auto',
    user_agent: normalizeUserAgent(src.user_agent),
    upstream_transport: normalizeUpstreamTransport(src.upstream_transport),
    websocket: normalizeEnabledToggle(src.websocket, true),
    client_features: normalizeEnabledToggle(src.client_features, false),
    analytics: normalizeEnabledToggle(src.analytics, false),
    protocols,
    convert: {
      chat_to_codex: src.convert?.chat_to_codex !== false,
      completions_to_codex: src.convert?.completions_to_codex !== false,
      anthropic_to_codex: src.convert?.anthropic_to_codex === true,
    },
    clients,
    quota: normalizeOpenAIQuotaPolicy(src.quota),
    gateway_worker: {
      preference: ['auto', 'vm', 'gateway_worker'].includes(src.gateway_worker?.preference)
        ? src.gateway_worker.preference
        : 'auto',
    },
    scheduling: normalizeCodexScheduling(src.scheduling),
    warmup: normalizeCodexWarmup(src.warmup),
    reset_credit: normalizeCodexResetCredit(src.reset_credit),
    // 窗口用尽后是否靠 ChatGPT 官方点数继续出量（默认关闭：停放到窗口重置，避免消耗点数）
    credit_overage: src.credit_overage === true,
    // BPS 总开关（默认开启，与 sub2api 新装默认一致）：关闭时所有请求只走原生通道；是否走 BPS 由账号的 BPS 模型名单决定
    bps_enabled: src.bps_enabled !== false,
    bps_images: normalizeCodexBpsImages(src.bps_images),
    bps_defaults: normalizeCodexBpsDefaults(src.bps_defaults),
    model_mappings: normalizeCodexModelMappings(src.model_mappings),
  }
}

export function isCodexProtocolAllowed(protocol, routing = {}) {
  const codex = normalizeCodexRouting(routing.codex || routing)
  if (!codex.enabled) return { ok: false, code: 'codex_disabled', mode: 'reject' }
  const entry = codex.protocols[protocol]
  if (!entry || entry.enabled === false || entry.mode === 'reject') {
    return { ok: false, code: 'protocol_not_allowed', mode: 'reject' }
  }
  return { ok: true, mode: entry.mode }
}

export function listCodexVms(vms = []) {
  return (vms || []).filter((vm) => isCodexVm(vm))
}
