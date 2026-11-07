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
 *
 * BPS（Excel Basispoints）通道已于 2026-11-07 停止运营并移除，`bps_*` 键不再保存，旧值读入时丢弃。
 */
import { CODEX_SMART_WEIGHTS, normalizeCodexScheduling } from '../pool/codex-scheduling-policy.mjs'

export const CODEX_LOCAL_SETTING_KEYS = Object.freeze([
  'gateway_worker',
  'scheduling',
  'warmup',
  'reset_credit',
  'credit_overage',
])

function asObject(raw) {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null
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
  }
}

export const DEFAULT_CODEX_SETTINGS = Object.freeze(normalizeCodexSettings())

/** 从任意对象（例如旧版 routing.json 的 codex 段）取出本地键。 */
export function pickCodexLocalSettings(codex = {}) {
  const src = asObject(codex) || {}
  return Object.fromEntries(CODEX_LOCAL_SETTING_KEYS.filter((key) => key in src).map((key) => [key, src[key]]))
}

export { CODEX_SMART_WEIGHTS }
