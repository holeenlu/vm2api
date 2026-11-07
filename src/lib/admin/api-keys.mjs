import { validateIpRules, permitsIp } from './key-ip-rules.mjs'
/**
 * Multi API-key store (sub2api-inspired, SQLite-backed).
 *
 * Fields aligned to sub2api basics:
 *   name, status, expires_at, quota (+ used), spend windows,
 *   concurrency (per-key, sub2api puts this on User).
 *
 * Master env key KIN_API_KEY is separate and unlimited.
 * Managed keys live in the `api_keys` table (see lib/db/).
 * Transient state (inflight concurrency, RPM buckets) stays in memory,
 * mirroring sub2api's Redis-transient split.
 *
 * Auth always goes through `key_hash` (HMAC). `key_secret` is a separate
 * at-rest copy of the plaintext — encrypted with KIN_DB_SECRET when set — so
 * the panel can re-reveal a key for copying after creation.
 */

import { keyScopeFromRecord, refreshAuthenticatedKey } from './key-scope.mjs'
import { GroupsRepo } from '../db/repos/groups-repo.mjs'
import { normalizePeerSharing } from './peer-sharing.mjs'
import crypto from 'node:crypto'
import { resolveStoreDb } from '../db/database.mjs'
import { ApiKeysRepo } from '../db/repos/api-keys-repo.mjs'
import { maybeEncrypt, maybeDecrypt } from '../db/secure.mjs'
import { calculateCost, normalizeUsage } from './pricing.mjs'
import { applyRate, fromMicros, microsOf, toMicros } from '../core/money.mjs'
import { keyClientProfile, validateClientProfileSelection } from '../gateway-worker/codex-client-profile.mjs'
import { UsersRepo } from '../db/repos/users-repo.mjs'

const KEY_PREFIX = 'sk-vm-'
const HASH_MARKER = 'hmac:'

/** USD 额度字段：同时写整数微单位（权威值）与 REAL 镜像（M6）。 */
function setUsd(rec, key, value) {
  const micros = Math.max(0, toMicros(Number(value) || 0) ?? 0)
  rec[key + '_micros'] = micros
  rec[key] = fromMicros(micros)
}

/** USD 额度已用尽：比较整数微单位。 */
function usdQuotaReached(rec) {
  const quota = microsOf(rec.quota_micros) ?? 0
  return quota > 0 && (microsOf(rec.quota_used_micros) ?? 0) >= quota
}

function clampInt(n, min, max, fallback) {
  const v = Number(n)
  if (!Number.isFinite(v)) return fallback
  return Math.max(min, Math.min(max, Math.floor(v)))
}

function nowIso() {
  return new Date().toISOString()
}

export function generateApiKey(prefix = KEY_PREFIX) {
  return prefix + crypto.randomBytes(32).toString('hex')
}

export function maskApiKey(key) {
  const s = String(key || '')
  if (s.length <= 12) return s.slice(0, 4) + '…'
  return s.slice(0, 8) + '…' + s.slice(-4)
}

/**
 * Recoverable plaintext for a stored record, or null when only the hash is
 * left (keys created before `key_secret` existed).
 */
export function plainApiKey(rec) {
  if (!rec) return null
  if (rec._plain_key) return String(rec._plain_key)
  if (rec.key_secret) {
    try {
      const plain = maybeDecrypt(rec.key_secret)
      if (plain) return String(plain)
    } catch {
      return null
    }
  }
  if (rec.key && !String(rec.key).startsWith(HASH_MARKER)) return String(rec.key)
  return null
}

