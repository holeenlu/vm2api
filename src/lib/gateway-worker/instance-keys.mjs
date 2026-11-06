/**
 * 按实例签发的 Gateway 内部 HMAC 密钥（中期技术债 M2：执行器信任边界；设计 5.1、6.2，运维见 SETUP 第 2、7 节）。
 *
 * - 引导必须有授权（审查 P0-1/P0-2/P0-3）：
 *   - 控制面托管的同机 Worker：托管器每次拉起子进程时生成一次性引导令牌（经子进程环境传入，控制面内存里只存摘要），
 *     Worker 注册时出示即可引导，用一次就作废；
 *   - 外部 Worker：管理员在面板上“允许引导”，为该实例开一个一次性、限时（默认 10 分钟）的授权窗口
 *     （gateway_worker_bootstrap_grants，写审计）。
 *   没有授权时不签发、不吊销任何已有密钥。授权在签发事务内消耗；事务内再查一次：已有已确认且有效的密钥时拒绝签发。
 * - 存储：只存 AES-256-GCM 密文（附加认证数据绑定实例与 key_id）。包裹密钥由数据库字段密钥 TAPMODELS_DB_SECRET /
 *   KIN_DB_SECRET 派生；没有配置时用 runtime-secrets.json 里单独生成的随机值 KIN_CODEX_GATEWAY_INSTANCE_KEY_WRAP
 *   （不再从共用令牌派生）。密文前缀记录来源。
 * - 下发：新密钥不明文下发，用请求方已持有的秘密（引导令牌、共用令牌或旧实例密钥）派生的密钥加密包裹。
 * - 轮换：新密钥为 active，旧 active 改为 retiring，宽限期（默认 10 分钟）内仍有效。轮换不能处置泄露：持有旧密钥的一方
 *   同样能在宽限期内拿到新密钥。处置泄露：吊销、更换共用令牌、再重新授权引导。
 * - 吊销：全部密钥立即失效；之后必须重新授权才能再引导。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { dbClient } from '../db/db-client.mjs'
import { audit } from '../admin/relay-common.mjs'

export const INSTANCE_KEY_MODES = Object.freeze(['off', 'on', 'required'])
export const DEFAULT_INSTANCE_KEY_GRACE_MS = 10 * 60_000
export const DEFAULT_BOOTSTRAP_WINDOW_MS = 10 * 60_000
// 轮换后 Worker 离线超过宽限期：上一把密钥在这个窗口内仍可换取尚未被用过的新密钥（复审 P2-7）
export const DEFAULT_RENEW_WINDOW_MS = 24 * 3600_000
export const INSTANCE_KEY_WRAP_SECRET = 'KIN_CODEX_GATEWAY_INSTANCE_KEY_WRAP'
const SIGNING_CACHE_MS = 5_000
const SEAL_PREFIX = 'ik1'
// 实例 ID 字符集（审查 P2）：首字符为字母或数字，其余为字母、数字、点、下划线、连字符，最长 64
export const INSTANCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export function validInstanceId(value) {
  return typeof value === 'string' && INSTANCE_ID_PATTERN.test(value)
}

/**
 * KIN_CODEX_GATEWAY_INSTANCE_KEYS：
 * - off：不签发新密钥，共用令牌对所有实例有效（已签发的密钥仍可用于校验与签名，便于回滚）；
 * - on（默认）：有引导授权的 Worker 注册时签发；已签发（Worker 已用过密钥）的实例只接受实例密钥，
 *   未签发的实例仍可用共用令牌（不签发）；
 * - required：共用令牌只能用于有引导授权的注册，其他请求一律要求实例密钥。
 * 拼错按默认值 on 运行（「Gateway Worker」页与启动日志标出）。
 */
export function instanceKeysMode(env = process.env) {
  const value = String(env.KIN_CODEX_GATEWAY_INSTANCE_KEYS ?? '')
    .trim()
    .toLowerCase()
  return INSTANCE_KEY_MODES.includes(value) ? value : 'on'
}

