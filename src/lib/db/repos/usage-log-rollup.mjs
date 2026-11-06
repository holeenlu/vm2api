/**
 * 小时汇总表 `usage_stats_hourly`（迁移 115、123）的统一数据源与使用记录页的汇总读取（数据访问分层 R5、技术债 M5）。
 *
 * 时间窗拆成三段：起点所在的不完整小时、中间的整小时、终点所在的不完整小时。整小时读汇总表，两端读 usage_logs，
 * 三段投影成同一形状（列名与 usage_logs 相同）后合并，再在外层套用调用方的谓词（归属、成败、屏蔽 auth 等只读维度列的条件）。
 * 统计页（RollupStatisticsRepo，usage-stats-rollup.mjs）与使用记录页（UsageLogsView 的 summary / ranking / overview）共用。
 */
import { ERROR_PRED, PROMPT_TOKENS_SQL, SUCCESS_PRED, ownerPred } from './usage-log-preds.mjs'
import { dbClient } from '../db-client.mjs'
import { moneySql } from './money-sql.mjs'

export const HOUR_MS = 3_600_000
const hourKey = (ms) => new Date(ms).toISOString().slice(0, 13)
const iso = (ms) => new Date(ms).toISOString()

// 与 statistics-repo 的 SLOT_SQL 相同：created_at 落到所在的 15 分钟 UTC 槽
const RAW_SLOT_SQL =
  "substr(created_at, 1, 14) || printf('%02d', (CAST(substr(created_at, 15, 2) AS INTEGER) / 15) * 15)"

const COLUMNS = `user_id, api_key_id, model, vm_id, billing_group_id, path, status, error_code,
  requests, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
  cache_creation_5m_tokens, cache_creation_1h_tokens, cost_micros, cost_n,
  duration_sum, duration_n, ttft_sum, ttft_n`

// 两段投影成同一形状：维度列名与 usage_logs 相同，谓词（ownerPred、SUCCESS_PRED / ERROR_PRED、屏蔽 auth）原样可用
const RAW_SELECT = `SELECT ${RAW_SLOT_SQL} AS slot, user_id, api_key_id, model, vm_id, billing_group_id, path, status, error_code,
  1 AS requests, IFNULL(input_tokens, 0) AS input_tokens, IFNULL(output_tokens, 0) AS output_tokens,
  IFNULL(cache_read_tokens, 0) AS cache_read_tokens, IFNULL(cache_creation_tokens, 0) AS cache_creation_tokens,
  IFNULL(cache_creation_5m_tokens, 0) AS cache_creation_5m_tokens,
  IFNULL(cache_creation_1h_tokens, 0) AS cache_creation_1h_tokens,
  IFNULL(${moneySql('actual_cost')}, 0) AS cost_micros, CASE WHEN ${moneySql('actual_cost')} IS NULL THEN 0 ELSE 1 END AS cost_n,
  IFNULL(duration_ms, 0) AS duration_sum, CASE WHEN duration_ms IS NULL THEN 0 ELSE 1 END AS duration_n,
  IFNULL(first_token_ms, 0) AS ttft_sum, CASE WHEN first_token_ms IS NULL THEN 0 ELSE 1 END AS ttft_n
  FROM usage_logs`

const ROLLUP_SELECT = `SELECT hour || ':00' AS slot, NULLIF(user_id, '') AS user_id, NULLIF(api_key_id, '') AS api_key_id,
  NULLIF(model, '') AS model, NULLIF(vm_id, '') AS vm_id, NULLIF(billing_group_id, -1) AS billing_group_id,
  NULLIF(path, '') AS path, NULLIF(status_code, -1) AS status, NULLIF(error_code, '') AS error_code,
  requests, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
  cache_creation_5m_tokens, cache_creation_1h_tokens, cost_micros, cost_n,
  duration_sum, duration_n, ttft_sum, ttft_n
  FROM usage_stats_hourly`

/** [since, until) 拆成（起点不完整小时）+ 整小时 + （终点不完整小时）。 */
export function splitWindow(since, until) {
  const fullFrom = Math.ceil(since / HOUR_MS) * HOUR_MS
  const fullTo = Math.floor(until / HOUR_MS) * HOUR_MS
  if (fullFrom >= fullTo) return { raw: [[since, until]], hours: null }
  const raw = []
  if (since < fullFrom) raw.push([since, fullFrom])
  if (fullTo < until) raw.push([fullTo, until])
  return { raw, hours: [fullFrom, fullTo] }
}

/**
 * 时间窗 [since, until)（毫秒，任一端可为 null 表示不限）内的统一数据源：不完整小时读 usage_logs，整小时读汇总表。
 * 一端不限时，那一端没有不完整小时，整段读汇总表（汇总表由触发器维护，含当前小时）。
 * where / params 是只引用汇总维度列（user_id、api_key_id、vm_id、status、error_code 等）的谓词，套在合并结果外层。
 */
