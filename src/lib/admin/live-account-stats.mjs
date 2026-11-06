/**
 * 账号实时指标：最近 5 分钟已完成请求的内存滚动窗口（不落盘、不查库）。
 *
 * 写入点是请求日志收尾（RequestLogStore.finish），与 usage_logs 同一份摘要；
 * 面板按账号键汇总：VM 为 vm_id，Gateway 账号为账号资源 id（日志里的 `gateway:<id>`）。
 * 只覆盖本进程处理的请求；进程重启后窗口从空开始。
 */

export const LIVE_WINDOW_MS = 5 * 60 * 1000
const RPM_WINDOW_MS = 60 * 1000
/** 上限保护：高峰每分钟数千请求，5 分钟窗口留足余量，超出时丢最旧的。 */
const MAX_ENTRIES = 200_000

const num = (value) => {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** 日志里的账号键 → 面板行 id。 */
export function liveAccountKey(vmId) {
  const key = String(vmId || '').trim()
  if (!key) return ''
  return key.startsWith('gateway:') ? key.slice('gateway:'.length) : key
}

function emptyBucket() {
  return {
    requests_1m: 0,
    tokens_1m: 0,
    io_tokens_1m: 0,
    requests: 0,
    success: 0,
    prompt_tokens: 0,
    cache_read_tokens: 0,
    ttft_sum: 0,
    ttft_n: 0,
    latency_sum: 0,
    latency_n: 0,
  }
}

function add(bucket, row, recent) {
  const io = row.input + row.output
  const tokens = io + row.cacheRead + row.cacheWrite
  if (recent) {
    bucket.requests_1m += 1
    bucket.tokens_1m += tokens
    bucket.io_tokens_1m += io
  }
  bucket.requests += 1
  if (row.ok) bucket.success += 1
  bucket.prompt_tokens += row.input + row.cacheRead + row.cacheWrite
  bucket.cache_read_tokens += row.cacheRead
  if (row.ttft != null) {
    bucket.ttft_sum += row.ttft
    bucket.ttft_n += 1
  }
  if (row.latency != null) {
    bucket.latency_sum += row.latency
    bucket.latency_n += 1
  }
}

export class LiveAccountStats {
  constructor({ now = Date.now, windowMs = LIVE_WINDOW_MS, maxEntries = MAX_ENTRIES } = {}) {
    this.now = now
    this.windowMs = windowMs
    this.maxEntries = maxEntries
    /** 环形队列：按完成时间递增追加，`head` 之前的已过期。 */
    this.rows = []
    this.head = 0
  }

  /** 记录一条已完成请求的日志摘要；没有账号键（未选到账号的拒绝等）的不计。 */
  record(summary = {}) {
    const key = liveAccountKey(summary.vm_id)
    if (!key) return
    const status = Number(summary.status)
    const ttft = Number(summary.first_token_ms)
    const latency = Number(summary.duration_ms)
    this.rows.push({
      at: this.now(),
      key,
      ok: status >= 200 && status < 400,
      input: num(summary.input_tokens),
      output: num(summary.output_tokens),
      cacheRead: num(summary.cache_read_tokens),
      cacheWrite: num(summary.cache_creation_tokens),
      ttft: Number.isFinite(ttft) && ttft >= 0 ? ttft : null,
      latency: Number.isFinite(latency) && latency >= 0 ? latency : null,
    })
    if (this.rows.length - this.head > this.maxEntries) this.head = this.rows.length - this.maxEntries
    this.compact()
  }

  prune(at = this.now()) {
    const cutoff = at - this.windowMs
    while (this.head < this.rows.length && this.rows[this.head].at < cutoff) this.head += 1
    this.compact()
  }

  compact() {
    if (this.head > 1024 && this.head * 2 > this.rows.length) {
      this.rows = this.rows.slice(this.head)
      this.head = 0
    }
  }

  /** 按账号汇总：最近 1 分钟的请求与 token，最近 5 分钟的成功率、缓存命中、首字与总延迟。 */
  snapshot() {
    const at = this.now()
    this.prune(at)
    const recentCutoff = at - RPM_WINDOW_MS
    const accounts = {}
    const total = emptyBucket()
    for (let i = this.head; i < this.rows.length; i += 1) {
      const row = this.rows[i]
      const recent = row.at >= recentCutoff
      accounts[row.key] ??= emptyBucket()
      add(accounts[row.key], row, recent)
      add(total, row, recent)
    }
    return {
      generated_at: new Date(at).toISOString(),
      window_ms: this.windowMs,
      rpm_window_ms: RPM_WINDOW_MS,
      total,
      accounts,
    }
  }
}

export const liveAccountStats = new LiveAccountStats()
