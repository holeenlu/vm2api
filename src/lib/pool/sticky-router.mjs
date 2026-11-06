/**
 * Configurable sticky / conversation-continuity routing (SQLite-backed).
 * Binds conversation key → account/VM for the TTL window.
 */

import crypto from 'node:crypto'
import { ENVELOPE_NEEDLES, extractPrompt } from '../core/distill-detect.mjs'
import { resolveStoreDb } from '../db/database.mjs'
import { StickyRepo } from '../db/repos/sticky-repo.mjs'
import {
  claudeCodeAgentRootSession,
  extractCallerSession,
  firstUserIdentityText,
  parseUserId,
} from '../identity/identity-rewrite.mjs'

export const DEFAULT_STICKY_HEADER_KEYS = [
  'x-session-id',
  'x-conversation-id',
  'x-claude-code-session-id',
  'session-id',
  'thread-id',
]

export const DEFAULT_STICKY_BODY_KEYS = ['conversation_id', 'session_id', 'thread_id', 'prompt_cache_key']

/** Per-request ids — never use as a conversation key. */
export const EPHEMERAL_STICKY_KEYS = new Set(['x-client-request-id', 'x-request-id'])

export function normalizeStickyPlatform(platform) {
  const value = String(platform || '')
    .trim()
    .toLowerCase()
  if (value === 'openai' || value === 'gpt' || value === 'codex') return 'openai'
  if (value === 'anthropic' || value === 'claude') return 'anthropic'
  return ''
}

/** Platform pools do not share a sticky row. Omitted platform keeps the legacy key. */
export function scopeStickyKey(key, platform) {
  const raw = String(key || '')
  if (!raw) return null
  const name = normalizeStickyPlatform(platform)
  if (!name) return raw
  const prefix = `p:${name}:`
  return raw.startsWith(prefix) ? raw : `${prefix}${raw}`
}

export function mergeStickyConfig(config) {
  const sticky = config?.sticky || {}
  const headerKeys = (
    Array.isArray(sticky.header_keys) && sticky.header_keys.length ? sticky.header_keys : DEFAULT_STICKY_HEADER_KEYS
  ).filter((k) => !EPHEMERAL_STICKY_KEYS.has(String(k).toLowerCase()))
  const outboundSession =
    String(sticky.outbound_session || '')
      .trim()
      .toLowerCase() === 'passthrough'
      ? 'passthrough'
      : 'rebuild'
  return {
    enabled: sticky.enabled !== false,
    mode: sticky.mode || 'conversation',
    ttl_seconds: sticky.ttl_seconds || 86400,
    header_keys: headerKeys,
    body_keys: Array.isArray(sticky.body_keys) && sticky.body_keys.length ? sticky.body_keys : DEFAULT_STICKY_BODY_KEYS,
    outbound_session: outboundSession,
  }
}

export function clientIp(req) {
  const headers = req?.headers || {}
  const xf = String(headers['x-forwarded-for'] || headers['X-Forwarded-For'] || '')
    .split(',')[0]
    .trim()
  const raw = xf || req?.socket?.remoteAddress || req?.ip || ''
  return String(raw)
    .replace(/^::ffff:/, '')
    .slice(0, 45)
}

export function isPersistableEnvelope(body = {}, inbound = null) {
  const hay = extractPrompt(inbound || body, body).joined.toLowerCase()
  return ENVELOPE_NEEDLES.some((item) => hay.includes(String(item).toLowerCase()))
}

/** One block of the first user message, chosen by firstUserIdentityText: the
 * first one that is not pure <system-reminder>. Later blocks of the same user
 * message change every turn and must not open another VM session slot. The
 * outbound session seed picks the same block (extractFirstUserIdentity).
 */
