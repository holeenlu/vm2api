/**
 * usage_logs + request_log_debug repository — sub2api UsageLog shape.
 * Normal summaries (always, unless mode=off) and full redacted debug records.
 *
 * DB columns follow sub2api naming (created_at, ip_address, user_id/group_id,
 * actual_cost, rate_multiplier). Records returned to callers keep the
 * historical `ts` / `ip` aliases so the panel API shape is unchanged; writers
 * may pass either name.
 */

import { getDb } from '../database.mjs'
import { applyRate, fromMicros, microsOf, rowMicros, toMicros } from '../../core/money.mjs'
import { microsSumSql, moneySql, usdSumSql } from './money-sql.mjs'
import { dbClient } from '../db-client.mjs'
import { recordVendorUsage } from '../../vendor/vendor-usage.mjs'
import { collectErrors, enrichLogRow, excludeErrorClassSql, ingressAuthSql } from '../../admin/error-class.mjs'
import {
  costColumnsFromUsage,
  emptyCostBucket,
  shanghaiDayStartIso,
  sumCostBuckets as sumCostColumns,
  UNPRICED_MODEL,
} from '../../admin/pricing.mjs'
import { cacheHitStats } from '../../admin/cache-metrics.mjs'
import { extraWindowSince, WINDOW_5H_MS, WINDOW_7D_MS } from '../../pool/quota-window.mjs'
import {
  ERROR_PRED,
  SUCCESS_PRED,
  SLA_ERROR_PRED,
  SLA_SUCCESS_PRED,
  ownerPred,
  PROMPT_TOKENS_SQL,
  TOTAL_TOKENS_SQL,
  totalTokens,
  UPSTREAM_PROMPT_TOKENS_SQL,
  UPSTREAM_TOTAL_TOKENS_SQL,
  upstreamTokenSql,
} from './usage-log-preds.mjs'
import { collapseBlockKeywords, foldInterceptRows } from '../../protocol/intercept-stats.mjs'
import { vmWindowForecast } from '../../usage/vm-quota-forecast.mjs'
import {
  addRollupBuckets,
  BILLING_ACCOUNT_KEY_SQL,
  ceilHourMs,
  hourKey,
  ROLLUP_SOURCE,
  rollupMeasures,
  windowSums,
} from './usage-cost-rollup.mjs'

/** settings key: ISO instant before which usage_logs rows may have been pruned. Monotonic. */
const PRUNED_THROUGH_KEY = 'usage_logs_pruned_through'
/** `query` 按行判定错误类别时每次读的行数与一次调用最多读的行数；旧的 offset 分页最多跳过的行数。 */
const QUERY_SCAN_CHUNK = 500
const QUERY_SCAN_CAP = 5000
const QUERY_MAX_OFFSET = 10_000
const BILLING_STATS_CACHE_TTL_MS = 10_000
const BILLING_BACKFILL_INTERVAL_MS = 60_000

export function billingStatsCacheKey(accountWindows) {
  if (!Array.isArray(accountWindows) || accountWindows.length === 0) return 'rolling'
  const normalized = accountWindows
    .map((win) => ({
      account_id: win?.account_id || '',
      vm_id: win?.vm_id || '',
      reset_5h: win?.reset_5h || null,
      reset_7d: win?.reset_7d || null,
      reset_7d_oi: win?.reset_7d_oi || null,
    }))
    .sort((a, b) =>
      `${a.account_id}\0${a.vm_id}`.localeCompare(`${b.account_id}\0${b.vm_id}`, 'en', { sensitivity: 'case' }),
    )
  return JSON.stringify(normalized)
}

// Preserve per-row prompt denominators when aligning account quota windows.
// Do not re-apply a single Anthropic formula on the mixed SUM (homepage/usage
// billing). Database-page PromptCacheMetricsPanel still uses input+read+write.
function sumCostBuckets(rows) {
  return {
    ...sumCostColumns(rows),
    prompt_tokens: rows.reduce((sum, row) => sum + (Number(row.prompt_tokens) || 0), 0),
  }
}

// Rolling 5h / 7d totals over every account: the per-account buckets already partition all rows.
function rollingTotal(byAccount) {
  const rows = [...byAccount.values()]
  const bucket = { ...sumCostBuckets(rows), unpriced: rows.reduce((sum, row) => sum + (Number(row.unpriced) || 0), 0) }
  return { ...bucket, ...cacheHitStats(bucket) }
}

// 成本列是上游口径（账号成本 / 供应商结算依据），重算成本只读上游原始 token（119）
const UPSTREAM_PRICE_TOKENS = [
  'input_tokens',
  'cache_read_tokens',
  'cache_creation_tokens',
  'cache_creation_5m_tokens',
  'cache_creation_1h_tokens',
]
  .map((column) => `${upstreamTokenSql(column)} AS ${column}`)
  .concat('output_tokens')
  .join(', ')

/** 重新定价改写的金额列（不含 actual_cost，它只在补算缺失成本时一并写）。 */
const REPRICE_MONEY = [
  'input_cost',
  'output_cost',
  'cache_read_cost',
  'cache_creation_cost',
  'web_search_cost',
  'image_cost',
  'total_cost',
]

/** usage_logs 的金额列（REAL 镜像）；`<name>_micros` 是权威值（迁移 126）。 */
export const USAGE_LOG_MONEY_COLUMNS = [
  'input_cost',
  'output_cost',
  'cache_read_cost',
  'cache_creation_cost',
  'web_search_cost',
  'image_cost',
  'total_cost',
  'actual_cost',
]

/** 有效金额上限（2^51 微单位，core/money.mjs MAX_MONEY_MICROS + 1）对应的美元值。 */
const MONEY_LIMIT_USD = '2251799813.685248'
/**
 * 整数列与 REAL 镜像不一致的行（上一版本在回滚期间写入或改写的行）。与迁移 126 的部分索引
 * `idx_usage_logs_money_drift` 是同一个表达式，查询可以只读这个（通常为空的）索引。
 */
const MONEY_DRIFT_SQL = USAGE_LOG_MONEY_COLUMNS.map(
  (c) =>
    `(${c}_micros IS NOT CAST(ROUND(${c} * 1000000) AS INTEGER) AND (${c} IS NULL OR ABS(${c}) < ${MONEY_LIMIT_USD}))`,
).join('\n   OR ')
const SYNC_LEGACY_MONEY_SQL = `UPDATE usage_logs SET ${USAGE_LOG_MONEY_COLUMNS.map(
  (c) =>
    `${c}_micros = CASE WHEN ${c} IS NULL THEN NULL WHEN ABS(${c}) < ${MONEY_LIMIT_USD} THEN CAST(ROUND(${c} * 1000000) AS INTEGER) ELSE ${c}_micros END`,
).join(', ')}
  WHERE rowid IN (SELECT rowid FROM usage_logs INDEXED BY idx_usage_logs_money_drift WHERE ${MONEY_DRIFT_SQL} LIMIT ?)`

const SUMMARY_COLUMNS = [
  'id',
  'request_id',
  'config_revision',
  'created_at',
  'log_mode',
  'method',
  'path',
  'protocol',
  'model',
  'stream',
  'status',
  'duration_ms',
  'api_key_kind',
  'api_key_id',
  'vm_id',
  'account_id',
  'workspace',
  'input_tokens',
  'output_tokens',
  'error_code',
  'error_message',
  'user_agent',
  'ip_address',
  'api_key_presented',
  'has_tools',
  'via',
  'cache_read_tokens',
  'cache_creation_tokens',
  'cache_creation_5m_tokens',
  'cache_creation_1h_tokens',
  // 119：主 token 列是客户计费口径；与之不同时这里存上游原始值，NULL 表示同主列
  'upstream_input_tokens',
  'upstream_cache_read_tokens',
  'upstream_cache_creation_tokens',
  'upstream_cache_creation_5m_tokens',
  'upstream_cache_creation_1h_tokens',
  'requested_model',
  'upstream_model',
  'response_model',
  'model_mismatch',
  'first_token_ms',
  'first_byte_ms',
  'generation_ms',
  'stop_reason',
  'attempt_count',
  'final_state',
  'final_account_id',
  'input_cost',
  'output_cost',
  'cache_read_cost',
  'cache_creation_cost',
  'web_search_requests',
  'web_search_cost',
  'total_cost',
  'pricing_model',
  'price_source',
  'price_version',
  'user_id',
  'group_id',
  'actual_cost',
  'rate_multiplier',
  'service_tier',
  'upstream_service_tier',
  'error_kind',
  'authorization_mode',
  'inbound_transport',
  'upstream_path',
  'upstream_transport',
  'upstream_error_json',
  'websocket_close_code',
  'continuation_unavailable_reason',
  'upstream_connection_exit_reason',
  'retry_after_ms',
  'speed',
  'long_context',
  'session_id',
  'outbound_session_id',
  'reasoning_effort',
  'inbound_device_id',
  'intercept',
  'jev_state',
  'vm_owner_user_id',
  'billing_status',
  'billing_group_id',
  'subscription_id',
  'api_key_name',
  'source',
  'image_model',
  'image_usage',
  'image_input_tokens',
  'image_output_tokens',
  'image_cost',
  'execution_kind',
  'account_resource_id',
  'gateway_instance_id',
  'dispatch_id',
  'receipt_id',
  'usage_confidence',
  // M6：金额的权威值是整数微单位；上面的 REAL 列是镜像，由 toRow 从整数派生同时写
  ...USAGE_LOG_MONEY_COLUMNS.map((c) => c + '_micros'),
]

const INSERT_SQL = `
      INSERT INTO usage_logs (${SUMMARY_COLUMNS.join(', ')})
      VALUES (${SUMMARY_COLUMNS.map(() => '?').join(', ')})
    `
const INSERT_IF_ABSENT_SQL = `
      INSERT OR IGNORE INTO usage_logs (${SUMMARY_COLUMNS.join(', ')})
      VALUES (${SUMMARY_COLUMNS.map(() => '?').join(', ')})
    `
