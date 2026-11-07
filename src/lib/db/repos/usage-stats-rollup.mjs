/**
 * 统计页（`/api/panel/statistics*`）读汇总表（数据访问分层 R5，迁移 115 `usage_stats_hourly`）。
 *
 * 时间窗拆成三段：起点所在的不完整小时、中间的整小时、终点所在的不完整小时。整小时读汇总表，两端读 usage_logs，
 * 三段投影成同一形状后合并，再套用与原查询相同的归属谓词（ownerPred）与成败谓词（SUCCESS_PRED / ERROR_PRED）。
 * 结果与直接扫 usage_logs 逐项相同（M6 起费用是整数微单位之和，不再有浮点求和顺序差异）。
 * 时间序列按 15 分钟槽分桶；桶边界不在整点时（非整小时时区）整段改用原查询。
 */
import { SUCCESS_PRED, ERROR_PRED } from './usage-log-preds.mjs'
import { StatisticsRepo } from './statistics-repo.mjs'
import { dbClient } from '../db-client.mjs'
import { AVG_DURATION, AVG_TTFT, HOUR_MS, PROMPT, TOKENS, statsSource, weighted } from './usage-log-rollup.mjs'

export { splitWindow, statsSource } from './usage-log-rollup.mjs'

export class RollupStatisticsRepo extends StatisticsRepo {
  async _totalsRow(since, until, ownerUserId) {
    const source = statsSource(since, until, ownerUserId)
    return dbClient(this.db).one(
      `
      SELECT COALESCE(SUM(requests), 0) AS requests,
             ${weighted(ERROR_PRED)} AS errors,
             COALESCE(SUM(cost_micros), 0) AS cost_micros,
             COALESCE(SUM(input_tokens), 0) AS input_tokens,
             COALESCE(SUM(output_tokens), 0) AS output_tokens,
             COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
             COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
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

  async _seriesRows(col, since, until, ownerUserId, buckets, extra = null) {
    // 汇总行以整点为槽：只有所有桶边界都在整点时才能按小时归桶
    if (!buckets.every((t) => t % HOUR_MS === 0))
      return super._seriesRows(col, since, until, ownerUserId, buckets, extra)
    const source = statsSource(since, until, ownerUserId, extra)
    return dbClient(this.db).many(
      `
      SELECT ${col} AS sid, slot,
             COALESCE(SUM(requests), 0) AS requests,
             COALESCE(SUM(cost_micros), 0) AS cost_micros,
             COALESCE(SUM(${TOKENS}), 0) AS tokens
      FROM ${source.sql}
      GROUP BY sid, slot
    `,
      ...source.params,
    )
  }

  async _leaderboardRows(col, since, until, ownerUserId, limit, extra = null) {
    const source = statsSource(since, until, ownerUserId, extra)
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
             COALESCE(SUM(cache_creation_5m_tokens), 0) AS cache_creation_5m_tokens,
             COALESCE(SUM(cache_creation_1h_tokens), 0) AS cache_creation_1h_tokens,
             COALESCE(SUM(${PROMPT}), 0) AS prompt_tokens,
             COALESCE(SUM(cost_micros), 0) AS cost_micros,
             ${AVG_DURATION} AS avg_duration_ms,
             ${AVG_TTFT} AS avg_ttft_ms
      FROM ${source.sql}
      GROUP BY IFNULL(${col}, '')
      ORDER BY cost_micros DESC, requests DESC
      ${limit == null ? '' : 'LIMIT ?'}
    `,
      ...source.params,
      ...(limit == null ? [] : [limit]),
    )
  }
}
