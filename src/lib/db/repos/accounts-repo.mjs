/**
 * accounts + account_allocations repository (sub2api-shaped table).
 *
 * The table follows the sub2api Account columns (id/platform/type/extra/
 * priority/schedulable/rate_limited_at/…, ISO-8601 TEXT timestamps) while the
 * public record shape stays what the pool/panel layers always consumed:
 * account_id, max_concurrency, unified, last_blocked, last_cli_rate_limit.
 * The unified/blocked/rate-limit snapshots live inside the `extra` JSON.
 */

import { getDb } from '../database.mjs'
import { dbClient } from '../db-client.mjs'
import { cachedAccountRow, rememberAccountRow } from './account-snapshot-cache.mjs'

const MAX_ALLOCATIONS_PER_ACCOUNT = 50

function parse(json, fallback = null) {
  if (json == null) return fallback
  try {
    return JSON.parse(json)
  } catch {
    return fallback
  }
}

const DEFAULT_UNIFIED = () => ({
  '5h': { utilization: 0, reset: null, status: 'active' },
  '7d': { utilization: 0, reset: null, status: 'active' },
  representative_claim: null,
  overage_status: null,
  updated_at: null,
})

export function rowToAccount(row) {
  if (!row) return null
  const extra = parse(row.extra, {}) || {}
  return {
    account_id: row.id,
    vm_id: row.vm_id,
    email: row.email,
    name: row.name || null,
    platform: row.platform || 'claude',
    type: row.type || 'oauth',
    status: row.status || 'active',
    priority: row.priority ?? 50,
    rate_multiplier: row.rate_multiplier ?? 1,
    schedulable: row.schedulable == null ? true : !!row.schedulable,
    max_concurrency: row.concurrency,
    concurrency_override: row.concurrency_override ? 1 : 0,
    max_rpm: row.max_rpm ?? 0,
    rpm_override: row.rpm_override ? 1 : 0,
    requests: row.requests || 0,
    tokens_in: row.tokens_in || 0,
    tokens_out: row.tokens_out || 0,
    cache_read_tokens: row.cache_read_tokens || 0,
    cache_creation_tokens: row.cache_creation_tokens || 0,
    unified: extra.unified ?? DEFAULT_UNIFIED(),
    last_blocked: extra.last_blocked ?? null,
    last_cli_rate_limit: extra.last_cli_rate_limit ?? null,
    window_history: extra.window_history ?? null,
    updated_at: row.updated_at,
  }
}

function buildExtra(acc) {
  return JSON.stringify({
    unified: acc.unified ?? null,
    last_blocked: acc.last_blocked ?? null,
    last_cli_rate_limit: acc.last_cli_rate_limit ?? null,
    window_history: acc.window_history ?? null,
  })
}

const GET_SQL = 'SELECT * FROM accounts WHERE id = ?'
const LIST_SQL = 'SELECT * FROM accounts ORDER BY id'
const INSERT_COLUMNS = `(id, vm_id, email, name, platform, type, status,
                            concurrency, concurrency_override,
                            max_rpm, rpm_override,
                            requests, tokens_in, tokens_out,
                            cache_read_tokens, cache_creation_tokens,
                            extra, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
const INSERT_SQL = `INSERT INTO accounts ${INSERT_COLUMNS}`
// 竞态 R10：并发首次 ensure 都读不到行时各自插入；冲突的一方不报错，之后读回胜者
const INSERT_IF_ABSENT_SQL = `INSERT INTO accounts ${INSERT_COLUMNS} ON CONFLICT(id) DO NOTHING`
const UPDATE_SQL = `
      UPDATE accounts SET vm_id = ?, email = ?, name = ?, type = ?,
                          concurrency = ?, concurrency_override = ?,
                          max_rpm = ?, rpm_override = ?,
                          requests = ?, tokens_in = ?, tokens_out = ?,
                          cache_read_tokens = ?, cache_creation_tokens = ?,
                          extra = ?, updated_at = ?
      WHERE id = ?
    `
// 字段级更新：只改这一项，不整行写回（并发的用量或窗口写入不被覆盖）
const SET_LAST_BLOCKED_SQL =
  "UPDATE accounts SET extra = json_set(COALESCE(NULLIF(extra, ''), '{}'), '$.last_blocked', json(?)), updated_at = ? WHERE id = ?"
const SET_VM_TYPE_SQL =
  'UPDATE accounts SET vm_id = COALESCE(?, vm_id), type = COALESCE(?, type), updated_at = ? WHERE id = ?'
const INSERT_ALLOC_SQL = `
      INSERT INTO account_allocations (account_id, at, source, util_5h, util_7d, status_5h, status_7d, claim, tokens_in, tokens_out)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
const TRIM_ALLOC_SQL = `
      DELETE FROM account_allocations WHERE account_id = ? AND id NOT IN (
        SELECT id FROM account_allocations WHERE account_id = ? ORDER BY id DESC LIMIT ?
      )
    `
const RECENT_ALLOC_SQL = 'SELECT * FROM account_allocations WHERE account_id = ? ORDER BY id DESC LIMIT ?'
const REMOVE_ALLOCS_SQL = 'DELETE FROM account_allocations WHERE account_id = ?'
const REMOVE_GROUPS_SQL = 'DELETE FROM account_groups WHERE account_id = ?'
const REMOVE_SQL = 'DELETE FROM accounts WHERE id = ?'
const ALLOC_COUNT_SQL = 'SELECT COUNT(*) c FROM account_allocations WHERE account_id = ?'

