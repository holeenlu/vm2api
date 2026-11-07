const WAIT_TIMEOUT_MIN_MS = 1000
const WAIT_TIMEOUT_MAX_MS = 120000

export const QUEUE_MAX_MIN = 1
export const QUEUE_MAX_MAX = 999
export const SEAT_GRACE_MAX_MS = 120000
export const SEAT_BUDGET_RESERVE_MAX = 0.5
export const CIRCUIT_THRESHOLD_MAX = 20
export const CIRCUIT_OPEN_MIN_MS = 1000
export const WORKER_HEALTH_TTL_MIN_MS = 1000
export const WORKER_HEALTH_TTL_MAX_MS = 60000

/** routing.pool defaults. strategy only places new seats; see seat-planner.mjs. */
export const DEFAULT_POOL_ROUTING = Object.freeze({
  strategy: 'balanced',
  queue_max: 50,
  seat_grace_ms: 30000,
  seat_budget_reserve_pct: 0.02,
  fallback_wait_timeout_ms: 30000,
  sticky_wait_timeout_ms: 45000,
  circuit_failure_threshold: 3,
  circuit_open_ms: 30000,
})

export const DEFAULT_POOL_CONFIG = Object.freeze({
  ...DEFAULT_POOL_ROUTING,
  worker_health_ttl_ms: 5000,
  heartbeat_stale_ms: 15000,
  fable_max_per_account: 4,
  default_max_per_account: 2,
})

function clampNumber(value, fallback, min, max, { round = true } = {}) {
  if (value == null || value === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  const v = round ? Math.round(n) : n
  return Math.min(max, Math.max(min, v))
}

function clampWaitTimeoutMs(value, fallback) {
  return clampNumber(value, fallback, WAIT_TIMEOUT_MIN_MS, WAIT_TIMEOUT_MAX_MS)
}

function circuitSetting(value, fallback, min, max) {
  if (!Number(value)) return fallback
  return clampNumber(value, fallback, min, max)
}

/**
 * Normalize the stored routing.pool block. Legacy strategies (weighted
 * round-robin, round-robin, lru, fill-first) read as balanced; the old
 * per-account waiter cap is dropped in favor of the pool-wide queue_max.
 */
export function normalizePoolRouting(pool = {}) {
  const next = { ...(pool && typeof pool === 'object' ? pool : {}) }
  delete next.max_waiters_per_account
  next.strategy = next.strategy === 'fill' ? 'fill' : 'balanced'
  next.queue_max = clampNumber(next.queue_max, DEFAULT_POOL_ROUTING.queue_max, QUEUE_MAX_MIN, QUEUE_MAX_MAX)
  next.seat_grace_ms = clampNumber(next.seat_grace_ms, DEFAULT_POOL_ROUTING.seat_grace_ms, 0, SEAT_GRACE_MAX_MS)
  next.seat_budget_reserve_pct = clampNumber(
    next.seat_budget_reserve_pct,
    DEFAULT_POOL_ROUTING.seat_budget_reserve_pct,
    0,
    SEAT_BUDGET_RESERVE_MAX,
    { round: false },
  )
  next.sticky_wait_timeout_ms = clampWaitTimeoutMs(
    next.sticky_wait_timeout_ms,
    DEFAULT_POOL_ROUTING.sticky_wait_timeout_ms,
  )
  next.fallback_wait_timeout_ms = clampWaitTimeoutMs(
    next.fallback_wait_timeout_ms,
    DEFAULT_POOL_ROUTING.fallback_wait_timeout_ms,
  )
  // UnitCircuit used to read 0 / junk as its default; store that default so
  // the panel shows the value that actually runs.
  next.circuit_failure_threshold = circuitSetting(
    next.circuit_failure_threshold,
    DEFAULT_POOL_ROUTING.circuit_failure_threshold,
    1,
    CIRCUIT_THRESHOLD_MAX,
  )
  next.circuit_open_ms = circuitSetting(
    next.circuit_open_ms,
    DEFAULT_POOL_ROUTING.circuit_open_ms,
    CIRCUIT_OPEN_MIN_MS,
    Number.MAX_SAFE_INTEGER,
  )
  // 健康缓存周期兼作维护定时器间隔：非数字曾得到 NaN，setInterval 退化成约 1ms 的紧循环、缓存永不命中
  if (next.worker_health_ttl_ms !== undefined)
    next.worker_health_ttl_ms = clampNumber(
      next.worker_health_ttl_ms,
      DEFAULT_POOL_CONFIG.worker_health_ttl_ms,
      WORKER_HEALTH_TTL_MIN_MS,
      WORKER_HEALTH_TTL_MAX_MS,
    )
  return next
}

export function normalizePoolConfig(config = {}) {
  return { ...DEFAULT_POOL_CONFIG, ...normalizePoolRouting(config) }
}

export function formatPoolSelectionSummary(details = {}) {
  const reason = String(details.reason || '').trim()
  if (!reason) return ''
  const parts = [reason]
  const soonest = Number(details.soonest_available_ms)
  if (Number.isFinite(soonest) && soonest > 0) parts.push(`soonest=${Math.round(soonest / 1000)}s`)
  const estimate = Number(details.estimated_wait_ms)
  if (Number.isFinite(estimate) && estimate > 0) parts.push(`estimate=${Math.round(estimate / 1000)}s`)
  const eligible = Number(details.eligible)
  if (Number.isFinite(eligible)) parts.push(`eligible=${eligible}`)
  if (details.sticky_cleared) parts.push('sticky_cleared')
  return parts.join(' ')
}