export function publicKeyView(rec, { reveal = false } = {}) {
  if (!rec) return null
  const plain = plainApiKey(rec)
  const masked = plain ? maskApiKey(plain) : `${rec.key_prefix || KEY_PREFIX}…${rec.key_suffix || 'hidden'}`
  return {
    id: rec.id,
    name: rec.name,
    key: reveal && plain ? plain : masked,
    revealable: !!plain,
    secret_status: plain ? 'available' : rec.key_secret ? 'decrypt_failed' : 'hash_only',
    key_prefix: rec.key_prefix || String(plain || KEY_PREFIX).slice(0, 10),
    status: rec.status,
    user_id: rec.user_id ?? null,
    group_id: rec.group_id ?? null,
    created_by_user_id: rec.created_by_user_id ?? null,
    max_concurrency: rec.max_concurrency,
    quota_requests: rec.quota_requests,
    // panel view keeps the historical name: quota_used = request count
    quota_used: rec.quota_requests_used ?? 0,
    quota_usd: rec.quota ?? 0,
    quota_usd_used: rec.quota_used ?? 0,
    rate_limit_5h: rec.rate_limit_5h ?? 0,
    rate_limit_1d: rec.rate_limit_1d ?? 0,
    rate_limit_7d: rec.rate_limit_7d ?? 0,
    usage_5h: rec.usage_5h ?? 0,
    usage_1d: rec.usage_1d ?? 0,
    usage_7d: rec.usage_7d ?? 0,
    rpm: rec.rpm,
    expires_at: rec.expires_at,
    created_at: rec.created_at,
    updated_at: rec.updated_at,
    last_used_at: rec.last_used_at,
    requests: rec.requests || 0,
    tokens_in: rec.tokens_in || 0,
    tokens_out: rec.tokens_out || 0,
    category: rec.category === 'api' ? 'api' : 'oauth',
    ip_whitelist: JSON.parse(rec.ip_whitelist || '[]'),
    ip_blacklist: JSON.parse(rec.ip_blacklist || '[]'),
    peer_sharing: normalizePeerSharing(rec.peer_sharing),
    codex_client_profile: keyClientProfile(rec),
    inflight: undefined, // filled by store.snapshot
  }
}

export class ApiKeyStore {
  constructor({ dataDir, db, hashSecret } = {}) {
    this.db = resolveStoreDb({ db, dataDir })
    this.repo = new ApiKeysRepo(this.db)
    this.hashSecret = String(
      hashSecret ||
        process.env.TAPMODELS_API_KEY_HASH_SECRET ||
        process.env.KIN_API_KEY_HASH_SECRET ||
        process.env.TAPMODELS_DB_SECRET ||
        process.env.KIN_DB_SECRET ||
        process.env.TAPMODELS_API_KEY ||
        process.env.KIN_API_KEY ||
        'kin-development-api-key-hash-secret',
    )
    this.userInflight = new Map()
    this.inflightOwners = new Map()
    this.inflight = new Map() // id → count
    this.rpmBuckets = new Map() // id → number[] timestamps ms
    this.users = new UsersRepo(this.db)
  }

  /** sub2api: an api key of a disabled/deleted user must not authenticate. */
  async _ownerActive(rec) {
    if (!rec?.user_id) return true // legacy unowned keys keep working
    try {
      const owner = await this.users.getById(rec.user_id)
      // soft-deleted owner is invisible here → key is revoked with them
      return !!owner && owner.status === 'active'
    } catch {
      return false
    }
  }

  /** Re-read from DB (no-op cache-wise; kept for API compat + post-restore). */
  reload() {}

  /** Re-bind to a fresh DB connection (after backup restore). 恢复的旧库可能带明文 Key，同样哈希化。 */
  async rebind(db) {
    this.db = db
    this.repo = new ApiKeysRepo(db)
    this.users = new UsersRepo(db)
    await this.hashLegacyPlaintextKeys()
  }

  /**
   * 残留明文 Key 一次性哈希化（审计阶段 1 W5，P1 未鉴权放大）：启动与备份恢复后各跑一次，之后鉴权只按 key_hash 查索引。
   * 原来哈希未命中时每次都把全表逐行与令牌比较（任意错误 Key 都触发一次全表扫描），已删除。
   * 同一明文已有哈希行（唯一索引冲突）时跳过该行并告警：它本来也鉴权不到（按哈希先命中已有行）。
   */
  async hashLegacyPlaintextKeys() {
    let hashed = 0
    for (const { id, key } of await this.repo.listPlaintextKeys()) {
      const token = String(key || '')
      if (!token.trim()) continue
      const keyHash = this._hash(token)
      try {
        const changed = await this.repo.hashPlaintextKey(id, token, {
          key: HASH_MARKER + keyHash,
          keyHash,
          keyPrefix: token.slice(0, 10),
          keySuffix: token.slice(-4),
          keySecret: maybeEncrypt(token),
          updatedAt: nowIso(),
        })
        if (changed) hashed += 1
      } catch (error) {
        console.warn(`[api-keys] plaintext key ${id} not hashed: ${error?.message || error}`)
      }
    }
    if (hashed) console.log(`[api-keys] hashed ${hashed} legacy plaintext key(s)`)
    return hashed
  }

