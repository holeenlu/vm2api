/**
 * Expected queue wait for the Claude seat queue.
 *
 * A request that cannot be seated used to wait out the whole sticky + fallback
 * budget (45 s + 30 s, up to the failover deadline) and then fail with
 * `pool_queue_timeout` anyway; the client retried at once and queued again.
 * When the pool is purely concurrency-bound the wait is predictable: requests
 * ahead drain at Σ capacity / mean hold time. If that wait cannot fit in the
 * budget the caller answers now, with the estimate as Retry-After.
 *
 * Every unknown keeps the old wait: a VM with no hold history, or one busy for
 * anything other than concurrency (cooldown, RPM, circuit probe), yields null.
 */

const HOLD_ALPHA = 0.2
const MIN_HOLD_SAMPLES = 5

/** Waits that a request completion ends. Anything else frees on its own clock. */
const DRAINED_BY_COMPLETION = new Set(['concurrency_limit', 'quota_band_inflight', 'slot_busy'])

/** Per-VM EWMA of how long one reservation holds its slot (acquire → release). */
export class HoldTimeTracker {
  constructor({ alpha = HOLD_ALPHA, minSamples = MIN_HOLD_SAMPLES } = {}) {
    this.alpha = alpha
    this.minSamples = minSamples
    this.byVm = new Map()
  }

  note(vmId, ms) {
    const id = String(vmId || '')
    const value = Number(ms)
    if (!id || !Number.isFinite(value) || value < 0) return
    const entry = this.byVm.get(id)
    if (!entry) this.byVm.set(id, { meanMs: value, samples: 1 })
    else {
      entry.meanMs += this.alpha * (value - entry.meanMs)
      entry.samples += 1
    }
  }

  /** Mean hold in ms, or null until the VM has enough completed reservations. */
  meanMs(vmId) {
    const entry = this.byVm.get(String(vmId || ''))
    return entry && entry.samples >= this.minSamples ? entry.meanMs : null
  }

  snapshot() {
    return Object.fromEntries(
      [...this.byVm].map(([vmId, entry]) => [vmId, { mean_ms: Math.round(entry.meanMs), samples: entry.samples }]),
    )
  }
}

/**
 * Slots this candidate drains per mean hold. Near the 5h/7d gate one call runs
 * at a time; a new seat also needs a free session slot. A cooldown that lasts
 * past `until` adds nothing; one that may lift sooner is not predictable (null).
 */
function drainSlots(candidate, until) {
  if (candidate.busy && !DRAINED_BY_COMPLETION.has(candidate.waitReason)) {
    const back = Number(candidate.availableAt) || 0
    return back > 0 && back >= until ? 0 : null
  }
  const concurrency = Number(candidate.maxConcurrency) || 0
  const seats = Number(candidate.seatCap) || 0
  const slots = candidate.draining || candidate.waitReason === 'quota_band_inflight' ? 1 : concurrency
  const cap = seats > 0 ? Math.min(slots, seats) : slots
  return cap > 0 ? cap : null
}

/**
 * ms until the request at queue position `ahead` (0 = next) is served, or null
 * when any serving VM is unpredictable.
 * @param {Array<object>} candidates VMs that can serve this request
 * @param {number} ahead requests queued in front of it for those VMs
 * @param {HoldTimeTracker} holds
 * @param {number} until end of this request's wait budget (epoch ms)
 */
export function estimateQueueWaitMs(candidates, ahead, holds, until = Number.POSITIVE_INFINITY) {
  if (!candidates?.length || !holds) return null
  let rate = 0
  for (const candidate of candidates) {
    const slots = drainSlots(candidate, until)
    if (slots === 0) continue
    const meanMs = holds.meanMs(candidate.vmId)
    if (slots == null || meanMs == null || meanMs <= 0) return null
    rate += slots / meanMs
  }
  if (!(rate > 0)) return null
  return Math.round((Math.max(0, Number(ahead) || 0) + 1) / rate)
}
