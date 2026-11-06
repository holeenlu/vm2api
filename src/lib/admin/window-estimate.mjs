/**
 * Subscription window capacity estimate. The capacity comes from the codex-proxy-rs style
 * sampling of the slot's used% history (`usage/vm-quota-forecast.mjs`, computed with the
 * billing statistics); this shapes it for the panel next to the window's logged spend.
 * Without paired history the sampling falls back to the whole cycle, i.e. spend ÷ used%.
 */
import { toPercentUsed } from '../pool/quota-window.mjs'
import { fromMicros, rowMicros, toMicros } from '../core/money.mjs'

/** Below this the vendor's rounding dominates the ratio (magpie HoldsFloor). */
export const ESTIMATE_MIN_USED_RATIO = 0.05

function round(v, digits) {
  const f = 10 ** digits
  return Math.round(v * f) / f
}

export function usedRatioOf(value) {
  const pct = toPercentUsed(value)
  return pct == null ? null : pct / 100
}

/**
 * @param {{ forecast?: { status, capacity_usd, capacity_tokens, low_sample, incomplete_cost } | null,
 *   spentUsd?: number, usedRatio?: number|null }} input
 */
export function estimateFromForecast({ forecast = null, spentUsd = 0, usedRatio = null } = {}) {
  // 金额在整数微单位上相减（M6）
  const spent = toMicros(spentUsd) || 0
  const ratio =
    usedRatio == null || !Number.isFinite(Number(usedRatio)) ? null : Math.min(1, Math.max(0, Number(usedRatio)))
  const base = {
    status: forecast?.status || 'no_data',
    spent_usd: fromMicros(spent),
    total_usd: null,
    remaining_usd: null,
    total_tokens: null,
    used_ratio: ratio == null ? null : round(ratio, 4),
    low_sample: Boolean(forecast?.low_sample),
    incomplete_cost: Boolean(forecast?.incomplete_cost),
  }
  if (base.status !== 'ok') return base
  const total = toMicros(forecast.capacity_usd)
  const tokens = Number(forecast.capacity_tokens)
  return {
    ...base,
    total_usd: total != null ? fromMicros(total) : null,
    remaining_usd: total != null ? fromMicros(Math.max(total - spent, 0)) : null,
    total_tokens: forecast.capacity_tokens != null && Number.isFinite(tokens) ? Math.round(tokens) : null,
  }
}

/**
 * Remaining spend in the live window. The live estimate wins; while it has no
 * number (fresh window, used% under the floor) the last closed window's
 * spend ÷ final used% stands in for capacity. `closed` carries `start`,
 * `used_ratio`, `total_cost`, `unpriced`.
 */
export function projectWindowRemaining({ live = null, closed = null, spentUsd = 0, coveredSince = null } = {}) {
  if (live?.status === 'ok' && live.total_usd != null) {
    return { source: 'current', total_usd: live.total_usd, remaining_usd: live.remaining_usd }
  }
  const none = { source: null, total_usd: null, remaining_usd: null }
  const ratio = Number(closed?.used_ratio)
  // 金额按整数微单位外推（M6）：上一窗口的花费 ÷ 用量比例，取整到微单位
  const cost = rowMicros(closed, 'total_cost')
  if (!Number.isFinite(ratio) || ratio < ESTIMATE_MIN_USED_RATIO || !(cost > 0)) return none
  if (Number(closed.unpriced) > 0) return none
  const startMs = Date.parse(closed.start || '')
  const coveredMs = Date.parse(coveredSince || '')
  if (!Number.isFinite(startMs) || !Number.isFinite(coveredMs) || coveredMs > startMs) return none
  const total = Math.round(cost / Math.min(1, ratio))
  const spent = toMicros(spentUsd) || 0
  return {
    source: 'previous',
    total_usd: fromMicros(total),
    remaining_usd: fromMicros(Math.max(total - spent, 0)),
  }
}
