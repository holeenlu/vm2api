import { monitorEventLoopDelay, performance } from 'node:perf_hooks'

const STAGES = new Set(['json_parse', 'claude_convert', 'codex_convert', 'context_preflight'])
const SIZE_LIMITS = [16_384, 262_144, 1_048_576, 4_194_304]
const SIZE_LABELS = ['le_16_kib', 'le_256_kib', 'le_1_mib', 'le_4_mib', 'gt_4_mib']
const DURATION_LIMITS = [0.1, 0.5, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1000]

function sizeBucket(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown'
  const index = SIZE_LIMITS.findIndex((limit) => bytes <= limit)
  return SIZE_LABELS[index < 0 ? SIZE_LIMITS.length : index]
}

function record(rows, stage, traffic, bucket, duration, failed) {
  const key = `${stage}:${traffic}:${bucket}`
  let row = rows.get(key)
  if (!row) {
    row = {
      stage,
      traffic,
      size_bucket: bucket,
      count: 0,
      errors: 0,
      total_ms: 0,
      max_ms: 0,
      duration_counts: Array(DURATION_LIMITS.length + 1).fill(0),
    }
    rows.set(key, row)
  }
  row.count++
  row.errors += failed ? 1 : 0
  row.total_ms += duration
  row.max_ms = Math.max(row.max_ms, duration)
  const index = DURATION_LIMITS.findIndex((limit) => duration <= limit)
  row.duration_counts[index < 0 ? DURATION_LIMITS.length : index]++
}

function serialize(rows) {
  return [...rows.values()].map((row) => ({
    ...row,
    mean_ms: row.total_ms / row.count,
    duration_counts: [...row.duration_counts],
  }))
}

/** Fixed labels and histograms only; never retain request bodies, paths or identities. */
export class RuntimeMetrics {
  constructor({ windowMs = 10_000, resolutionMs = 20 } = {}) {
    this.windowMs = windowMs
    this.resolutionMs = resolutionMs
    this.sizes = new WeakMap()
    this.total = new Map()
    this.window = new Map()
    this.timer = null
    this.last = null
    this.startedAt = null
  }

  start() {
    if (this.timer) return
    this.total.clear()
    this.window.clear()
    this.last = null
    this.startedAt = new Date().toISOString()
    this.windowStartedAt = this.startedAt
    this.windowStarted = performance.now()
    this.previousElu = performance.eventLoopUtilization()
    this.delay = monitorEventLoopDelay({ resolution: this.resolutionMs })
    this.delay.enable()
    this.timer = setInterval(() => this.sample(), this.windowMs)
    this.timer.unref()
  }

  stop() {
    if (!this.timer) return
    this.sample()
    clearInterval(this.timer)
    this.timer = null
    this.delay.disable()
  }

  setBodyBytes(req, bytes) {
    if (req && typeof req === 'object') this.sizes.set(req, bytes)
  }

  // Only synchronous work belongs here. Uploads, decompression and upstream
  // waits must not be counted as main-thread computation.
  measure(req, stage, work) {
    if (!this.timer || !STAGES.has(stage)) return work()
    const started = performance.now()
    let failed = true
    try {
      const result = work()
      failed = false
      return result
    } finally {
      const duration = performance.now() - started
      const bucket = sizeBucket(this.sizes.get(req))
      const traffic = /^\/v1\/(responses|messages|chat\/completions|completions)(?:[/?]|$)/.test(req?.url || '')
        ? 'inference'
        : 'other'
      record(this.total, stage, traffic, bucket, duration, failed)
      record(this.window, stage, traffic, bucket, duration, failed)
    }
  }

  sample() {
    const current = performance.eventLoopUtilization()
    const delta = performance.eventLoopUtilization(current, this.previousElu)
    const ended = performance.now()
    const endedAt = new Date().toISOString()
    const count = this.delay.count
    this.last = {
      started_at: this.windowStartedAt,
      ended_at: endedAt,
      elapsed_ms: ended - this.windowStarted,
      event_loop: {
        utilization: delta.utilization,
        active_ms: delta.active,
        idle_ms: delta.idle,
        delay: {
          resolution_ms: this.resolutionMs,
          samples: count,
          mean_ms: count ? this.delay.mean / 1e6 : null,
          p50_ms: count ? this.delay.percentile(50) / 1e6 : null,
          p95_ms: count ? this.delay.percentile(95) / 1e6 : null,
          p99_ms: count ? this.delay.percentile(99) / 1e6 : null,
          max_ms: count ? this.delay.max / 1e6 : null,
        },
      },
      request_work: serialize(this.window),
    }
    this.previousElu = current
    this.windowStarted = ended
    this.windowStartedAt = endedAt
    this.window.clear()
    this.delay.reset()
  }

  snapshot() {
    return {
      enabled: this.timer != null,
      started_at: this.startedAt,
      sampled_at: new Date().toISOString(),
      window_ms: this.windowMs,
      size_basis: 'decoded_inbound_bytes',
      duration_bucket_upper_ms: [...DURATION_LIMITS, null],
      // Reads do not reset counters or sampling windows for other observers.
      last_window: this.last ? structuredClone(this.last) : null,
      request_work_total: serialize(this.total),
    }
  }
}

export const runtimeMetrics = new RuntimeMetrics()