const INSERT_DEBUG_SQL = `
      INSERT INTO request_log_debug (request_id, ts, record_json) VALUES (?, ?, ?)
      ON CONFLICT(request_id) DO UPDATE SET ts = excluded.ts, record_json = excluded.record_json
    `
const INSERT_DEBUG_IF_ABSENT_SQL = `
      INSERT OR IGNORE INTO request_log_debug (request_id, ts, record_json) VALUES (?, ?, ?)
    `
const GET_DEBUG_SQL = 'SELECT record_json FROM request_log_debug WHERE request_id = ?'
const VM_OWNER_SQL = 'SELECT owner_user_id FROM vms WHERE id = ?'
const LIST_DEBUG_SQL = 'SELECT record_json FROM request_log_debug ORDER BY ts DESC LIMIT ?'
const GET_BY_REQUEST_ID_SQL = 'SELECT * FROM usage_logs WHERE request_id = ?'
// OCTET_LENGTH counts encoded bytes and lets SQLite read TEXT size from metadata without loading each body.
const DEBUG_BYTES_SQL = 'SELECT COALESCE(SUM(OCTET_LENGTH(record_json)), 0) AS n FROM request_log_debug'
const DEBUG_COUNT_SQL = 'SELECT COUNT(*) AS n FROM request_log_debug'
const DELETE_OLD_USAGE_SQL = 'DELETE FROM usage_logs WHERE created_at < ?'
const DELETE_OLD_DEBUG_SQL = 'DELETE FROM request_log_debug WHERE ts < ?'
const DELETE_OLDEST_DEBUG_SQL = `
      DELETE FROM request_log_debug WHERE request_id IN (
        SELECT request_id FROM request_log_debug ORDER BY ts ASC LIMIT ?
      )
    `

/** 记录里的金额：有 `*_micros` 用它，否则（只给了美元值的写入方）在这里换算一次。 */
function recMicros(rec, column) {
  const micros = microsOf(rec[column + '_micros'])
  return micros != null ? micros : toMicros(rec[column])
}

function toRow(rec) {
  return SUMMARY_COLUMNS.map((c) => {
    if (c.endsWith('_micros') && USAGE_LOG_MONEY_COLUMNS.includes(c.slice(0, -7))) return recMicros(rec, c.slice(0, -7))
    if (USAGE_LOG_MONEY_COLUMNS.includes(c)) return fromMicros(recMicros(rec, c))
    if (c === 'billing_status') return rec[c] || 'unmetered'
    if (c === 'source') return rec[c] || 'protocol'
    if (c === 'created_at') return rec.created_at ?? rec.ts ?? null
    if (c === 'ip_address') return rec.ip_address ?? rec.ip ?? null
    if (c === 'stream') return rec.stream ? 1 : 0
    if (c === 'has_tools') return rec.has_tools == null ? null : rec.has_tools ? 1 : 0
    if (c === 'cache_creation_tokens' && rec[c] == null) return null
    if (c.startsWith('upstream_') && c.endsWith('_tokens')) return rec[c] == null ? null : Number(rec[c]) || 0
    if (
      c === 'input_tokens' ||
      c === 'output_tokens' ||
      c === 'cache_read_tokens' ||
      c === 'cache_creation_tokens' ||
      c === 'cache_creation_5m_tokens' ||
      c === 'cache_creation_1h_tokens' ||
      c === 'web_search_requests' ||
      c === 'image_input_tokens' ||
      c === 'image_output_tokens'
    )
      return Number(rec[c]) || 0
    return rec[c] ?? null
  })
}

function fromRow(row) {
  if (!row) return null
  return {
    ...row,
    ts: row.created_at,
    ip: row.ip_address,
    stream: !!row.stream,
    has_tools: row.has_tools == null ? null : !!row.has_tools,
  }
}

function timeCond(since, until) {
  const where = []
  const params = []
  if (since) {
    where.push('created_at >= ?')
    params.push(new Date(since).toISOString())
  }
  if (until) {
    where.push('created_at <= ?')
    params.push(new Date(until).toISOString())
  }
  return { cond: where.length ? `WHERE ${where.join(' AND ')}` : '', params }
}

function accountEventKey(row) {
  return `${row?.account_id || ''}\0${row?.vm_id || ''}`
}

function resolveAccountWindow(windows, row) {
  const list = Array.isArray(windows) ? windows : []
  return (
    list.find((w) => w.account_id === row.account_id && (w.vm_id || null) === (row.vm_id || null)) ||
    list.find((w) => w.account_id && w.account_id === row.account_id) ||
    list.find((w) => w.vm_id && w.vm_id === row.vm_id) ||
    null
  )
}

function isFableRow(row) {
  const upstream = String(row?.upstream_model ?? '').trim()
  const model = String(row?.model ?? '').trim()
  return (upstream || model).toLowerCase().includes('fable')
}

function unpricedWithTokens(row) {
  return row?.pricing_model === UNPRICED_MODEL && totalTokens(row) > 0
}

function bucketEventsSince(rows = [], sinceMs) {
  const since = Number(sinceMs)
  const picked = rows.filter((row) => {
    const at = Date.parse(row.created_at)
    return Number.isFinite(at) && (!Number.isFinite(since) || at >= since)
  })
  if (!picked.length) return { ...emptyCostBucket(), unpriced: 0 }
  return {
    ...sumCostBuckets(
      picked.map((row) => ({
        requests: 1,
        success: Number(row.success || 0),
        errors: Number(row.errors || 0),
        input_tokens: Number(row.input_tokens || 0),
        output_tokens: Number(row.output_tokens || 0),
        cache_read_tokens: Number(row.cache_read_tokens || 0),
        cache_creation_tokens: Number(row.cache_creation_tokens || 0),
        prompt_tokens: Number(row.prompt_tokens || 0),
        input_cost_micros: Number(row.input_cost_micros || 0),
        output_cost_micros: Number(row.output_cost_micros || 0),
        cache_read_cost_micros: Number(row.cache_read_cost_micros || 0),
        cache_creation_cost_micros: Number(row.cache_creation_cost_micros || 0),
        total_cost_micros: Number(row.total_cost_micros || 0),
      })),
    ),
    unpriced: picked.filter(unpricedWithTokens).length,
  }
}

function filterCond({ since = null, until = null, vmId = null, accountId = null, apiKeyId = null } = {}) {
  const { cond, params } = timeCond(since, until)
  const parts = cond ? [cond.replace(/^WHERE /, '')] : []
  if (vmId) {
    parts.push('vm_id = ?')
    params.push(vmId)
  }
  if (apiKeyId) {
    parts.push('api_key_id = ?')
    params.push(apiKeyId)
  }
  if (accountId) {
    parts.push('(account_id = ? OR final_account_id = ?)')
    params.push(accountId, accountId)
  }
  return { cond: parts.length ? `WHERE ${parts.join(' AND ')}` : '', params }
}

/** Same percentile pick as sub2api ops cards. */
export function percentile(sorted, p) {
  if (!sorted.length) return null
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))
  return sorted[i]
}

export function summarizeLatency(values) {
  const s = (values || [])
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b)
  if (!s.length) {
    return { samples: 0, p50_ms: null, p90_ms: null, p95_ms: null, p99_ms: null, avg_ms: null, max_ms: null }
  }
  return {
    samples: s.length,
    p50_ms: percentile(s, 0.5),
    p90_ms: percentile(s, 0.9),
    p95_ms: percentile(s, 0.95),
    p99_ms: percentile(s, 0.99),
    avg_ms: Math.round(s.reduce((a, b) => a + b, 0) / s.length),
    max_ms: s[s.length - 1],
  }
}

export class UsageLogsRepo {
  constructor(db = getDb(), { billingMaintenance = true } = {}) {
    this.db = db
    this.client = dbClient(db)
    this._billingMaintenance = billingMaintenance
    // Panel endpoints request the same expensive billing snapshot several times
    // during one refresh. Keep this cache repository-local so it never affects
    // request accounting or persists across processes.
    this._billingStatsCache = new Map()
    this._forecastCache = new Map()
    this._billingBackfillAt = 0
  }

  /** Cheap EXISTS: ≥1 2xx row visible to the caller (same ownerPred as request-log stats). */
  async hasSuccessfulRequest({ owner_user_id = null } = {}) {
    const own = ownerPred(owner_user_id)
    const where = own.sql ? `AND ${own.sql}` : ''
    const row = await this.client.one(
      `SELECT 1 AS ok FROM usage_logs WHERE status >= 200 AND status < 300 ${where} LIMIT 1`,
      ...own.params,
    )
    return !!row
  }

  async belongsToOwner(requestId, ownerUserId) {
    if (!requestId) return false
    if (!ownerUserId) return true
    const own = ownerPred(ownerUserId)
    const row = await this.client.one(
      `SELECT 1 AS ok FROM usage_logs WHERE request_id = ? AND ${own.sql} LIMIT 1`,
      requestId,
      ...own.params,
    )
    return !!row
  }

  async getByRequestId(requestId) {
    if (!requestId) return null
    const row = await this.client.one(GET_BY_REQUEST_ID_SQL, requestId)
    return row ? enrichLogRow(fromRow(row)) : null
  }

  // 使用记录与供应商用量事实在同一个事务里写入（R6 B8：调用方是写回队列的 async 落库闭包 RequestLogStore.finish>persist，
  // 在写回批事务内执行时嵌套为 SAVEPOINT）
  async insertSummary(rec) {
    return this.client.tx(async (tx) => {
      await tx.run(INSERT_SQL, ...toRow(rec))
      await recordVendorUsage(this.db, await tx.one(GET_BY_REQUEST_ID_SQL, rec.request_id || rec.id))
      this._billingStatsCache.clear()
      return rec
    })
  }

  async vmOwnerOf(vmId) {
    if (!vmId) return null
    return (await this.client.one(VM_OWNER_SQL, String(vmId)))?.owner_user_id || null
  }

  /** INSERT OR IGNORE (legacy import path). @returns true when inserted */
  async insertSummaryIfAbsent(rec) {
    return this.client.tx(async (tx) => {
      const inserted = (await tx.run(INSERT_IF_ABSENT_SQL, ...toRow(rec))).changes > 0
      if (inserted) {
        await recordVendorUsage(this.db, await tx.one(GET_BY_REQUEST_ID_SQL, rec.request_id || rec.id))
        this._billingStatsCache.clear()
      }
      return inserted
    })
  }