export function firstUserFingerprint(body = {}) {
  const msgs = Array.isArray(body?.messages) ? body.messages : Array.isArray(body?.input) ? body.input : []
  const user = msgs.find((m) => String(m?.role || m?.type || '').toLowerCase() === 'user') || msgs[0]
  let text = ''
  if (user) {
    const c = user.content ?? user.text ?? user.input
    if (typeof c === 'string') text = c
    else if (Array.isArray(c)) {
      text = firstUserIdentityText(
        c.map((part) =>
          typeof part === 'string' ? part : part?.type === 'text' && typeof part.text === 'string' ? part.text : '',
        ),
      )
    }
  } else if (typeof body?.input === 'string') {
    text = body.input
  } else if (typeof body?.prompt === 'string') {
    text = body.prompt
  }
  text = String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 4000)
  if (!text) return ''
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 24)
}

/** Side queries spawned by a live parent turn. Not a new conversation. */
export const COMPANION_PARENT_MS = 120_000

function systemText(system) {
  if (typeof system === 'string') return system
  if (!Array.isArray(system)) return ''
  return system.map((block) => (typeof block === 'string' ? block : block?.text || '')).join('\n')
}

function firstUserText(body = {}) {
  const msgs = Array.isArray(body?.messages) ? body.messages : []
  const user = msgs.find((m) => String(m?.role || '').toLowerCase() === 'user')
  const content = user?.content
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  for (const part of content) {
    if (typeof part === 'string' && part.trim()) return part.trim()
    if (part?.type === 'text' && typeof part.text === 'string' && part.text.trim()) return part.text.trim()
  }
  return ''
}

/**
 * Claude Code skill-routing / short Haiku hops.
 * They carry a fresh session_id but belong to the parent turn that just ran.
 */
export function isParentSessionCompanion(body = {}) {
  const model = String(body?.model || '').toLowerCase()
  if (!model.includes('haiku')) return false
  const msgs = Array.isArray(body?.messages) ? body.messages : []
  if (msgs.length !== 1 || String(msgs[0]?.role || '').toLowerCase() !== 'user') return false
  const tools = body?.tools
  if (Array.isArray(tools) ? tools.length > 0 : !!tools) return false
  if (firstUserText(body).startsWith('Compress into one routing hint')) return true
  const system = systemText(body?.system)
  if (!system || system.length > 800) return false
  return /x-anthropic-billing-header/i.test(system) && /you are claude code/i.test(system)
}

export const SHORT_PROBE_MAX_CHARS = 64

/**
 * One-shot test calls: sub2api account test, new-api channel test, verify
 * scripts. One short text user turn, no tools, any max_tokens. They carry no
 * conversation, so they must not hold a session seat or move a sticky pin.
 */
export function isShortProbeRequest(body = {}) {
  const msgs = Array.isArray(body?.messages) ? body.messages : []
  if (msgs.length !== 1 || String(msgs[0]?.role || '').toLowerCase() !== 'user') return false
  const tools = body?.tools
  if (Array.isArray(tools) ? tools.length > 0 : !!tools) return false
  const content = msgs[0].content
  let text = ''
  if (typeof content === 'string') text = content
  else if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part === 'string') text += part
      else if (part?.type === 'text' && typeof part.text === 'string') text += part.text
      else return false
    }
  } else return false
  text = text.trim()
  return text.length > 0 && text.length <= SHORT_PROBE_MAX_CHARS
}

export function explicitParentSessionId(body = {}, headers = {}) {
  const parsed = parseUserId(body?.metadata?.user_id) || {}
  const meta = body?.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata) ? body.metadata : {}
  return String(
    parsed.root_session_id ||
      parsed.parent_session_id ||
      meta.root_session_id ||
      meta.parent_session_id ||
      headers?.['x-kin-root-session'] ||
      headers?.['x-kin-parent-session'] ||
      claudeCodeAgentRootSession({ inbound: body, body, headers }) ||
      '',
  ).trim()
}

export function childDeclaredWithoutParent(body = {}, headers = {}) {
  const meta = body?.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata) ? body.metadata : {}
  const declared = meta.kin_child === true || String(meta.kin_child || headers?.['x-kin-child'] || '') === '1'
  return declared && !explicitParentSessionId(body, headers)
}

/** 一次绑定最多按读到的行重试几次条件写（R13）；每次失败都说明行在读之后被别的请求改过。 */
const BIND_CAS_ATTEMPTS = 4