  async list({ reveal = false } = {}) {
    const groups = new GroupsRepo(this.db)
    const out = []
    for (const k of await this.repo.list())
      out.push({
        ...publicKeyView(k, { reveal }),
        inflight: this.inflight.get(k.id) || 0,
        group_name: k.group_id ? (await groups.getById(k.group_id))?.name || null : '平台服务',
      })
    return out
  }

  async getById(id) {
    return this.repo.getById(id)
  }

  async authenticate(token) {
    if (!token) return { ok: false, reason: 'missing' }
    const hash = this._hash(token)
    const indexed = await this.repo.getByHash(hash)
    if (indexed) {
      if (!(await this._ownerActive(indexed))) return { ok: false, reason: 'user_disabled' }
      if (!plainApiKey(indexed)) {
        indexed.key_secret = maybeEncrypt(token)
        // 补存密文：重新读取并整行写回在同一个 db.tx 里，不覆盖读取之后并发写入的用量
        await this.repo.client.tx(async () => {
          const current = await this.repo.getById(indexed.id)
          if (current && !plainApiKey(current)) await this.repo.update({ ...current, key_secret: indexed.key_secret })
        })
      }
      return { ok: true, record: indexed }
    }
    return { ok: false, reason: 'invalid' }
  }

  async create(input = {}) {
    const name =
      String(input.name || 'default')
        .trim()
        .slice(0, 100) || 'default'
    let key = input.key ? String(input.key).trim() : generateApiKey()
    if (key.length < 16) throw Object.assign(new Error('key too short'), { code: 'key_too_short' })
    if (!/^[A-Za-z0-9_-]+$/.test(key)) {
      throw Object.assign(new Error('key has invalid characters'), { code: 'key_invalid' })
    }
    const keyHash = this._hash(key)
    if (await this.repo.getByHash(keyHash)) {
      throw Object.assign(new Error('key already exists'), { code: 'key_exists' })
    }

    const rec = {
      id: 'key_' + crypto.randomBytes(6).toString('hex'),
      name,
      key: HASH_MARKER + keyHash,
      key_hash: keyHash,
      key_prefix: key.slice(0, 10),
      key_suffix: key.slice(-4),
      key_secret: maybeEncrypt(key),
      status: 'active',
      max_concurrency: clampInt(input.max_concurrency, 0, 128, input.default_concurrency ?? 20),
      quota_requests: clampInt(input.quota_requests, 0, 1e9, 0),
      quota_requests_used: 0,
      user_id: input.user_id ?? null,
      group_id: input.group_id ?? null,
      created_by_user_id: input.created_by_user_id ?? null,
      ip_whitelist: JSON.stringify(validateIpRules(input.ip_whitelist || [])),
      ip_blacklist: JSON.stringify(validateIpRules(input.ip_blacklist || [])),
      peer_sharing: JSON.stringify(normalizePeerSharing(input.peer_sharing)),
      codex_client_profile: input.codex_client_profile
        ? JSON.stringify(validateClientProfileSelection(input.codex_client_profile))
        : null,
      rpm: clampInt(input.rpm, 0, 1e6, 0),
      expires_at: input.expires_at ? new Date(input.expires_at).toISOString() : null,
      created_at: nowIso(),
      updated_at: nowIso(),
      last_used_at: null,
      requests: 0,
      tokens_in: 0,
      tokens_out: 0,
      category: String(input.category || 'oauth').toLowerCase() === 'api' ? 'api' : 'oauth',
    }
    setUsd(rec, 'quota', input.quota)
    setUsd(rec, 'quota_used', 0)
    for (const key of ['rate_limit_5h', 'rate_limit_1d', 'rate_limit_7d']) setUsd(rec, key, input[key])
    if (rec.expires_at && Number.isNaN(Date.parse(rec.expires_at))) {
      throw Object.assign(new Error('invalid expires_at'), { code: 'invalid_expires_at' })
    }
    const stored = await this.repo.insert(rec)
    return { ...stored, key, _plain_key: key }
  }