function positiveSeconds(raw, fallback) {
  const seconds = Number(raw)
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : fallback
}

export function instanceKeyGraceMs(env = process.env) {
  return positiveSeconds(env.KIN_CODEX_GATEWAY_INSTANCE_KEY_GRACE_SECONDS, DEFAULT_INSTANCE_KEY_GRACE_MS)
}

export function renewWindowMs(env = process.env) {
  return positiveSeconds(env.KIN_CODEX_GATEWAY_INSTANCE_KEY_RENEW_SECONDS, DEFAULT_RENEW_WINDOW_MS)
}

export function bootstrapWindowMs(env = process.env) {
  return positiveSeconds(env.KIN_CODEX_GATEWAY_BOOTSTRAP_WINDOW_SECONDS, DEFAULT_BOOTSTRAP_WINDOW_MS)
}

/** 常量时间比较两个字符串（共用令牌等）。 */
export function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''))
  const right = Buffer.from(String(b ?? ''))
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right)
}

// runtime-secrets.json 与数据库同目录（与 data/runtime-secrets.json 的约定一致）
function runtimeSecretsFile(env, db) {
  let location = null
  try {
    location = db?.location?.() || null
  } catch {}
  const dir = location ? path.dirname(location) : env.KIN_DATA_DIR || path.join(process.cwd(), 'data')
  return path.join(dir, 'runtime-secrets.json')
}

// 包裹密钥的独立随机值：环境变量优先；否则读 runtime-secrets.json，签发时没有就生成并写回（0600）
function wrapRandomSecret(env, db, create) {
  if (env[INSTANCE_KEY_WRAP_SECRET]) return String(env[INSTANCE_KEY_WRAP_SECRET])
  const file = runtimeSecretsFile(env, db)
  let saved = {}
  try {
    saved = JSON.parse(fs.readFileSync(file, 'utf8')) || {}
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (saved[INSTANCE_KEY_WRAP_SECRET]) return String(saved[INSTANCE_KEY_WRAP_SECRET])
  if (!create) return ''
  const value = crypto.randomBytes(32).toString('hex')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, `${JSON.stringify({ ...saved, [INSTANCE_KEY_WRAP_SECRET]: value })}\n`, { mode: 0o600 })
  fs.renameSync(temp, file)
  fs.chmodSync(file, 0o600)
  return value
}

function wrapSecret(env, source, db, create = false) {
  if (source === 'db') return env.TAPMODELS_DB_SECRET || env.KIN_DB_SECRET || ''
  if (source === 'wrap') return wrapRandomSecret(env, db, create)
  return ''
}

function wrapKey(env, source, db, create = false) {
  const secret = wrapSecret(env, source, db, create)
  if (!secret)
    throw Object.assign(new Error(`instance key wrapping secret (${source}) is not configured`), {
      code: 'instance_key_wrap_unavailable',
    })
  return Buffer.from(crypto.hkdfSync('sha256', String(secret), 'kin-gateway-instance-key', `wrap/v1/${source}`, 32))
}

const aad = (instanceId, keyId) => Buffer.from(`kin-gateway-instance-key/v1\n${instanceId}\n${keyId}`)

/** 加密实例密钥：ik1:<来源 db|wrap>:<iv>:<tag>:<密文>（base64url）。 */
export function sealInstanceSecret(instanceId, keyId, secret, env = process.env, db = null) {
  const source = wrapSecret(env, 'db', db) ? 'db' : 'wrap'
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', wrapKey(env, source, db, true), iv)
  cipher.setAAD(aad(instanceId, keyId))
  const sealed = Buffer.concat([cipher.update(String(secret), 'utf8'), cipher.final()])
  return [SEAL_PREFIX, source, iv, cipher.getAuthTag(), sealed]
    .map((part) => (Buffer.isBuffer(part) ? part.toString('base64url') : part))
    .join(':')
}