/**
 * 按读到的行算出下一次绑定（bind 的原有语义，未改）。`ifGeneration` 不符时返回 null。
 * VM 与账号都变且未允许迁移时锁定在原行：并发的同会话请求读到胜者后保留胜者（R13）。
 */
function nextBinding(
  prev,
  { accountId, vmId, sessionId = null, deviceId = null, slotIndex = null },
  { countHit, ifGeneration, replaceSession, clearSlot, allowMove, keepExpiry },
  ttl,
) {
  const prevGeneration = Number(prev.generation) || 0
  if (ifGeneration != null && prevGeneration !== Number(ifGeneration)) return null
  const vmChanged = !!(prev.vm_id && vmId && prev.vm_id !== vmId)
  const accountChanged = !!(prev.account_id && accountId && prev.account_id !== accountId)
  const locked = vmChanged && accountChanged && !allowMove
  const nextAccount = locked ? prev.account_id : accountId
  const nextVm = locked ? prev.vm_id : vmId
  const nextSlot = locked
    ? (prev.slot_index ?? null)
    : clearSlot
      ? null
      : slotIndex == null
        ? (prev.slot_index ?? null)
        : Number(slotIndex)
  const changed = !!(
    prev.vm_id &&
    !clearSlot &&
    (nextAccount !== prev.account_id || nextVm !== prev.vm_id || (slotIndex != null && nextSlot !== prev.slot_index))
  )
  const generation = prev.vm_id ? (changed ? prevGeneration + 1 : prevGeneration || 1) : 1
  const sameVm = !!(prev.vm_id && nextVm && prev.vm_id === nextVm)
  const nextSessionId = locked
    ? prev.session_id || sessionId || null
    : replaceSession
      ? sessionId || null
      : sameVm
        ? prev.session_id || sessionId || null
        : sessionId || prev.session_id || null
  const device = deviceId == null ? prev.device_id || null : String(deviceId).trim() || null
  return {
    account_id: nextAccount,
    vm_id: nextVm,
    session_id: nextSessionId,
    device_id: device || null,
    bound_at: keepExpiry && Number(prev.bound_at) ? Number(prev.bound_at) : Date.now(),
    expires_at: keepExpiry && Number(prev.expires_at) > Date.now() ? Number(prev.expires_at) : Date.now() + ttl,
    hits: (prev.hits || 0) + (countHit ? 1 : 0),
    generation,
    slot_index: nextSlot,
  }
}

function resolvedEntry(key, ent) {
  if (!ent) return null
  if (Date.now() > ent.expires_at) {
    return null
  }
  return {
    accountId: ent.account_id,
    vmId: ent.vm_id,
    sessionId: ent.session_id || null,
    generation: Number(ent.generation) || 0,
    slotIndex: ent.slot_index == null ? null : Number(ent.slot_index),
    key,
  }
}

/**
 * R6 B7b：绑定经 async 仓储读写。写入是条件写（竞态 R13）：按读到的行做 CAS（没有行时 ON CONFLICT DO NOTHING），
 * 行在读之后被另一个请求改过就重读、按胜者重算（VM 与账号都不同则锁定在胜者），同一会话的并发请求不会各自绑到
 * 不同 VM。构造函数不读库：`await StickyRouter.create()` 会清理别名行。Codex 候选准入同样经异步方法读写（R6 B7c）。
 */
export class StickyRouter {
  constructor({ dataDir, db, config }) {
    this.db = resolveStoreDb({ db, dataDir })
    this.repo = new StickyRepo(this.db)
    this.config = mergeStickyConfig(config)
  }

  /** 构造并清理不是会话槽位的别名行（内容指纹、设备别名）。 */
  static async create(options) {
    const router = new StickyRouter(options)
    await router.repo.dropAliasKeys()
    return router
  }

  /** Kept for API compat + post-restore hook (state lives in DB). */
  reload() {}

  /** Re-bind to a fresh DB connection (after backup restore). */
  rebind(db) {
    this.db = db
    this.repo = new StickyRepo(db)
  }