  /** 整行读改写放在同一个 db.tx 里（R6 B7a）：异步化后不与并发的用量累加交错、不写回过期的计数。 */
  async update(id, patch = {}) {
    return this.repo.client.tx(() => this._update(id, patch))
  }

  async _update(id, patch) {
    const rec = await this.repo.getById(id)
    if (!rec) return null
    if (patch.name != null) rec.name = String(patch.name).trim().slice(0, 100) || rec.name
    if (patch.status != null) {
      const st = String(patch.status).toLowerCase()
      if (!['active', 'disabled'].includes(st)) {
        throw Object.assign(new Error('invalid status'), { code: 'invalid_status' })
      }
      rec.status = st
    }
    if (patch.max_concurrency != null)
      rec.max_concurrency = clampInt(patch.max_concurrency, 0, 128, rec.max_concurrency)
    if (patch.quota_requests != null) rec.quota_requests = clampInt(patch.quota_requests, 0, 1e9, rec.quota_requests)
    for (const key of ['quota', 'rate_limit_5h', 'rate_limit_1d', 'rate_limit_7d'])
      if (patch[key] != null) setUsd(rec, key, patch[key])
    if (Object.hasOwn(patch, 'group_id')) rec.group_id = patch.group_id == null ? null : Number(patch.group_id)
    if (patch.rpm != null) rec.rpm = clampInt(patch.rpm, 0, 1e6, rec.rpm)
    if (patch.expires_at === null) rec.expires_at = null
    else if (patch.expires_at != null) {
      const iso = new Date(patch.expires_at).toISOString()
      if (Number.isNaN(Date.parse(iso)))
        throw Object.assign(new Error('invalid expires_at'), { code: 'invalid_expires_at' })
      rec.expires_at = iso
    }
    if (patch.reset_quota === true) {
      rec.quota_requests_used = 0
      setUsd(rec, 'quota_used', 0)
    }
    // recover from quota_exhausted whenever spend is back under the cap
    if (
      rec.status === 'quota_exhausted' &&
      !usdQuotaReached(rec) &&
      !(rec.quota_requests > 0 && (rec.quota_requests_used ?? 0) >= rec.quota_requests)
    ) {
      rec.status = 'active'
    }
    if (patch.category != null) {
      rec.category = String(patch.category).toLowerCase() === 'api' ? 'api' : 'oauth'
    }
    for (const field of ['ip_whitelist', 'ip_blacklist'])
      if (patch[field] != null) rec[field] = JSON.stringify(validateIpRules(patch[field]))
    if (patch.peer_sharing != null) rec.peer_sharing = JSON.stringify(normalizePeerSharing(patch.peer_sharing))
    // Key 级上游客户端画像：null 继承通用设置
    if (Object.hasOwn(patch, 'codex_client_profile')) {
      rec.codex_client_profile = patch.codex_client_profile
        ? JSON.stringify(validateClientProfileSelection(patch.codex_client_profile))
        : null
    }
    rec.updated_at = nowIso()
    return this.repo.update(rec)
  }

  /**
   * Plaintext of a managed key for panel copy.
   * @returns {null | { ok: false, code: string } | { ok: true, id, name, key }}
   */
  async reveal(id) {
    const rec = await this.repo.getById(id)
    if (!rec) return null
    const key = plainApiKey(rec)
    if (!key) return { ok: false, code: rec.key_secret ? 'key_decryption_failed' : 'key_not_recoverable' }
    return { ok: true, id: rec.id, name: rec.name, key }
  }

  /** Issue a fresh plaintext on the same record; the old value stops working. */
  async rotate(id) {
    return this.repo.client.tx(() => this._rotate(id))
  }

  async _rotate(id) {
    const rec = await this.repo.getById(id)
    if (!rec) return null
    const key = generateApiKey()
    const keyHash = this._hash(key)
    if (await this.repo.getByHash(keyHash)) {
      throw Object.assign(new Error('key already exists'), { code: 'key_exists' })
    }
    rec.key = HASH_MARKER + keyHash
    rec.key_hash = keyHash
    rec.key_prefix = key.slice(0, 10)
    rec.key_suffix = key.slice(-4)
    rec.key_secret = maybeEncrypt(key)
    rec.updated_at = nowIso()
    const stored = await this.repo.update(rec)
    return { ...stored, key, _plain_key: key }
  }

