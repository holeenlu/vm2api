/**
 * sticky_sessions repository — conversation key → account/VM bindings.
 */

import { getDb } from '../database.mjs'
import { dbClient } from '../db-client.mjs'

function rowToEntry(row) {
  if (!row) return null
  return {
    account_id: row.account_id,
    vm_id: row.vm_id,
    session_id: row.session_id,
    device_id: row.device_id || null,
    bound_at: row.bound_at,
    expires_at: row.expires_at,
    hits: row.hits || 0,
    generation: Number(row.generation) || 0,
    slot_index: row.slot_index == null ? null : Number(row.slot_index),
  }
}

const GET_SQL = 'SELECT * FROM sticky_sessions WHERE key = ?'
const UPSERT_SQL = `
      INSERT INTO sticky_sessions (key, account_id, vm_id, session_id, device_id, bound_at, expires_at, hits, generation, slot_index)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        account_id = excluded.account_id,
        vm_id = excluded.vm_id,
        session_id = excluded.session_id,
        device_id = COALESCE(excluded.device_id, sticky_sessions.device_id),
        bound_at = excluded.bound_at,
        expires_at = excluded.expires_at,
        hits = excluded.hits,
        generation = excluded.generation,
        slot_index = excluded.slot_index
    `
// 竞态 R13：绑定是条件写。没有行时 ON CONFLICT DO NOTHING，冲突说明另一个请求先绑了；有行时按读到的整行做 CAS，
// 行在读之后被改过就不写。两种情况都由调用方读回胜者再决定（StickyRouter.bind）。
const INSERT_IF_ABSENT_SQL = `
      INSERT INTO sticky_sessions (key, account_id, vm_id, session_id, device_id, bound_at, expires_at, hits, generation, slot_index)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO NOTHING
    `
const CAS_SQL = `
      UPDATE sticky_sessions SET
        account_id = ?, vm_id = ?, session_id = ?, device_id = COALESCE(?, device_id),
        bound_at = ?, expires_at = ?, hits = ?, generation = ?, slot_index = ?
      WHERE key = ?
        AND account_id IS ? AND vm_id IS ? AND session_id IS ? AND NULLIF(device_id, '') IS ?
        AND bound_at IS ? AND expires_at IS ? AND COALESCE(hits, 0) = ? AND COALESCE(generation, 0) = ?
        AND slot_index IS ?
    `
const DELETE_SQL = 'DELETE FROM sticky_sessions WHERE key = ?'
const DELETE_BY_ACCOUNT_SQL = 'DELETE FROM sticky_sessions WHERE account_id = ? OR vm_id = ?'
const PURGE_SQL = 'DELETE FROM sticky_sessions WHERE expires_at < ?'
const DROP_ALIAS_SQL = `
      DELETE FROM sticky_sessions
      WHERE key = 'envelope'
        OR key LIKE 'ch:%'
        OR key LIKE 'dev:%'
        OR key LIKE '%:envelope'
        OR key LIKE '%:ch:%'
        OR key LIKE '%:dev:%'
    `
const ALL_SQL = 'SELECT * FROM sticky_sessions'
const COUNT_SQL = 'SELECT COUNT(*) c FROM sticky_sessions'

function entryParams(key, ent) {
  return [
    key,
    ent.account_id ?? null,
    ent.vm_id ?? null,
    ent.session_id ?? null,
    ent.device_id ?? null,
    ent.bound_at ?? Date.now(),
    ent.expires_at ?? null,
    ent.hits ?? 0,
    Number(ent.generation) || 0,
    ent.slot_index == null ? null : Number(ent.slot_index),
  ]
}

/** 数据访问经 DbClient 异步执行（R6 B7b；Codex 候选准入自 B7c）。 */
export class StickyRepo {
  constructor(db = getDb()) {
    this.db = db
    this.client = dbClient(db)
  }

  async get(key) {
    return rowToEntry(await this.client.one(GET_SQL, key))
  }

  async upsert(key, ent) {
    await this.client.run(UPSERT_SQL, ...entryParams(key, ent))
  }

  /**
   * 条件写（R13）：`prev` 为 null 时只在没有行时插入；否则只在行仍等于 `prev` 时更新。返回是否写入。
   * `prev` 必须是本仓储 get() 读到的原样记录。
   */
  async compareAndSet(key, prev, ent) {
    if (!prev) return (await this.client.run(INSERT_IF_ABSENT_SQL, ...entryParams(key, ent))).changes > 0
    const [, ...next] = entryParams(key, ent)
    const result = await this.client.run(
      CAS_SQL,
      ...next,
      key,
      prev.account_id ?? null,
      prev.vm_id ?? null,
      prev.session_id ?? null,
      prev.device_id ?? null,
      prev.bound_at ?? null,
      prev.expires_at ?? null,
      prev.hits ?? 0,
      Number(prev.generation) || 0,
      prev.slot_index == null ? null : Number(prev.slot_index),
    )
    return result.changes > 0
  }

  async remove(key) {
    await this.client.run(DELETE_SQL, key)
  }

  async removeByAccount({ accountId = null, vmId = null } = {}) {
    if (!accountId && !vmId) return 0
    return (await this.client.run(DELETE_BY_ACCOUNT_SQL, accountId || '', vmId || '')).changes
  }

  async purgeExpired(now = Date.now()) {
    return (await this.client.run(PURGE_SQL, now)).changes
  }

  /** Content fingerprints and device aliases are not conversation slots. */
  async dropAliasKeys() {
    return (await this.client.run(DROP_ALIAS_SQL)).changes
  }

  async all() {
    const out = {}
    for (const row of await this.client.many(ALL_SQL)) out[row.key] = rowToEntry(row)
    return out
  }

  async count() {
    return (await this.client.one(COUNT_SQL)).c
  }
}