  async insertDebug(requestId, ts, record) {
    await this.client.run(INSERT_DEBUG_SQL, requestId, ts || new Date().toISOString(), JSON.stringify(record))
  }

  async insertDebugIfAbsent(requestId, ts, record) {
    return (
      (
        await this.client.run(
          INSERT_DEBUG_IF_ABSENT_SQL,
          requestId,
          ts || new Date().toISOString(),
          JSON.stringify(record),
        )
      ).changes > 0
    )
  }

  async getDebug(requestId) {
    const row = await this.client.one(GET_DEBUG_SQL, requestId)
    if (!row) return null
    try {
      return enrichLogRow(JSON.parse(row.record_json))
    } catch {
      return null
    }
  }

  async listDebug({ limit = 20, owner_user_id = null } = {}) {
    const n = Math.max(1, Math.min(100, Number(limit) || 20))
    const own = ownerPred(owner_user_id)
    if (!own.sql) {
      return (await this.client.many(LIST_DEBUG_SQL, n))
        .map((r) => {
          try {
            return enrichLogRow(JSON.parse(r.record_json))
          } catch {
            return null
          }
        })
        .filter(Boolean)
    }
    return (
      await this.client.many(
        `
      SELECT d.record_json
      FROM request_log_debug d
      JOIN usage_logs u ON u.request_id = d.request_id
      WHERE ${own.sql}
      ORDER BY d.ts DESC
      LIMIT ?
    `,
        ...own.params,
        n,
      )
    )
      .map((r) => {
        try {
          return enrichLogRow(JSON.parse(r.record_json))
        } catch {
          return null
        }
      })
      .filter(Boolean)
  }

