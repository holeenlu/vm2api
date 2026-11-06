/**
 * Account runtime state — facade over two tables (sub2api SSOT split).
 *
 * Persistent scheduling fields (priority, cooldown → temp_unschedulable_*,
 * rate_limited_at / rate_limit_reset_at / overload_until, session_window_*,
 * last_used_at, load_factor) live on `accounts` as ISO-8601 TEXT, matching
 * the sub2api Account columns. High-frequency worker transients (heartbeat,
 * worker status, per-model cooldowns, credential generation) live in the thin
 * `account_runtime` table. Callers keep the historical merged-state shape
 * with ms-epoch numbers; conversion happens here.
 */

import { getDb } from '../database.mjs'
import { dbClient } from '../db-client.mjs'
import { rowToAccount } from './accounts-repo.mjs'
import { cachedAccountRows, rememberAccountRow, rememberRuntimeRow } from './account-snapshot-cache.mjs'

function parse(value, fallback = null) {
  if (value == null) return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function toMs(iso) {
  if (iso == null) return null
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : null
}

function toIso(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n) || n <= 0) return null
  // MAX_SAFE_INTEGER is used as a "forever" sentinel — clamp to the ISO range
  return new Date(Math.min(n, 8.64e15)).toISOString()
}

function mergeState(rt, acc) {
  if (!rt && !acc) return null
  return {
    account_id: rt?.account_id ?? acc?.id,
    vm_id: rt?.vm_id ?? acc?.vm_id ?? null,
    status: rt?.status || 'unknown',
    priority: Number(acc?.priority) || 0,
    weight: Math.max(0, Number(acc?.load_factor) || 0),
    cooldown_until: toMs(acc?.temp_unschedulable_until),
    cooldown_reason: acc?.temp_unschedulable_reason || null,
    model_states: parse(rt?.model_states_json, {}),
    last_used_at: toMs(acc?.last_used_at),
    credential_generation: Number(rt?.credential_generation) || 0,
    refresh_status: rt?.refresh_status || null,
    worker_heartbeat_at: rt?.worker_heartbeat_at == null ? null : Number(rt.worker_heartbeat_at),
    worker_status: parse(rt?.worker_status_json),
    protection_state: parse(rt?.protection_state_json, null),
    protection_generation: Number(rt?.protection_generation) || 0,
    rate_limited_at: toMs(acc?.rate_limited_at),
    rate_limit_reset_at: toMs(acc?.rate_limit_reset_at),
    overload_until: toMs(acc?.overload_until),
    session_window_start: toMs(acc?.session_window_start),
    session_window_end: toMs(acc?.session_window_end),
    session_window_status: acc?.session_window_status || null,
    updated_at: rt?.updated_at ?? acc?.updated_at ?? null,
  }
}

const SNAPSHOT_SQL = `SELECT a.id, a.vm_id, a.email, a.name, a.platform, a.type,
      a.status, a.schedulable, a.priority, a.rate_multiplier, a.concurrency,
      a.concurrency_override, a.max_rpm, a.rpm_override, a.requests,
      a.tokens_in, a.tokens_out, a.cache_read_tokens, a.cache_creation_tokens,
      a.extra, a.updated_at, a.load_factor, a.last_used_at,
      a.temp_unschedulable_until, a.temp_unschedulable_reason, a.rate_limited_at,
      a.rate_limit_reset_at, a.overload_until, a.session_window_start,
      a.session_window_end, a.session_window_status,
      r.account_id AS rt_account_id, r.vm_id AS rt_vm_id, r.status AS rt_status,
      r.updated_at AS rt_updated_at, r.model_states_json, r.credential_generation,
      r.refresh_status, r.worker_heartbeat_at, r.worker_status_json,
      r.protection_state_json, r.protection_generation
      FROM accounts a FULL JOIN account_runtime r ON r.account_id = a.id`