  isolateKey(raw, req = null) {
    const id = req?.apiKeyRecord?.id
    if (id == null || id === '') return String(raw)
    const owner = req?.apiKeyRecord?.user_id || 'platform'
    const group = req?.apiKeyRecord?.group_id
    return group ? 'u' + owner + ':k' + id + ':g' + group + ':' + raw : 'k' + id + ':' + raw
  }

  extractKey(req, body = {}) {
    if (!this.config.enabled) return null
    const mode = this.config.mode || 'conversation'

    if (mode === 'ip') {
      const ip = clientIp(req)
      return ip ? this.isolateKey(`ip:${ip}`, req) : null
    }
    if (mode === 'session') {
      const id = req?.apiKeyRecord?.id
      if (id != null && id !== '') return `k${id}:login`
      const auth = String(req?.headers?.authorization || req?.headers?.['x-api-key'] || '').trim()
      if (auth) {
        return this.isolateKey(`login:${crypto.createHash('sha256').update(auth).digest('hex').slice(0, 24)}`, req)
      }
      const ip = clientIp(req)
      return ip ? this.isolateKey(`ip:${ip}`, req) : null
    }

    if (isPersistableEnvelope(body)) {
      const id = req?.apiKeyRecord?.id
      if (id != null && id !== '') return `k${id}:envelope`
    }

    const caller = extractCallerSession({ inbound: body, body, headers: req?.headers || {} })
    if (caller && !EPHEMERAL_STICKY_KEYS.has(String(caller).toLowerCase())) {
      return this.isolateKey(caller, req)
    }
    for (const k of this.config.header_keys || []) {
      const key = String(k).toLowerCase()
      if (EPHEMERAL_STICKY_KEYS.has(key)) continue
      const v = req?.headers?.[key] || req?.headers?.[k]
      if (v) return this.isolateKey(String(v), req)
    }
    for (const k of this.config.body_keys || []) {
      if (body?.[k]) return this.isolateKey(String(body[k]), req)
    }
    const fp = firstUserFingerprint(body)
    if (fp) return this.isolateKey(`ch:${fp}`, req)
    return null
  }

  /**
   * Official Claude Code parent + child hops share metadata.user_id.device_id
   * even when the child mints a new session_id. Bind the family to one account.
   *
   * Agent / local-agent sub-agents are classified unofficial for persona
   * (oh-my-pi stealth), but they still send the parent device_id. Pool
   * sticky must use this key regardless of officialTraffic.
   */
  extractOfficialFamilyKey(req, body = {}) {
    if (!this.config.enabled) return null
    const parsed = parseUserId(body?.metadata?.user_id)
    const device = String(parsed?.device_id || '').trim()
    if (!device) return null
    return this.isolateKey(`dev:${device}`, req)
  }

  /** Ordered aliases for one logical conversation. Each caller session keeps its own key.
   * A child does not reuse the parent key or a device-wide fam slot.
   */
  collectPoolKeys(req, body = {}, opts = {}) {
    if (!this.config.enabled) return []
    const keys = []
    const platform = normalizeStickyPlatform(opts?.platform)
    const add = (key) => {
      const scoped = scopeStickyKey(key, platform)
      if (scoped && !keys.includes(scoped)) keys.push(scoped)
    }
    const caller = extractCallerSession({ inbound: body, body, headers: req?.headers || {} })
    if (caller && !EPHEMERAL_STICKY_KEYS.has(String(caller).toLowerCase())) {
      add(this.isolateKey(caller, req))
      return keys
    }
    const mode = this.config.mode || 'conversation'
    if (mode === 'conversation' && isPersistableEnvelope(body)) {
      const id = req?.apiKeyRecord?.id
      if (id != null && id !== '') add(`k${id}:envelope`)
      if (keys.length) return keys
    }
    const fingerprint = firstUserFingerprint(body)
    if (fingerprint) add(this.isolateKey(`ch:${fingerprint}`, req))
    return keys
  }

