/**
 * Codex 本地设置（统一控制面重构 P4，设计第 10 节、15.1）：上游 routing.codex 之外、本地定制新增的设置键。
 *
 * 这些键不再写进 routing.json（上游文件格式保持上游原样），由控制面数据库 executor_settings 保存并带 config_revision
 * （settings-store.mjs）。本文件是这些键的唯一定义：默认值、规范化、设置描述（settings schema，P4.4）与服务端校验。
 *
 *   gateway_worker.preference   Codex 请求走 Gateway Worker 还是 Codex VM（auto / vm / gateway_worker）
 *   scheduling                  账号选择策略与智能权重（codex-scheduling-policy.mjs）
 *   warmup                      账号预热时刻与模型
 *   reset_credit                自动使用重置卡的提前量与周额度上限
 *   credit_overage              窗口用尽后是否用官方点数继续出量
 *   bps_enabled                 BPS 总开关
 *   bps_images                  BPS 图片策略
 *   bps_defaults                账号首次添加 BPS 授权时套用的默认设置模板
 */
import { CODEX_SMART_WEIGHTS, normalizeCodexScheduling } from '../pool/codex-scheduling-policy.mjs'

export { linkCodexSettings } from '../../shared/executor-schema/link-codex-settings.mjs'

export const CODEX_LOCAL_SETTING_KEYS = Object.freeze([
  'gateway_worker',
  'scheduling',
  'warmup',
  'reset_credit',
  'credit_overage',
  'bps_enabled',
  'bps_images',
  'bps_defaults',
])

function asObject(raw) {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null
}

function boundedInt(value, min, max, fallback) {
  const n = Number(value)
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback
}

// BPS 图片策略（对齐 sub2api Excel BPS 图片设置）：auto_compact 由 Gateway Worker 在同一账号上压缩历史图片后继续生成
// （仅官方 Codex 客户端，其他客户端超限改走原生）；warn 接近上限提醒一次、超限要求先 compact；off 不限张数。
// 单张与合计上限受 BPS 原生附件上限（32 MiB / 64 MiB）约束；提醒与预留必须小于张数上限。
export const BPS_IMAGE_POLICIES = Object.freeze(['auto_compact', 'warn', 'off'])
export const BPS_IMAGE_LIMITS = Object.freeze({ maxImages: 200, maxImageMiB: 32, maxTotalMiB: 64 })

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

export const GATEWAY_WORKER_PREFERENCES = Object.freeze(['auto', 'vm', 'gateway_worker'])

/** 本地设置的规范化（未知键丢弃，缺省取默认值）。 */
export function normalizeCodexSettings(raw = {}) {
  const src = asObject(raw) || {}
  return {
    gateway_worker: {
      preference: GATEWAY_WORKER_PREFERENCES.includes(src.gateway_worker?.preference)
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
  }
}

export const DEFAULT_CODEX_SETTINGS = Object.freeze(normalizeCodexSettings())

/** 从任意对象（例如旧版 routing.json 的 codex 段）取出本地键。 */
export function pickCodexLocalSettings(codex = {}) {
  const src = asObject(codex) || {}
  return Object.fromEntries(CODEX_LOCAL_SETTING_KEYS.filter((key) => key in src).map((key) => [key, src[key]]))
}

export { CODEX_SMART_WEIGHTS }
