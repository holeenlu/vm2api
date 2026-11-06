/**
 * VM slot quota observation history (migration 093 `quota_observations`): one row each time a
 * window's used% or reset changes. The capacity forecast pairs these with logged usage.
 * Writes happen on the request path, so unchanged readings cost one in-memory comparison.
 */
import { getDb } from '../db/database.mjs'
import { parseResetMs, toPercentUsed } from '../pool/quota-window.mjs'
import { insertObservation, latestObservation, pruneObservationsBefore } from './repos/quota-observations-repo.mjs'

export const QUOTA_OBSERVATION_WINDOWS = { '5h': 5 * 3600, '7d': 7 * 86_400, '7d_oi': 7 * 86_400 }
const RETAIN_MS = 9 * 86_400_000
const PRUNE_INTERVAL_MS = 3_600_000
// Codex reset times derived from reset-after-seconds move a little on every reply.
export const RESET_TOLERANCE_MS = 60_000

const lastByDb = new WeakMap()
const prunedAtByDb = new WeakMap()

function lastFor(db) {
  let map = lastByDb.get(db)
  if (!map) {
    map = new Map()
    lastByDb.set(db, map)
  }
  return map
}

function sameReset(a, b) {
  const x = Date.parse(a || '')
  const y = Date.parse(b || '')
  if (!Number.isFinite(x) || !Number.isFinite(y)) return !Number.isFinite(x) && !Number.isFinite(y)
  return Math.abs(x - y) <= RESET_TOLERANCE_MS
}

/**
 * `windows`: { '5h' | '7d' | '7d_oi': { utilization (ratio or percent), reset, seconds? } }.
 * Readings without utilization or reset are skipped (no reading is not 0%). Failures never reach the caller.
 */
export function recordQuotaObservations(vmId, windows, { now = Date.now(), db = null } = {}) {
  if (!vmId || !windows) return 0
  let handle = db
  try {
    handle ||= getDb()
  } catch {
    return 0
  }
  let written = 0
  try {
    const last = lastFor(handle)
    for (const [key, defaultSeconds] of Object.entries(QUOTA_OBSERVATION_WINDOWS)) {
      const reading = windows[key]
      const used = toPercentUsed(reading?.utilization)
      if (used == null) continue
      const usedPercent = Math.round(used * 100) / 100
      // Without a reset the reading cannot be tied to a window cycle.
      const resetMs = parseResetMs(reading.reset ?? reading.reset_at)
      if (!Number.isFinite(resetMs)) continue
      const reset = new Date(resetMs).toISOString()
      const mapKey = `${vmId}\0${key}`
      let prev = last.get(mapKey)
      if (prev === undefined) {
        prev = latestObservation(handle, vmId, key) || null
      }
      if (prev && Number(prev.used_percent) === usedPercent && sameReset(prev.reset_at, reset)) continue
      const seconds = Number(reading.seconds) > 0 ? Math.round(Number(reading.seconds)) : defaultSeconds
      insertObservation(handle, {
        vmId,
        window: key,
        usedPercent,
        resetAt: reset,
        windowSeconds: seconds,
        observedAt: new Date(now).toISOString(),
      })
      last.set(mapKey, { used_percent: usedPercent, reset_at: reset })
      written += 1
    }
    if (written && now - (prunedAtByDb.get(handle) || 0) >= PRUNE_INTERVAL_MS) {
      prunedAtByDb.set(handle, now)
      pruneObservationsBefore(handle, new Date(now - RETAIN_MS).toISOString())
    }
  } catch {
    // Observation history is advisory; a missing table or locked DB must not fail the request.
  }
  return written
}

/** Codex slot `buildCodexUsageView` output → observation windows (window length from window_minutes). */
export function codexUsageWindows(usage) {
  const limits = usage?.limits || {}
  const seconds = (minutes) => (Number(minutes) > 0 ? Number(minutes) * 60 : null)
  return {
    '5h': {
      utilization: limits.used_5h_percent,
      reset: limits.reset_5h_at,
      seconds: seconds(limits.window_5h_minutes),
    },
    '7d': {
      utilization: limits.used_7d_percent,
      reset: limits.reset_7d_at,
      seconds: seconds(limits.window_7d_minutes),
    },
  }
}