function insertParams(acc) {
  const now = new Date().toISOString()
  return [
    acc.account_id,
    acc.vm_id ?? null,
    acc.email ?? null,
    acc.name ?? acc.email ?? acc.account_id,
    acc.platform ?? 'claude',
    acc.type ?? 'oauth',
    acc.status ?? 'active',
    acc.max_concurrency ?? 2,
    acc.concurrency_override ? 1 : 0,
    acc.max_rpm ?? 0,
    acc.rpm_override ? 1 : 0,
    acc.requests ?? 0,
    acc.tokens_in ?? 0,
    acc.tokens_out ?? 0,
    acc.cache_read_tokens ?? 0,
    acc.cache_creation_tokens ?? 0,
    buildExtra(acc),
    acc.created_at ?? now,
    acc.updated_at ?? now,
  ]
}

/**
 * 数据访问经 DbClient 异步执行（R6 B7b）。读到的行同时写进账号调度快照副本（account-snapshot-cache.mjs），
 * 供 `PoolScheduler.reserve()` 的同步复核使用。
 */
export class AccountsRepo {
  constructor(db = getDb()) {
    this.db = db
    this.client = dbClient(db)
  }

  _remember(accountId, row) {
    rememberAccountRow(this.db, accountId, row || null)
    return rowToAccount(row)
  }

  async get(accountId) {
    return this._remember(accountId, await this.client.one(GET_SQL, accountId))
  }

  async list() {
    return (await this.client.many(LIST_SQL)).map((row) => this._remember(row.id, row))
  }

  /**
   * 同步读：本进程最近一次经仓储读到或写后读回的行（account-snapshot-cache.mjs），不读库。从未读过时返回 undefined，
   * 已确认不存在时返回 null。只给同步准入判定（AccountQuota.tryAcquire 等）在调用方没传账号行时使用。
   */
  cached(accountId) {
    const row = cachedAccountRow(this.db, accountId)
    return row === undefined ? undefined : rowToAccount(row)
  }

  /** Insert if missing, returns stored account. Commercial resource membership is maintained separately. */
  async insert(acc) {
    await this.client.run(INSERT_SQL, ...insertParams(acc))
    return this.get(acc.account_id)
  }

  /** 不存在才插入（ON CONFLICT DO NOTHING），返回库里的行（并发插入时是先插入的一方）。 */
  async insertIfAbsent(acc) {
    await this.client.run(INSERT_IF_ABSENT_SQL, ...insertParams(acc))
    return this.get(acc.account_id)
  }

  /** Full-row save of a mutated account object. */
  async save(acc) {
    await this.client.run(
      UPDATE_SQL,
      acc.vm_id ?? null,
      acc.email ?? null,
      acc.name ?? acc.email ?? acc.account_id,
      acc.type ?? 'oauth',
      acc.max_concurrency ?? 2,
      acc.concurrency_override ? 1 : 0,
      acc.max_rpm ?? 0,
      acc.rpm_override ? 1 : 0,
      acc.requests ?? 0,
      acc.tokens_in ?? 0,
      acc.tokens_out ?? 0,
      acc.cache_read_tokens ?? 0,
      acc.cache_creation_tokens ?? 0,
      buildExtra(acc),
      new Date().toISOString(),
      acc.account_id,
    )
    return this.get(acc.account_id)
  }

  /** 只写 `extra.last_blocked`（准入拒绝的记录），不整行写回。 */
  async setLastBlocked(accountId, lastBlocked) {
    await this.client.run(
      SET_LAST_BLOCKED_SQL,
      JSON.stringify(lastBlocked ?? null),
      new Date().toISOString(),
      accountId,
    )
    return this.get(accountId)
  }

  /** 只改归属 VM 与类型（传 null 的保持不变）。 */
  async setVmAndType(accountId, { vmId = null, type = null } = {}) {
    await this.client.run(SET_VM_TYPE_SQL, vmId ?? null, type ?? null, new Date().toISOString(), accountId)
    return this.get(accountId)
  }

  async remove(accountId) {
    const removed = await this.client.tx(async (tx) => {
      await tx.run(REMOVE_ALLOCS_SQL, accountId)
      await tx.run(REMOVE_GROUPS_SQL, accountId)
      return (await tx.run(REMOVE_SQL, accountId)).changes > 0
    })
    rememberAccountRow(this.db, accountId, null)
    return removed
  }

  async addAllocation(accountId, alloc, { max = MAX_ALLOCATIONS_PER_ACCOUNT } = {}) {
    await this.client.run(
      INSERT_ALLOC_SQL,
      accountId,
      alloc.at || new Date().toISOString(),
      alloc.source ?? null,
      alloc.util_5h ?? null,
      alloc.util_7d ?? null,
      alloc.status_5h ?? null,
      alloc.status_7d ?? null,
      alloc.claim ?? null,
      alloc.tokens_in ?? null,
      alloc.tokens_out ?? null,
    )
    await this.client.run(TRIM_ALLOC_SQL, accountId, accountId, max)
  }

  async recentAllocations(accountId, limit = 5) {
    return (await this.client.many(RECENT_ALLOC_SQL, accountId, limit)).reverse().map((r) => ({
      at: r.at,
      source: r.source ?? undefined,
      util_5h: r.util_5h,
      util_7d: r.util_7d,
      status_5h: r.status_5h ?? undefined,
      status_7d: r.status_7d ?? undefined,
      claim: r.claim,
      tokens_in: r.tokens_in,
      tokens_out: r.tokens_out,
    }))
  }

  async allocationCount(accountId) {
    return (await this.client.one(ALLOC_COUNT_SQL, accountId)).c
  }
}