  /**
   * Filtered page over summaries (newest first), keyset on `(created_at DESC, id DESC)`（技术债 M5，数据访问分层 R4 遗留）。
   * 不再整表 COUNT：返回 `{ items, next_cursor, has_more }`，`next_cursor` 为 `{ created_at, id }`，原样回传给下一页。
   * - 游标谓词与使用记录页相同：先给 created_at 范围上界，索引从游标处开始扫，深翻页不随页数变慢；
   * - 错误类别按行在 JS 判定（指定 `error_class`，或屏蔽 `auth` 以外的类别）时分块扫描，一次最多读 QUERY_SCAN_CAP 行；
   *   读满仍不够一页时，游标指向最后读到的行、`has_more` 为 true，由调用方继续翻；
   * - `offset` 是上游 `/api/panel/request-logs` 的公开参数，按上游优先保留到上游删除为止（没有游标时生效，最多 QUERY_MAX_OFFSET 行）。
   */
  async query({
    limit = 50,
    offset = 0,
    cursor_created_at = null,
    cursor_id = null,
    api_key_id = null,
    vm_id = null,
    account_id = null,
    model = null,
    status = null,
    protocol = null,
    since = null,
    until = null,
    q = null,
    error_class = null,
    exclude_error_class = null,
    maxLimit = 500,
    owner_user_id = null,
  } = {}) {
    const where = []
    const params = []
    const own = ownerPred(owner_user_id)
    if (own.sql) {
      where.push(own.sql)
      params.push(...own.params)
    }
    if (api_key_id) {
      where.push('api_key_id = ?')
      params.push(api_key_id)
    }
    if (vm_id) {
      where.push('vm_id = ?')
      params.push(vm_id)
    }
    if (account_id) {
      where.push('account_id = ?')
      params.push(account_id)
    }
    if (model) {
      where.push('model = ?')
      params.push(model)
    }
    if (protocol) {
      where.push('protocol = ?')
      params.push(protocol)
    }
    if (error_class && (status == null || status === '')) status = 'error'
    if (status != null && status !== '') {
      if (String(status) === 'error') where.push(ERROR_PRED)
      else if (String(status) === 'ok') where.push('(status < 400 AND status IS NOT NULL)')
      else {
        where.push('status = ?')
        params.push(Number(status))
      }
    }
    let keep = null
    if (error_class) keep = (row) => row.error_class === error_class
    else if (exclude_error_class) {
      const excludeSql = excludeErrorClassSql(exclude_error_class)
      if (excludeSql) where.push(excludeSql)
      // SQL 只能预先去掉一部分 auth；SQL 的判定比按行分类窄（例如 400 + "x-api-key header is required"），
      // auth 仍按行再判一次，与改游标分页前的行为一致（M5 复审 P2-4）
      const blocked = new Set(
        String(exclude_error_class)
          .split(',')
          .map((c) => c.trim())
          .filter(Boolean),
      )
      if (blocked.size) keep = (row) => !row.error_class || !blocked.has(row.error_class)
    }
    if (since) {
      where.push('created_at >= ?')
      params.push(new Date(since).toISOString())
    }
    if (until) {
      where.push('created_at <= ?')
      params.push(new Date(until).toISOString())
    }
    if (q) {
      where.push('(path LIKE ? OR error_code LIKE ? OR error_message LIKE ? OR request_id LIKE ?)')
      const like = `%${String(q).slice(0, 100)}%`
      params.push(like, like, like, like)
    }
    const cap = Math.max(1, Math.min(5000, Number(maxLimit) || 500))
    const n = Math.max(1, Math.min(cap, Number(limit) || 50))
    let cursor =
      cursor_created_at && cursor_id ? { created_at: String(cursor_created_at), id: String(cursor_id) } : null
    const off = cursor ? 0 : Math.max(0, Math.min(QUERY_MAX_OFFSET, Math.trunc(Number(offset)) || 0))
    const page = async (at, count, skip = 0) => {
      const w = where.slice()
      const p = params.slice()
      if (at) {
        w.push('created_at <= ? AND (created_at < ? OR id < ?)')
        p.push(at.created_at, at.created_at, at.id)
      }
      return this.client.many(
        `SELECT * FROM usage_logs ${w.length ? `WHERE ${w.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
        ...p,
        count,
        skip,
      )
    }
    const cursorOf = (row) => (row ? { created_at: row.created_at, id: row.id } : null)
    if (!keep) {
      const rows = await page(cursor, n + 1, off)
      const items = rows.slice(0, n).map(fromRow).map(enrichLogRow)
      const hasMore = rows.length > n
      return { items, next_cursor: hasMore ? cursorOf(items.at(-1)) : null, has_more: hasMore }
    }
    const matches = []
    let skip = off
    let scanned = 0
    let last = null
    let exhausted = false
    while (matches.length <= n) {
      const rows = await page(cursor, QUERY_SCAN_CHUNK)
      for (const raw of rows) {
        scanned++
        last = raw
        const row = enrichLogRow(fromRow(raw))
        if (!keep(row)) continue
        if (skip > 0) {
          skip--
          continue
        }
        matches.push(row)
        if (matches.length > n) break
      }
      if (matches.length > n) break
      if (rows.length < QUERY_SCAN_CHUNK) {
        exhausted = true
        break
      }
      if (scanned >= QUERY_SCAN_CAP) break
      cursor = cursorOf(last)
    }
    if (matches.length > n) {
      const items = matches.slice(0, n)
      return { items, next_cursor: cursorOf(items.at(-1)), has_more: true }
    }
    if (exhausted) return { items: matches, next_cursor: null, has_more: false }
    // 读满 QUERY_SCAN_CAP 行仍不够一页：从最后读到的行继续
    return { items: matches, next_cursor: cursorOf(last), has_more: true }
  }

  /**
   * Aggregate stats bucketed by day or hour (dashboard/usage charts).
   * @returns {Array<{bucket, requests, errors, input_tokens, output_tokens, avg_duration_ms}>}
   */
  async aggregate({ since = null, until = null, bucket = 'day', owner_user_id = null } = {}) {
    const fmt = bucket === 'hour' ? '%Y-%m-%dT%H:00' : '%Y-%m-%d'
    const { cond, params } = timeCond(since, until)
    const own = ownerPred(owner_user_id)
    let where = cond
    const allParams = [...params]
    if (own.sql) {
      where = where ? `${where} AND ${own.sql}` : `WHERE ${own.sql}`
      allParams.push(...own.params)
    }
    return await this.client.many(
      `
      SELECT strftime('${fmt}', created_at, '+8 hours') AS bucket,
             COUNT(*) AS requests,
             SUM(CASE WHEN ${ERROR_PRED} THEN 1 ELSE 0 END) AS errors,
             COALESCE(SUM(input_tokens), 0) AS input_tokens,
             COALESCE(SUM(output_tokens), 0) AS output_tokens,
             COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
             COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
             COALESCE(SUM(${PROMPT_TOKENS_SQL}), 0) AS prompt_tokens,
             ${usdSumSql('total_cost')} AS total_cost,
             CAST(AVG(duration_ms) AS INTEGER) AS avg_duration_ms,
             CAST(AVG(first_token_ms) AS INTEGER) AS avg_first_token_ms
      FROM usage_logs ${where}
      GROUP BY bucket ORDER BY bucket
    `,
      ...allParams,
    )
  }

  /** Grand totals (dashboard db_totals). */
  async totals() {
    const row = await this.client.one(`
      SELECT COUNT(*) AS requests,
             SUM(CASE WHEN ${ERROR_PRED} THEN 1 ELSE 0 END) AS errors,
             COALESCE(SUM(input_tokens), 0) AS input_tokens,
             COALESCE(SUM(output_tokens), 0) AS output_tokens,
             COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
             COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
             COALESCE(SUM(${PROMPT_TOKENS_SQL}), 0) AS prompt_tokens,
             ${usdSumSql('input_cost')} AS input_cost,
             ${usdSumSql('output_cost')} AS output_cost,
             ${usdSumSql('cache_read_cost')} AS cache_read_cost,
             ${usdSumSql('cache_creation_cost')} AS cache_creation_cost,
             ${usdSumSql('total_cost')} AS total_cost
      FROM usage_logs
    `)
    return { ...row, ...cacheHitStats(row) }
  }

  _usageForPrice(row) {
    return {
      input_tokens: row.input_tokens,
      output_tokens: row.output_tokens,
      cache_read_tokens: row.cache_read_tokens,
      cache_creation_tokens: row.cache_creation_tokens,
      cache_creation_5m_tokens: row.cache_creation_5m_tokens,
      cache_creation_1h_tokens: row.cache_creation_1h_tokens,
      web_search_requests: row.web_search_requests,
      service_tier: row.service_tier,
      speed: row.speed,
    }
  }

  /** Stored image generation usage for re-pricing; Images endpoint rows bill it alone. */
  _imageForPrice(row) {
    const only = row.protocol === 'openai.images'
    if (!row.image_usage && !only) return null
    let usage = null
    try {
      usage = row.image_usage ? JSON.parse(row.image_usage) : null
    } catch {}
    return { usage, model: row.image_model, only }
  }

  async _repriceRows(rows, { writeActualCost = false } = {}) {
    if (!rows.length) return { rows: 0, changed: 0, still_unpriced: 0, delta_usd: 0, delta_micros: 0 }
    // 整数列是权威值，REAL 镜像由它派生同时写（M6）
    const money = REPRICE_MONEY.map((c) => `${c}_micros = ?, ${c} = ?`).join(', ')
    const upd = `
      UPDATE usage_logs
         SET ${money},${writeActualCost ? ' actual_cost_micros = ?, actual_cost = ?,' : ''}
             pricing_model = ?, price_source = ?, price_version = ?, long_context = ?
       WHERE id = ?
    `
    let changed = 0
    let still_unpriced = 0
    let delta_micros = 0
    await this.client.tx(async (tx) => {
      for (const r of rows) {
        const model = r.upstream_model || r.model || r.requested_model
        const priced = costColumnsFromUsage(this._usageForPrice(r), model, this._imageForPrice(r))
        const same =
          REPRICE_MONEY.every((c) => (microsOf(r[c + '_micros']) ?? null) === (priced[c + '_micros'] ?? null)) &&
          (r.pricing_model ?? null) === (priced.pricing_model ?? null) &&
          (r.price_source ?? null) === (priced.price_source ?? null) &&
          (r.price_version ?? null) === (priced.price_version ?? null) &&
          (r.long_context ?? null) === (priced.long_context ?? null)
        if (priced.pricing_model === UNPRICED_MODEL || priced.total_cost_micros == null) still_unpriced += 1
        if (!same) {
          changed += 1
          delta_micros += (priced.total_cost_micros || 0) - (microsOf(r.total_cost_micros) || 0)
        }
        const moneyArgs = REPRICE_MONEY.flatMap((c) => [priced[c + '_micros'] ?? null, priced[c] ?? null])
        const actualArgs = []
        if (writeActualCost) {
          const parsedRate = r.rate_multiplier == null ? 1 : Number(r.rate_multiplier)
          const rate = Number.isFinite(parsedRate) ? parsedRate : 1
          const actual = applyRate(priced.total_cost_micros ?? null, rate)
          actualArgs.push(actual, fromMicros(actual))
        }
        await tx.run(
          upd,
          ...moneyArgs,
          ...actualArgs,
          priced.pricing_model ?? UNPRICED_MODEL,
          priced.price_source ?? null,
          priced.price_version ?? null,
          priced.long_context ?? null,
          r.id,
        )
      }
    })
    return { rows: rows.length, changed, still_unpriced, delta_usd: fromMicros(delta_micros), delta_micros }
  }

  /**
   * 启动时（对外服务之前）把“只写了 REAL”的行的整数列按 ROUND(REAL × 1e6) 补齐（M6 回滚兼容）。
   * 上一版本在回滚期间写入或改写的使用记录只改 REAL；这些行落在部分索引 idx_usage_logs_money_drift 里，
   * 正常情况下索引为空，这一步只读一次空索引。按批次各自一个事务；改写整数列经汇总触发器同步更新小时汇总。
   * 返回改写的行数。
   */
  async syncLegacyMoneyRows({ batch = 2000, onProgress = null, progressEvery = 50_000 } = {}) {
    let total = 0
    let reported = 0
    for (;;) {
      const changed = Number((await this.client.run(SYNC_LEGACY_MONEY_SQL, batch)).changes || 0)
      total += changed
      if (changed < batch) return total
      // 每批单独提交；行数多时（实测约 2.8 万行/秒）按进度报告，便于判断启动为何还没开始监听
      if (onProgress && total - reported >= progressEvery) {
        reported = total
        onProgress(total)
      }
    }
  }

  /**
   * Fill official cost on rows that predate the billing columns, re-pricing with the
   * stored service_tier / speed. Rows the pricer cannot price are marked 'unpriced'
   * (cost stays NULL) so they are never guessed at standard rates. Idempotent.
   * Only `pricing_model IS NULL` rows; those set actual_cost = total_cost × rate_multiplier.
   */
  async backfillMissingCosts({ limit = 4000 } = {}) {
    const rows = await this.client.many(
      `
      SELECT id, model, upstream_model, requested_model,
             ${UPSTREAM_PRICE_TOKENS},
             web_search_requests,
             rate_multiplier, service_tier, speed, protocol, image_model, image_usage,
             input_cost_micros, output_cost_micros, cache_read_cost_micros, cache_creation_cost_micros,
             web_search_cost_micros, image_cost_micros, total_cost_micros,
             pricing_model, price_source, price_version, long_context
      FROM usage_logs
      WHERE pricing_model IS NULL
      LIMIT ?
    `,
      Math.max(1, Math.min(20000, Number(limit) || 4000)),
    )
    return (await this._repriceRows(rows, { writeActualCost: true })).rows
  }

  /** Rewrite cost columns in [since, until]; never actual_cost / rate_multiplier. */
  async repriceRange({ since, until } = {}) {
    const { cond, params } = timeCond(since, until)
    const where = cond ? `${cond} AND rowid > ?` : 'WHERE rowid > ?'
    // Keyset pages keep a month-long range from loading every row at once.
    const page = `
      SELECT rowid AS _rowid, id, model, upstream_model, requested_model,
             ${UPSTREAM_PRICE_TOKENS},
             web_search_requests,
             rate_multiplier, service_tier, speed, protocol, image_model, image_usage,
             input_cost_micros, output_cost_micros, cache_read_cost_micros, cache_creation_cost_micros,
             web_search_cost_micros, image_cost_micros, total_cost_micros,
             pricing_model, price_source, price_version, long_context
      FROM usage_logs ${where}
      ORDER BY rowid
      LIMIT 2000
    `
    const out = { rows: 0, changed: 0, still_unpriced: 0, delta_usd: 0 }
    let delta = 0
    let after = 0
    for (;;) {
      const rows = await this.client.many(page, ...params, after)
      if (!rows.length) break
      const part = await this._repriceRows(rows, { writeActualCost: false })
      out.rows += part.rows
      out.changed += part.changed
      out.still_unpriced += part.still_unpriced
      delta += part.delta_micros
      after = rows.at(-1)._rowid
    }
    out.delta_usd = fromMicros(delta)
    return out
  }

  async unpricedModels({ since } = {}) {
    const where = [`pricing_model = '${UNPRICED_MODEL}'`]
    const params = []
    if (since) {
      where.push('created_at >= ?')
      params.push(new Date(since).toISOString())
    }
    return (
      await this.client.many(
        `
      SELECT COALESCE(NULLIF(upstream_model, ''), NULLIF(model, ''), NULLIF(requested_model, ''), '') AS model,
             COUNT(*) AS requests,
             MAX(created_at) AS last_seen
      FROM usage_logs
      WHERE ${where.join(' AND ')}
      GROUP BY 1
      ORDER BY requests DESC, last_seen DESC
    `,
        ...params,
      )
    ).map((r) => ({
      model: r.model,
      requests: Number(r.requests || 0),
      last_seen: r.last_seen || null,
    }))
  }

  async _costSelect(cond, params) {
    const row = await this.client.one(
      `
      SELECT
        COUNT(*) AS requests,
        COALESCE(SUM(${upstreamTokenSql('input_tokens')}), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(${upstreamTokenSql('cache_read_tokens')}), 0) AS cache_read_tokens,
        COALESCE(SUM(${upstreamTokenSql('cache_creation_tokens')}), 0) AS cache_creation_tokens,
        COALESCE(SUM(${UPSTREAM_PROMPT_TOKENS_SQL}), 0) AS prompt_tokens,
        ${usdSumSql('input_cost')} AS input_cost,
        ${usdSumSql('output_cost')} AS output_cost,
        ${usdSumSql('cache_read_cost')} AS cache_read_cost,
        ${usdSumSql('cache_creation_cost')} AS cache_creation_cost,
        ${usdSumSql('total_cost')} AS total_cost,
        COALESCE(SUM(CASE WHEN pricing_model = '${UNPRICED_MODEL}' AND (${UPSTREAM_TOTAL_TOKENS_SQL}) > 0 THEN 1 ELSE 0 END), 0) AS unpriced
      FROM usage_logs ${cond}
    `,
      ...params,
    )
    const out = {
      requests: Number(row?.requests || 0),
      input_tokens: Number(row?.input_tokens || 0),
      output_tokens: Number(row?.output_tokens || 0),
      cache_read_tokens: Number(row?.cache_read_tokens || 0),
      cache_creation_tokens: Number(row?.cache_creation_tokens || 0),
      prompt_tokens: Number(row?.prompt_tokens || 0),
      input_cost: Number(row?.input_cost || 0),
      output_cost: Number(row?.output_cost || 0),
      cache_read_cost: Number(row?.cache_read_cost || 0),
      cache_creation_cost: Number(row?.cache_creation_cost || 0),
      total_cost: Number(row?.total_cost || 0),
      unpriced: Number(row?.unpriced || 0),
    }
    return { ...out, ...cacheHitStats(out) }
  }

  /** Official cost of one slot / credential over a fixed span (a closed quota window). */
  async costBetween({ since, until, vmId = null, accountId = null } = {}) {
    const { cond, params } = filterCond({ since, until, vmId, accountId })
    return this._costSelect(cond, params)
  }

  /** Per billing account (key, slot) usage at or after `since`, from the hourly rollup plus the partial edge hour. */
  async costByAccount({ since = null } = {}) {
    const sinceMs = since == null ? null : new Date(since).getTime()
    const sums = await windowSums(this.db, {
      sinceMs,
      rollup: { select: 'account_key AS account_id, vm_ref AS vm_id', group: 'account_key, vm_ref' },
      raw: { select: `${BILLING_ACCOUNT_KEY_SQL} AS account_id, NULLIF(vm_id, '') AS vm_id`, group: '1, 2' },
      keyOf: accountEventKey,
      successPred: SLA_SUCCESS_PRED,
      errorPred: SLA_ERROR_PRED,
    })
    return [...sums.values()]
      .map((r) => ({ ...addRollupBuckets([r]), account_id: r.account_id, vm_id: r.vm_id || null }))
      .sort((a, b) => b.total_cost_micros - a.total_cost_micros)
  }

  /**
   * Official cost grouped by upstream model and billing band for one credential / slot.
   * service_tier is folded to fast / flex / other-raw (standard aliases → NULL);
   * speed is 'fast' or NULL. unpriced_requests counts rows left without an estimate.
   */
  async costByModel({ vmId = null, accountId = null, since = null, until = null } = {}) {
    const { cond, params } = filterCond({ since, until, vmId, accountId })
    const rows = await this.client.many(
      `
      SELECT COALESCE(NULLIF(upstream_model, ''), NULLIF(model, ''), NULLIF(requested_model, ''), '—') AS model,
             CASE
               WHEN service_tier IS NULL OR service_tier IN ('', 'default', 'auto', 'standard') THEN NULL
               WHEN service_tier IN ('priority', 'fast') THEN 'fast'
               ELSE service_tier
             END AS service_tier,
             CASE WHEN speed = 'fast' THEN 'fast' ELSE NULL END AS speed,
             COALESCE(long_context, 0) AS long_context,
             COUNT(*) AS requests,
             SUM(CASE WHEN pricing_model = '${UNPRICED_MODEL}' THEN 1 ELSE 0 END) AS unpriced_requests,
             COALESCE(SUM(${upstreamTokenSql('input_tokens')}), 0) AS input_tokens,
             COALESCE(SUM(output_tokens), 0) AS output_tokens,
             COALESCE(SUM(${upstreamTokenSql('cache_read_tokens')}), 0) AS cache_read_tokens,
             COALESCE(SUM(${upstreamTokenSql('cache_creation_tokens')}), 0) AS cache_creation_tokens,
             COALESCE(SUM(${UPSTREAM_PROMPT_TOKENS_SQL}), 0) AS prompt_tokens,
             ${usdSumSql('input_cost')} AS input_cost,
             ${usdSumSql('output_cost')} AS output_cost,
             ${usdSumSql('cache_read_cost')} AS cache_read_cost,
             ${usdSumSql('cache_creation_cost')} AS cache_creation_cost,
             ${usdSumSql('total_cost')} AS total_cost
      FROM usage_logs ${cond}
      GROUP BY 1, 2, 3, 4
      ORDER BY ${microsSumSql('total_cost')} DESC, requests DESC
      LIMIT 24
    `,
      ...params,
    )
    return rows.map((r) => ({
      model: r.model,
      service_tier: r.service_tier || null,
      speed: r.speed || null,
      long_context: Number(r.long_context || 0),
      requests: Number(r.requests || 0),
      unpriced_requests: Number(r.unpriced_requests || 0),
      input_tokens: Number(r.input_tokens || 0),
      output_tokens: Number(r.output_tokens || 0),
      cache_read_tokens: Number(r.cache_read_tokens || 0),
      cache_creation_tokens: Number(r.cache_creation_tokens || 0),
      prompt_tokens: Number(r.prompt_tokens || 0),
      input_cost: Number(r.input_cost || 0),
      output_cost: Number(r.output_cost || 0),
      cache_read_cost: Number(r.cache_read_cost || 0),
      cache_creation_cost: Number(r.cache_creation_cost || 0),
      total_cost: Number(r.total_cost || 0),
    }))
  }

  /**
   * Per-slot usage over the last `days` Shanghai calendar days (stats dialog).
   * Buckets are Shanghai days so the last bucket lines up with billingStats().today.
   * `models` / `endpoints` are ranked by request count and capped; `endpoints`
   * is the inbound request path (usage_logs keeps no separate upstream endpoint).
   */
  async vmUsageStats({ vmId, days = 30 } = {}) {
    return this._usageWindow({
      vmId,
      days,
      rankExpr: "COALESCE(NULLIF(path, ''), '—')",
      rankKey: 'endpoints',
      rankLimit: 8,
    })
  }

  /** Same window as vmUsageStats, isolated to one managed key. Third rank is the VM. */
  async keyUsageStats({ apiKeyId, days = 30 } = {}) {
    return this._usageWindow({
      apiKeyId,
      days,
      rankExpr: "COALESCE(NULLIF(vm_id, ''), '—')",
      rankKey: 'vms',
      rankLimit: 12,
    })
  }

  async _usageWindow({ vmId = null, apiKeyId = null, days = 30, rankExpr, rankKey, rankLimit = 8 } = {}) {
    const empty = { days: 0, since: null, history: [], models: [], [rankKey]: [] }
    if (!vmId && !apiKeyId) return empty
    const span = Math.max(1, Math.min(90, Math.floor(Number(days)) || 30))
    const since = new Date(Date.parse(shanghaiDayStartIso()) - (span - 1) * 86400_000).toISOString()
    const { cond, params } = filterCond({ since, vmId, apiKeyId })
    // Key 统计是客户视角（计费口径主列）；槽位统计是账号视角，读上游原始 token（119）
    const tok = (column) => (apiKeyId ? column : upstreamTokenSql(column))
    const history = (
      await this.client.many(
        `
      SELECT strftime('%Y-%m-%d', created_at, '+8 hours') AS day,
             COUNT(*) AS requests,
             SUM(CASE WHEN ${SLA_ERROR_PRED} THEN 1 ELSE 0 END) AS errors,
             COALESCE(SUM(${tok('input_tokens')}), 0) AS input_tokens,
             COALESCE(SUM(output_tokens), 0) AS output_tokens,
             COALESCE(SUM(${tok('cache_read_tokens')}), 0) AS cache_read_tokens,
             COALESCE(SUM(${tok('cache_creation_tokens')}), 0) AS cache_creation_tokens,
             COALESCE(SUM(${apiKeyId ? PROMPT_TOKENS_SQL : UPSTREAM_PROMPT_TOKENS_SQL}), 0) AS prompt_tokens,
             ${usdSumSql(apiKeyId ? 'actual_cost' : 'total_cost')} AS total_cost,
             COALESCE(SUM(duration_ms), 0) AS duration_ms_sum,
             SUM(CASE WHEN duration_ms IS NOT NULL THEN 1 ELSE 0 END) AS duration_n
      FROM usage_logs ${cond}
      GROUP BY day ORDER BY day
    `,
        ...params,
      )
    ).map((r) => ({
      day: r.day,
      requests: Number(r.requests || 0),
      errors: Number(r.errors || 0),
      input_tokens: Number(r.input_tokens || 0),
      output_tokens: Number(r.output_tokens || 0),
      cache_read_tokens: Number(r.cache_read_tokens || 0),
      cache_creation_tokens: Number(r.cache_creation_tokens || 0),
      prompt_tokens: Number(r.prompt_tokens || 0),
      total_cost: Number(r.total_cost || 0),
      duration_ms_sum: Number(r.duration_ms_sum || 0),
      duration_n: Number(r.duration_n || 0),
    }))
    const group = async (expr, limit) =>
      (
        await this.client.many(
          `
      SELECT ${expr} AS name,
             COUNT(*) AS requests,
             COALESCE(SUM(${apiKeyId ? TOTAL_TOKENS_SQL : UPSTREAM_TOTAL_TOKENS_SQL}), 0) AS tokens,
             ${microsSumSql(apiKeyId ? 'actual_cost' : 'total_cost')} AS total_cost_micros
      FROM usage_logs ${cond}
      GROUP BY name ORDER BY requests DESC, total_cost_micros DESC LIMIT ${limit}
    `,
          ...params,
        )
      ).map((r) => ({
        name: r.name,
        requests: Number(r.requests || 0),
        tokens: Number(r.tokens || 0),
        total_cost: fromMicros(Number(r.total_cost_micros || 0)),
      }))
    return {
      days: span,
      since,
      history,
      models: await group(
        "COALESCE(NULLIF(upstream_model, ''), NULLIF(model, ''), NULLIF(requested_model, ''), '—')",
        12,
      ),
      [rankKey]: await group(rankExpr, rankLimit),
    }
  }

  /**
   * Shanghai-day protocol gate: blocks, passes, and the words that blocked.
   * `total` is every inbound inference request (warmup answers included) plus
   * gate blocks on other paths, so each stage's share uses one denominator.
   */
  async protocolEntryStats({ since = shanghaiDayStartIso() } = {}) {
    // COALESCE: a bare `col = x` on NULL yields NULL, and `NOT NULL` drops the row.
    const block = `(
      COALESCE(error_code, '') = 'policy_blocked'
      OR COALESCE(via, '') IN ('hard-regex', 'jev', 'distill-detect', 'refusal-guard')
      OR COALESCE(final_state, '') IN ('policy_blocked', 'distill_blocked', 'refusal_guard', 'refusal_similar', 'refusal_device')
    )`
    const inference = `path IN ('/v1/messages', '/v1/responses', '/v1/chat/completions')`
    const row = await this.client.one(
      `SELECT
           SUM(CASE WHEN ${inference} OR ${block} THEN 1 ELSE 0 END) AS total,
           SUM(CASE WHEN ${block} THEN 1 ELSE 0 END) AS blocked,
           SUM(CASE WHEN ${inference}
                     AND NOT ${block}
                     AND COALESCE(via, '') != 'warmup-intercept'
                THEN 1 ELSE 0 END) AS passed
         FROM usage_logs
         WHERE created_at >= ?`,
      since,
    )
    const keywords = await this.client.many(
      `SELECT error_message AS message, COUNT(*) AS count
         FROM usage_logs
         WHERE created_at >= ?
           AND ${block}
           AND error_message IS NOT NULL
           AND error_message != ''
         GROUP BY error_message
         ORDER BY count DESC
         LIMIT 50`,
      since,
    )
    const grouped = await this.client.many(
      `SELECT intercept, via, error_message AS message,
                CASE WHEN ${block} THEN 1 ELSE 0 END AS blocked,
                COUNT(*) AS count
         FROM usage_logs
         WHERE created_at >= ?
           AND (
             ${block}
             OR (${inference} AND COALESCE(via, '') != 'warmup-intercept')
           )
         GROUP BY intercept, via, error_message, blocked`,
      since,
    )
    const folded = foldInterceptRows(grouped)
    return {
      since,
      total: Number(row?.total || 0),
      blocked: Number(row?.blocked || 0),
      passed: Number(row?.passed || 0),
      keywords: collapseBlockKeywords(keywords),
      blocks: folded.blocks,
      passes: folded.passes,
    }
  }

  /** Official-standard totals: all-time + Shanghai calendar today + per account. */
  async billingStats(opts = {}) {
    const { accountWindows = null, now = Date.now() } = opts
    const cacheable = !Object.hasOwn(opts, 'now')
    const cacheNow = Date.now()
    const key = billingStatsCacheKey(accountWindows)
    const cached = cacheable ? this._billingStatsCache.get(key) : null
    if (cached && cached.expires_at > cacheNow) return cached.value

    if (this._billingMaintenance) await this.maintainBillingCosts()

    const value = await this._computeBillingStats({ accountWindows, now })
    if (this._billingStatsCache.size >= 32) this._billingStatsCache.clear()
    if (cacheable) this._billingStatsCache.set(key, { value, expires_at: Date.now() + BILLING_STATS_CACHE_TTL_MS })
    return value
  }

  // The reporting worker runs the existing repair before its read transaction,
  // so all parts of a billing snapshot see the same committed database state.
  async maintainBillingCosts() {
    const cacheNow = Date.now()
    if (cacheNow - this._billingBackfillAt >= BILLING_BACKFILL_INTERVAL_MS) {
      this._billingBackfillAt = cacheNow
      try {
        if (await this.backfillMissingCosts()) this._billingStatsCache.clear()
      } catch {}
    }
  }

  async _computeBillingStats({ accountWindows = null, now = Date.now() } = {}) {
    const todayStart = shanghaiDayStartIso()
    const fiveHStart = new Date(now - WINDOW_5H_MS).toISOString()
    const sevenDStart = new Date(now - WINDOW_7D_MS).toISOString()
    const accountsTotal = await this.costByAccount()
    const accountsToday = await this.costByAccount({ since: todayStart })
    // The per-account queries already cover every row. Re-sum them for the
    // global buckets instead of scanning the entire usage table two more times.
    // This matters on multi-GB databases where each synchronous full scan also
    // blocks unrelated HTTP requests on the Node event loop.
    const totalBucket = sumCostBuckets(accountsTotal)
    const todayBucket = sumCostBuckets(accountsToday)
    const total = { ...totalBucket, ...cacheHitStats(totalBucket) }
    const today = { ...todayBucket, ...cacheHitStats(todayBucket) }
    const keyOf = (a) => a.account_id + '\0' + (a.vm_id || '')
    const todayById = new Map(accountsToday.map((a) => [keyOf(a), a]))
    const aligned = Array.isArray(accountWindows) && accountWindows.length > 0
    let eventsSince = sevenDStart
    if (aligned) {
      let earliest = Date.parse(sevenDStart)
      for (const win of accountWindows) {
        for (const [reset, dur] of [
          [win.reset_5h, WINDOW_5H_MS],
          [win.reset_7d, WINDOW_7D_MS],
          [win.reset_7d_oi, WINDOW_7D_MS],
        ]) {
          const start = extraWindowSince(reset, dur, now)
          if (start != null && start < earliest) earliest = start
        }
      }
      eventsSince = new Date(earliest).toISOString()
    }
    const fiveById = aligned
      ? null
      : new Map((await this.costByAccount({ since: fiveHStart })).map((a) => [keyOf(a), a]))
    const sevenById = aligned
      ? null
      : new Map((await this.costByAccount({ since: sevenDStart })).map((a) => [keyOf(a), a]))
    // Whole hours from the rollup; the hour each window starts in is read from usage_logs for that account only.
    const hoursByKey = aligned ? await this._rollupHoursByAccount(eventsSince) : null
    const coverage = await this.logCoverageStart()
    const coveredSince = Date.parse(coverage || '') || 0
    const forecast = (vmId, window) =>
      vmWindowForecast(this.db, { vmId, window, coveredSince, now, cache: this._forecastCache })
    const windowBucket = async (a, sinceMs, fableOnly = false) => {
      const edge = ceilHourMs(sinceMs)
      const edgeHour = hourKey(edge)
      const hours = (hoursByKey.get(keyOf(a)) || []).filter((r) => r.hour >= edgeHour && (!fableOnly || r.fable === 1))
      const edgeRows =
        edge > sinceMs
          ? (await this._costEventsForAccount(a, sinceMs, edge)).filter((row) => !fableOnly || isFableRow(row))
          : []
      return addRollupBuckets([...hours, bucketEventsSince(edgeRows, sinceMs)])
    }
    const accounts = []
    for (const a of accountsTotal) {
      const t = todayById.get(keyOf(a)) || emptyCostBucket()
      const win = aligned ? resolveAccountWindow(accountWindows, a) : null
      const since5 = aligned ? (extraWindowSince(win?.reset_5h, WINDOW_5H_MS, now) ?? Date.parse(fiveHStart)) : null
      const since7 = aligned ? (extraWindowSince(win?.reset_7d, WINDOW_7D_MS, now) ?? Date.parse(sevenDStart)) : null
      const w = aligned ? await windowBucket(a, since5) : fiveById.get(keyOf(a)) || emptyCostBucket()
      const w7 = aligned ? await windowBucket(a, since7) : sevenById.get(keyOf(a)) || emptyCostBucket()
      let window_fable = null
      if (aligned && win?.reset_7d_oi) {
        const sinceFable = extraWindowSince(win.reset_7d_oi, WINDOW_7D_MS, now) ?? Date.parse(sevenDStart)
        const fable = await windowBucket(a, sinceFable, true)
        window_fable = {
          cost: Number(fable.total_cost || 0),
          tokens: totalTokens(fable),
          requests: Number(fable.requests || 0),
          unpriced: Number(fable.unpriced || 0),
          start: new Date(sinceFable).toISOString(),
        }
      }
      accounts.push({
        ...a,
        today: { ...t },
        window_5h: { ...w },
        window_7d: { ...w7 },
        today_cost: Number(t.total_cost || 0),
        today_requests: Number(t.requests || 0),
        today_input_tokens: Number(t.input_tokens || 0),
        today_output_tokens: Number(t.output_tokens || 0),
        today_cache_read_tokens: Number(t.cache_read_tokens || 0),
        today_cache_creation_tokens: Number(t.cache_creation_tokens || 0),
        today_input_cost: Number(t.input_cost || 0),
        today_output_cost: Number(t.output_cost || 0),
        today_cache_cost: fromMicros((t.cache_read_cost_micros || 0) + (t.cache_creation_cost_micros || 0)),
        window_5h_cost: Number(w.total_cost || 0),
        window_5h_requests: Number(w.requests || 0),
        window_5h_tokens: totalTokens(w),
        window_5h_unpriced: Number(w.unpriced || 0),
        window_5h_input_tokens: Number(w.input_tokens || 0),
        window_5h_output_tokens: Number(w.output_tokens || 0),
        window_5h_cache_read_tokens: Number(w.cache_read_tokens || 0),
        window_5h_cache_creation_tokens: Number(w.cache_creation_tokens || 0),
        window_5h_input_cost: Number(w.input_cost || 0),
        window_5h_output_cost: Number(w.output_cost || 0),
        window_5h_cache_cost: fromMicros((w.cache_read_cost_micros || 0) + (w.cache_creation_cost_micros || 0)),
        window_5h_start: aligned ? new Date(since5).toISOString() : fiveHStart,
        window_7d_cost: Number(w7.total_cost || 0),
        window_7d_requests: Number(w7.requests || 0),
        window_7d_success: Number(w7.success || 0),
        window_7d_errors: Number(w7.errors || 0),
        window_7d_tokens: totalTokens(w7),
        window_7d_unpriced: Number(w7.unpriced || 0),
        window_7d_start: aligned ? new Date(since7).toISOString() : sevenDStart,
        window_fable,
        // Window capacity from the slot's used% history (codex-proxy-rs sampling); slot rows only.
        forecast_5h: aligned && a.vm_id ? await forecast(a.vm_id, '5h') : null,
        forecast_7d: aligned && a.vm_id ? await forecast(a.vm_id, '7d') : null,
        forecast_fable: window_fable && a.vm_id ? await forecast(a.vm_id, '7d_oi') : null,
      })
    }
    const window5h = aligned
      ? {
          ...sumCostBuckets(accounts.map((a) => a.window_5h)),
          ...cacheHitStats(sumCostBuckets(accounts.map((a) => a.window_5h))),
        }
      : rollingTotal(fiveById)
    const window7d = aligned
      ? {
          ...sumCostBuckets(accounts.map((a) => a.window_7d)),
          ...cacheHitStats(sumCostBuckets(accounts.map((a) => a.window_7d))),
        }
      : rollingTotal(sevenById)
    return {
      source: 'anthropic-official',
      currency: 'USD',
      today_start: todayStart,
      log_coverage_start: coverage,
      window_5h_start: aligned
        ? accounts.reduce((min, a) => (!min || a.window_5h_start < min ? a.window_5h_start : min), fiveHStart)
        : fiveHStart,
      window_7d_start: aligned
        ? accounts.reduce((min, a) => (!min || a.window_7d_start < min ? a.window_7d_start : min), sevenDStart)
        : sevenDStart,
      today,
      window_5h: window5h,
      window_7d: window7d,
      total,
      accounts,
    }
  }

  /**
   * Earliest instant whose traffic is still fully in usage_logs: the later of the DB's
   * creation (first migration) and the recorded prune boundary. Neither the oldest
   * surviving row (a quiet hour looks like a gap) nor the current retain_days (raising
   * it does not bring deleted rows back) can stand in for that boundary.
   */
  async logCoverageStart() {
    const created = Date.parse(
      (await this.client.one("SELECT MIN(applied_at) AS t FROM schema_migrations WHERE version = '001'"))?.t || '',
    )
    const pruned = Date.parse((await this._prunedThrough()) || '')
    const start = Math.max(Number.isFinite(created) ? created : -Infinity, Number.isFinite(pruned) ? pruned : -Infinity)
    return Number.isFinite(start) ? new Date(start).toISOString() : null
  }

  async _prunedThrough() {
    const row = await this.client.one(`SELECT value FROM settings WHERE key = '${PRUNED_THROUGH_KEY}'`)
    try {
      return row ? JSON.parse(row.value) : null
    } catch {
      return null
    }
  }

  /** Rollup hours since `since`, per billing account key, with the Fable flag kept apart. */
  async _rollupHoursByAccount(since) {
    const rows = await this.client.many(
      `SELECT account_key AS account_id, vm_ref AS vm_id, hour, fable, ${rollupMeasures(SLA_SUCCESS_PRED, SLA_ERROR_PRED)}
           FROM ${ROLLUP_SOURCE} WHERE hour >= ? GROUP BY account_key, vm_ref, hour, fable`,
      hourKey(new Date(since).getTime()),
    )
    const map = new Map()
    for (const row of rows) {
      const key = accountEventKey(row)
      const list = map.get(key) || []
      list.push(row)
      map.set(key, list)
    }
    return map
  }

  /** One billing account's rows in [sinceMs, untilMs) — the partial hour a quota window starts in. */
  async _costEventsForAccount(account, sinceMs, untilMs) {
    const vm = account.vm_id || ''
    return (
      await this.client.many(
        `
      SELECT
        ${BILLING_ACCOUNT_KEY_SQL} AS account_id,
        vm_id,
        created_at,
        model,
        upstream_model,
        pricing_model,
        CASE WHEN ${SLA_SUCCESS_PRED} THEN 1 ELSE 0 END AS success,
        CASE WHEN ${SLA_ERROR_PRED} THEN 1 ELSE 0 END AS errors,
        COALESCE(${upstreamTokenSql('input_tokens')}, 0) AS input_tokens,
        COALESCE(output_tokens, 0) AS output_tokens,
        COALESCE(${upstreamTokenSql('cache_read_tokens')}, 0) AS cache_read_tokens,
        COALESCE(${upstreamTokenSql('cache_creation_tokens')}, 0) AS cache_creation_tokens,
        (${UPSTREAM_PROMPT_TOKENS_SQL}) AS prompt_tokens,
        COALESCE(${moneySql('input_cost')}, 0) AS input_cost_micros,
        COALESCE(${moneySql('output_cost')}, 0) AS output_cost_micros,
        COALESCE(${moneySql('cache_read_cost')}, 0) AS cache_read_cost_micros,
        COALESCE(${moneySql('cache_creation_cost')}, 0) AS cache_creation_cost_micros,
        COALESCE(${moneySql('total_cost')}, 0) AS total_cost_micros
      FROM usage_logs
      WHERE ${BILLING_ACCOUNT_KEY_SQL} = ? AND created_at >= ? AND created_at < ?
    `,
        account.account_id,
        new Date(sinceMs).toISOString(),
        new Date(untilMs).toISOString(),
      )
    ).filter((row) => (row.vm_id || '') === vm)
  }

  async ownerBilling({ ownerUserId = null, since = null, until = null, groupBy = 'vm' } = {}) {
    const where = []
    const params = []
    const own = ownerPred(ownerUserId)
    if (own.sql) {
      where.push(own.sql)
      params.push(...own.params)
    }
    if (since) {
      where.push('created_at >= ?')
      params.push(new Date(since).toISOString())
    }
    if (until) {
      where.push('created_at <= ?')
      params.push(new Date(until).toISOString())
    }
    const cond = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const grouped = groupBy === 'key' ? 'key' : 'vm'
    const groupCol = grouped === 'key' ? 'api_key_id' : 'vm_id'
    const totals = await this.client.one(
      `
      SELECT COUNT(*) AS requests,
             SUM(CASE WHEN ${SUCCESS_PRED} THEN 1 ELSE 0 END) AS ok,
             SUM(CASE WHEN ${ERROR_PRED} THEN 1 ELSE 0 END) AS fail,
             COALESCE(SUM(${PROMPT_TOKENS_SQL}), 0) AS tokens_in,
             COALESCE(SUM(output_tokens), 0) AS tokens_out,
             COALESCE(SUM(COALESCE(${moneySql('actual_cost')}, ${moneySql('total_cost')}, 0)), 0) / 1000000.0 AS cost_usd,
             ${usdSumSql('total_cost')} AS official_cost_usd
      FROM usage_logs ${cond}
    `,
      ...params,
    )
    const items = await this.client.many(
      `
      SELECT ${groupCol} AS id,
             COUNT(*) AS requests,
             SUM(CASE WHEN ${SUCCESS_PRED} THEN 1 ELSE 0 END) AS ok,
             SUM(CASE WHEN ${ERROR_PRED} THEN 1 ELSE 0 END) AS fail,
             COALESCE(SUM(${PROMPT_TOKENS_SQL}), 0) AS tokens_in,
             COALESCE(SUM(output_tokens), 0) AS tokens_out,
             COALESCE(SUM(COALESCE(${moneySql('actual_cost')}, ${moneySql('total_cost')}, 0)), 0) / 1000000.0 AS cost_usd,
             ${usdSumSql('total_cost')} AS official_cost_usd
      FROM usage_logs ${cond}
      GROUP BY ${groupCol}
      ORDER BY cost_usd DESC
    `,
      ...params,
    )
    const num = (row, key) => Number(row?.[key] || 0)
    return {
      group_by: grouped,
      since: since ? new Date(since).toISOString() : null,
      until: until ? new Date(until).toISOString() : null,
      totals: {
        requests: num(totals, 'requests'),
        ok: num(totals, 'ok'),
        fail: num(totals, 'fail'),
        tokens_in: num(totals, 'tokens_in'),
        tokens_out: num(totals, 'tokens_out'),
        cost_usd: num(totals, 'cost_usd'),
        official_cost_usd: num(totals, 'official_cost_usd'),
      },
      items: items.map((row) => ({
        vm_id: grouped === 'vm' ? row.id || null : undefined,
        api_key_id: grouped === 'key' ? row.id || null : undefined,
        requests: num(row, 'requests'),
        ok: num(row, 'ok'),
        fail: num(row, 'fail'),
        tokens_in: num(row, 'tokens_in'),
        tokens_out: num(row, 'tokens_out'),
        cost_usd: num(row, 'cost_usd'),
        official_cost_usd: num(row, 'official_cost_usd'),
      })),
    }
  }

  /**
   * Windowed ops snapshot aligned with sub2api overview cards:
   * SLA / error / 429 / 503, QPS·TPS, duration + first_token percentiles, per-model.
   */
  async windowStats({ since = null, until = null, owner_user_id = null } = {}) {
    const { cond, params } = timeCond(since, until)
    const own = ownerPred(owner_user_id)
    let where = cond
    const allParams = [...params]
    if (own.sql) {
      where = where ? `${where} AND ${own.sql}` : `WHERE ${own.sql}`
      allParams.push(...own.params)
    }
    const counts = await this.client.one(
      `
      SELECT
        COUNT(*) AS requests,
        SUM(CASE WHEN ${SLA_SUCCESS_PRED} THEN 1 ELSE 0 END) AS success,
        SUM(CASE WHEN ${SLA_ERROR_PRED} THEN 1 ELSE 0 END) AS errors,
        SUM(CASE WHEN status = 429 THEN 1 ELSE 0 END) AS status_429,
        SUM(CASE WHEN status = 529 THEN 1 ELSE 0 END) AS status_529,
        SUM(CASE WHEN status = 503 THEN 1 ELSE 0 END) AS status_503,
        SUM(CASE WHEN stream = 1 THEN 1 ELSE 0 END) AS stream_requests,
        SUM(CASE WHEN first_token_ms IS NOT NULL THEN 1 ELSE 0 END) AS ttft_samples,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens,
        COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
        COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
        COALESCE(SUM(${PROMPT_TOKENS_SQL}), 0) AS prompt_tokens,
        ${usdSumSql('total_cost')} AS total_cost
      FROM usage_logs ${where}
    `,
      ...allParams,
    )
    const requests = Number(counts?.requests || 0)
    const success = Number(counts?.success || 0)
    const errors = Number(counts?.errors || 0)
    const inputTokens = Number(counts?.input_tokens || 0)
    const outputTokens = Number(counts?.output_tokens || 0)
    const cacheRead = Number(counts?.cache_read_tokens || 0)
    const cacheWrite = Number(counts?.cache_creation_tokens || 0)
    const cache = cacheHitStats({
      input_tokens: inputTokens,
      cache_read_tokens: cacheRead,
      cache_creation_tokens: cacheWrite,
      prompt_tokens: Number(counts?.prompt_tokens || 0),
    })
    const tokens = inputTokens + outputTokens + cacheRead + cacheWrite

    const startMs = since ? Date.parse(since) : null
    const endMs = until ? Date.parse(until) : Date.now()
    const windowSeconds =
      Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(1, (endMs - startMs) / 1000) : Math.max(1, requests)

    const minuteRows = await this.client.many(
      `
      SELECT strftime('%Y-%m-%dT%H:%M', created_at) AS minute,
             COUNT(*) AS requests,
             COALESCE(SUM(${TOTAL_TOKENS_SQL}), 0) AS tokens
      FROM usage_logs ${where}
      GROUP BY minute
    `,
      ...allParams,
    )
    const peakReq = minuteRows.reduce((m, r) => Math.max(m, Number(r.requests || 0)), 0)
    const peakTok = minuteRows.reduce((m, r) => Math.max(m, Number(r.tokens || 0)), 0)
    const lastMinute = minuteRows.length ? minuteRows[minuteRows.length - 1] : null

    const ttftWhere = where ? `${where} AND first_token_ms IS NOT NULL` : 'WHERE first_token_ms IS NOT NULL'
    const durWhere = where ? `${where} AND duration_ms IS NOT NULL` : 'WHERE duration_ms IS NOT NULL'
    const ttfts = (await this.client.many(`SELECT first_token_ms AS v FROM usage_logs ${ttftWhere}`, ...allParams)).map(
      (r) => r.v,
    )
    const durs = (await this.client.many(`SELECT duration_ms AS v FROM usage_logs ${durWhere}`, ...allParams)).map(
      (r) => r.v,
    )

    const byModel = await this.client.many(
      `
      SELECT COALESCE(NULLIF(upstream_model, ''), NULLIF(model, ''), '—') AS model,
             COUNT(*) AS requests,
             SUM(CASE WHEN ${SLA_ERROR_PRED} THEN 1 ELSE 0 END) AS errors,
             SUM(CASE WHEN first_token_ms IS NOT NULL THEN 1 ELSE 0 END) AS ttft_samples,
             CAST(AVG(first_token_ms) AS INTEGER) AS avg_first_token_ms,
             CAST(AVG(duration_ms) AS INTEGER) AS avg_duration_ms
      FROM usage_logs ${where}
      GROUP BY 1
      ORDER BY requests DESC
      LIMIT 12
    `,
      ...allParams,
    )

    return {
      since: since ? new Date(since).toISOString() : null,
      until: until ? new Date(until).toISOString() : new Date().toISOString(),
      window_seconds: Math.round(windowSeconds),
      requests,
      success,
      errors,
      sla: requests ? success / requests : 1,
      error_rate: requests ? errors / requests : 0,
      status_429: Number(counts?.status_429 || 0),
      status_529: Number(counts?.status_529 || 0),
      status_503: Number(counts?.status_503 || 0),
      stream_requests: Number(counts?.stream_requests || 0),
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_tokens: cacheRead,
      cache_creation_tokens: cacheWrite,
      prompt_tokens: cache.prompt_tokens,
      cache_hit_rate: cache.cache_hit_rate,
      sticky: await this._stickyWindow({ since, until, owner_user_id }),
      total_cost: Number(counts?.total_cost || 0),
      qps: {
        current: lastMinute ? Number(lastMinute.requests || 0) / 60 : 0,
        peak: peakReq / 60,
        avg: requests / windowSeconds,
      },
      tps: {
        current: lastMinute ? Number(lastMinute.tokens || 0) / 60 : 0,
        peak: peakTok / 60,
        avg: tokens / windowSeconds,
      },
      duration: summarizeLatency(durs),
      ttft: summarizeLatency(ttfts),
      by_model: byModel.map((r) => ({
        model: r.model,
        requests: Number(r.requests || 0),
        errors: Number(r.errors || 0),
        ttft_samples: Number(r.ttft_samples || 0),
        avg_first_token_ms: r.avg_first_token_ms ?? null,
        avg_duration_ms: r.avg_duration_ms ?? null,
      })),
      error_collection: await this.errorCollection({ since, until, owner_user_id }),
    }
  }

  async _stickyWindow({ since = null, until = null, owner_user_id = null } = {}) {
    const empty = { selections: 0, hits: 0, rate: null }
    try {
      const parts = []
      const params = []
      if (since) {
        parts.push('started_at >= ?')
        params.push(since)
      }
      if (until) {
        parts.push('started_at <= ?')
        params.push(until)
      }
      const own = ownerPred(owner_user_id)
      if (own.sql) {
        parts.push(`request_id IN (SELECT request_id FROM usage_logs WHERE ${own.sql})`)
        params.push(...own.params)
      }
      const where = parts.length ? `WHERE ${parts.join(' AND ')}` : ''
      const rows = await this.client.many(
        `
        SELECT selection_reason, COUNT(*) AS n
        FROM request_attempts ${where}
        GROUP BY 1
      `,
        ...params,
      )
      let selections = 0
      let hits = 0
      for (const row of rows) {
        const n = Number(row.n || 0)
        selections += n
        if (String(row.selection_reason || '') === 'sticky') hits += n
      }
      return {
        selections,
        hits,
        rate: selections > 0 ? hits / selections : null,
      }
    } catch {
      return empty
    }
  }

  async errorCollection({ since = null, until = null, owner_user_id = null } = {}) {
    const { cond, params } = timeCond(since, until)
    const own = ownerPred(owner_user_id)
    const errCond = `${cond ? `${cond} AND ` : 'WHERE '}${ERROR_PRED}${own.sql ? ` AND ${own.sql}` : ''}`
    const rows = await this.client.many(
      `
      SELECT created_at AS ts, request_id, status, error_code, error_message, model, upstream_model, vm_id, ip_address AS ip, api_key_presented
      FROM usage_logs ${errCond}
      ORDER BY created_at DESC, id DESC
      LIMIT 2000
    `,
      ...params,
      ...own.params,
    )
    return {
      ...collectErrors(rows),
      ingress_hits: await this.ingressHits({ since, until, owner_user_id }),
    }
  }

  /** Invalid-key 401s grouped by presented token + IP (still counted when muted). */
  async ingressHits({ since = null, until = null, owner_user_id = null } = {}) {
    const { cond, params } = timeCond(since, until)
    const own = ownerPred(owner_user_id)
    const authPred = own.sql ? `${ingressAuthSql()} AND ${own.sql}` : ingressAuthSql()
    const where = cond ? `${cond} AND ${authPred}` : `WHERE ${authPred}`
    try {
      return (
        await this.client.many(
          `
        SELECT
          COALESCE(api_key_presented, '') AS api_key_presented,
          COALESCE(ip_address, '') AS ip,
          COUNT(*) AS count,
          MAX(created_at) AS last_ts,
          MAX(error_code) AS error_code
        FROM usage_logs
        ${where}
        GROUP BY 1, 2
        ORDER BY count DESC
        LIMIT 40
      `,
          ...params,
          ...own.params,
        )
      ).map((row) => ({
        api_key_presented: row.api_key_presented || '',
        ip: row.ip || '',
        count: Number(row.count || 0),
        last_ts: row.last_ts || null,
        error_code: row.error_code || null,
      }))
    } catch {
      return []
    }
  }

  /**
   * Age out summaries/debug independently, then trim debug blobs to maxBytes.
   * Number form `cleanup(7)` keeps the old retainDays-only call.
   */
  async cleanup(opts = {}) {
    const cfg = this._cleanupOpts(opts)
    const usage_logs = await this._pruneUsage(cfg.usageCutoff)
    const debug_by_age = (await this.client.run(DELETE_OLD_DEBUG_SQL, cfg.debugCutoff)).changes
    const debug_by_size = await this.trimDebugToMaxBytes(cfg.maxBytes)
    if (usage_logs + debug_by_age + debug_by_size > 0) {
      try {
        await this.client.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      } catch {}
    }
    try {
      await this.client.exec('PRAGMA optimize')
    } catch {}
    return {
      usage_logs,
      request_log_debug: debug_by_age + debug_by_size,
      debug_by_age,
      debug_by_size,
    }
  }

  /** Delete summaries before `cutoff` and advance the prune boundary in one transaction. */
  async _pruneUsage(cutoff) {
    return this.client.tx(async (tx) => {
      const deleted = (await tx.run(DELETE_OLD_USAGE_SQL, cutoff)).changes
      if (deleted > 0) {
        const prev = await this._prunedThrough()
        if (!prev || prev < cutoff) {
          await tx.run(
            `
              INSERT INTO settings (key, value, updated_at) VALUES ('${PRUNED_THROUGH_KEY}', ?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
            `,
            JSON.stringify(cutoff),
            new Date().toISOString(),
          )
        }
      }
      return deleted
    })
  }

  _cleanupOpts(opts) {
    const raw = typeof opts === 'number' ? { retainDays: opts } : opts || {}
    const retainDays = Math.max(1, Number(raw.retainDays) || 7)
    let debugDays = Math.max(1, Number(raw.debugRetainDays) || 3)
    if (debugDays > retainDays) debugDays = retainDays
    return {
      usageCutoff: new Date(Date.now() - retainDays * 86400_000).toISOString(),
      debugCutoff: new Date(Date.now() - debugDays * 86400_000).toISOString(),
      maxBytes: Math.max(0, Number(raw.maxBytes) || 0),
    }
  }

  async debugBytes() {
    return Number((await this.client.one(DEBUG_BYTES_SQL)).n || 0)
  }

  async countDebug() {
    return Number((await this.client.one(DEBUG_COUNT_SQL)).n || 0)
  }

  /** Delete oldest debug rows until the stored JSON bytes fit maxBytes. */
  async trimDebugToMaxBytes(maxBytes) {
    const cap = Math.max(0, Number(maxBytes) || 0)
    if (cap <= 0) return 0
    let deleted = 0
    for (let i = 0; i < 8; i++) {
      const used = await this.debugBytes()
      if (used <= cap) return deleted
      const count = await this.countDebug()
      if (!count) return deleted
      const avg = Math.max(1, Math.floor(used / count))
      const need = Math.min(count, Math.max(1, Math.ceil((used - cap) / avg) + 1))
      const n = (await this.client.run(DELETE_OLDEST_DEBUG_SQL, need)).changes
      if (!n) return deleted
      deleted += n
    }
    return deleted
  }

  async count() {
    return (await this.client.one('SELECT COUNT(*) c FROM usage_logs')).c
  }
}

/** Transitional alias while callers migrate to the sub2api name. */
export { UsageLogsRepo as RequestLogsRepo }