  async remove(id) {
    const removed = await this.repo.remove(id)
    if (!removed) return false
    // Live reservations survive deletion until their request releases them.
    this.rpmBuckets.delete(`key:${id}`)
    return true
  }

  _expired(rec, now = Date.now()) {
    if (!rec.expires_at) return false
    return Date.parse(rec.expires_at) <= now
  }

  _rpmCount(id, now = Date.now()) {
    const windowMs = 60_000
    let arr = this.rpmBuckets.get(id) || []
    arr = arr.filter((t) => now - t < windowMs)
    this.rpmBuckets.set(id, arr)
    return arr.length
  }

  /**
   * 准入所需的库内数据（所属用户、分组、用户分组覆盖），先一次 await 读齐（竞态 R7）：
   * 之后的内存计数检查与自增在同一个同步段里完成，中间没有 await。
   */
  async _limitFacts(rec) {
    const groups = new GroupsRepo(this.db)
    const owner = rec?.user_id ? await this.users.getById(rec.user_id) : null
    const override = rec?.user_id && rec.group_id ? await groups.override(rec.user_id, rec.group_id) : null
    const group = rec?.group_id && override?.rpm_limit == null ? await groups.getById(rec.group_id) : null
    return { owner, override, group }
  }

  _rpmPolicies(rec, { owner, override, group }) {
    const overrideRpm = override?.rpm_limit
    return [
      { bucket: `key:${rec.id}`, limit: rec.rpm || 0, code: 'api_key_rate_limit' },
      {
        bucket: rec.user_id ? `user:${rec.user_id}` : null,
        limit: rec.user_id ? owner?.rpm_limit || 0 : 0,
        code: 'user_rate_limit',
      },
      {
        bucket: rec.group_id ? `group:${rec.group_id}:user:${rec.user_id || 'platform'}` : null,
        limit: overrideRpm ?? (rec.group_id ? group?.rpm_limit || 0 : 0),
        code: 'group_rate_limit',
      },
    ]
  }

  _userConcurrencyCap(rec, { owner }) {
    if (!rec?.user_id) return 0
    return owner?.role === 'super_admin' ? 0 : Number(owner?.concurrency) || 0
  }

  /**
   * 该 Key 实际生效的请求上限（CPR 互联 key_limits）：并发取 Key 与所属用户上限中较小的正数，
   * RPM 取 Key、用户、分组（含用户覆盖）中较小的正数；0 表示不限。与 check() 使用同一组限制来源。
   */
  async effectiveLimits(rec) {
    const positive = (values) => {
      const list = values.map(Number).filter((value) => Number.isFinite(value) && value > 0)
      return list.length ? Math.min(...list) : 0
    }
    const facts = await this._limitFacts(rec)
    return {
      max_concurrency: positive([rec?.max_concurrency, this._userConcurrencyCap(rec, facts)]),
      requests_per_minute: positive(
        this._rpmPolicies(rec, facts)
          .filter((p) => p.bucket)
          .map((p) => p.limit),
      ),
    }
  }

  /**
   * Pre-flight gate for a managed key. Does not acquire concurrency.
   * @returns {{ ok: true } | { ok: false, code, message, status }}
   */
  permitsIp(rec, address) {
    return permitsIp(rec, address)
  }