  /** Live parent for this device_id. Companions must not inherit fam:/alias rows
   * or another device's session on the same API key.
   */
  async latestParentPoolKey(
    req,
    { platform = 'anthropic', now = Date.now(), withinMs = COMPANION_PARENT_MS, deviceId = '' } = {},
  ) {
    const device = String(deviceId || '').trim()
    if (!device) return null
    const id = req?.apiKeyRecord?.id
    if (id == null || id === '') return null
    const prefix = scopeStickyKey(this.isolateKey('', req), platform)
    if (!prefix) return null
    let best = null
    let bestAt = 0
    for (const [key, ent] of Object.entries(await this.repo.all())) {
      if (!key.startsWith(prefix)) continue
      const rest = key.slice(prefix.length)
      if (!rest || /^(fam:|ch:|dev:|envelope$|login$)/.test(rest)) continue
      if (String(ent?.device_id || '') !== device) continue
      if (!ent?.expires_at || now > ent.expires_at) continue
      const at = Number(ent.bound_at) || 0
      if (now - at > withinMs) continue
      if (at < bestAt) continue
      bestAt = at
      best = key
    }
    return best
  }

  /**
   * One conversation, one pool key. An already-bound alias wins so a new
   * per-hop session id cannot open a second VM session.
   */
  async extractPoolKey(req, body = {}, opts = {}) {
    const keys = this.collectPoolKeys(req, body, opts)
    for (const key of keys) if (await this.resolve(key)) return key
    if (normalizeStickyPlatform(opts?.platform) === 'anthropic') {
      for (const key of this.collectPoolKeys(req, body)) if (await this.resolve(key)) return key
    }
    return keys[0] || null
  }

  familyKey(req, sessionId, platform = '') {
    const id = String(sessionId || '').trim()
    if (!id || !this.config.enabled) return null
    return scopeStickyKey(this.isolateKey(`family:${id}`, req), platform)
  }

  /** Canonical session identity — exact sticky, scoped to customer, Key and group for commercial calls. */
  canonicalSessionKey(sessionId, req = null) {
    const id = String(sessionId || '').trim()
    return id ? (req?.apiKeyRecord?.group_id ? this.isolateKey('sess:' + id, req) : 'sess:' + id) : null
  }

  /** Canonical device identity — VM affinity, scoped to customer, Key and group for commercial calls. */
  canonicalDeviceKey(deviceId, req = null) {
    const id = String(deviceId || '').trim()
    return id ? (req?.apiKeyRecord?.group_id ? this.isolateKey('dev2:' + id, req) : 'dev2:' + id) : null
  }

  /** Canonical family identity — parent/root session, scoped to customer, Key and group for commercial calls. */
  canonicalFamilyKey(sessionId, req = null) {
    const id = String(sessionId || '').trim()
    return id ? (req?.apiKeyRecord?.group_id ? this.isolateKey('family2:' + id, req) : 'family2:' + id) : null
  }

  /**
   * Anthropic session sticky keys. A trusted inbound session_id maps to one
   * canonical key across API keys; a still-live legacy API-key-scoped row is
   * copied onto it once. Without a trusted session_id the legacy aliases stay.
   * @returns {{ stickyKey: string|null, stickyKeys: string[] }}
   */
  async sessionPoolKeys(req, body = {}, { sessionId = '', deviceId = '', migrate = true } = {}) {
    if (!this.config.enabled) return { stickyKey: null, stickyKeys: [] }
    const canonical = this.canonicalSessionKey(sessionId, req)
    if (canonical && req?.apiKeyRecord?.group_id) return { stickyKey: canonical, stickyKeys: [canonical] }
    if (!canonical) {
      return {
        stickyKey: await this.extractPoolKey(req, body, { platform: 'anthropic' }),
        stickyKeys: this.collectPoolKeys(req, body, { platform: 'anthropic' }),
      }
    }
    // Live legacy rows ride along as aliases so a credential failure unbinds
    // them too; otherwise the next turn would copy a dead pin back.
    const aliases = [
      ...new Set([...this.collectPoolKeys(req, body, { platform: 'anthropic' }), ...this.collectPoolKeys(req, body)]),
    ].filter((key) => key !== canonical)
    const legacy = []
    for (const key of aliases) if (await this.resolve(key)) legacy.push(key)
    if (!(await this.resolve(canonical)) && legacy.length) {
      if (!migrate) return { stickyKey: legacy[0], stickyKeys: legacy }
      await this.migrateLegacyIdentity(legacy[0], { sessionId, deviceId })
    }
    return { stickyKey: canonical, stickyKeys: [canonical, ...legacy] }
  }

