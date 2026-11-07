/**
 * Quota window capacity forecast (codex-proxy-rs admin quota_forecast / quota_forecast_sampling),
 * shared by Gateway accounts and VM slots.
 *
 * A window reports only used%. Pair each used% observation with the account's cumulative logged
 * usage at that instant, cut the cycle into ≥5pp blocks, and extrapolate the remaining quota from
 * the latest 3 blocks + tail:
 *   capacity = cycle usage + sample usage × (100 − used%) / sample progress%
 * Without paired history the sample is the whole cycle (cumulative), i.e. cycle usage ÷ used%.
 * Read-only estimate; never feeds billing or scheduling.
 */
import { fromMicros, rowMicros } from '../core/money.mjs'

const MIN_USED_PERCENT = 5
const LOW_SAMPLE_PERCENT = 10
const RECENT_BLOCKS = 3
export const MAX_FORECAST_HISTORY_POINTS = 128

export function emptyUsage() {
  return {
    request_count: 0,
    tokens: 0,
    missing_token_count: 0,
    known_cost_count: 0,
    unavailable_cost_count: 0,
    // 金额按整数微单位累加（M6），usd 只是由它派生的展示值
    usd_micros: 0,
    usd: 0,
    excluded_request_count: 0,
  }
}

function difference(current, baseline) {
  const out = {}
  for (const key of Object.keys(current)) {
    if (key === 'usd') continue
    const value = current[key] - baseline[key]
    if (!Number.isFinite(value) || value < 0) return null
    out[key] = value
  }
  out.usd = fromMicros(out.usd_micros)
  return out
}

/**
 * Cumulative usage by completion time: `at(cutoff)` sums rows completed at or before cutoff.
 * Rows: { completedAt, included, tokens, missingTokens, cost (null = unavailable) }.
 */
export function usageTimeline(rows) {
  const sorted = rows.filter((row) => Number.isFinite(row.completedAt)).sort((a, b) => a.completedAt - b.completedAt)
  const times = []
  const totals = []
  const usage = emptyUsage()
  for (const row of sorted) {
    if (!row.included) usage.excluded_request_count += 1
    else {
      usage.request_count += 1
      usage.tokens += row.tokens
      if (row.missingTokens) usage.missing_token_count += 1
      const micros = rowMicros(row, 'cost')
      if (micros == null) usage.unavailable_cost_count += 1
      else {
        usage.known_cost_count += 1
        usage.usd_micros += micros
        usage.usd = fromMicros(usage.usd_micros)
      }
    }
    times.push(row.completedAt)
    totals.push({ ...usage })
  }
  return {
    at(cutoff) {
      let lo = 0
      let hi = times.length
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (times[mid] <= cutoff) lo = mid + 1
        else hi = mid
      }
      return lo === 0 ? emptyUsage() : { ...totals[lo - 1] }
    },
  }
}

/** CPR select_forecast_sample: ≥5pp blocks, latest 3 + tail; a drop over 1pp is discontinuous and restarts. */
export function selectForecastSample({ startAt, current, history, interrupted = false }) {
  const points = history
    .filter(
      (point) =>
        startAt <= point.observedAt &&
        point.observedAt < current.observedAt &&
        Number.isFinite(point.usedPercent) &&
        point.usedPercent >= 0 &&
        point.usedPercent <= 100,
    )
    .sort((a, b) => a.observedAt - b.observedAt)
  const sample = {
    method: 'cumulative',
    startAt,
    endAt: current.observedAt,
    baselinePercent: 0,
    sampledPercent: current.usedPercent,
    blockCount: 0,
    observationCount: points.length,
    discontinuous: interrupted,
    cycleUsage: current.usage,
    usage: current.usage,
  }
  points.push(current)
  const cycleBaseline = interrupted ? points[0] : null
  let anchors = []
  let highWater = null
  for (const point of points) {
    if (highWater) {
      if (point.observedAt <= highWater.observedAt) continue
      if (point.usedPercent < highWater.usedPercent) {
        if (highWater.usedPercent - point.usedPercent <= 1) continue
        sample.discontinuous = true
        anchors = []
      }
    }
    highWater = point
    if (!anchors.length || point.usedPercent - anchors[anchors.length - 1].usedPercent >= MIN_USED_PERCENT) {
      anchors.push(point)
    }
  }
  const last = points[points.length - 1]
  if (cycleBaseline) {
    const usage = difference(last.usage, cycleBaseline.usage)
    if (!usage) {
      sample.discontinuous = true
      return sample
    }
    sample.cycleUsage = usage
  }
  if (anchors.length < 2) return sample
  const baselineIndex = Math.max(0, anchors.length - (RECENT_BLOCKS + 1))
  const baseline = anchors[baselineIndex]
  const progress = last.usedPercent - baseline.usedPercent
  if (!Number.isFinite(progress) || progress < MIN_USED_PERCENT) return sample
  const usage = difference(last.usage, baseline.usage)
  if (!usage) {
    sample.discontinuous = true
    return sample
  }
  if (usage.request_count === 0) return sample
  return {
    ...sample,
    method: 'incremental',
    startAt: baseline.observedAt,
    baselinePercent: baseline.usedPercent,
    sampledPercent: progress,
    blockCount: anchors.length - baselineIndex - 1,
    usage,
    discontinuous: false,
  }
}

function scaled(value, factor) {
  const result = value * factor
  return Number.isFinite(result) && result >= 0 ? result : null
}