  /**
   * 准入的库内部分：复核 Key、分组与额度窗口，并读齐限流所需数据。返回的 `facts` 交给同步的 `_admitTransient`。
   * @returns {Promise<{ ok: true, record, facts } | { ok: false, code, message, status }>}
   */
  async _admitStored(rec, now, address) {
    const live = await refreshAuthenticatedKey(rec, this.db)
    if (live.error)
      return {
        ok: false,
        code: live.error,
        message: 'API key is no longer valid; retry with current credentials',
        status: 403,
      }
    rec = live.record
    if (address !== undefined && !this.permitsIp(rec, address))
      return { ok: false, code: 'ip_not_allowed', message: 'Client IP is not allowed', status: 403 }
    if (!rec) return { ok: false, code: 'invalid_api_key', message: 'Invalid credentials', status: 401 }
    const scope = await keyScopeFromRecord(rec, this.db)
    if (scope.error) return { ok: false, code: scope.error, message: '分组不可用或无权调用', status: 403 }
    if (rec.status !== 'active') {
      if (rec.status === 'quota_exhausted') {
        return { ok: false, code: 'api_key_quota_exhausted', message: 'API key quota exhausted', status: 429 }
      }
      return { ok: false, code: 'api_key_disabled', message: 'API key is disabled', status: 403 }
    }
    if (this._expired(rec, now)) {
      return { ok: false, code: 'api_key_expired', message: 'API key has expired', status: 403 }
    }
    if (rec.quota_requests > 0 && (rec.quota_requests_used ?? 0) >= rec.quota_requests) {
      return {
        ok: false,
        code: 'api_key_quota_exhausted',
        message: 'API key quota exhausted',
        status: 429,
        detail: { quota_requests: rec.quota_requests, quota_used: rec.quota_requests_used },
      }
    }
    if (usdQuotaReached(rec)) {
      return {
        ok: false,
        code: 'api_key_quota_exhausted',
        message: 'API key USD quota exhausted',
        status: 429,
        detail: { quota: rec.quota, quota_used: rec.quota_used },
      }
    }
    // sub2api rate windows: limit > 0 and the current window is still open
    for (const [limitKey, usageKey, startKey, ms] of [
      ['rate_limit_5h', 'usage_5h', 'window_5h_start', 5 * 3600_000],
      ['rate_limit_1d', 'usage_1d', 'window_1d_start', 24 * 3600_000],
      ['rate_limit_7d', 'usage_7d', 'window_7d_start', 7 * 24 * 3600_000],
    ]) {
      const limit = microsOf(rec[limitKey + '_micros']) ?? 0
      if (limit <= 0) continue
      const start = rec[startKey] ? Date.parse(rec[startKey]) : NaN
      const windowOpen = Number.isFinite(start) && now - start < ms
      const used = microsOf(rec[usageKey + '_micros']) ?? 0
      if (windowOpen && used >= limit) {
        return {
          ok: false,
          code: 'api_key_rate_limit',
          message: `API key ${limitKey.replace('rate_limit_', '')} spend limit exceeded`,
          status: 429,
          detail: { limit: fromMicros(limit), used: fromMicros(used) },
        }
      }
    }
    return { ok: true, record: rec, facts: await this._limitFacts(rec) }
  }

  /** 准入的内存部分（RPM、Key 并发、用户并发）：同步执行，不读库。 */
  _admitTransient(rec, facts, now) {
    for (const { bucket, limit, code } of this._rpmPolicies(rec, facts)) {
      if (bucket && limit > 0 && this._rpmCount(bucket, now) >= limit) {
        return {
          ok: false,
          code,
          message: '每分钟请求上限已达到',
          status: 429,
          detail: { limit, current: this._rpmCount(bucket, now) },
        }
      }
    }
    const inflight = this.inflight.get(rec.id) || 0
    if (rec.max_concurrency > 0 && inflight >= rec.max_concurrency) {
      return {
        ok: false,
        code: 'api_key_concurrency_limit',
        message: `API key concurrency limit (${rec.max_concurrency})`,
        status: 429,
        detail: { inflight, max: rec.max_concurrency },
      }
    }
    // sub2api user-level cap: sum of inflight across all of the owner's keys.
    // The operator (admin) is never capped: its traffic is the platform's own.
    if (rec.user_id) {
      const cap = this._userConcurrencyCap(rec, facts)
      if (cap > 0) {
        const total = this.userInflight.get(rec.user_id) || 0
        if (total >= cap) {
          return {
            ok: false,
            code: 'user_concurrency_limit',
            message: `User concurrency limit (${cap})`,
            status: 429,
            detail: { inflight: total, max: cap },
          }
        }
      }
    }
    return { ok: true, record: rec }
  }

