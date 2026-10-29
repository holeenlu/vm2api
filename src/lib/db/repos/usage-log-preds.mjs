/**
 * SQL predicates over `usage_logs` shared by every reader (legacy request-log
 * repo, scrolling log view, statistics). Columns are unqualified: callers query
 * `usage_logs` without joins and resolve display names separately.
 */

import { ignoredErrorSqlList, slaOkErrorSqlList } from '../../admin/error-class.mjs'

const IGNORED_CODES_SQL = ignoredErrorSqlList()
const SLA_OK_CODES_SQL = slaOkErrorSqlList()

export const ERROR_PRED = `(status >= 400 OR (error_code IS NOT NULL AND error_code != '' AND error_code NOT IN (${IGNORED_CODES_SQL})))`
export const SUCCESS_PRED = `(status < 400 AND (error_code IS NULL OR error_code = '' OR error_code IN (${IGNORED_CODES_SQL})))`
const SLA_OK_PRED = `(status = 429 OR (error_code IS NOT NULL AND error_code != '' AND error_code IN (${SLA_OK_CODES_SQL})))`
export const SLA_SUCCESS_PRED = `(${SUCCESS_PRED} OR ${SLA_OK_PRED})`
export const SLA_ERROR_PRED = `(${ERROR_PRED} AND NOT (${SLA_OK_PRED}))`

// After migration 037 every row stores disjoint input. Prompt (cache hit
// denominator) is the input-side total; total tokens also include output.
export const PROMPT_TOKENS_SQL =
  'IFNULL(input_tokens, 0) + IFNULL(cache_read_tokens, 0) + IFNULL(cache_creation_tokens, 0)'
export const TOTAL_TOKENS_SQL =
  'IFNULL(input_tokens, 0) + IFNULL(output_tokens, 0) + IFNULL(cache_read_tokens, 0) + IFNULL(cache_creation_tokens, 0)'

export function totalTokens(row = {}) {
  return (
    (Number(row.input_tokens) || 0) +
    (Number(row.output_tokens) || 0) +
    (Number(row.cache_read_tokens) || 0) +
    (Number(row.cache_creation_tokens) || 0)
  )
}

export const ADMIN_DOMAIN_IDS_SQL = `
  WITH RECURSIVE managed(id, role) AS (
    SELECT id, role FROM users WHERE id = ? AND deleted_at IS NULL
    UNION ALL
    SELECT u.id, u.role FROM users u JOIN managed m ON u.parent_user_id = m.id
    WHERE u.deleted_at IS NULL
  ) SELECT id FROM managed WHERE role IN ('admin', 'user')
`

/** Customer visibility is the immutable authenticated caller snapshot. */
export function ownerPred(ownerUserId) {
  if (ownerUserId?.type === 'panel_key_creator') {
    const id = String(ownerUserId.creatorId || '').trim()
    return id
      ? { sql: 'api_key_id IN (SELECT id FROM api_keys WHERE created_by_user_id = ?)', params: [id] }
      : { sql: '1 = 0', params: [] }
  }
  if (ownerUserId?.type === 'panel_admin_scope') {
    const id = String(ownerUserId.adminId || '').trim()
    const root = String(ownerUserId.scopeRootId || id).trim()
    return id
      ? {
          sql: `(user_id IN (${ADMIN_DOMAIN_IDS_SQL}) OR api_key_id IN (
            SELECT id FROM api_keys WHERE created_by_user_id IN (${ADMIN_DOMAIN_IDS_SQL})
          ))`,
          params: [root, root],
        }
      : { sql: '1 = 0', params: [] }
  }
  // Wallets/subscriptions have user_id, but no api_key_id. Keep their domain
  // predicate separate from usage attributed to a key's creator.
  if (ownerUserId?.type === 'panel_users') {
    const root = String(ownerUserId.scopeRootId || '').trim()
    if (!root) return { sql: '1 = 0', params: [] }
    const sql = `user_id IN (${ADMIN_DOMAIN_IDS_SQL})`
    return ownerUserId.userId
      ? { sql: `(${sql} AND user_id = ?)`, params: [root, ownerUserId.userId] }
      : { sql, params: [root] }
  }
  const id = String(ownerUserId || '').trim()
  return id ? { sql: 'user_id = ?', params: [id] } : { sql: '', params: [] }
}