const SNAPSHOTS_SQL = SNAPSHOT_SQL + ' WHERE COALESCE(a.id, r.account_id) IN (SELECT value FROM json_each(?))'
const ACCOUNT_COLUMNS = [
  'id',
  'vm_id',
  'email',
  'name',
  'platform',
  'type',
  'status',
  'schedulable',
  'priority',
  'rate_multiplier',
  'concurrency',
  'concurrency_override',
  'max_rpm',
  'rpm_override',
  'requests',
  'tokens_in',
  'tokens_out',
  'cache_read_tokens',
  'cache_creation_tokens',
  'extra',
  'updated_at',
  'load_factor',
  'last_used_at',
  'temp_unschedulable_until',
  'temp_unschedulable_reason',
  'rate_limited_at',
  'rate_limit_reset_at',
  'overload_until',
  'session_window_start',
  'session_window_end',
  'session_window_status',
]
const RUNTIME_COLUMNS = [
  'rt_account_id',
  'rt_vm_id',
  'rt_status',
  'rt_updated_at',
  'model_states_json',
  'credential_generation',
  'refresh_status',
  'worker_heartbeat_at',
  'worker_status_json',
  'protection_state_json',
  'protection_generation',
]
const HEARTBEAT_SQL = `INSERT INTO account_runtime
      (account_id, vm_id, status, worker_heartbeat_at, worker_status_json,
       credential_generation, refresh_status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET
        status = CASE WHEN account_runtime.status IN ('disabled','cooldown','rate_limited')
          THEN account_runtime.status ELSE excluded.status END,
        worker_heartbeat_at = excluded.worker_heartbeat_at,
        worker_status_json = excluded.worker_status_json,
        credential_generation = MAX(account_runtime.credential_generation, excluded.credential_generation),
        refresh_status = excluded.refresh_status,
        updated_at = excluded.updated_at
      WHERE COALESCE(account_runtime.worker_heartbeat_at, 0) <= excluded.worker_heartbeat_at`
const ENSURE_ACC_SQL = `
      INSERT OR IGNORE INTO accounts (id, vm_id, name, extra, created_at, updated_at)
      VALUES (?, ?, ?, '{}', ?, ?)
    `
// Protection writes use the persisted revision as a CAS token.  The
// revision is incremented in SQLite so concurrent workers cannot both
// claim the same state transition after a read-then-write race.
const PROTECTION_SNAPSHOT_SQL = `
      SELECT protection_state_json, protection_generation
      FROM account_runtime
      WHERE account_id = ?
    `
const PROTECTION_CAS_SQL = `
      UPDATE account_runtime
      SET protection_state_json = ?,
          protection_generation = protection_generation + 1,
          updated_at = ?
      WHERE account_id = ? AND protection_generation = ?
    `
const REMOVE_RT_SQL = 'DELETE FROM account_runtime WHERE account_id = ?'

/** 调度输入里写到 accounts 列的字段：键 → [列, 取值]；只写调用方给出的键（R12 字段级更新）。 */
const ACCOUNT_FIELDS = {
  last_used_at: ['last_used_at', (v) => toIso(v)],
  cooldown_until: ['temp_unschedulable_until', (v) => toIso(v)],
  cooldown_reason: ['temp_unschedulable_reason', (v) => v ?? null],
  rate_limited_at: ['rate_limited_at', (v) => toIso(v)],
  rate_limit_reset_at: ['rate_limit_reset_at', (v) => toIso(v)],
  overload_until: ['overload_until', (v) => toIso(v)],
  session_window_start: ['session_window_start', (v) => toIso(v)],
  session_window_end: ['session_window_end', (v) => toIso(v)],
  session_window_status: ['session_window_status', (v) => v ?? null],
}

const has = (input, key) => Object.prototype.hasOwnProperty.call(input, key)