  async canAccept(rec, now = Date.now(), address) {
    const stored = await this._admitStored(rec, now, address)
    if (!stored.ok) return stored
    return this._admitTransient(stored.record, stored.facts, now)
  }

  async acquire(rec, now = Date.now(), address) {
    const stored = await this._admitStored(rec, now, address)
    if (!stored.ok) return stored
    // 竞态 R7：从这里到返回是一个同步段（检查内存计数 + 自增，中间没有 await），并发请求不会同时通过上限检查
    const gate = this._admitTransient(stored.record, stored.facts, now)
    if (!gate.ok) return gate
    rec = gate.record
    const id = rec.id
    this.inflight.set(id, (this.inflight.get(id) || 0) + 1)
    if (rec.user_id) {
      this.inflightOwners.set(id, rec.user_id)
      this.userInflight.set(rec.user_id, (this.userInflight.get(rec.user_id) || 0) + 1)
    }
    for (const { bucket } of this._rpmPolicies(rec, stored.facts)) {
      if (!bucket) continue
      this._rpmCount(bucket, now)
      const values = this.rpmBuckets.get(bucket)
      values.push(now)
    }
    return { ok: true }
  }

  release(recOrId) {
    const id = typeof recOrId === 'string' ? recOrId : recOrId?.id
    if (!id || !this.inflight.has(id)) return
    const owner = this.inflightOwners.get(id)
    if (owner) {
      const remaining = (this.userInflight.get(owner) || 0) - 1
      if (remaining > 0) this.userInflight.set(owner, remaining)
      else this.userInflight.delete(owner)
    }
    const n = (this.inflight.get(id) || 0) - 1
    if (n <= 0) {
      this.inflight.delete(id)
      this.inflightOwners.delete(id)
    } else this.inflight.set(id, n)
  }

  /**
   * 金额参数为整数微单位（M6）：`actualCostMicros` 是结算的实际扣费，`officialCostMicros` 是官方价；
   * 没有实际扣费时按官方价 × 倍率（applyRate，四舍五入一次）。
   */
  async recordUsage(
    recOrId,
    usage = {},
    { model = null, rateMultiplier = 1, officialCostMicros, actualCostMicros } = {},
  ) {
    const id = typeof recOrId === 'string' ? recOrId : recOrId?.id
    if (!(await this.repo.getById(id))) return null
    const normalized = normalizeUsage(usage)
    let billed = microsOf(officialCostMicros)
    if (billed == null) billed = microsOf(usage.total_cost_micros) ?? toMicros(usage.total_cost)
    if (billed == null && model) {
      try {
        const c = calculateCost(normalized, model)
        if (c?.known) billed = c.total_cost_micros
      } catch {}
    }
    if (billed == null) billed = toMicros(usage.cost ?? usage.actual_cost) || 0
    // key quota/windows track actual (group-rated) spend, sub2api-style
    const rate = Number.isFinite(Number(rateMultiplier)) ? Number(rateMultiplier) : 1
    const cost = microsOf(actualCostMicros) ?? applyRate(billed, rate) ?? 0
    const rec = await this.repo.recordUsage(id, {
      tokens_in: Number(normalized.input_tokens) || Number(normalized.tokens_in) || 0,
      tokens_out: Number(normalized.output_tokens) || Number(normalized.tokens_out) || 0,
      cache_read_tokens: Number(normalized.cache_read_input_tokens ?? normalized.cache_read_tokens) || 0,
      cache_creation_tokens: Number(normalized.cache_creation_input_tokens ?? normalized.cache_creation_tokens) || 0,
      cost_micros: cost,
    })
    // sub2api: the billing write flips the key when the USD quota runs out.
    // 竞态 R8：条件更新（仍为 active 且已用达到上限才翻转），不整行写回覆盖并发修改的其他字段
    if (rec && rec.status === 'active' && usdQuotaReached(rec)) {
      await this.repo.markQuotaExhausted(id, nowIso())
    }
    return rec
  }

  async snapshot() {
    const keys = await this.list({ reveal: false })
    return {
      total: keys.length,
      active: keys.filter((k) => k.status === 'active').length,
      keys,
    }
  }

  _hash(token) {
    return crypto
      .createHmac('sha256', this.hashSecret)
      .update(String(token || ''))
      .digest('hex')
  }
}
