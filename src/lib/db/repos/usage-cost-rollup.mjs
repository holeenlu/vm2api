/**
 * Readers over `usage_cost_hourly` (migration 093): whole hours come from the rollup,
 * the partial hour at a window's start from `usage_logs`. Results match a direct
 * `usage_logs` scan of the same span; success / error use the same usage-log-preds
 * predicates because the rollup keeps `status` / `error_code` as dimensions.
 */
import { UPSTREAM_PROMPT_TOKENS_SQL, UPSTREAM_TOTAL_TOKENS_SQL, upstreamTokenSql } from './usage-log-preds.mjs'
import { dbClient } from '../db-client.mjs'

export const HOUR_MS = 3_600_000
export const BILLING_ACCOUNT_KEY_SQL = "COALESCE(NULLIF(final_account_id, ''), NULLIF(account_id, ''), vm_id, '—')"

const round8 = (v) => Math.round((Number(v) || 0) * 1e8) / 1e8

export const hourKey = (ms) => new Date(ms).toISOString().slice(0, 13)
export const ceilHourMs = (ms) => Math.ceil(ms / HOUR_MS) * HOUR_MS

/** Rollup rows with usage_logs column semantics, so the shared predicates apply unchanged. */
export const ROLLUP_SOURCE = `(SELECT *, NULLIF(status_code, -1) AS status, NULLIF(vm_id, '') AS vm_ref,
  NULLIF(account_resource_id, '') AS resource_ref FROM usage_cost_hourly)`

export function rollupMeasures(successPred, errorPred) {
  return `
    SUM(requests) AS requests,
    SUM(CASE WHEN ${successPred} THEN requests ELSE 0 END) AS success,
    SUM(CASE WHEN ${errorPred} THEN requests ELSE 0 END) AS errors,
    SUM(input_tokens) AS input_tokens,
    SUM(output_tokens) AS output_tokens,
    SUM(cache_read_tokens) AS cache_read_tokens,
    SUM(cache_creation_tokens) AS cache_creation_tokens,
    SUM(input_tokens + cache_read_tokens + cache_creation_tokens) AS prompt_tokens,
    SUM(input_cost) AS input_cost,
    SUM(output_cost) AS output_cost,
    SUM(cache_read_cost) AS cache_read_cost,
    SUM(cache_creation_cost) AS cache_creation_cost,
    SUM(total_cost) AS total_cost,
    SUM(unpriced) AS unpriced`
}

export function rawMeasures(successPred, errorPred) {
  return `
    COUNT(*) AS requests,
    SUM(CASE WHEN ${successPred} THEN 1 ELSE 0 END) AS success,
    SUM(CASE WHEN ${errorPred} THEN 1 ELSE 0 END) AS errors,
    COALESCE(SUM(${upstreamTokenSql('input_tokens')}), 0) AS input_tokens,
    COALESCE(SUM(output_tokens), 0) AS output_tokens,
    COALESCE(SUM(${upstreamTokenSql('cache_read_tokens')}), 0) AS cache_read_tokens,
    COALESCE(SUM(${upstreamTokenSql('cache_creation_tokens')}), 0) AS cache_creation_tokens,
    COALESCE(SUM(${UPSTREAM_PROMPT_TOKENS_SQL}), 0) AS prompt_tokens,
    COALESCE(SUM(input_cost), 0) AS input_cost,
    COALESCE(SUM(output_cost), 0) AS output_cost,
    COALESCE(SUM(cache_read_cost), 0) AS cache_read_cost,
    COALESCE(SUM(cache_creation_cost), 0) AS cache_creation_cost,
    COALESCE(SUM(total_cost), 0) AS total_cost,
    COALESCE(SUM(CASE WHEN pricing_model = 'unpriced' AND (${UPSTREAM_TOTAL_TOKENS_SQL}) > 0 THEN 1 ELSE 0 END), 0) AS unpriced`
}

const COUNT_FIELDS = [
  'requests',
  'success',
  'errors',
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_creation_tokens',
  'prompt_tokens',
  'unpriced',
]
const COST_FIELDS = ['input_cost', 'output_cost', 'cache_read_cost', 'cache_creation_cost', 'total_cost']

export function emptyRollupBucket() {
  const out = {}
  for (const field of [...COUNT_FIELDS, ...COST_FIELDS]) out[field] = 0
  return out
}

/** Adds measure rows; rollup subtraction may leave float dust, so costs are rounded and floored at 0. */
export function addRollupBuckets(rows = []) {
  const out = emptyRollupBucket()
  for (const row of rows) {
    if (!row) continue
    for (const field of COUNT_FIELDS) out[field] += Number(row[field]) || 0
    for (const field of COST_FIELDS) out[field] += Number(row[field]) || 0
  }
  for (const field of COUNT_FIELDS) out[field] = Math.max(0, Math.round(out[field]))
  for (const field of COST_FIELDS) out[field] = Math.max(0, round8(out[field]))
  return out
}

/**
 * Sums usage at or after `sinceMs` per group. `rollup` / `raw` describe the same grouping
 * and filter over the two sources: `{ select, group, where, params }` with `select` /
 * `group` producing identical key columns, and `keyOf(row)` merging the two.
 * `sinceMs` null sums everything (rollup only).
 */
export async function windowSums(db, { sinceMs = null, rollup, raw, keyOf, successPred, errorPred }) {
  const groups = new Map()
  const take = (rows) => {
    for (const row of rows) {
      const key = keyOf(row)
      const list = groups.get(key) || []
      list.push(row)
      groups.set(key, list)
    }
  }
  const whereOf = (parts) => (parts.length ? `WHERE ${parts.join(' AND ')}` : '')
  const rollupWhere = rollup.where ? [rollup.where] : []
  const rollupParams = [...(rollup.params || [])]
  if (sinceMs != null) {
    const edge = ceilHourMs(sinceMs)
    rollupWhere.push('hour >= ?')
    rollupParams.push(hourKey(edge))
    if (edge > sinceMs) {
      const rawWhere = [...(raw.where ? [raw.where] : []), 'created_at >= ?', 'created_at < ?']
      take(
        await dbClient(db).many(
          `SELECT ${raw.select}, ${rawMeasures(successPred, errorPred)} FROM usage_logs ${whereOf(rawWhere)} GROUP BY ${raw.group}`,
          ...(raw.params || []),
          new Date(sinceMs).toISOString(),
          new Date(edge).toISOString(),
        ),
      )
    }
  }
  take(
    await dbClient(db).many(
      `SELECT ${rollup.select}, ${rollupMeasures(successPred, errorPred)} FROM ${ROLLUP_SOURCE} ${whereOf(rollupWhere)} GROUP BY ${rollup.group}`,
      ...rollupParams,
    ),
  )
  const out = new Map()
  for (const [key, rows] of groups) out.set(key, { ...rows[0], ...addRollupBuckets(rows) })
  return out
}
