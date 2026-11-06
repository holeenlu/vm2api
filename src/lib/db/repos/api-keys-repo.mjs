/**
 * api_keys repository — persistence for managed client API keys.
 * Pure SQL layer; business rules stay in lib/api-keys.mjs (ApiKeyStore).
 *
 * sub2api-shaped: user_id/group_id ownership, USD quota (quota/quota_used)
 * plus 5h/1d/7d USD rate-limit windows. The legacy request-count quota pair
 * is quota_requests / quota_requests_used. Soft delete via deleted_at.
 *
 * M6：USD 额度、窗口上限与用量的权威值是 `*_micros` 整数列；REAL 列（quota、usage_5h…）是镜像，
 * 每次写入都由整数派生同时写。记录对象同时带两种字段，业务判断一律比较 `*_micros`。
 */

import { getDb } from '../database.mjs'
import { dbClient } from '../db-client.mjs'
import { MAX_MONEY_MICROS, fromMicros, microsOf, rowMicros, toMicros } from '../../core/money.mjs'
import { moneySql } from './money-sql.mjs'

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

/** USD 金额列（REAL 镜像）；对应的 `<name>_micros` 是权威值。 */
export const KEY_MONEY_COLUMNS = [
  'quota',
  'quota_used',
  'rate_limit_5h',
  'rate_limit_1d',
  'rate_limit_7d',
  'usage_5h',
  'usage_1d',
  'usage_7d',
]
const WRITE_COLUMNS = [...COLUMNS, ...KEY_MONEY_COLUMNS.map((c) => c + '_micros')]

const WINDOWS = [
  { usage: 'usage_5h', start: 'window_5h_start', ms: 5 * 3600 * 1000 },
  { usage: 'usage_1d', start: 'window_1d_start', ms: 24 * 3600 * 1000 },
  { usage: 'usage_7d', start: 'window_7d_start', ms: 7 * 24 * 3600 * 1000 },
]

const NUMERIC_DEFAULT_0 = new Set(['quota_requests', 'quota_requests_used', 'requests', 'tokens_in', 'tokens_out'])

function rowToRec(row) {
  if (!row) return null
  const rec = Object.fromEntries(COLUMNS.map((c) => [c, row[c]]))
  for (const c of KEY_MONEY_COLUMNS) {
    // 整数列为 NULL 只会是只写 REAL 的旧写入方留下的行：按 REAL 派生（与 money-sql.mjs 同口径）
    const micros = rowMicros(row, c) ?? 0
    rec[c + '_micros'] = micros
    rec[c] = fromMicros(micros)
  }
  return rec
}

/** 记录里的金额：有 `*_micros` 用它，否则（调用方只给了美元值）在这里换算一次。 */
function moneyMicrosOf(rec, c) {
  const micros = microsOf(rec[c + '_micros'])
  if (micros != null) return micros
  return Math.max(0, toMicros(rec[c]) ?? 0)
}

function toValue(rec, c) {
  if (c.endsWith('_micros')) return moneyMicrosOf(rec, c.slice(0, -7))
  if (KEY_MONEY_COLUMNS.includes(c)) return fromMicros(moneyMicrosOf(rec, c))
  const v = rec[c]
  if (v == null) {
    if (c === 'category') return 'oauth'
    if (c === 'peer_sharing') return '{}'
    return NUMERIC_DEFAULT_0.has(c) ? 0 : null
  }
  return v
}

// 读取列：整数金额超出有效范围（|micros| > MAX_MONEY_MICROS，node:sqlite 读超过 2^53 的整数会整条语句抛错）时按 NULL 读，
// rowToRec 再按 REAL 回退（同样越界时按 0，即“不限”）。正常数据不会越界（迁移 126 与写入方都已限制），这里保证认证不被拖垮。
const SELECT_COLUMNS = [
  ...COLUMNS,
  ...KEY_MONEY_COLUMNS.map(
    (c) =>
      `CASE WHEN ${c}_micros BETWEEN -${MAX_MONEY_MICROS} AND ${MAX_MONEY_MICROS} THEN ${c}_micros END AS ${c}_micros`,
  ),
].join(', ')
const LIST_SQL = `SELECT ${SELECT_COLUMNS} FROM api_keys WHERE deleted_at IS NULL ORDER BY created_at`
const GET_SQL = `SELECT ${SELECT_COLUMNS} FROM api_keys WHERE id = ? AND deleted_at IS NULL`
const GET_BY_KEY_SQL = `SELECT ${SELECT_COLUMNS} FROM api_keys WHERE key = ? AND deleted_at IS NULL`
const GET_BY_HASH_SQL = `SELECT ${SELECT_COLUMNS} FROM api_keys WHERE key_hash = ? AND deleted_at IS NULL`
const INSERT_SQL = `
      INSERT INTO api_keys (${WRITE_COLUMNS.join(', ')})
      VALUES (${WRITE_COLUMNS.map(() => '?').join(', ')})
    `
const UPDATE_COLUMNS = WRITE_COLUMNS.filter((c) => c !== 'id')
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
        quota_used_micros = IFNULL(${moneySql('quota_used')}, 0) + ?,
        quota_used = (IFNULL(${moneySql('quota_used')}, 0) + ?) / 1000000.0,
        usage_5h_micros = ?, usage_5h = ?, window_5h_start = ?,
        usage_1d_micros = ?, usage_1d = ?, window_1d_start = ?,
        usage_7d_micros = ?, usage_7d = ?, window_7d_start = ?,
        last_used_at = ?,
        updated_at = ?
      WHERE id = ?
    `
// 竞态 R8：额度用尽的状态翻转是条件更新，只在仍为 active 且已用额度达到上限时改状态，不整行写回覆盖并发修改的其他字段
const MARK_QUOTA_EXHAUSTED_SQL = `UPDATE api_keys SET status='quota_exhausted', updated_at=? WHERE id=? AND deleted_at IS NULL AND status='active' AND ${moneySql('quota')}>0 AND ${moneySql('quota_used')}>=${moneySql('quota')}`

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
    await this.client.run(INSERT_SQL, ...WRITE_COLUMNS.map((c) => toValue(rec, c)))
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
   * now - start >= size the window resets (usage=cost, start=now). 金额为整数微单位。
   */
  _rollWindow(rec, key, costMicros, nowMs) {
    const start = rec[key.start] ? Date.parse(rec[key.start]) : NaN
    if (!Number.isFinite(start) || nowMs - start >= key.ms) {
      return { usage: costMicros, start: new Date(nowMs).toISOString() }
    }
    return { usage: (rec[key.usage + '_micros'] || 0) + costMicros, start: rec[key.start] }
  }

  /** `cost_micros`：本次实际扣费（整数微单位）。 */
  async recordUsage(
    id,
    { tokens_in = 0, tokens_out = 0, cache_read_tokens = 0, cache_creation_tokens = 0, cost_micros = 0 } = {},
  ) {
    const rec = await this.getById(id)
    if (!rec) return null
    const nowMs = Date.now()
    const now = new Date(nowMs).toISOString()
    const micros = microsOf(cost_micros) || 0
    const w = WINDOWS.map((win) => this._rollWindow(rec, win, micros, nowMs))
    await this.client.run(
      RECORD_USAGE_SQL,
      Number(tokens_in) || 0,
      Number(tokens_out) || 0,
      Number(cache_read_tokens) || 0,
      Number(cache_creation_tokens) || 0,
      micros,
      micros,
      ...w.flatMap((win) => [win.usage, fromMicros(win.usage), win.start]),
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