  /**
   * Family lock key. Trusted parent/root ids use the canonical key; a live
   * legacy family row is copied onto it once so an in-flight family stays put.
   */
  async familyPoolKey(req, sessionId, { trusted = false } = {}) {
    const legacy = this.familyKey(req, sessionId, 'anthropic')
    if (!trusted || !legacy) return legacy
    const canonical = this.canonicalFamilyKey(sessionId, req)
    if (req?.apiKeyRecord?.group_id) return canonical
    if (!(await this.resolve(canonical))) {
      const prev = await this.resolve(legacy)
      if (prev?.accountId && prev?.vmId) {
        await this.bind(canonical, { accountId: prev.accountId, vmId: prev.vmId }, { countHit: false })
      }
    }
    return canonical
  }

  /** @returns {Promise<{ accountId: string, vmId: string } | null>} */
  async resolve(key) {
    if (!key || !this.config.enabled) return null
    return resolvedEntry(key, await this.repo.get(key))
  }

  /**
   * 条件写一个绑定（R13）：读行 → 按读到的行算下一状态 → CAS 写入；行在读之后被改过（并发的同会话请求先绑了）
   * 就重读重算，按胜者锁定。`ifGeneration` 不符、或多次重试仍冲突时返回 false（不写）。
   */
  async _writeBinding(key, compute) {
    for (let attempt = 0; attempt < BIND_CAS_ATTEMPTS; attempt++) {
      const row = await this.repo.get(key)
      const next = compute(row || {})
      if (!next) return null
      if (await this.repo.compareAndSet(key, row, next)) return next
    }
    return null
  }

  async bind(
    key,
    payload = {},
    {
      countHit = true,
      ifGeneration = null,
      replaceSession = false,
      clearSlot = false,
      allowMove = false,
      keepExpiry = false,
    } = {},
  ) {
    if (!key || !this.config.enabled) return false
    const ttl = (this.config.ttl_seconds || 86400) * 1000
    const opts = { countHit, ifGeneration, replaceSession, clearSlot, allowMove, keepExpiry }
    return !!(await this._writeBinding(key, (prev) => nextBinding(prev, payload, opts, ttl)))
  }

  /**
   * 首次绑定（R13）：没有有效绑定时写入自己的选择，返回库里的胜者。并发的同会话请求先绑了另一个 VM 时，
   * 返回的是对方的绑定，调用方改用胜者（若胜者可用）。
   */
  async claim(key, { accountId, vmId } = {}) {
    if (!key || !this.config.enabled || !accountId || !vmId) return null
    const live = await this.resolve(key)
    if (live) return live
    await this.bind(key, { accountId, vmId }, { countHit: false })
    return this.resolve(key)
  }

  /** Move an entire family together. Session rows stay until their next turn. */
  async rebindFamily(key, { accountId, vmId } = {}) {
    if (!key || !this.config.enabled || !accountId || !vmId) return null
    const ttl = (this.config.ttl_seconds || 86400) * 1000
    const next = await this._writeBinding(key, (prev) => ({
      account_id: accountId,
      vm_id: vmId,
      session_id: null,
      device_id: prev.device_id || null,
      bound_at: Date.now(),
      expires_at: Date.now() + ttl,
      hits: prev.hits || 0,
      generation: (Number(prev.generation) || 0) + 1,
      slot_index: null,
    }))
    return next ? { generation: next.generation, vmId, accountId } : null
  }

