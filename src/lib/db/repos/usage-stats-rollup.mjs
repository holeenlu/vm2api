/**
 * 统计页（`/api/panel/statistics*`）读汇总表（数据访问分层 R5，迁移 115 `usage_stats_hourly`）。
 *
 * 时间窗拆成三段：起点所在的不完整小时、中间的整小时、终点所在的不完整小时。整小时读汇总表，两端读 usage_logs，
 * 三段投影成同一形状后合并，再套用与原查询相同的归属谓词（ownerPred）与成败谓词（SUCCESS_PRED / ERROR_PRED）。
 * 结果与直接扫 usage_logs 一致（费用为浮点和，求和顺序不同可能有 1e-9 量级差异）。
 * 时间序列按 15 分钟槽分桶；桶边界不在整点时（非整小时时区）整段改用原查询。
 */
import { ERROR_PRED, PROMPT_TOKENS_SQL, SUCCESS_PRED, ownerPred } from './usage-log-preds.mjs'
import { StatisticsRepo } from './statistics-repo.mjs'
import { dbClient } from '../db-client.mjs'

const HOUR_MS = 3_600_000
const hourKey = (ms) => new Date(ms).toISOString().slice(0, 13)
const iso = (ms) => new Date(ms).toISOString()

// 与 statistics-repo 的 SLOT_SQL 相同：created_at 落到所在的 15 分钟 UTC 槽
const RAW_SLOT_SQL =
  "substr(created_at, 1, 14) || printf('%02d', (CAST(substr(created_at, 15, 2) AS INTEGER) / 15) * 15)"

const COLUMNS = `user_id, api_key_id, model, vm_id, billing_group_id, path, status, error_code,
  requests, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost,
  duration_sum, duration_n, ttft_sum, ttft_n`

const RAW_PART = `SELECT ${RAW_SLOT_SQL} AS slot, user_id, api_key_id, model, vm_id, billing_group_id, path, status, error_code,
  1 AS requests, IFNULL(input_tokens, 0) AS input_tokens, IFNULL(output_tokens, 0) AS output_tokens,
  IFNULL(cache_read_tokens, 0) AS cache_read_tokens, IFNULL(cache_creation_tokens, 0) AS cache_creation_tokens,
  IFNULL(actual_cost, 0) AS cost,
  IFNULL(duration_ms, 0) AS duration_sum, CASE WHEN duration_ms IS NULL THEN 0 ELSE 1 END AS duration_n,
  IFNULL(first_token_ms, 0) AS ttft_sum, CASE WHEN first_token_ms IS NULL THEN 0 ELSE 1 END AS ttft_n
  FROM usage_logs WHERE created_at >= ? AND created_at < ?`

const ROLLUP_PART = `SELECT hour || ':00' AS slot, NULLIF(user_id, '') AS user_id, NULLIF(api_key_id, '') AS api_key_id,
  NULLIF(model, '') AS model, NULLIF(vm_id, '') AS vm_id, NULLIF(billing_group_id, -1) AS billing_group_id,
  NULLIF(path, '') AS path, NULLIF(status_code, -1) AS status, NULLIF(error_code, '') AS error_code,
  requests, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost,
  duration_sum, duration_n, ttft_sum, ttft_n
  FROM usage_stats_hourly WHERE hour >= ? AND hour < ?`

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

/** 窗口内的数据源（统一列）与参数；ownerUserId 的谓词套在外层，列名与 usage_logs 相同。 */
export function statsSource(since, until, ownerUserId) {
  const { raw, hours } = splitWindow(since, until)
  const parts = []
  const params = []
  for (const [from, to] of raw) {
    parts.push(RAW_PART)
    params.push(iso(from), iso(to))
  }
  if (hours) {
    parts.push(ROLLUP_PART)
    params.push(hourKey(hours[0]), hourKey(hours[1]))
  }
  const own = ownerPred(ownerUserId)
  const where = own.sql ? `WHERE ${own.sql}` : ''
  return {
    sql: `(SELECT ${COLUMNS}, slot FROM (${parts.join(' UNION ALL ')}) ${where})`,
    params: [...params, ...own.params],
  }
}

const TOKENS = 'input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens'
const PROMPT = PROMPT_TOKENS_SQL.replace(/IFNULL\((\w+), 0\)/g, '$1')
const weighted = (pred) => `COALESCE(SUM(CASE WHEN ${pred} THEN requests ELSE 0 END), 0)`

export class RollupStatisticsRepo extends StatisticsRepo {
  async _totalsRow(since, until, ownerUserId) {
    const source = statsSource(since, until, ownerUserId)
    return dbClient(this.db).one(
      `
      SELECT COALESCE(SUM(requests), 0) AS requests,
             ${weighted(ERROR_PRED)} AS errors,
             COALESCE(SUM(cost), 0) AS cost,
             COALESCE(SUM(cost), 0) AS actual_cost,
             COALESCE(SUM(input_tokens), 0) AS input_tokens,
             COALESCE(SUM(output_tokens), 0) AS output_tokens,
             COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
             COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
             COALESCE(SUM(${PROMPT}), 0) AS prompt_tokens,
             SUM(duration_sum) / NULLIF(SUM(duration_n), 0) AS avg_duration_ms,
             SUM(ttft_sum) / NULLIF(SUM(ttft_n), 0) AS avg_ttft_ms
      FROM ${source.sql}
    `,
      ...source.params,
    )
  }

  async _seriesRows(col, since, until, ownerUserId, buckets) {
    // 汇总行以整点为槽：只有所有桶边界都在整点时才能按小时归桶
    if (!buckets.every((t) => t % HOUR_MS === 0)) return super._seriesRows(col, since, until, ownerUserId, buckets)
    const source = statsSource(since, until, ownerUserId)
    return dbClient(this.db).many(
      `
      SELECT ${col} AS sid, slot,
             COALESCE(SUM(requests), 0) AS requests,
             COALESCE(SUM(cost), 0) AS cost,
             COALESCE(SUM(${TOKENS}), 0) AS tokens
      FROM ${source.sql}
      GROUP BY sid, slot
    `,
      ...source.params,
    )
  }

  async _leaderboardRows(col, since, until, ownerUserId, limit) {
    const source = statsSource(since, until, ownerUserId)
    return dbClient(this.db).many(
      `
      SELECT ${col} AS sid,
             COALESCE(SUM(requests), 0) AS requests,
             ${weighted(SUCCESS_PRED)} AS success,
             ${weighted(ERROR_PRED)} AS errors,
             COALESCE(SUM(input_tokens), 0) AS input_tokens,
             COALESCE(SUM(output_tokens), 0) AS output_tokens,
             COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
             COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
             COALESCE(SUM(${PROMPT}), 0) AS prompt_tokens,
             COALESCE(SUM(cost), 0) AS cost,
             COALESCE(SUM(cost), 0) AS actual_cost,
             SUM(duration_sum) / NULLIF(SUM(duration_n), 0) AS avg_duration_ms,
             SUM(ttft_sum) / NULLIF(SUM(ttft_n), 0) AS avg_ttft_ms
      FROM ${source.sql}
      GROUP BY IFNULL(${col}, '')
      ORDER BY cost DESC, requests DESC
      LIMIT ?
    `,
      ...source.params,
      limit,
    )
  }
}