export function openInstanceSecret(instanceId, keyId, sealed, env = process.env, db = null) {
  const [prefix, source, iv, tag, data] = String(sealed || '').split(':')
  if (prefix !== SEAL_PREFIX || !['db', 'wrap'].includes(source) || !iv || !tag || data == null)
    throw Object.assign(new Error('instance key record is malformed'), { code: 'instance_key_unreadable' })
  const decipher = crypto.createDecipheriv('aes-256-gcm', wrapKey(env, source, db), Buffer.from(iv, 'base64url'))
  decipher.setAAD(aad(instanceId, keyId))
  decipher.setAuthTag(Buffer.from(tag, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8')
}

/** 实例密钥指纹（SHA-256 前 8 字节），用于面板与日志核对；不能反推出密钥。 */
export function instanceKeyFingerprint(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest('hex').slice(0, 16)
}

/**
 * 下发新密钥时的包裹（审查 P2）：用请求方已持有的秘密（引导令牌、共用令牌或本次签名用的旧实例密钥）经 HKDF-SHA256
 * 派生 AES-256-GCM 密钥，附加认证数据绑定实例、新 key_id 与本次请求的随机串。输出 base64url(iv ‖ 密文 ‖ tag)。
 * Worker 侧 instance_key.go 的 unwrapDeliveredKey 与之对应。
 */
export function wrapDeliveredSecret(holderSecret, { instanceId, keyId, nonce }, secret) {
  const key = Buffer.from(
    crypto.hkdfSync('sha256', String(holderSecret), 'kin-gateway-key-delivery', `v1\n${instanceId}\n${keyId}`, 32),
  )
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(`${instanceId}\n${keyId}\n${nonce}`))
  const sealed = Buffer.concat([cipher.update(String(secret), 'utf8'), cipher.final()])
  return Buffer.concat([iv, sealed, cipher.getAuthTag()]).toString('base64url')
}

export function unwrapDeliveredSecret(holderSecret, { instanceId, keyId, nonce }, wrapped) {
  const raw = Buffer.from(String(wrapped || ''), 'base64url')
  const key = Buffer.from(
    crypto.hkdfSync('sha256', String(holderSecret), 'kin-gateway-key-delivery', `v1\n${instanceId}\n${keyId}`, 32),
  )
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12))
  decipher.setAAD(Buffer.from(`${instanceId}\n${keyId}\n${nonce}`))
  decipher.setAuthTag(raw.subarray(raw.length - 16))
  return Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString('utf8')
}

const iso = (ms) => new Date(ms).toISOString()

