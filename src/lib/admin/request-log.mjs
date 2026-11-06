/**
 * Request logging — sub2api UsageLog + access-log inspired (SQLite-backed).
 *
 * Modes:
 *   off    — no writes
 *   normal — summary row (tokens, status, duration, key/vm ids; no bodies)
 *   debug  — normal + full redacted request record (headers/body/hop_meta)
 *
 * Storage: `request_logs` (summaries) + `request_log_debug` (full records).
 * Optional JSONL mirror for external log shippers: KIN_REQUEST_LOG_JSONL=1
 * (writes the previous data/request-logs/YYYY-MM-DD.jsonl format alongside).
 *
 * Env: KIN_REQUEST_LOG_MODE=off|normal|debug (default normal)
 * Per-request override: X-Kin-Debug: 1 or X-Kin-Log: debug|normal|off
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { redactSecretText, redactSecrets } from '../core/security.mjs'
import { resolveStoreDb } from '../db/database.mjs'
import { enqueueWrite, recordBillingWriteFailure, writeBehindArmed, WRITE_KIND } from '../db/write-behind.mjs'
import { UsageLogsRepo } from '../db/repos/usage-logs-repo.mjs'
import { findSupplierRuntimeVm } from '../vendor/repos/resources-repo.mjs'
import { UsageStatsWorker } from './usage-stats-worker.mjs'
import { liveAccountStats } from './live-account-stats.mjs'
import { classifyRequestError, resolveMutedErrorClasses } from './error-class.mjs'
import { costColumnsFromUsage, normalizeUsage } from './pricing.mjs'
import { disjointOpenaiUsage } from '../protocol/openai-usage.mjs'
import {
  REASONING_EFFORTS,
  sessionIdForLog,
  responseModelForLog,
  transportForLog,
  upstreamPathForLog,
} from '../protocol/log-fields.mjs'

/** Persist the token a client actually sent — only for failed ingress auth. */
export function presentedApiKeyForLog(token) {
  const t = String(token || '').trim()
  if (!t || t.startsWith('kin-panel-')) return ''
  return t.slice(0, 240)
}

const MODES = new Set(['off', 'normal', 'debug'])

const DEFAULT_RETAIN_DAYS = 7
const DEFAULT_DEBUG_RETAIN_DAYS = 3
const DEFAULT_MAX_MB = 2048
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000