export function rollupSource({ since = null, until = null, where = [], params: whereParams = [] } = {}) {
  const parts = []
  const params = []
  const raw = (from, to) => {
    parts.push(`${RAW_SELECT} WHERE created_at >= ? AND created_at < ?`)
    params.push(iso(from), iso(to))
  }
  const hours = (from, to) => {
    const cond = []
    if (from != null) {
      cond.push('hour >= ?')
      params.push(hourKey(from))
    }
    if (to != null) {
      cond.push('hour < ?')
      params.push(hourKey(to))
    }
    parts.push(cond.length ? `${ROLLUP_SELECT} WHERE ${cond.join(' AND ')}` : ROLLUP_SELECT)
  }
  if (since != null && until != null) {
    const split = splitWindow(since, until)
    for (const [from, to] of split.raw) raw(from, to)
    if (split.hours) hours(split.hours[0], split.hours[1])
  } else if (since != null) {
    const fullFrom = Math.ceil(since / HOUR_MS) * HOUR_MS
    if (since < fullFrom) raw(since, fullFrom)
    hours(fullFrom, null)
  } else if (until != null) {
    const fullTo = Math.floor(until / HOUR_MS) * HOUR_MS
    hours(null, fullTo)
    if (fullTo < until) raw(fullTo, until)
  } else hours(null, null)
  const preds = where.filter(Boolean)
  const outer = preds.length ? `WHERE ${preds.join(' AND ')}` : ''
  return {
    sql: `(SELECT ${COLUMNS}, slot FROM (${parts.join(' UNION ALL ')}) ${outer})`,
    params: [...params, ...whereParams],
  }
}

/** 窗口内的数据源（统一列）与参数；ownerUserId 的谓词套在外层，列名与 usage_logs 相同。 */
export function statsSource(since, until, ownerUserId) {
  const own = ownerPred(ownerUserId)
  return rollupSource({ since, until, where: [own.sql], params: own.params })
}

export const TOKENS = 'input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens'
export const PROMPT = PROMPT_TOKENS_SQL.replace(/IFNULL\((\w+), 0\)/g, '$1')
export const weighted = (pred) => `COALESCE(SUM(CASE WHEN ${pred} THEN requests ELSE 0 END), 0)`
// 窗口全在不完整小时内时两列都是整数和，SQLite 整数相除会截断；乘 1.0 与 AVG(duration_ms) 一致
export const AVG_DURATION = 'SUM(duration_sum) * 1.0 / NULLIF(SUM(duration_n), 0)'
export const AVG_TTFT = 'SUM(ttft_sum) * 1.0 / NULLIF(SUM(ttft_n), 0)'

/**
 * 使用记录页（`/api/panel/usage-logs/summary|ranking|overview`）的汇总读取（技术债 M5）。source 由 rollupSource 构造；
 * 列与 UsageLogsView 逐行扫描路径的 SQL 一一对应，一致性测试见 test/unit/usage-logs-rollup.test.mjs。
 */
export async function rollupLogSummaryRow(db, source) {
  return dbClient(db).one(
    `
    SELECT COALESCE(SUM(requests), 0) AS requests,
           ${weighted(SUCCESS_PRED)} AS success,
           ${weighted(ERROR_PRED)} AS errors,
           COALESCE(SUM(cost_micros), 0) AS cost_micros,
           COALESCE(SUM(input_tokens), 0) AS input_tokens,
           COALESCE(SUM(output_tokens), 0) AS output_tokens,
           COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
           COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
           COALESCE(SUM(cache_creation_5m_tokens), 0) AS cache_creation_5m_tokens,
           COALESCE(SUM(cache_creation_1h_tokens), 0) AS cache_creation_1h_tokens,
           COALESCE(SUM(${PROMPT}), 0) AS prompt_tokens,
           ${AVG_DURATION} AS avg_duration_ms,
           ${AVG_TTFT} AS avg_ttft_ms
    FROM ${source.sql}
  `,
    ...source.params,
  )
}

/** 排行的分组行：col 为 `api_key_id` 或 `user_id`；空归属不参与排行。owner_id 取该组最大的 user_id。 */
export async function rollupLogRankingRows(db, source, col) {
  return dbClient(db).many(
    `
    SELECT ${col} AS id,
           MAX(user_id) AS owner_id,
           COALESCE(SUM(requests), 0) AS requests,
           COALESCE(SUM(${TOKENS}), 0) AS tokens,
           COALESCE(SUM(cost_micros), 0) AS cost_micros,
           COALESCE(SUM(cost_n), 0) AS cost_n
    FROM ${source.sql}
    WHERE ${col} IS NOT NULL AND ${col} != ''
    GROUP BY ${col}
  `,
    ...source.params,
  )
}