export function createInstanceKeyStore({ db, env = process.env, now = () => Date.now(), log = console } = {}) {
  const handle = () => (typeof db === 'function' ? db() : db)
  const c = () => dbClient(handle())
  const signingCache = new Map()
  const invalidate = (instanceId) => (instanceId ? signingCache.delete(instanceId) : signingCache.clear())
  const usable = (row, at = now()) =>
    !!row && (row.state === 'active' || (row.state === 'retiring' && row.expires_at && Date.parse(row.expires_at) > at))
  const open = (row) => openInstanceSecret(row.instance_id, row.key_id, row.sealed_secret, env, handle())

  async function rows(instanceId) {
    return c().many(
      "SELECT * FROM gateway_worker_instance_keys WHERE instance_id=? AND state<>'revoked' ORDER BY created_at DESC, key_id DESC",
      instanceId,
    )
  }

  // 生成与加密在事务外完成（可能要写 runtime-secrets.json），事务体内不等待 I/O
  function newKey(instanceId, actor) {
    const keyId = `ik_${crypto.randomBytes(9).toString('base64url')}`
    const secret = crypto.randomBytes(32).toString('hex')
    return {
      keyId,
      secret,
      row: {
        key_id: keyId,
        instance_id: instanceId,
        sealed_secret: sealInstanceSecret(instanceId, keyId, secret, env, handle()),
        fingerprint: instanceKeyFingerprint(secret),
        created_at: iso(now()),
        created_by: actor,
      },
    }
  }

  async function insert(tx, row) {
    await tx.run(
      "INSERT INTO gateway_worker_instance_keys(key_id,instance_id,sealed_secret,fingerprint,state,created_at,created_by) VALUES(?,?,?,?,'active',?,?)",
      row.key_id,
      row.instance_id,
      row.sealed_secret,
      row.fingerprint,
      row.created_at,
      row.created_by,
    )
  }

  const api = {
    mode: () => instanceKeysMode(env),
    graceMs: () => instanceKeyGraceMs(env),
    invalidate,

    /** 实例是否“已签发”：存在 Worker 已用过（confirmed）且仍有效的密钥。 */
    async issued(instanceId) {
      const at = now()
      return (await rows(instanceId)).some((row) => row.confirmed_at && usable(row, at))
    },

    /** 实例是否有任何仍有效的密钥（含已签发、Worker 还没用过的）。 */
    async hasLiveKey(instanceId) {
      const at = now()
      return (await rows(instanceId)).some((row) => usable(row, at))
    },

    /** 该实例当前是否有未过期、未使用的引导授权（只读，用于决定是否尝试引导）。 */
    async bootstrapGrant(instanceId) {
      return c().one(
        'SELECT * FROM gateway_worker_bootstrap_grants WHERE instance_id=? AND consumed_at IS NULL AND expires_at>?',
        instanceId,
        iso(now()),
      )
    },

    /** 管理员允许引导：为实例开一个一次性、限时的授权窗口（覆盖之前未用的授权），写审计。 */
    async allowBootstrap(instanceId, { actor = 'system', windowMs = bootstrapWindowMs(env) } = {}) {
      const stamp = now()
      const expiresAt = iso(stamp + windowMs)
      await c().tx(async (tx) => {
        await tx.run(
          `INSERT INTO gateway_worker_bootstrap_grants(instance_id,created_by,created_at,expires_at,consumed_at,consumed_key_id)
             VALUES(?,?,?,?,NULL,NULL)
             ON CONFLICT(instance_id) DO UPDATE SET created_by=excluded.created_by,created_at=excluded.created_at,
               expires_at=excluded.expires_at,consumed_at=NULL,consumed_key_id=NULL`,
          instanceId,
          actor,
          iso(stamp),
          expiresAt,
        )
        await audit(handle(), actor, 'gateway.instance_key.bootstrap_allowed', instanceId, null, {
          expires_at: expiresAt,
        })
      })
      return { instance_id: instanceId, expires_at: expiresAt }
    },

    /**
     * 引导签发。authorization：
     *   { kind: 'supervisor', allowed: (liveKeyIds) => boolean, commit(keyId) }（同机托管的一次性引导令牌；
     *     事务提交后由调用方 commit 标记为已用。已用过的令牌在它签发的密钥尚未确认时仍可重新引导，用于响应丢失或
     *     Worker 落盘失败后的自愈）
     *   { kind: 'grant' }（管理员授权窗口，在事务内消耗）
     * 事务内：已有已确认且有效的密钥 → 拒绝（instance_key_already_issued，不消耗授权）；授权消耗失败 → 拒绝
     * （instance_key_bootstrap_not_allowed）；否则吊销该实例未确认的密钥并签发新的 active 密钥，写审计。
     */
    async bootstrap(instanceId, { authorization, actor = 'system:gateway-register' } = {}) {
      if (!authorization) return { ok: false, code: 'instance_key_bootstrap_not_allowed' }
      const fresh = newKey(instanceId, actor)
      const result = await c().tx(async (tx) => {
        const stamp = iso(now())
        const live = await tx.many(
          "SELECT key_id,state,confirmed_at,expires_at FROM gateway_worker_instance_keys WHERE instance_id=? AND state<>'revoked'",
          instanceId,
        )
        if (live.some((row) => row.confirmed_at && usable(row)))
          return { ok: false, code: 'instance_key_already_issued' }
        if (authorization.kind === 'supervisor') {
          // 托管令牌在事务提交后才标记为已用（复审 P1-2）；已用过的令牌只能重新引导它签发、尚未确认的那把密钥
          if (!authorization.allowed(live.filter((row) => usable(row)).map((row) => row.key_id)))
            return { ok: false, code: 'instance_key_bootstrap_not_allowed' }
        } else {
          const consumed = await tx.run(
            'UPDATE gateway_worker_bootstrap_grants SET consumed_at=?,consumed_key_id=? WHERE instance_id=? AND consumed_at IS NULL AND expires_at>?',
            stamp,
            fresh.keyId,
            instanceId,
            stamp,
          )
          if (!Number(consumed.changes || 0)) return { ok: false, code: 'instance_key_bootstrap_not_allowed' }
        }
        await tx.run(
          "UPDATE gateway_worker_instance_keys SET state='revoked',revoked_at=? WHERE instance_id=? AND state<>'revoked'",
          stamp,
          instanceId,
        )
        await insert(tx, fresh.row)
        await audit(handle(), actor, 'gateway.instance_key.issued', instanceId, null, {
          key_id: fresh.keyId,
          fingerprint: fresh.row.fingerprint,
          authorization: authorization.kind,
          replaced: live.map((row) => row.key_id),
        })
        return { ok: true }
      })
      invalidate(instanceId)
      if (!result.ok) return result
      return { ok: true, key_id: fresh.keyId, secret: fresh.secret, fingerprint: fresh.row.fingerprint }
    },

    /**
     * 在线轮换：新密钥成为 active，原 active 改为 retiring、宽限期内仍有效；原 active 从未被 Worker 用过时直接吊销。
     * 没有 active 密钥时返回 null（实例未签发）。注意：持有旧密钥的一方同样能拿到新密钥，轮换不能处置泄露。
     */
    async rotate(instanceId, { actor = 'system', graceMs = instanceKeyGraceMs(env) } = {}) {
      const fresh = newKey(instanceId, actor)
      const result = await c().tx(async (tx) => {
        const current = await tx.one(
          "SELECT * FROM gateway_worker_instance_keys WHERE instance_id=? AND state='active' ORDER BY created_at DESC LIMIT 1",
          instanceId,
        )
        if (!current) return null
        const stamp = now()
        const expiresAt = current.confirmed_at ? iso(stamp + graceMs) : null
        if (current.confirmed_at)
          await tx.run(
            "UPDATE gateway_worker_instance_keys SET state='retiring',expires_at=?,superseded_by=? WHERE instance_id=? AND state='active'",
            expiresAt,
            fresh.keyId,
            instanceId,
          )
        else {
          await tx.run(
            "UPDATE gateway_worker_instance_keys SET state='revoked',revoked_at=? WHERE instance_id=? AND state='active'",
            iso(stamp),
            instanceId,
          )
          // 被吊销的是还没确认的接替者：它的前任改为指向新密钥，离线的 Worker 仍能用前任续接（第三轮复审 P2-3）
          await tx.run(
            'UPDATE gateway_worker_instance_keys SET superseded_by=? WHERE instance_id=? AND superseded_by=?',
            fresh.keyId,
            instanceId,
            current.key_id,
          )
        }
        await insert(tx, fresh.row)
        await audit(
          handle(),
          actor,
          'gateway.instance_key.rotated',
          instanceId,
          { key_id: current.key_id, fingerprint: current.fingerprint },
          { key_id: fresh.keyId, fingerprint: fresh.row.fingerprint, previous_expires_at: expiresAt },
        )
        return {
          key_id: fresh.keyId,
          fingerprint: fresh.row.fingerprint,
          previous_key_id: current.key_id,
          previous_expires_at: expiresAt,
        }
      })
      invalidate(instanceId)
      return result
    },

    /** 吊销该实例的全部密钥（立即失效），并作废未使用的引导授权。返回被吊销的 key_id 列表。 */
    async revoke(instanceId, { actor = 'system', reason = 'revoked' } = {}) {
      const revoked = await c().tx(async (tx) => {
        const live = await tx.many(
          "SELECT key_id,fingerprint FROM gateway_worker_instance_keys WHERE instance_id=? AND state<>'revoked'",
          instanceId,
        )
        const stamp = iso(now())
        await tx.run(
          'UPDATE gateway_worker_bootstrap_grants SET expires_at=? WHERE instance_id=? AND consumed_at IS NULL AND expires_at>?',
          stamp,
          instanceId,
          stamp,
        )
        if (!live.length) return []
        await tx.run(
          "UPDATE gateway_worker_instance_keys SET state='revoked',revoked_at=? WHERE instance_id=? AND state<>'revoked'",
          stamp,
          instanceId,
        )
        await audit(handle(), actor, 'gateway.instance_key.revoked', instanceId, { keys: live }, null, reason)
        return live.map((row) => row.key_id)
      })
      invalidate(instanceId)
      return revoked
    },

    /**
     * 校验实例密钥签名（不记确认：调用方在 mTLS 与 nonce 检查都通过后再调 confirm）。
     * 未知、已吊销、宽限期已过的密钥统一返回 instance_key_invalid（具体原因只在 reason 里，供日志）；能解开的
     * 已吊销或过期密钥随 responseSecret 返回，用于给这条拒绝响应签名，让 Worker 能确认拒绝确实来自控制面。
     */
    async verify({ instanceId, keyId, headers, body, method, path: target, verifyHeaders }) {
      const row = await c().one('SELECT * FROM gateway_worker_instance_keys WHERE key_id=?', String(keyId || ''))
      const invalid = (reason, responseSecret = null) => ({
        ok: false,
        code: 'instance_key_invalid',
        reason,
        responseSecret,
      })
      if (!row || row.instance_id !== instanceId) return invalid('unknown')
      let secret
      try {
        secret = open(row)
      } catch (error) {
        log.warn?.(`gateway instance key ${row.key_id} for ${instanceId} cannot be opened: ${error.message}`)
        return invalid('unreadable')
      }
      const signature = verifyHeaders({ secret, headers, body, method, path: target })
      if (!signature.ok) return { ok: false, code: 'invalid_internal_auth', reason: signature.code }
      if (row.state === 'revoked') return invalid('revoked', secret)
      if (!usable(row)) {
        // 续接（复审 P2-7）：宽限期已过，但接替它的新密钥仍是当前密钥、还没被 Worker 用过，且在续接窗口内——
        // 只允许用这把旧密钥换取新密钥（调用方据 renewOnly 只下发密钥，不处理其他内容）
        if (row.state === 'retiring' && row.superseded_by && now() - Date.parse(row.expires_at) < renewWindowMs(env)) {
          const successor = await c().one(
            "SELECT key_id,confirmed_at FROM gateway_worker_instance_keys WHERE key_id=? AND instance_id=? AND state='active'",
            row.superseded_by,
            instanceId,
          )
          if (successor && !successor.confirmed_at)
            return { ok: true, renewOnly: true, nonce: signature.nonce, keyId: row.key_id, state: row.state, secret }
        }
        return invalid('expired', secret)
      }
      return { ok: true, nonce: signature.nonce, keyId: row.key_id, state: row.state, secret }
    },

    /** 预过滤用（复审 P2-5）：key_id 对应的实例；没有这把密钥时返回 null。不解密、不读正文。 */
    async keyOwner(keyId) {
      const row = await c().one(
        'SELECT instance_id FROM gateway_worker_instance_keys WHERE key_id=?',
        String(keyId || ''),
      )
      return row?.instance_id || null
    },

    /** 记下 Worker 已用过这把密钥（控制面此后用它签名发往 Worker 的请求）。 */
    async confirm(instanceId, keyId) {
      const result = await c().run(
        'UPDATE gateway_worker_instance_keys SET confirmed_at=? WHERE key_id=? AND instance_id=? AND confirmed_at IS NULL',
        iso(now()),
        keyId,
        instanceId,
      )
      if (Number(result.changes || 0)) invalidate(instanceId)
    },

    /**
     * Worker 用旧密钥签名时需要下发的新密钥（当前 active 不是本次签名用的那把）：用旧密钥包裹，连同旧密钥的到期时间。
     */
    async delivery(instanceId, usedKeyId, usedSecret, nonce) {
      const list = await rows(instanceId)
      const active = list.find((row) => row.state === 'active')
      if (!active || active.key_id === usedKeyId) return null
      const used = list.find((row) => row.key_id === usedKeyId)
      return {
        instance_id: instanceId,
        key_id: active.key_id,
        wrapped: wrapDeliveredSecret(usedSecret, { instanceId, keyId: active.key_id, nonce }, open(active)),
        fingerprint: active.fingerprint,
        ...(used ? { previous_key_id: used.key_id, previous_expires_at: used.expires_at || null } : {}),
      }
    },

    /** 控制面发往该实例的请求用哪把密钥签名：Worker 已用过的最新有效密钥；没有时返回 null（用共用令牌）。 */
    async signingKey(instanceId) {
      if (!instanceId) return null
      const cached = signingCache.get(instanceId)
      if (cached && now() - cached.at < SIGNING_CACHE_MS) return cached.value
      const at = now()
      const row = (await rows(instanceId)).find((entry) => entry.confirmed_at && usable(entry, at))
      let value = null
      if (row) {
        try {
          value = { keyId: row.key_id, secret: open(row) }
        } catch (error) {
          log.warn?.(`gateway instance key ${row.key_id} for ${instanceId} cannot be opened: ${error.message}`)
        }
      }
      signingCache.set(instanceId, { at, value })
      return value
    },

    /** 面板展示：每个实例的密钥状态（不含密钥本身）与未使用的引导授权。 */
    async statuses() {
      const at = now()
      const all = await c().many(
        "SELECT key_id,instance_id,fingerprint,state,created_at,confirmed_at,expires_at FROM gateway_worker_instance_keys WHERE state<>'revoked' ORDER BY created_at DESC, key_id DESC",
      )
      const out = new Map()
      const entry = (id) =>
        out.get(id) || out.set(id, { state: 'none', keys: [], bootstrap_allowed_until: null }).get(id)
      for (const row of all) {
        if (!usable(row, at)) continue
        const item = entry(row.instance_id)
        item.keys.push({
          key_id: row.key_id,
          fingerprint: row.fingerprint,
          state: row.state,
          created_at: row.created_at,
          confirmed_at: row.confirmed_at,
          expires_at: row.expires_at,
        })
        if (row.confirmed_at) item.state = 'issued'
        else if (item.state === 'none') item.state = 'pending'
      }
      for (const grant of await c().many(
        'SELECT instance_id,expires_at FROM gateway_worker_bootstrap_grants WHERE consumed_at IS NULL AND expires_at>?',
        iso(at),
      ))
        entry(grant.instance_id).bootstrap_allowed_until = grant.expires_at
      return out
    },
  }
  return api
}

const stores = new WeakMap()
/** 同一个数据库句柄共用一个实例（签名密钥缓存在进程内共享，轮换、吊销后立即失效）。 */
export function instanceKeyStoreFor(db) {
  if (!db || (typeof db !== 'object' && typeof db !== 'function')) return null
  let store = stores.get(db)
  if (!store) {
    store = createInstanceKeyStore({ db })
    stores.set(db, store)
  }
  return store
}
