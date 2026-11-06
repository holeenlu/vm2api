/**
 * VM slot quota window capacity (codex-proxy-rs sampling, see `quota-capacity.mjs`): the slot's
 * used% history from `quota_observations` paired with its own usage_logs rows. Runs inside the
 * billing statistics worker; results are reused until a new observation arrives.
 */
import { capacityEstimateStatus, windowCapacity } from './quota-capacity.mjs'
import { RESET_TOLERANCE_MS } from './quota-observations.mjs'
import { latestObservationWithId, observationsSince, slotUsageRows } from './repos/quota-observations-repo.mjs'

const CACHE_LIMIT = 1024

function empty(status) {
  return { status, capacity_usd: null, capacity_tokens: null, low_sample: false, incomplete_cost: false }
}

/** `window`: '5h' | '7d' | '7d_oi'. `cache`: a Map kept by the caller across calls. */
export async function vmWindowForecast(db, { vmId, window, coveredSince = 0, now = Date.now(), cache = null }) {
  if (!vmId) return empty('no_data')
  const latest = await latestObservationWithId(db, vmId, window)
  if (!latest) return empty('no_data')
  const resetAt = Date.parse(latest.reset_at || '')
  if (!Number.isFinite(resetAt) || resetAt <= now) return empty('no_reset')
  const key = `${vmId}\0${window}\0${latest.id}\0${coveredSince}`
  const hit = cache?.get(key)
  if (hit) return hit
  const seconds = Number(latest.window_seconds)
  const start = new Date(resetAt - seconds * 1000).toISOString()
  const observations = (await observationsSince(db, vmId, window, start, latest.id)).map((row) => ({
    observedAt: Date.parse(row.observed_at),
    resetAt: Date.parse(row.reset_at || ''),
    usedPercent: Number(row.used_percent),
  }))
  const usageRows = (await slotUsageRows(db, vmId, window, start, latest.observed_at)).map((row) => {
    const tokens =
      Number(row.input_tokens || 0) +
      Number(row.output_tokens || 0) +
      Number(row.cache_read_tokens || 0) +
      Number(row.cache_creation_tokens || 0)
    const unpriced = row.pricing_model === 'unpriced' && tokens > 0
    return {
      // usage_logs.created_at is stamped when the request finishes.
      completedAt: Date.parse(row.created_at),
      included: row.ok === 1,
      tokens,
      missingTokens: row.input_tokens == null || row.output_tokens == null,
      cost: unpriced || row.total_cost == null ? null : Number(row.total_cost),
    }
  })
  const capacity = windowCapacity({
    window: { seconds, resetAt, usedPercent: Number(latest.used_percent) },
    observedAt: Date.parse(latest.observed_at),
    observations,
    usageRows,
    coveredSince,
    now,
    resetJitterMs: RESET_TOLERANCE_MS,
  })
  const result = {
    status: capacityEstimateStatus(capacity.reason),
    capacity_usd: capacity.capacity_usd,
    capacity_tokens: capacity.capacity_tokens,
    low_sample: capacity.low_sample,
    incomplete_cost: capacity.incomplete_cost,
  }
  if (cache) {
    if (cache.size >= CACHE_LIMIT) cache.clear()
    cache.set(key, result)
  }
  return result
}
