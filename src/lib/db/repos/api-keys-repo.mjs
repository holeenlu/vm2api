/**
 * api_keys repository — persistence for managed client API keys.
 * Pure SQL layer; business rules stay in lib/api-keys.mjs (ApiKeyStore).
 *
 * sub2api-shaped: user_id/group_id ownership, USD quota (quota/quota_used)
 * plus 5h/1d/7d USD rate-limit windows. The legacy request-count quota pair
 * is quota_requests / quota_requests_used. Soft delete via deleted_at.
 */

import { getDb } from '../database.mjs'
import { dbClient } from '../db-client.mjs'

const COLUMNS = [
  'id',
  'name',
  'key',
  'status',
  'max_concurrency',
  'quota_requests',
  'quota_requests_used',
  'rpm',
  'expires_at',
  'created_at',
  'updated_at',
  'last_used_at',
  'requests',
  'tokens_in',
  'tokens_out',
  'cache_read_tokens',
  'cache_creation_tokens',
  'key_hash',
  'key_prefix',
  'key_suffix',
  'category',
  'key_secret',
  'user_id',
  'group_id',
  'created_by_user_id',
  'quota',
  'quota_used',
  'rate_limit_5h',
  'rate_limit_1d',
  'rate_limit_7d',
  'usage_5h',
  'usage_1d',
  'usage_7d',
  'window_5h_start',
  'window_1d_start',
  'window_7d_start',
  'ip_whitelist',
  'ip_blacklist',
  'deleted_at',
  'peer_sharing',
  'codex_client_profile',
  'codex_route',
]

const WINDOWS = [
  { usage: 'usage_5h', start: 'window_5h_start', ms: 5 * 3600 * 1000 },
  { usage: 'usage_1d', start: 'window_1d_start', ms: 24 * 3600 * 1000 },
  { usage: 'usage_7d', start: 'window_7d_start', ms: 7 * 24 * 3600 * 1000 },
]

const NUMERIC_DEFAULT_0 = new Set([
  'quota_requests',
  'quota_requests_used',
  'requests',
  'tokens_in',
  'tokens_out',
  'quota',
  'quota_used',
  'rate_limit_5h',
  'rate_limit_1d',
  'rate_limit_7d',
  'usage_5h',
  'usage_1d',
  'usage_7d',
])

function rowToRec(row) {
  if (!row) return null
  return Object.fromEntries(COLUMNS.map((c) => [c, row[c]]))
}

function toValue(rec, c) {
  const v = rec[c]
  if (v == null) {
    if (c === 'category') return 'oauth'
    if (c === 'peer_sharing') return '{}'
    return NUMERIC_DEFAULT_0.has(c) ? 0 : null
  }
  return v
}

const LIST_SQL = 'SELECT * FROM api_keys WHERE deleted_at IS NULL ORDER BY created_at'
const GET_SQL = 'SELECT * FROM api_keys WHERE id = ? AND deleted_at IS NULL'
const GET_BY_KEY_SQL = 'SELECT * FROM api_keys WHERE key = ? AND deleted_at IS NULL'
const GET_BY_HASH_SQL = 'SELECT * FROM api_keys WHERE key_hash = ? AND deleted_at IS NULL'
const INSERT_SQL = `
      INSERT INTO api_keys (${COLUMNS.join(', ')})
      VALUES (${COLUMNS.map(() => '?').join(', ')})
    `
const UPDATE_COLUMNS = COLUMNS.filter((c) => c !== 'id')
const UPDATE_SQL = `UPDATE api_keys SET ${UPDATE_COLUMNS.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`
const DELETE_SQL =
  "UPDATE api_keys SET deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),status='disabled' WHERE id=? AND deleted_at IS NULL"