/** model_states 的 JSON 路径。键是模型名或内部键（`__circuit`），不含双引号；含双引号的键拒绝写入。 */
function modelStatePath(key) {
  const name = String(key || '')
  if (!name || /["\\]/.test(name)) throw new Error(`invalid model_states key: ${name}`)
  return `$."${name}"`
}

/**
 * 字段级写入（R12）：只写 input 里给出的字段，不读整行、合并、写回整行，并发的冷却、窗口、熔断与心跳更新互不覆盖。
 * 与原整行写入等价的约定：accounts 列按“键在 input 里”写（undefined 写 NULL）；运行态 status / model_states
 * 为 null 时保持不变；凭据代次、心跳、保护代次只增不减；refresh_status / worker_status / protection_state 沿用
 * 原来按心跳与保护代次比较的条件。新建账号行时 priority / weight 取原来对空状态的默认值（0 / 1）。
 * 返回 [sql, params] 列表，异步与同步出口共用。
 */
function upsertStatements(input, { createdAccount = false, now = new Date().toISOString() } = {}) {
  const id = input.account_id
  const vmId = input.vm_id
  const statements = [[ENSURE_ACC_SQL, [id, vmId, id, now, now]]]
  const sets = ['vm_id = ?']
  const params = [vmId]
  const priority = input.priority ?? (createdAccount ? 0 : null)
  if (priority != null) {
    sets.push('priority = ?')
    params.push(Number(priority))
  }
  const weight = input.weight ?? (createdAccount ? 1 : null)
  if (weight != null) {
    sets.push('load_factor = ?')
    params.push(Math.max(0, Number(weight)))
  }
  for (const [key, [column, value]] of Object.entries(ACCOUNT_FIELDS)) {
    if (!has(input, key)) continue
    sets.push(`${column} = ?`)
    params.push(value(input[key]))
  }
  sets.push('updated_at = ?')
  params.push(now, id)
  statements.push([`UPDATE accounts SET ${sets.join(', ')} WHERE id = ?`, params])

  // SET 子句里的参数按出现顺序追加在 VALUES 参数之后
  const setParams = []
  const hbProvided = has(input, 'worker_heartbeat_at')
  const hbExcluded = () => {
    if (!hbProvided) return 'COALESCE(account_runtime.worker_heartbeat_at, 0)'
    setParams.push(input.worker_heartbeat_at ?? null)
    return 'COALESCE(?, 0)'
  }
  const pgExcluded = () => {
    if (!has(input, 'protection_generation')) return 'account_runtime.protection_generation'
    setParams.push(Number(input.protection_generation) || 0)
    return '?'
  }
  const rtSets = ['vm_id = excluded.vm_id']
  if (input.status != null) rtSets.push('status = excluded.status')
  if (input.model_states != null) rtSets.push('model_states_json = excluded.model_states_json')
  if (has(input, 'refresh_status'))
    rtSets.push(
      `refresh_status = CASE WHEN ${hbExcluded()} >= COALESCE(account_runtime.worker_heartbeat_at, 0) THEN excluded.refresh_status ELSE account_runtime.refresh_status END`,
    )
  if (has(input, 'worker_status'))
    rtSets.push(
      `worker_status_json = CASE WHEN ${hbExcluded()} >= COALESCE(account_runtime.worker_heartbeat_at, 0) THEN excluded.worker_status_json ELSE account_runtime.worker_status_json END`,
    )
  if (has(input, 'protection_state'))
    rtSets.push(
      `protection_state_json = CASE WHEN ${pgExcluded()} >= account_runtime.protection_generation THEN excluded.protection_state_json ELSE account_runtime.protection_state_json END`,
    )
  // 凭据代次、心跳、保护代次只增不减；没给出时保持原值（与原整行写入的 MAX 语义一致）
  rtSets.push(
    'credential_generation = MAX(account_runtime.credential_generation, COALESCE(?, account_runtime.credential_generation))',
  )
  setParams.push(input.credential_generation ?? null)
  rtSets.push(
    'worker_heartbeat_at = MAX(COALESCE(account_runtime.worker_heartbeat_at, 0), COALESCE(?, account_runtime.worker_heartbeat_at, 0))',
  )
  setParams.push(input.worker_heartbeat_at ?? null)
  rtSets.push(
    'protection_generation = MAX(account_runtime.protection_generation, COALESCE(?, account_runtime.protection_generation))',
  )
  setParams.push(input.protection_generation == null ? null : Number(input.protection_generation) || 0)
  rtSets.push('updated_at = excluded.updated_at')
  statements.push([
    `INSERT INTO account_runtime (
        account_id, vm_id, status, model_states_json, credential_generation,
        refresh_status, worker_heartbeat_at, worker_status_json,
        protection_state_json, protection_generation, updated_at
      ) VALUES (?, ?, COALESCE(?, 'unknown'), COALESCE(?, '{}'), COALESCE(?, 0), ?, ?, ?, ?, COALESCE(?, 0), ?)
      ON CONFLICT(account_id) DO UPDATE SET ${rtSets.join(',\n        ')}`,
    [
      id,
      vmId,
      input.status ?? null,
      input.model_states != null ? JSON.stringify(input.model_states) : null,
      input.credential_generation ?? null,
      input.refresh_status ?? null,
      input.worker_heartbeat_at ?? null,
      input.worker_status != null ? JSON.stringify(input.worker_status) : null,
      input.protection_state != null ? JSON.stringify(input.protection_state) : null,
      input.protection_generation == null ? null : Number(input.protection_generation) || 0,
      now,
      ...setParams,
    ],
  ])
  return statements
}

/**
 * 只改 model_states 的一个键（R11 熔断、按模型冷却）：json_set 原地更新，不读改写整个 JSON。
 * `status` 为 null 时运行态 status 保持不变（新建行为 'unknown'）。
 */
function modelStateStatements(accountId, vmId, key, value, { status = null, now = new Date().toISOString() } = {}) {
  const path = modelStatePath(key)
  const json = JSON.stringify(value ?? null)
  return [
    [ENSURE_ACC_SQL, [accountId, vmId, accountId, now, now]],
    ['UPDATE accounts SET vm_id = ?, updated_at = ? WHERE id = ?', [vmId, now, accountId]],
    [
      `INSERT INTO account_runtime (account_id, vm_id, status, model_states_json, credential_generation, updated_at)
       VALUES (?, ?, COALESCE(?, 'unknown'), json_object(?, json(?)), 0, ?)
       ON CONFLICT(account_id) DO UPDATE SET
         vm_id = excluded.vm_id,
         status = COALESCE(?, account_runtime.status),
         model_states_json = json_set(COALESCE(NULLIF(account_runtime.model_states_json, ''), '{}'), ?, json(?)),
         worker_heartbeat_at = COALESCE(account_runtime.worker_heartbeat_at, 0),
         updated_at = excluded.updated_at`,
      [accountId, vmId, status, String(key), json, now, status, path, json],
    ],
  ]
}

/**
 * 数据访问经 DbClient 异步执行（R6 B7b）。写入是字段级的（R11、R12），读到的行同时写进账号调度快照副本
 * （account-snapshot-cache.mjs），`cachedSnapshot()` 供 `PoolScheduler.reserve()` 的同步复核读取。
 * Codex 账号保护（codex-account-protection）同样经异步方法读写（R6 B7c）。
 */
export class AccountRuntimeRepo {
  constructor(db = getDb()) {
    this.db = db
    this.client = dbClient(db)
  }

  _remember(ids, rows) {
    const seen = new Set()
    for (const row of rows) {
      const id = row.id ?? row.rt_account_id
      seen.add(id)
      rememberAccountRow(
        this.db,
        id,
        row.id == null ? null : Object.fromEntries(ACCOUNT_COLUMNS.map((column) => [column, row[column]])),
      )
      rememberRuntimeRow(
        this.db,
        id,
        row.rt_account_id == null ? null : Object.fromEntries(RUNTIME_COLUMNS.map((column) => [column, row[column]])),
      )
    }
    for (const id of ids || []) {
      if (seen.has(id)) continue
      rememberAccountRow(this.db, id, null)
      rememberRuntimeRow(this.db, id, null)
    }
  }

  async schedulingSnapshot(accountIds) {
    if (!accountIds.length) return new Map()
    const rows = await this.client.many(SNAPSHOTS_SQL, JSON.stringify(accountIds))
    this._remember(accountIds, rows)
    return new Map(rows.map((row) => [row.id ?? row.rt_account_id, this.snapshotRow(row)]))
  }

  /**
   * 同步读：最近一次读到的快照加上本进程之后的写入（account-snapshot-cache.mjs）。只给 reserve() 的同步复核用；
   * 还没读过的账号返回 undefined（与 schedulingSnapshot 查不到时一致）。
   */
  cachedSnapshot(accountId) {
    const rows = cachedAccountRows(this.db, accountId)
    if (!rows || (!rows.account && !rows.runtime)) return undefined
    const row = {
      ...Object.fromEntries(ACCOUNT_COLUMNS.map((column) => [column, rows.account?.[column] ?? null])),
      ...Object.fromEntries(RUNTIME_COLUMNS.map((column) => [column, rows.runtime?.[column] ?? null])),
    }
    if (!rows.account) row.id = null
    if (!rows.runtime) row.rt_account_id = null
    return this.snapshotRow(row)
  }

  snapshotRow(row) {
    const account = row.id == null ? null : row
    const runtime =
      row.rt_account_id == null
        ? null
        : {
            ...row,
            account_id: row.rt_account_id,
            vm_id: row.rt_vm_id,
            status: row.rt_status,
            updated_at: row.rt_updated_at,
          }
    return { account: rowToAccount(account), state: mergeState(runtime, account) }
  }

  async get(accountId) {
    return (await this.schedulingSnapshot([accountId])).get(accountId)?.state || null
  }

  async list() {
    const rows = await this.client.many(SNAPSHOT_SQL)
    this._remember([], rows)
    return rows.map((row) => this.snapshotRow(row).state)
  }

  async writeHeartbeat(input) {
    await this.client.run(
      HEARTBEAT_SQL,
      input.account_id,
      input.vm_id,
      input.status,
      input.worker_heartbeat_at,
      JSON.stringify(input.worker_status),
      input.credential_generation,
      input.refresh_status,
      new Date().toISOString(),
    )
    // 不读回：心跳只改 worker 列（状态、凭据代次与健康缓存同源），reserve() 的复核不依赖它们比副本更新
  }

  async upsert(input = {}) {
    if (!input.account_id || !input.vm_id) return null
    await this.client.tx(async (tx) => {
      const created = !(await tx.one('SELECT 1 FROM accounts WHERE id = ?', input.account_id))
      for (const [sql, params] of upsertStatements(input, { createdAccount: created })) await tx.run(sql, ...params)
    })
    return this.get(input.account_id)
  }

  /** 只改 model_states 的一个键（json_set），返回写入后的状态。 */
  async setModelState(accountId, { vmId, key, value, status = null } = {}) {
    if (!accountId || !vmId) return null
    await this.client.tx(async (tx) => {
      for (const [sql, params] of modelStateStatements(accountId, vmId, key, value, { status }))
        await tx.run(sql, ...params)
    })
    return this.get(accountId)
  }

  /**
   * Read the account protection summary and its SQLite CAS revision.
   *
   * The revision is separate from the semantic freeze `state.generation`:
   * every successful write advances it, including an operator clear, so a
   * late probe cannot overwrite a newer state transition.
   */
  async getProtectionState(accountId) {
    return protectionOf(await this.client.one(PROTECTION_SNAPSHOT_SQL, accountId))
  }

  /**
   * Store a bounded protection summary if the persisted CAS revision still
   * equals `expectedGeneration`.
   *
   * Returns the new revision on success and `null` on a stale writer.  The
   * caller should re-read and re-evaluate the transition after a conflict.
   */
  async compareAndSwapProtectionState(
    accountId,
    { expectedGeneration = 0, state = null, updatedAt = new Date().toISOString() } = {},
  ) {
    const expected = Number(expectedGeneration)
    if (!Number.isInteger(expected) || expected < 0) return null
    const result = await this.client.run(
      PROTECTION_CAS_SQL,
      state == null ? null : JSON.stringify(state),
      updatedAt,
      accountId,
      expected,
    )
    if (!result.changes) return null
    await this.get(accountId)
    return expected + 1
  }

  /**
   * Clear persisted protection state through the same CAS boundary.
   *
   * `state` may be supplied when a caller wants to retain policy/credential
   * metadata while clearing counters; omitted state removes the JSON summary.
   */
  async clearProtectionState(
    accountId,
    { expectedGeneration = 0, state = null, updatedAt = new Date().toISOString() } = {},
  ) {
    return this.compareAndSwapProtectionState(accountId, { expectedGeneration, state, updatedAt })
  }

  /**
   * Structured rate-limit / session-window write-through
   * (sub2api account.rate_limited_at / rate_limit_reset_at / overload_until /
   *  session_window_* counterpart). Only provided fields are updated.
   */
  async updateWindow(
    accountId,
    {
      vmId = null,
      rateLimitedAt,
      rateLimitResetAt,
      overloadUntil,
      sessionWindowStart,
      sessionWindowEnd,
      sessionWindowStatus,
    } = {},
  ) {
    const current = await this.get(accountId)
    const resolvedVm = current ? current.vm_id || vmId : vmId
    if (!resolvedVm) return null
    const patch = { account_id: accountId, vm_id: resolvedVm }
    if (rateLimitedAt !== undefined) patch.rate_limited_at = rateLimitedAt
    if (rateLimitResetAt !== undefined) patch.rate_limit_reset_at = rateLimitResetAt
    if (overloadUntil !== undefined) patch.overload_until = overloadUntil
    if (sessionWindowStart !== undefined) patch.session_window_start = sessionWindowStart
    if (sessionWindowEnd !== undefined) patch.session_window_end = sessionWindowEnd
    if (sessionWindowStatus !== undefined) patch.session_window_status = sessionWindowStatus
    return this.upsert(patch)
  }

  async markCooldown(accountId, { vmId, until, reason, model = null, status = 'cooldown' } = {}) {
    const current = await this.get(accountId)
    const resolvedVm = current ? current.vm_id : vmId
    if (!resolvedVm) return null
    if (model) {
      return this.setModelState(accountId, {
        vmId: resolvedVm,
        key: model,
        value: {
          status,
          cooldown_until: Number(until) || null,
          reason: reason || null,
          updated_at: new Date().toISOString(),
        },
      })
    }
    const patch = {
      account_id: accountId,
      vm_id: resolvedVm,
      status,
      cooldown_until: Number(until) || null,
      cooldown_reason: reason || null,
    }
    // Structured mirror of the protocol-level limit (sub2api account columns).
    // overload_until is only the 529 hard column (RateLimitService.handle529).
    // A 502 failover also uses reason provider_overloaded for 15s; writing it
    // here paints every hopped VM as 过载冷却 and removes them from the pool.
    if (/rate_limited|quota_exhausted/i.test(String(reason || ''))) {
      patch.rate_limited_at = Date.now()
      patch.rate_limit_reset_at = Number(until) || null
    }
    return this.upsert(patch)
  }

  /** Stale-access 401 / 403 permission — not quota, Fable, or 429. */
  static AUTH_COOLDOWN = /authentication_failed_after_refresh|permission_denied/i
  /** Grant-death leftover. A later live ticket must drop this or the panel stays revoke. */
  static GRANT_REVOKE_COOLDOWN =
    /oauth_revoked|oauth_invalid_grant|invalid_grant|token has been revoked|oauth_no_refresh/i

  isAuthCooldown(state) {
    return AccountRuntimeRepo.AUTH_COOLDOWN.test(String(state?.cooldown_reason || ''))
  }

  isGrantRevokeCooldown(state) {
    return (
      AccountRuntimeRepo.GRANT_REVOKE_COOLDOWN.test(String(state?.cooldown_reason || '')) ||
      (String(state?.status || '') === 'disabled' &&
        AccountRuntimeRepo.GRANT_REVOKE_COOLDOWN.test(String(state?.cooldown_reason || state?.status || '')))
    )
  }

  /** 读、判定、清除在同一事务里（不在判定之后清掉别的调用链刚写的冷却）；清除是字段级写入。 */
  async _clearIf(accountId, vmId, test, fields) {
    const cleared = await this.client.tx(async () => {
      const current = await this.get(accountId)
      if (!current || !test(current)) return false
      const vm = current.vm_id || vmId
      if (!vm) return false
      const created = !(await this.client.one('SELECT 1 FROM accounts WHERE id = ?', accountId))
      for (const [sql, params] of upsertStatements(
        { account_id: accountId, vm_id: vm, ...fields },
        { createdAccount: created },
      ))
        await this.client.run(sql, ...params)
      return true
    })
    if (cleared) await this.get(accountId)
    return cleared
  }

  /** Worker fresh / refresh success: drop only auth leftover so quota cools stay. */
  async clearAuthCooldown(accountId, { vmId = null } = {}) {
    return this._clearIf(accountId, vmId, (state) => this.isAuthCooldown(state), {
      status: 'ready',
      cooldown_until: null,
      cooldown_reason: null,
    })
  }

  /** Live login / import: drop leftover oauth_revoked disable. Quota cools stay. */
  async clearGrantRevokeCooldown(accountId, { vmId = null } = {}) {
    return this._clearIf(accountId, vmId, (state) => this.isGrantRevokeCooldown(state), {
      status: 'ready',
      cooldown_until: null,
      cooldown_reason: null,
    })
  }

  /** Operator / panel: drop account + per-model cooldown leftovers. */
  async clearAccountCooldown(accountId, { vmId = null } = {}) {
    return this._clearIf(accountId, vmId, () => true, {
      status: 'ready',
      cooldown_until: null,
      cooldown_reason: null,
      rate_limit_reset_at: null,
      overload_until: null,
      model_states: {},
    })
  }

  /** 到期清理：每个账号在事务里重读后只清已到期的字段与 model_states 键（json_remove），不整行写回。 */
  async clearExpired(now = Date.now()) {
    for (const listed of await this.list()) {
      if (!listed.vm_id || !expiredFields(listed, now)) continue
      await this.client.tx(async () => {
        const state = await this.get(listed.account_id)
        const expired = state?.vm_id ? expiredFields(state, now) : null
        if (!expired) return
        const { fields, models } = expired
        if (Object.keys(fields).length) {
          for (const [sql, params] of upsertStatements({
            account_id: state.account_id,
            vm_id: state.vm_id,
            ...fields,
          }))
            await this.client.run(sql, ...params)
        }
        for (const model of models) {
          await this.client.run(
            'UPDATE account_runtime SET model_states_json = json_remove(model_states_json, ?), updated_at = ? WHERE account_id = ?',
            modelStatePath(model),
            new Date().toISOString(),
            state.account_id,
          )
        }
      })
      await this.get(listed.account_id)
    }
  }

  async remove(accountId) {
    const removed = (await this.client.run(REMOVE_RT_SQL, accountId)).changes > 0
    await this.get(accountId)
    return removed
  }
}

function protectionOf(row) {
  if (!row) return null
  return {
    state: parse(row.protection_state_json, null),
    generation: Number(row.protection_generation) || 0,
  }
}

/** 到期的冷却字段与 model_states 键；都没到期时返回 null。 */
function expiredFields(state, now) {
  const fields = {}
  if (state.cooldown_until && state.cooldown_until <= now) {
    fields.status = 'ready'
    fields.cooldown_until = null
    fields.cooldown_reason = null
  }
  if (state.rate_limit_reset_at && state.rate_limit_reset_at <= now) fields.rate_limit_reset_at = null
  if (state.overload_until && state.overload_until <= now) fields.overload_until = null
  const models = []
  for (const [model, modelState] of Object.entries(state.model_states || {})) {
    if (modelState?.cooldown_until && Number(modelState.cooldown_until) <= now && !/["\\]/.test(model))
      models.push(model)
  }
  return Object.keys(fields).length || models.length ? { fields, models } : null
}