// Observations thinned evenly to the cap, always keeping the last one.
function thin(points) {
  if (points.length <= MAX_FORECAST_HISTORY_POINTS) return points
  const sorted = [...points].sort((a, b) => a.observedAt - b.observedAt)
  const step = sorted.length / MAX_FORECAST_HISTORY_POINTS
  const out = []
  for (let i = 0; i < MAX_FORECAST_HISTORY_POINTS - 1; i++) out.push(sorted[Math.floor(i * step)])
  out.push(sorted[sorted.length - 1])
  return out
}

/**
 * Capacity of one quota window.
 * - `window`: { seconds, resetAt (ms), usedPercent|null } — the latest snapshot, observed at `observedAt`.
 * - `observations`: [{ observedAt, resetAt, usedPercent }] earlier snapshots of the same window identity.
 * - `usageRows`: the account's usage rows (see usageTimeline) from the cycle start on.
 * - `coveredSince`: usage before this instant may be missing (account added / logs pruned).
 * Returns `reason` null on success, else a code: no_window, window_expired, no_cycle_snapshot,
 * used_unknown, resampling, partial_cycle, no_usage, low_progress, no_estimate.
 */
export function windowCapacity({
  window,
  observedAt,
  observations = [],
  usageRows = [],
  coveredSince = 0,
  now,
  resetJitterMs = 2_000,
}) {
  const result = {
    reason: 'no_window',
    source: null,
    low_sample: false,
    incomplete_cost: false,
    incomplete_tokens: false,
    capacity_tokens: null,
    capacity_usd: null,
  }
  if (!window || !Number.isFinite(window.resetAt) || !(window.seconds > 0)) return result
  const start = window.resetAt - window.seconds * 1000
  const inCycle = Number.isFinite(observedAt) && start <= observedAt && observedAt <= now
  const cutoff = inCycle ? observedAt : now
  const timeline = usageTimeline(usageRows.filter((row) => row.completedAt >= start && row.completedAt <= cutoff))
  const cycleUsage = timeline.at(cutoff)
  let interrupted = false
  const history = []
  for (const observation of observations) {
    if (observation.usedPercent == null || !Number.isFinite(observation.usedPercent)) continue
    if (Math.abs(observation.resetAt - window.resetAt) > resetJitterMs) {
      // Reset drifted beyond tolerance inside this cycle: the window was reset or rewritten.
      if (observation.observedAt >= start) interrupted = true
      continue
    }
    history.push({
      observedAt: observation.observedAt,
      usedPercent: observation.usedPercent,
      usage: timeline.at(observation.observedAt),
    })
  }
  const sample =
    inCycle && window.usedPercent != null
      ? selectForecastSample({
          startAt: start,
          current: { observedAt, usedPercent: window.usedPercent, usage: cycleUsage },
          history: thin(history),
          interrupted,
        })
      : null
  const usage = sample?.cycleUsage || cycleUsage
  result.source = {
    used_percent: window.usedPercent,
    observed_at: Number.isFinite(observedAt) ? new Date(observedAt).toISOString() : null,
    reset_at: new Date(window.resetAt).toISOString(),
    tokens: usage.tokens,
    usd: usage.known_cost_count > 0 ? usage.usd : null,
  }
  result.incomplete_cost =
    usage.unavailable_cost_count > 0 || usage.known_cost_count === 0 || usage.known_cost_count !== usage.request_count
  result.incomplete_tokens = usage.missing_token_count > 0
  const fail = (reason) => ({ ...result, reason })
  if (!(start <= now && now < window.resetAt)) return fail('window_expired')
  if (!inCycle) return fail('no_cycle_snapshot')
  if (window.usedPercent == null) return fail('used_unknown')
  if (sample.discontinuous) return fail('resampling')
  if (coveredSince > start && sample.method === 'cumulative') return fail('partial_cycle')
  if (usage.request_count === 0) return fail('no_usage')
  if (
    !(
      sample.startAt >= start &&
      sample.sampledPercent >= MIN_USED_PERCENT &&
      sample.sampledPercent <= window.usedPercent
    )
  ) {
    return fail('low_progress')
  }
  result.low_sample =
    sample.sampledPercent < LOW_SAMPLE_PERCENT || (sample.method === 'incremental' && sample.blockCount < 2)
  const remainingFactor = (100 - window.usedPercent) / sample.sampledPercent
  const remainingTokens = sample.usage.tokens > 0 ? scaled(sample.usage.tokens, remainingFactor) : null
  result.capacity_tokens = remainingTokens == null ? null : usage.tokens + remainingTokens
  // 外推的剩余额度按整数微单位取整后再与已用金额相加（M6）
  const remainingMicros =
    sample.usage.known_cost_count > 0 && sample.usage.usd_micros >= 0
      ? scaled(sample.usage.usd_micros, remainingFactor)
      : null
  result.capacity_usd =
    usage.known_cost_count > 0 && remainingMicros != null
      ? fromMicros(usage.usd_micros + Math.round(remainingMicros))
      : null
  result.reason = result.capacity_tokens == null && result.capacity_usd == null ? 'no_estimate' : null
  return result
}

export { scaled as scaleCapacity }

/** Capacity reason → the panel estimate status the UI labels (`lib:usage.*`). */
const ESTIMATE_STATUS = {
  no_window: 'no_data',
  used_unknown: 'no_data',
  window_expired: 'no_reset',
  no_cycle_snapshot: 'log_gap',
  partial_cycle: 'log_gap',
  no_usage: 'log_gap',
  no_estimate: 'log_gap',
  resampling: 'resampling',
  low_progress: 'low_usage',
}

export function capacityEstimateStatus(reason) {
  return reason ? ESTIMATE_STATUS[reason] || 'no_data' : 'ok'
}