  /**
   * Device VM affinity is a soft VM preference, not a session seat binding.
   * `ifAbsent`: only when the device has no live row (the scheduler's machine home; first writer wins, R13).
   */
  async bindDeviceAffinity(key, { accountId, vmId } = {}, { countHit = false, ifAbsent = false } = {}) {
    if (!key || !this.config.enabled || !accountId || !vmId) return null
    const ttl = (this.config.ttl_seconds || 86400) * 1000
    const next = await this._writeBinding(key, (prev) => {
      if (ifAbsent && prev.vm_id && Date.now() <= prev.expires_at) return null
      const changed = !!(prev.vm_id && (prev.account_id !== accountId || prev.vm_id !== vmId))
      const prevGeneration = Number(prev.generation) || 0
      return {
        account_id: accountId,
        vm_id: vmId,
        session_id: null,
        device_id: prev.device_id || null,
        bound_at: Date.now(),
        expires_at: Date.now() + ttl,
        hits: (prev.hits || 0) + (countHit ? 1 : 0),
        generation: prev.vm_id ? (changed ? prevGeneration + 1 : prevGeneration || 1) : 1,
        slot_index: null,
      }
    })
    return next ? { generation: next.generation, vmId, accountId } : null
  }

  /**
   * A4: bridge a legacy (API-key-scoped) sticky hit to the canonical,
   * key-less identity keys from A1. Call only when a request resolves
   * through an existing legacy key *and* carries a trusted session_id /
   * device_id (e.g. from resolveInboundIdentity/metadata.user_id) — this
   * never guesses an identity and never runs as a batch migration.
   *
   * Session canonical key reuses bind()'s locked/generation semantics:
   * a row is locked only when both VM and account differ, so a stale
   * legacy hit cannot silently merge onto another session's home.
   * Same-account VM moves still write the new outbound session. Device
   * canonical key reuses bindDeviceAffinity()'s existing soft-preference
   * semantics (A2), which is allowed to move — that is its documented
   * behavior already.
   *
   * The legacy row itself, and any unrelated row, is never modified or
   * deleted here.
   *
   * @returns {{ sessionKey: string|null, deviceKey: string|null }}
   */
  async migrateLegacyIdentity(legacyKey, { sessionId = '', deviceId = '' } = {}) {
    const result = { sessionKey: null, deviceKey: null }
    if (!this.config.enabled || !legacyKey) return result
    const bound = await this.resolve(legacyKey)
    if (!bound || !bound.accountId || !bound.vmId) return result

    const sessionKey = this.canonicalSessionKey(sessionId)
    if (sessionKey && sessionKey !== legacyKey) {
      await this.bind(
        sessionKey,
        { accountId: bound.accountId, vmId: bound.vmId, sessionId: bound.sessionId || sessionId, deviceId },
        { countHit: false },
      )
      result.sessionKey = sessionKey
    }

    // A live device affinity is the principal's home VM; a legacy session hit
    // must not move it.
    const deviceKey = this.canonicalDeviceKey(deviceId)
    if (deviceKey && !(await this.resolve(deviceKey))) {
      await this.bindDeviceAffinity(deviceKey, { accountId: bound.accountId, vmId: bound.vmId }, { countHit: false })
      result.deviceKey = deviceKey
    }

    return result
  }

  async unbind(key) {
    if (!key) return
    await this.repo.remove(key)
  }

  async unbindByAccount({ accountId = null, vmId = null } = {}) {
    return this.repo.removeByAccount({ accountId, vmId })
  }

  /** Live keys pinned to this account or VM, so their windows leave with them. */
  async boundKeys({ accountId = null, vmId = null } = {}) {
    if (!accountId && !vmId) return []
    await this._purge()
    return Object.entries((await this.repo.all()) || {})
      .filter(([, ent]) => (accountId && ent?.account_id === accountId) || (vmId && ent?.vm_id === vmId))
      .map(([key, ent]) => ({ key, accountId: ent.account_id, vmId: ent.vm_id }))
  }

  async _purge() {
    return this.repo.purgeExpired(Date.now())
  }

  async stats() {
    await this._purge()
    const sessions = await this.repo.all()
    const list = Object.values(sessions || {})
    return {
      enabled: !!this.config.enabled,
      mode: this.config.mode,
      active_sessions: Object.keys(sessions).length,
      total_hits: list.reduce((n, s) => n + (Number(s.hits) || 0), 0),
      sessions,
    }
  }

  reloadConfig(config) {
    this.config = mergeStickyConfig(config)
  }
}
