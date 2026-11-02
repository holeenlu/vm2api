/** Fable-only usage ceiling, measured against its own weekly window (7d_oi).
 * The existing weekly_split config is retained; no total-weekly conversion or
 * reservation for regular models is performed. Off by default.
 */
import { parseResetMs } from './quota-window.mjs'

export const DEFAULT_FABLE_SHARE = 0.5

export function normalizeUtil(v) {
  if (v == null || v === '') return null
  const x = Number(v)
  if (!Number.isFinite(x)) return null
  return Math.max(0, Math.min(1, x > 1.5 ? x / 100 : x))
}

function limitRatio(value) {
  const n = typeof value === 'number' || (typeof value === 'string' && value.trim()) ? Number(value) : NaN
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : DEFAULT_FABLE_SHARE
}

export function weeklySplitConfig(quota = {}) {
  const raw = quota?.weekly_split && typeof quota.weekly_split === 'object' ? quota.weekly_split : {}
  return { enabled: raw.enabled === true, fable_share: limitRatio(raw.fable_share) }
}

export function computeWeeklySplit({
  utilization_7d_oi,
  reset_7d_oi,
  fable_share = DEFAULT_FABLE_SHARE,
  enabled = true,
  now = Date.now(),
} = {}) {
  const limit = limitRatio(fable_share)
  const resetMs = parseResetMs(reset_7d_oi)
  const expired = Number.isFinite(resetMs) && resetMs > 0 && resetMs <= now
  const used = expired ? 0 : normalizeUtil(utilization_7d_oi)
  return {
    enabled: !!enabled,
    fable_share: limit,
    fable_utilization: used,
    fable_remaining: used == null ? null : Math.max(0, limit - used),
    fable_blocked: !!enabled && (limit === 0 || (used != null && used >= limit)),
  }
}

export function publicWeeklySplit(split) {
  if (!split?.enabled) return null
  return {
    enabled: true,
    fable_share: split.fable_share,
    fable_utilization: split.fable_utilization,
    fable_remaining: split.fable_remaining,
    fable_blocked: split.fable_blocked,
  }
}

/** This policy only prevents new Fable admissions; other model families are unaffected. */
export function splitBlocksModel(split, model) {
  return split?.enabled &&
    split.fable_blocked &&
    String(model || '')
      .toLowerCase()
      .includes('fable')
    ? 'fable_usage_limit'
    : null
}