function clampInt(value, min, max, fallback) {
  if (value == null || value === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

/** Keep summary retain_days, a shorter debug window, and a hard size cap. */
export function normalizeLoggingConfig(raw = {}) {
  const modeRaw = String(raw.mode || 'normal')
    .trim()
    .toLowerCase()
  const mode = MODES.has(modeRaw) ? modeRaw : 'normal'
  const retainDays = clampInt(raw.retain_days ?? raw.retainDays, 1, 90, DEFAULT_RETAIN_DAYS)
  let debugRetainDays = clampInt(
    raw.debug_retain_days ?? raw.debugRetainDays,
    1,
    90,
    Math.min(DEFAULT_DEBUG_RETAIN_DAYS, retainDays),
  )
  if (debugRetainDays > retainDays) debugRetainDays = retainDays
  return {
    ...raw,
    mode,
    retain_days: retainDays,
    debug_retain_days: debugRetainDays,
    max_mb: clampInt(raw.max_mb ?? raw.maxMb, 0, 102400, DEFAULT_MAX_MB),
  }
}

function dayKey(d = new Date()) {
  return d.toISOString().slice(0, 10)
}

function safeIp(req) {
  const xf = String(req.headers?.['x-forwarded-for'] || '')
    .split(',')[0]
    .trim()
  const raw = xf || req.socket?.remoteAddress || ''
  return String(raw).slice(0, 45)
}

function summarizeBody(body) {
  if (!body || typeof body !== 'object') return { empty: true }
  const messages = Array.isArray(body.messages) ? body.messages : null
  const roles = messages ? messages.map((m) => m?.role).filter(Boolean) : []
  let systemLen = 0
  if (typeof body.system === 'string') systemLen = body.system.length
  else if (Array.isArray(body.system)) {
    systemLen = body.system.reduce((n, b) => n + (typeof b === 'string' ? b.length : (b?.text || '').length), 0)
  }
  return {
    model: body.model || null,
    stream: !!body.stream,
    max_tokens: body.max_tokens ?? body.max_output_tokens ?? null,
    messages_count: messages ? messages.length : body.input != null ? 1 : 0,
    roles,
    tools_count: Array.isArray(body.tools) ? body.tools.length : 0,
    has_thinking: body.thinking != null,
    system_len: systemLen,
    top_level_keys: Object.keys(body).sort(),
  }
}

/**
 * Cache-creation TTL breakdown.
 * Prefer usage.cache_creation.ephemeral_5m/1h; cache_creation_input_tokens beyond
 * that split (absent, or stale after message_delta) bills 1h only on an explicit cache_ttl === '1h',
 * else 5m. DEFAULT_CACHE_TTL is not a billing fallback.
 */
function cacheCreationBreakdown(usage) {
  if (!usage || typeof usage !== 'object') {
    return { cache_creation_5m_tokens: null, cache_creation_1h_tokens: null }
  }
  const nested = usage.cache_creation
  let five = Number(nested?.ephemeral_5m_input_tokens) || 0
  let hour = Number(nested?.ephemeral_1h_input_tokens) || 0
  const total = Number(usage.cache_creation_input_tokens ?? usage.cache_creation_tokens) || 0
  const unsplit = total - five - hour
  if (unsplit > 0) {
    if (usage.cache_ttl === '1h') hour += unsplit
    else five += unsplit
  }
  if (five === 0 && hour === 0) {
    return { cache_creation_5m_tokens: null, cache_creation_1h_tokens: null }
  }
  return { cache_creation_5m_tokens: five, cache_creation_1h_tokens: hour }
}

const BILLED_TOKEN_COLUMNS = Object.freeze([
  'input_tokens',
  'cache_read_tokens',
  'cache_creation_tokens',
  'cache_creation_5m_tokens',
  'cache_creation_1h_tokens',
])

/**
 * 客户计费口径（protocol/customer-usage.mjs 的结果）写进主 token 列，全平台展示同一口径；
 * 与上游原始值不同时，原始值保留到 upstream_*（账号成本、额度预测、供应商结算读它）。
 * output_tokens 两种口径相同，不需要单独保留。
 */
export function applyBilledTokens(summary, customerUsage) {
  if (!summary || !customerUsage || typeof customerUsage !== 'object') return summary
  const usage = normalizeUsage(disjointOpenaiUsage(customerUsage) || {})
  const billed = {
    input_tokens: usage.input_tokens ?? null,
    cache_read_tokens: usage.cache_read_tokens ?? usage.cache_read_input_tokens ?? null,
    cache_creation_tokens: usage.cache_creation_tokens ?? usage.cache_creation_input_tokens ?? null,
    ...cacheCreationBreakdown(usage),
  }
  if (BILLED_TOKEN_COLUMNS.every((c) => (Number(summary[c]) || 0) === (Number(billed[c]) || 0))) return summary
  for (const c of BILLED_TOKEN_COLUMNS) {
    summary[`upstream_${c}`] = summary[c] ?? null
    summary[c] = billed[c]
  }
  return summary
}

function imageTokenCount(v) {
  return Number.isSafeInteger(v) && v > 0 ? v : 0
}

function webSearchRequestsOf(usage) {
  const n = Number(usage?.server_tool_use?.web_search_requests ?? usage?.web_search_requests)
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0
}

const PRICED_COLUMN_KEYS = [
  'input_cost',
  'output_cost',
  'cache_read_cost',
  'cache_creation_cost',
  'web_search_cost',
  'image_cost',
  'total_cost',
  'pricing_model',
  'price_source',
  'price_version',
  'service_tier',
  'speed',
  'long_context',
]

/** Image generation usage on this row; an Images endpoint row (`openai.images`) bills it alone. */
function imageForLog(extra) {
  const only = extra.protocol === 'openai.images'
  if (!extra.image_usage && !only) return null
  return { usage: extra.image_usage || null, model: extra.image_model || null, only }
}

function costColumnsForLog(usage, model, extra = {}) {
  if (extra.pricing_model != null) {
    const out = {}
    for (const key of PRICED_COLUMN_KEYS) out[key] = extra[key] ?? null
    return out
  }
  const priced = costColumnsFromUsage(usage, model, imageForLog(extra))
  return {
    input_cost: priced.input_cost ?? null,
    output_cost: priced.output_cost ?? null,
    cache_read_cost: priced.cache_read_cost ?? null,
    cache_creation_cost: priced.cache_creation_cost ?? null,
    web_search_cost: priced.web_search_cost ?? null,
    image_cost: priced.image_cost ?? null,
    total_cost: priced.total_cost ?? null,
    pricing_model: priced.pricing_model ?? null,
    price_source: priced.price_source ?? null,
    price_version: priced.price_version ?? null,
    service_tier: priced.service_tier ?? null,
    speed: priced.speed ?? null,
    long_context: priced.long_context ?? null,
  }
}

/** Tri-state model mismatch: null = upstream did not declare a model. */
function modelMismatch(requested, upstream) {
  if (!requested || !upstream) return null
  const norm = (m) =>
    String(m)
      .split('/')
      .filter(Boolean)
      .pop()
      .replace(/\[1m\]$/i, '')
      .toLowerCase()
  return norm(requested) === norm(upstream) ? 0 : 1
}

function redactHeaders(headers = {}) {
  const out = {}
  for (const [k, v] of Object.entries(headers)) {
    const key = String(k).toLowerCase()
    if (key === 'authorization' || key === 'x-api-key' || key === 'cookie' || key === 'set-cookie') {
      out[key] = '***REDACTED***'
    } else if (key === 'x-panel-token') {
      out[key] = '***REDACTED***'
    } else {
      out[key] = typeof v === 'string' ? v.slice(0, 512) : v
    }
  }
  return out
}

const SENSITIVE_KEY = /authorization|token|password|secret|cookie|api[_-]?key/i
const SNAP_MAX_STRING = 80
const SNAP_MAX_ARRAY = 24
const SNAP_MAX_DEPTH = 6
const SNAP_MAX_TOTAL = 12000
const IMAGE_DATA_KEYS = new Set(['data', 'base64', 'b64_json'])

function imagePayloadSummary(value) {
  if (typeof value === 'string') return `…[${value.length} bytes]`
  return '[omitted-image]'
}

function redactImagePayloads(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object') return value
  if (seen.has(value)) return '[Circular]'
  seen.add(value)
  if (Array.isArray(value)) return value.map((item) => redactImagePayloads(item, seen))
  const type = value.type
  const isImage = type === 'image' || type === 'input_image' || type === 'image_url' || value.source || value.image_url
  const out = {}
  for (const [key, nested] of Object.entries(value)) {
    if (IMAGE_DATA_KEYS.has(key) && typeof nested === 'string' && nested.length > 32) {
      out[key] = imagePayloadSummary(nested)
      continue
    }
    if (isImage && key === 'source' && nested && typeof nested === 'object') {
      out[key] = {
        type: nested.type || 'base64',
        media_type: nested.media_type || null,
        url: Boolean(nested.url),
        bytes: typeof nested.data === 'string' ? nested.data.length : 0,
      }
      continue
    }
    if (isImage && key === 'image_url' && nested && typeof nested === 'object') {
      out[key] = { url: Boolean(nested.url), detail: nested.detail || null }
      continue
    }
    out[key] = redactImagePayloads(nested, seen)
  }
  return out
}

export function sanitizeRequestBodySnapshot(value, opts = {}, seen = new WeakSet(), depth = 0) {
  const maxString = opts.maxStringChars ?? SNAP_MAX_STRING
  const maxArray = opts.maxArrayItems ?? SNAP_MAX_ARRAY
  const maxDepth = opts.maxDepth ?? SNAP_MAX_DEPTH
  if (value == null) return value
  if (typeof value === 'string') {
    return value.length > maxString ? value.slice(0, maxString) + `…[${value.length}]` : value
  }
  if (typeof value !== 'object') return value
  if (seen.has(value)) return '[Circular]'
  if (depth >= maxDepth) return '[MaxDepth]'
  seen.add(value)
  if (Array.isArray(value)) {
    const items = value.slice(0, maxArray).map((v) => sanitizeRequestBodySnapshot(v, opts, seen, depth + 1))
    if (value.length > maxArray) items.push(`…[${value.length - maxArray} more]`)
    return items
  }
  const out = {}
  const isImage =
    value.type === 'image' ||
    value.type === 'input_image' ||
    value.type === 'image_url' ||
    value.source ||
    value.image_url
  for (const [k, v] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(k)) {
      out[k] = '[REDACTED]'
      continue
    }
    if (k === 'encrypted_content') {
      out[k] = `…[${String(v || '').length} chars]`
      continue
    }
    if (k === 'tools' && Array.isArray(v)) {
      out[k] = v
        .slice(0, maxArray)
        .map((t) => ({ type: t?.type || 'function', name: t?.name || t?.function?.name || null }))
      continue
    }
    if (IMAGE_DATA_KEYS.has(k) && typeof v === 'string' && v.length > 32) {
      out[k] = imagePayloadSummary(v)
      continue
    }
    if (isImage && k === 'source' && v && typeof v === 'object') {
      out[k] = {
        type: v.type || 'base64',
        media_type: v.media_type || null,
        url: Boolean(v.url),
        bytes: typeof v.data === 'string' ? v.data.length : 0,
      }
      continue
    }
    out[k] = sanitizeRequestBodySnapshot(v, opts, seen, depth + 1)
  }
  let raw = ''
  try {
    raw = JSON.stringify(out)
  } catch {
    return out
  }
  if (raw.length > (opts.maxTotalChars ?? SNAP_MAX_TOTAL)) {
    return { _truncated: true, _chars: raw.length, preview: raw.slice(0, opts.maxTotalChars ?? SNAP_MAX_TOTAL) }
  }
  return out
}

function clampBody(obj, maxChars = 200_000) {
  let raw
  try {
    raw = redactSecrets(redactImagePayloads(obj))
  } catch {
    raw = '{"error":"redact_failed"}'
  }
  if (raw.length <= maxChars) {
    try {
      return JSON.parse(raw)
    } catch {
      return { _raw: raw.slice(0, maxChars) }
    }
  }
  return { _truncated: true, _chars: raw.length, preview: raw.slice(0, maxChars) }
}

/**
 * Client-facing response as stored in a debug record. The body stays raw text
 * (SSE frames or JSON) so the panel can show exactly what went out; only
 * credential-shaped substrings are masked.
 */
function debugResponse(captured) {
  let body = captured.body || ''
  try {
    body = JSON.parse(redactSecrets(body))
  } catch {}
  return {
    status: captured.status ?? null,
    headers: captured.headers || null,
    body,
    bytes: captured.bytes || 0,
    truncated: !!captured.truncated,
  }
}

export function resolveLogMode(envMode, req) {
  const hdr = String(req?.headers?.['x-kin-log'] || '')
    .trim()
    .toLowerCase()
  if (MODES.has(hdr)) return hdr
  if (String(req?.headers?.['x-kin-debug'] || '') === '1') return 'debug'
  const base = String(envMode || 'normal')
    .trim()
    .toLowerCase()
  return MODES.has(base) ? base : 'normal'
}

export function newRequestId(req) {
  // Server-owned identity prevents caller collisions across accounting and diagnostics.
  return crypto.randomUUID()
}

const UPSTREAM_ERROR_FIELDS = ['code', 'type', 'message', 'param', 'close_reason', 'last_event_type']

/** 上游错误对象的受控投影：只保留声明的字符串字段（各 1KiB），都缺失时为 null。 */
function diagnosticJson(value) {
  if (!value || typeof value !== 'object') return null
  const out = {}
  for (const key of UPSTREAM_ERROR_FIELDS)
    if (typeof value[key] === 'string' && value[key].trim()) out[key] = value[key].trim().slice(0, 1024)
  return Object.keys(out).length ? JSON.stringify(out) : null
}

/** 使用记录落库失败时追加的待补写文件（位于 request-logs 目录），由 `scripts/replay-failed-usage-logs.mjs` 补写。 */
export const FAILED_USAGE_LOGS_FILE = 'failed-usage-logs.jsonl'

export class RequestLogStore {
  constructor({
    dataDir,
    db,
    mode = process.env.KIN_REQUEST_LOG_MODE || 'normal',
    maxDebugBodyChars = Number(process.env.KIN_REQUEST_LOG_DEBUG_CHARS || 200000),
    retainDays = Number(process.env.KIN_REQUEST_LOG_RETAIN_DAYS || DEFAULT_RETAIN_DAYS),
    debugRetainDays = Number(process.env.KIN_REQUEST_LOG_DEBUG_RETAIN_DAYS || DEFAULT_DEBUG_RETAIN_DAYS),
    maxMb = Number(process.env.KIN_REQUEST_LOG_MAX_MB || DEFAULT_MAX_MB),
    jsonlMirror = process.env.KIN_REQUEST_LOG_JSONL === '1',
  } = {}) {
    this.dataDir = dataDir || path.join(process.cwd(), 'data')
    this.db = resolveStoreDb({ db, dataDir: this.dataDir })
    this.repo = new UsageLogsRepo(this.db)
    this._statistics = null
    this._statisticsPaused = false
    this.root = path.join(this.dataDir, 'request-logs')
    this.mode = MODES.has(String(mode).toLowerCase()) ? String(mode).toLowerCase() : 'normal'
    this.maxDebugBodyChars = Number.isFinite(maxDebugBodyChars) ? maxDebugBodyChars : 200000
    this.retainDays = Number.isFinite(retainDays) && retainDays > 0 ? retainDays : DEFAULT_RETAIN_DAYS
    this.debugRetainDays =
      Number.isFinite(debugRetainDays) && debugRetainDays > 0 ? debugRetainDays : DEFAULT_DEBUG_RETAIN_DAYS
    if (this.debugRetainDays > this.retainDays) this.debugRetainDays = this.retainDays
    this.maxMb = Number.isFinite(maxMb) && maxMb >= 0 ? maxMb : DEFAULT_MAX_MB
    this.jsonlMirror = !!jsonlMirror
    this.mutedErrorClasses = resolveMutedErrorClasses(null)
    this._mem = [] // recent normal summaries for panel hot path
    this._memMax = 200
    this._cleanupTimer = null
  }

  setConfig({ mode, retainDays, debugRetainDays, maxMb, mutedErrorClasses } = {}) {
    if (mode != null) {
      const m = String(mode).trim().toLowerCase()
      if (MODES.has(m)) this.mode = m
    }
    if (retainDays != null) {
      const n = Number(retainDays)
      if (Number.isFinite(n) && n > 0) this.retainDays = n
    }
    if (debugRetainDays != null) {
      const n = Number(debugRetainDays)
      if (Number.isFinite(n) && n > 0) this.debugRetainDays = n
    }
    if (maxMb != null) {
      const n = Number(maxMb)
      if (Number.isFinite(n) && n >= 0) this.maxMb = n
    }
    if (this.debugRetainDays > this.retainDays) this.debugRetainDays = this.retainDays
    if (mutedErrorClasses !== undefined) {
      this.mutedErrorClasses = resolveMutedErrorClasses(mutedErrorClasses)
    }
    return this.snapshot()
  }

  /** Kept for API compat + post-restore hook (state lives in DB). */
  reload() {
    this._mem = []
  }

  /** Re-bind to a fresh DB connection (after backup restore). */
  rebind(db) {
    void this._statistics?.close()
    this._statistics = null
    this.db = db
    this.repo = new UsageLogsRepo(db)
    this._mem = []
  }

  start(req, { protocol = null, pathName = null } = {}) {
    const requestId = newRequestId(req)
    try {
      req.headers = req.headers || {}
    } catch {}
    const mode = resolveLogMode(this.mode, req)
    return {
      request_id: requestId,
      mode,
      t0: Date.now(),
      protocol,
      path: pathName || req.url || '',
      method: req.method || 'POST',
      ip: safeIp(req),
      user_agent: String(req.headers?.['user-agent'] || '').slice(0, 512),
      // Responses WebSocket 把每个 response.create 改写成 POST 交给协议层，这里保留原入站方式
      inbound_transport: req.inboundTransport === 'websocket' ? 'websocket' : 'http',
      headers: mode === 'debug' ? redactHeaders(req.headers) : null,
      // Outbound bodies carry the gateway's rewrite (persona / overlay) and are
      // readable by the owning tenant; only the operator's configured mode may
      // enable them, never the caller's x-kin-debug / x-kin-log header.
      capture_outbound: this.mode === 'debug',
    }
  }

  /**
   * Debug mode only: mirror what the client actually received (status,
   * headers, body bytes up to maxDebugBodyChars) onto `ctx.response` so
   * finish() can store it next to the inbound/outbound bodies. Normal mode
   * never wraps the response.
   */
  tapResponse(ctx, res) {
    if (!ctx || ctx.mode !== 'debug' || !res || ctx.response) return
    const limit = Math.max(0, this.maxDebugBodyChars)
    const captured = { status: null, headers: null, body: '', bytes: 0, truncated: false }
    ctx.response = captured
    const decoder = new TextDecoder()
    const take = (chunk, encoding) => {
      if (chunk == null || typeof chunk === 'function') return
      const buf =
        typeof chunk === 'string' ? Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8') : chunk
      if (!(buf instanceof Uint8Array)) return
      captured.bytes += buf.byteLength
      if (captured.truncated) return
      const room = limit - captured.body.length
      const text = decoder.decode(buf, { stream: true })
      if (text.length <= room) {
        captured.body += text
        return
      }
      captured.body += text.slice(0, Math.max(0, room))
      captured.truncated = true
    }
    const write = res.write
    const end = res.end
    res.write = function tappedWrite(chunk, encoding, cb) {
      take(chunk, encoding)
      return write.call(this, chunk, encoding, cb)
    }
    res.end = function tappedEnd(chunk, encoding, cb) {
      take(chunk, encoding)
      return end.call(this, chunk, encoding, cb)
    }
    res.once('finish', () => {
      captured.status = res.statusCode || null
      try {
        captured.headers = redactHeaders(res.getHeaders?.() || {})
      } catch {}
    })
  }

  /**
   * Write normal summary always (unless off).
   * Write debug full record when mode===debug.
   *
   * async（R6 B7a）：只有关闭日志且带 vm_id 时才 await 一次供应商 VM 判定，其余路径在调用时同步执行完。
   * 落库 persist 仍是同步闭包（写回队列 write-behind 批事务同步执行，见 docs/data-access/R6_PROGRESS.md B2 / B8）。
   */
  async finish(ctx, extra = {}) {
    if (!ctx) return null
    if (ctx.mode === 'off') {
      const supplier = extra.vm_id && (await findSupplierRuntimeVm(this.db, extra.vm_id))
      if (!supplier) {
        // 关闭日志时仍计入账号实时指标（只在内存）
        const usage = normalizeUsage(disjointOpenaiUsage(extra.usage || {}) || {})
        liveAccountStats.record({
          vm_id: extra.vm_id,
          status: extra.status,
          duration_ms: Math.max(0, Date.now() - (ctx.t0 || Date.now())),
          first_token_ms: extra.first_token_ms,
          input_tokens: extra.input_tokens ?? usage.input_tokens,
          output_tokens: extra.output_tokens ?? usage.output_tokens,
          cache_read_tokens: extra.cache_read_tokens ?? usage.cache_read_tokens ?? usage.cache_read_input_tokens,
          cache_creation_tokens:
            extra.cache_creation_tokens ?? usage.cache_creation_tokens ?? usage.cache_creation_input_tokens,
        })
        return null
      }
      ctx = { ...ctx, mode: 'normal', capture_outbound: false, headers: null }
    }
    const duration_ms = Math.max(0, Date.now() - (ctx.t0 || Date.now()))
    const usage = normalizeUsage(disjointOpenaiUsage(extra.usage || {}) || {})
    const breakdown = cacheCreationBreakdown(usage)
    const webSearch = extra.web_search_requests ?? webSearchRequestsOf(usage)
    const billedUsage = {
      ...usage,
      input_tokens: extra.input_tokens ?? usage.input_tokens,
      output_tokens: extra.output_tokens ?? usage.output_tokens,
      cache_read_tokens: extra.cache_read_tokens ?? usage.cache_read_input_tokens ?? usage.cache_read_tokens,
      cache_creation_tokens:
        extra.cache_creation_tokens ?? usage.cache_creation_input_tokens ?? usage.cache_creation_tokens,
      cache_creation_5m_tokens:
        extra.cache_creation_5m_tokens ?? usage.cache_creation_5m_tokens ?? breakdown.cache_creation_5m_tokens,
      cache_creation_1h_tokens:
        extra.cache_creation_1h_tokens ?? usage.cache_creation_1h_tokens ?? breakdown.cache_creation_1h_tokens,
      cache_creation: usage.cache_creation,
      web_search_requests: webSearch,
      cache_ttl: usage.cache_ttl,
      service_tier: extra.service_tier ?? usage.service_tier,
      speed: extra.speed ?? usage.speed,
      requested_speed: extra.requested_speed ?? usage.requested_speed,
    }
    const summary = {
      id: 'log_' + crypto.randomBytes(6).toString('hex'),
      request_id: ctx.request_id,
      config_revision:
        Number.isSafeInteger(Number(extra.config_revision)) && Number(extra.config_revision) > 0
          ? Number(extra.config_revision)
          : null,
      ts: new Date().toISOString(),
      log_mode: ctx.mode,
      method: ctx.method,
      path: extra.path || ctx.path,
      protocol: extra.protocol || ctx.protocol || null,
      model: extra.model || null,
      stream: !!extra.stream,
      status: extra.status ?? null,
      duration_ms,
      api_key_kind: extra.api_key_kind || null,
      api_key_id: extra.api_key_id || null,
      vm_id: extra.vm_id || null,
      account_id: extra.account_id || null,
      workspace: extra.workspace || null,
      input_tokens: extra.input_tokens ?? usage.input_tokens ?? null,
      output_tokens: extra.output_tokens ?? usage.output_tokens ?? null,
      error_code: extra.error_code || null,
      error_message: extra.error_message ? redactSecretText(extra.error_message).slice(0, 300) : null,
      user_agent: ctx.user_agent,
      ip: ctx.ip,
      api_key_presented: extra.api_key_presented ? presentedApiKeyForLog(extra.api_key_presented) : null,
      has_tools: extra.has_tools ?? null,
      via: extra.via || extra.hop_meta?.via || null,
      cache_read_tokens: extra.cache_read_tokens ?? usage.cache_read_tokens ?? usage.cache_read_input_tokens ?? null,
      cache_creation_tokens:
        extra.cache_creation_tokens ?? usage.cache_creation_tokens ?? usage.cache_creation_input_tokens ?? null,
      ...breakdown,
      web_search_requests: webSearch,
      requested_model: extra.requested_model || extra.model || null,
      upstream_model: extra.upstream_model || null,
      response_model: responseModelForLog(extra),
      model_mismatch: modelMismatch(extra.requested_model || extra.model, responseModelForLog(extra)),
      first_token_ms: extra.first_token_ms ?? null,
      first_byte_ms: extra.first_byte_ms ?? null,
      generation_ms: extra.generation_ms ?? null,
      stop_reason: extra.stop_reason || usage.stop_reason || null,
      attempt_count: extra.attempt_count ?? null,
      final_state: extra.final_state || null,
      final_account_id: extra.final_account_id || extra.account_id || null,
      session_id: sessionIdForLog(extra.session_id),
      outbound_session_id: sessionIdForLog(extra.outbound_session_id),
      reasoning_effort: REASONING_EFFORTS.has(extra.reasoning_effort) ? extra.reasoning_effort : null,
      inbound_device_id: sessionIdForLog(extra.inbound_device_id),
      // Gate verdict JSON from intercept-gate; the risk audit groups on it.
      intercept: extra.intercept ? String(extra.intercept).slice(0, 400) : null,
      // Exact classifyJev payload.state. Context, not a span the model named.
      jev_state: extra.jev_state ? String(extra.jev_state).slice(0, 64000) : null,
      image_model: extra.image_model || null,
      image_usage: extra.image_usage ? JSON.stringify(extra.image_usage) : null,
      image_input_tokens: imageTokenCount(extra.image_usage?.input_tokens),
      image_output_tokens: imageTokenCount(extra.image_usage?.output_tokens),
      execution_kind: extra.execution_kind || null,
      account_resource_id: extra.account_resource_id || null,
      gateway_instance_id: extra.gateway_instance_id || null,
      dispatch_id: extra.dispatch_id || null,
      receipt_id: extra.receipt_id || null,
      usage_confidence: extra.usage_confidence || null,
      // sub2api ownership + billing columns
      user_id: extra.user_id ?? null,
      billing_status: extra.billing_status || 'unmetered',
      billing_group_id: extra.billing_group_id ?? extra.group_id ?? null,
      subscription_id: extra.subscription_id || null,
      api_key_name: extra.api_key_name || null,
      source: extra.api_key_kind === 'master' ? 'platform' : 'protocol',
      vm_owner_user_id: null,
      group_id: extra.group_id ?? 1,
      rate_multiplier: Number.isFinite(Number(extra.rate_multiplier)) ? Number(extra.rate_multiplier) : 1,
      ...costColumnsForLog(billedUsage, extra.upstream_model || extra.model || extra.requested_model, extra),
      upstream_service_tier: extra.upstream_service_tier || null,
      // Gateway 请求诊断（092）：只存上游声明与网关已知事实，超长文本截断
      error_kind: extra.error_kind ? String(extra.error_kind).slice(0, 64) : null,
      // Gateway 请求的授权方式（094）：native / bps，其余路径为空
      authorization_mode: ['native', 'bps'].includes(extra.authorization_mode) ? extra.authorization_mode : null,
      // 端点与传输方式（099）：上游路径由执行路径在发出请求时写入，未发往上游为空
      inbound_transport: transportForLog(ctx.inbound_transport),
      upstream_path: upstreamPathForLog(extra.upstream_path),
      upstream_transport: transportForLog(extra.upstream_transport),
      upstream_error_json: diagnosticJson(extra.upstream_error),
      websocket_close_code: Number.isInteger(extra.websocket_close_code) ? extra.websocket_close_code : null,
      continuation_unavailable_reason: extra.continuation_unavailable_reason
        ? String(extra.continuation_unavailable_reason).slice(0, 64)
        : null,
      upstream_connection_exit_reason: extra.upstream_connection_exit_reason
        ? String(extra.upstream_connection_exit_reason).slice(0, 64)
        : null,
      retry_after_ms:
        Number.isFinite(extra.retry_after_ms) && extra.retry_after_ms >= 0 ? Math.round(extra.retry_after_ms) : null,
    }
    // sub2api actual_cost: official cost × group rate multiplier (0 is a valid rate)
    if (summary.total_cost != null) {
      summary.actual_cost = Object.hasOwn(extra, 'actual_cost')
        ? extra.actual_cost
        : summary.total_cost * summary.rate_multiplier
    }
    const classified = classifyRequestError(summary)
    if (classified?.error_class) summary.error_class = classified.error_class
    // 账号实时指标按上游原始消耗统计，在改写主列之前记录
    liveAccountStats.record(summary)
    applyBilledTokens(summary, extra.customer_usage)

    // 落库闭包（R6 B8 改 async）：写回队列启用时在写回批事务里按顺序 await，否则 finish 直接 await；只有数据库操作与同步文件追加，
    // 不等待真实 I/O（批事务不能跨事件循环）
    const persist = async () => {
      summary.vm_owner_user_id = await this.repo.vmOwnerOf(extra.vm_id)
      try {
        await this.repo.insertSummaryIfAbsent(summary)
      } catch (error) {
        // 使用记录没写进去（结算可能已提交）：不再静默吞掉（M5 复审 P1-3）。计数、告警，并把这一行追加到
        // 失败记录文件，供 `scripts/replay-failed-usage-logs.mjs` 补写；不向上抛，以免连带回滚已完成的结算
        this._recordPersistFailure(summary, error)
      }
      if (this.jsonlMirror) this._appendJsonl(summary)
      if (ctx.mode !== 'debug') return
      const debugRec = {
        ...summary,
        headers: ctx.headers,
        inbound_summary: extra.inbound_summary || summarizeBody(extra.inbound_body),
        request_body_snapshot:
          !extra.classifier && extra.inbound_body != null ? sanitizeRequestBodySnapshot(extra.inbound_body) : null,
        inbound_body:
          !extra.classifier && extra.inbound_body != null
            ? clampBody(extra.inbound_body, this.maxDebugBodyChars)
            : null,
        hop_meta: extra.hop_meta || null,
        via: extra.via || extra.hop_meta?.via || null,
        upstream_status: extra.upstream_status ?? null,
        outbound_summary: extra.outbound_summary || null,
        cache_prefix: extra.cache_prefix || null,
        cache_continuity: extra.cache_continuity || null,
        classifier: extra.classifier || null,
        outbound_headers:
          ctx.capture_outbound && extra.outbound_headers != null ? redactHeaders(extra.outbound_headers) : null,
        outbound_headers_source: ctx.capture_outbound ? extra.outbound_headers_source || null : null,
        worker_envelope_headers:
          ctx.capture_outbound && extra.worker_envelope_headers != null
            ? redactHeaders(extra.worker_envelope_headers)
            : null,
        outbound_body:
          ctx.capture_outbound && !extra.classifier && extra.outbound_body != null
            ? clampBody(extra.outbound_body, this.maxDebugBodyChars)
            : null,
        response: ctx.response ? debugResponse(ctx.response) : null,
      }
      try {
        await this.repo.insertDebug(summary.request_id || summary.id, summary.ts, debugRec)
      } catch {}
    }
    this._mem.push(summary)
    if (this._mem.length > this._memMax) this._mem = this._mem.slice(-this._memMax)
    // 写回队列未启用时（测试、工具进程）直接写完再返回，与原同步版本一样 finish 返回时行已落库。
    // 使用记录是计费相关写入：队列已满时不丢弃，改为直接写库（技术债 M5，write-behind.mjs 有界队列）
    if (!writeBehindArmed() || !enqueueWrite(persist, { kind: WRITE_KIND.BILLING })) await persist()
    return summary
  }

  /** Optional legacy JSONL mirror for external log collectors. */
  _recordPersistFailure(summary, error) {
    recordBillingWriteFailure()
    const now = Date.now()
    if (now - (this._persistFailWarnAt || 0) >= 60_000) {
      this._persistFailWarnAt = now
      console.error(
        `[request-log] usage log write failed for ${summary.request_id || summary.id}: ${error?.message || error}; queued for replay in failed-usage-logs.jsonl`,
      )
    }
    try {
      fs.mkdirSync(this.root, { recursive: true })
      fs.appendFileSync(
        path.join(this.root, FAILED_USAGE_LOGS_FILE),
        `${JSON.stringify({ at: new Date(now).toISOString(), error: String(error?.message || error).slice(0, 300), summary })}\n`,
        { mode: 0o600 },
      )
    } catch {}
  }

  _appendJsonl(summary) {
    try {
      fs.mkdirSync(this.root, { recursive: true })
      const file = path.join(this.root, `${dayKey()}.jsonl`)
      fs.appendFileSync(file, JSON.stringify(summary) + '\n', { mode: 0o600 })
    } catch {}
  }

  _mutedExclude(opts = {}) {
    if (opts.error_class || opts.include_muted) return null
    if (opts.exclude_error_class != null && String(opts.exclude_error_class).trim() !== '') {
      return opts.exclude_error_class
    }
    return this.mutedErrorClasses.length ? this.mutedErrorClasses.join(',') : null
  }

  _dropMuted(items, exclude) {
    if (!exclude) return items
    const blocked = new Set(
      String(exclude)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    )
    if (!blocked.size) return items
    return (items || []).filter((row) => !row.error_class || !blocked.has(row.error_class))
  }

  async listNormal({ limit = 50, ...filters } = {}) {
    return (await this.queryNormal({ limit, ...filters })).items
  }

  /**
   * Filtered keyset page (panel `/request-logs` normal mode): `{ items, next_cursor, has_more }`, no total.
   * Default hides muted classes; the repo drops them while scanning so pages stay full.
   */
  async queryNormal(opts = {}) {
    return this.repo.query({ ...opts, exclude_error_class: this._mutedExclude(opts) })
  }

  /** Aggregated stats for charts. */
  async aggregate(opts = {}) {
    return this.repo.aggregate(opts)
  }

  async totals() {
    return this.repo.totals()
  }

  async hasSuccessfulRequest(opts = {}) {
    return this.repo.hasSuccessfulRequest(opts)
  }

  async billingStats(opts = {}) {
    if (this._statisticsPaused) throw new Error('billing statistics are paused')
    this._statistics ??= new UsageStatsWorker(this.db)
    return this._statistics.billingStats(opts)
  }

  async pauseStatistics() {
    this._statisticsPaused = true
    const statistics = this._statistics
    this._statistics = null
    await statistics?.close()
  }

  resumeStatistics() {
    this._statisticsPaused = false
  }

  async ownerBilling(opts = {}) {
    return this.repo.ownerBilling(opts)
  }

  async costByModel(opts = {}) {
    return this.repo.costByModel(opts)
  }

  async vmUsageStats(opts = {}) {
    return this.repo.vmUsageStats(opts)
  }

  async costBetween(opts = {}) {
    return this.repo.costBetween(opts)
  }

  async keyUsageStats(opts = {}) {
    return this.repo.keyUsageStats(opts)
  }

  /** Windowed SLA / QPS / TTFT snapshot for overview + log analysis. */
  async windowStats(opts = {}) {
    return this.repo.windowStats(opts)
  }

  async protocolEntryStats(opts = {}) {
    return this.repo.protocolEntryStats(opts)
  }

  async listDebug({
    limit = 20,
    exclude_error_class = null,
    include_muted = false,
    error_class = null,
    owner_user_id = null,
  } = {}) {
    const exclude = this._mutedExclude({ exclude_error_class, include_muted, error_class })
    const n = Math.max(1, Math.min(100, Number(limit) || 20))
    const pool = await this.repo.listDebug({ limit: exclude ? Math.min(200, n * 15) : n, owner_user_id })
    const items = error_class ? pool.filter((row) => row.error_class === error_class) : this._dropMuted(pool, exclude)
    return items.slice(0, n)
  }

  async getDebug(requestId, { owner_user_id = null } = {}) {
    if (!requestId) return null
    const rec = (await this.repo.getDebug(requestId)) || (await this.repo.getByRequestId(requestId))
    if (!rec) return null
    if (owner_user_id && !(await this.repo.belongsToOwner(requestId, owner_user_id))) return null
    return rec
  }

  async snapshot() {
    let totalRows = null
    try {
      totalRows = await this.repo.count()
    } catch {}
    return {
      mode: this.mode,
      retain_days: this.retainDays,
      debug_retain_days: this.debugRetainDays,
      max_mb: this.maxMb,
      muted_error_classes: this.mutedErrorClasses.slice(),
      recent_normal: this._mem.length,
      backend: 'sqlite',
      jsonl_mirror: this.jsonlMirror,
      total_rows: totalRows,
    }
  }

  /** Retention: delete rows older than retain windows, then enforce max_mb. */
  async cleanup() {
    try {
      await this.repo.cleanup({
        retainDays: this.retainDays,
        debugRetainDays: this.debugRetainDays,
        maxBytes: this.maxMb > 0 ? this.maxMb * 1024 * 1024 : 0,
      })
    } catch {}
    this._cleanupLegacyFiles(this.retainDays, this.root)
    this._cleanupLegacyFiles(this.debugRetainDays, path.join(this.root, 'debug'))
  }

  startCleanupScheduler({ intervalMs = CLEANUP_INTERVAL_MS } = {}) {
    this.stopCleanupScheduler()
    const ms = Math.max(60_000, Number(intervalMs) || CLEANUP_INTERVAL_MS)
    const run = () => {
      this.cleanup().catch(() => {})
    }
    this._cleanupTimer = setInterval(run, ms)
    if (typeof this._cleanupTimer.unref === 'function') this._cleanupTimer.unref()
  }

  stopCleanupScheduler() {
    clearInterval(this._cleanupTimer)
    this._cleanupTimer = null
  }

  _cleanupLegacyFiles(days, dir) {
    const cutoff = Date.now() - days * 86400_000
    try {
      if (!fs.existsSync(dir)) return
      for (const name of fs.readdirSync(dir)) {
        if (!/^\d{4}-\d{2}-\d{2}/.test(name)) continue
        const dayMs = Date.parse(name.slice(0, 10) + 'T00:00:00Z')
        if (!Number.isFinite(dayMs) || dayMs >= cutoff) continue
        fs.rmSync(path.join(dir, name), { recursive: true, force: true })
      }
    } catch {}
  }
}

const EXPORT_COLUMNS = [
  'ts',
  'request_id',
  'method',
  'path',
  'protocol',
  'status',
  'error_class',
  'error_code',
  'error_message',
  'error_label',
  'model',
  'vm_id',
  'ip',
  'api_key_presented',
  'duration_ms',
  'first_token_ms',
  'first_byte_ms',
  'generation_ms',
  'input_tokens',
  'output_tokens',
  'total_cost',
  'api_key_id',
  'api_key_kind',
]

function csvCell(v) {
  if (v == null || v === '') return ''
  const s = String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function logsToCsv(items = []) {
  const header = EXPORT_COLUMNS.join(',')
  const rows = items.map((row) => EXPORT_COLUMNS.map((k) => csvCell(row[k])).join(','))
  return [header, ...rows].join('\n') + (items.length ? '\n' : '')
}

export function logsToJsonl(items = []) {
  return (
    items
      .map((row) => {
        const out = {}
        for (const k of EXPORT_COLUMNS) out[k] = row[k] ?? null
        return JSON.stringify(out)
      })
      .join('\n') + (items.length ? '\n' : '')
  )
}

export { summarizeBody, redactHeaders, clampBody, DEFAULT_RETAIN_DAYS, DEFAULT_DEBUG_RETAIN_DAYS, DEFAULT_MAX_MB }