const RECORD_USAGE_SQL = `
      UPDATE api_keys SET
        requests = requests + 1,
        quota_requests_used = quota_requests_used + 1,
        tokens_in = tokens_in + ?,
        tokens_out = tokens_out + ?,
        cache_read_tokens = COALESCE(cache_read_tokens, 0) + ?,
        cache_creation_tokens = COALESCE(cache_creation_tokens, 0) + ?,
        quota_used = quota_used + ?,
        usage_5h = ?, window_5h_start = ?,
        usage_1d = ?, window_1d_start = ?,
        usage_7d = ?, window_7d_start = ?,
        last_used_at = ?,
        updated_at = ?
      WHERE id = ?
    `
// 竞态 R8：额度用尽的状态翻转是条件更新，只在仍为 active 且已用额度达到上限时改状态，不整行写回覆盖并发修改的其他字段
const MARK_QUOTA_EXHAUSTED_SQL =
  "UPDATE api_keys SET status='quota_exhausted', updated_at=? WHERE id=? AND deleted_at IS NULL AND status='active' AND quota>0 AND quota_used>=quota"

/** 数据访问经 DbClient 异步执行（R6 B7a）。 */
export class ApiKeysRepo {
  constructor(db = getDb()) {
    this.db = db
    this.client = dbClient(db)
  }

  async list() {
    return (await this.client.many(LIST_SQL)).map(rowToRec)
  }

  async getById(id) {
    return rowToRec(await this.client.one(GET_SQL, id))
  }

  async getByKey(key) {
    return rowToRec(await this.client.one(GET_BY_KEY_SQL, key))
  }

  async getByHash(hash) {
    return rowToRec(await this.client.one(GET_BY_HASH_SQL, hash))
  }

  async insert(rec) {
    await this.client.run(INSERT_SQL, ...COLUMNS.map((c) => toValue(rec, c)))
    return this.getById(rec.id)
  }

  /** Full-row update from a record object (id immutable). */
  async update(rec) {
    await this.client.run(UPDATE_SQL, ...UPDATE_COLUMNS.map((c) => toValue(rec, c)), rec.id)
    return this.getById(rec.id)
  }

  async remove(id) {
    return (await this.client.run(DELETE_SQL, id)).changes > 0
  }

  /**
   * Sub2api APIKey window semantics: a window opens at first spend; once
   * now - start >= size the window resets (usage=cost, start=now).
   */
  _rollWindow(rec, key, cost, nowMs) {
    const start = rec[key.start] ? Date.parse(rec[key.start]) : NaN
    if (!Number.isFinite(start) || nowMs - start >= key.ms) {
      return { usage: cost, start: new Date(nowMs).toISOString() }
    }
    return { usage: (Number(rec[key.usage]) || 0) + cost, start: rec[key.start] }
  }

  async recordUsage(
    id,
    { tokens_in = 0, tokens_out = 0, cache_read_tokens = 0, cache_creation_tokens = 0, cost = 0 } = {},
  ) {
    const rec = await this.getById(id)
    if (!rec) return null
    const nowMs = Date.now()
    const now = new Date(nowMs).toISOString()
    const usd = Number(cost) || 0
    const w = WINDOWS.map((win) => this._rollWindow(rec, win, usd, nowMs))
    await this.client.run(
      RECORD_USAGE_SQL,
      Number(tokens_in) || 0,
      Number(tokens_out) || 0,
      Number(cache_read_tokens) || 0,
      Number(cache_creation_tokens) || 0,
      usd,
      w[0].usage,
      w[0].start,
      w[1].usage,
      w[1].start,
      w[2].usage,
      w[2].start,
      now,
      now,
      id,
    )
    return this.getById(id)
  }

  /** 竞态 R8：USD 额度用尽时条件翻转为 quota_exhausted；返回是否改了状态。 */
  async markQuotaExhausted(id, now = new Date().toISOString()) {
    return (await this.client.run(MARK_QUOTA_EXHAUSTED_SQL, now, id)).changes > 0
  }

  async count() {
    return (await this.client.one('SELECT COUNT(*) c FROM api_keys WHERE deleted_at IS NULL')).c
  }
}
