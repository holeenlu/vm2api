import crypto from 'node:crypto'
import { dbClient } from '../db/db-client.mjs'
import { GroupsRepo } from '../db/repos/groups-repo.mjs'
import { maybeDecrypt, maybeEncrypt } from '../db/secure.mjs'
import { audit, relayError } from '../admin/relay-common.mjs'
import { vendorAllowsGroup, vendorGroupPlatforms } from '../vendor/vendor-groups.mjs'
import { vendorProxyAddress } from '../vendor/vendor-platform.mjs'
import { parseCodexImportPayload } from '../vm/codex-slot.mjs'
import { parseSocks5Line } from '../vm/proxy-pool.mjs'
import { socksProxyUrl } from '../vm/socks-address.mjs'
import { nextGatewayAccountId, reserveGatewayAccountId } from './account-ids.mjs'
import { createCredentialCustody } from '../executor/credential-custody.mjs'
import {
  accountByOwnerExternalId,
  activeSupplierProxy,
  enabledPlatformProxy,
  groupHasOtherResources,
  insertPlatformAccount,
  listPlatformProxies,
  updateAccountRecord,
  updateAccountSecret,
  updateOwnedAccountAuthorized,
  vendorById,
} from './repos/accounts-repo.mjs'
import {
  updateResourceConfigStamped,
  getResourceSecretJson,
  tombstoneResource,
} from '../vendor/repos/resources-repo.mjs'
import {
  clearExpiredOAuthSessions,
  closeAccountOAuthSessions,
  completeOAuthSession,
  getOAuthSession,
  saveOAuthSessionResult,
  upsertPendingOAuthSession,
} from './repos/oauth-sessions-repo.mjs'
import {
  exchangeGatewayCode,
  gatewayAuthUrl,
  refreshGatewayToken,
  tokenExpiry,
  tokenIdentity,
} from './gateway-oauth.mjs'

const stamp = () => new Date().toISOString()
const ACCOUNT_LOCKS = new Map()
// 写回 config_json 时去掉账号视图里现算的分组（迁移 128 起分组只以 group_resources 为准）与投影时期的旧键
const VIEW_ONLY_CONFIG_KEYS = ['group_ids', 'projection_revision', 'config_fingerprint']
function storedConfig(config = {}) {
  const out = { ...config }
  for (const key of VIEW_ONLY_CONFIG_KEYS) delete out[key]
  return JSON.stringify(out)
}
const text = (value) => String(value ?? '').trim()
const AUTHORIZATION_KINDS = Object.freeze(['import', 'oauth'])
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex')
// 会话上加密保存的 JSON（PKCE 会话、换出的令牌）
const parseSecret = (value) => {
  try {
    return JSON.parse(maybeDecrypt(value) || 'null')
  } catch {
    return null
  }
}
/** CPR `modelAccess`: all, or 1–256 exact model IDs as an allow/deny list. */
export function normalizeModelAccess(value) {
  if (value == null) return { mode: 'all', models: [] }
  const mode = value.mode
  const models = Array.isArray(value.models) ? value.models : null
  if (!['all', 'allowlist', 'denylist'].includes(mode) || !models)
    throw relayError('invalid_model_access', '模型范围无效')
  if (mode === 'all') {
    if (models.length) throw relayError('invalid_model_access', '全部模型时不能指定模型列表')
    return { mode, models: [] }
  }
  if (
    !models.length ||
    models.length > 256 ||
    models.some((m) => typeof m !== 'string' || !m || m.length > 256 || m !== m.trim() || m.includes('*')) ||
    new Set(models).size !== models.length
  )
    throw relayError('invalid_model_access', '模型列表须为 1–256 个不重复的精确模型 ID')
  return { mode, models: [...models] }
}

/** Operator-owned Gateway accounts use the same resource/binding facts as suppliers,
 * with a null supplier. No synthetic supplier, portal login or supplier settlement. */
// 授权会话有效期（与 Worker 过去的 oauthSessionTTL 相同）
const OAUTH_SESSION_TTL_MS = 10 * 60_000

export class GatewayAccountManagement {
  constructor({ repo, service, proxyPool, tokenFetch } = {}) {
    this.repo = repo
    this.service = service
    this.proxyPool = proxyPool
    // 换码与刷新的 fetch（测试注入；默认经账号出站代理）
    this.tokenFetch = tokenFetch
    this.drafts = new Map()
    // 账号互斥锁跨实例共享：运营端、供应商端、心跳与回执补拉各自 new 一个管理实例，同一账号的操作仍要互斥
    this.locks = ACCOUNT_LOCKS
  }

  get db() {
    return this.repo.db
  }
  get groups() {
    return new GroupsRepo(this.db)
  }

  async account(id) {
    const row = (await this.repo.listCodexAccounts({ includeArchived: true })).find((item) => item.id === id)
    if (!row) throw relayError('account_not_found', 'Codex 账号不存在', 404)
    return row
  }

  // 账号归属允许的分组（不看分组当前是否已有 API 端点）：启用、支持 OpenAI，供应商自有账号还要在供应商及父级的授权分组内。
  // 返回 null 表示账号的供应商已停用（所有分组都不允许）。
  async groupScope(account = null) {
    let owner = null
    let parent = null
    if (account?.vendor_id) {
      owner = await vendorById(this.db, account.vendor_id)
      if (!owner || owner.status !== 'active') return null
      if (owner.parent_id) {
        parent = await vendorById(this.db, owner.parent_id)
        if (!parent || parent.status !== 'active') return null
      }
    }
    const openaiAllowed = (v) =>
      !v ||
      !JSON.parse(v.platforms_json || '[]').length ||
      JSON.parse(v.platforms_json).some((p) => ['openai', 'codex'].includes(p))
    return (group) =>
      group.status === 'active' &&
      vendorGroupPlatforms(group).includes('openai') &&
      (!owner || (openaiAllowed(owner) && openaiAllowed(parent) && vendorAllowsGroup(owner, parent, group)))
  }

  async availableGroups(account = null) {
    const allowed = await this.groupScope(account)
    if (!allowed) return []
    // 先取出“分组里已有其他资源”的判定（只查启用、支持 OpenAI 的分组，与原来的短路求值相同），再同步过滤
    const groups = await this.groups.list()
    const occupied = new Set()
    for (const group of groups)
      if (
        group.status === 'active' &&
        vendorGroupPlatforms(group).includes('openai') &&
        (await groupHasOtherResources(this.db, group.id))
      )
        occupied.add(group.id)
    return groups.filter((group) => allowed(group) && !occupied.has(group.id))
  }

  /** 按 proxy_id 现解析出站代理地址（供应商代理资源或平台代理池，含认证）；不可用时返回空串。 */
  async proxyAddress(proxyId) {
    const supplierProxy = await activeSupplierProxy(this.db, proxyId)
    if (supplierProxy) {
      // 供应商代理以统一代理池里的那份为准（只改认证时池里先更新）；池里没有时用资源上记的地址
      const poolId = JSON.parse(supplierProxy.config_json || '{}').pool_proxy_id
      const pooled = poolId && this.proxyPool?.getProxyByIdWithAuth(poolId)
      if (pooled && pooled.kind !== 'local') return socksProxyUrl(pooled)
      return vendorProxyAddress(
        JSON.parse(maybeDecrypt(supplierProxy.secret_json) || '{}').endpoint ||
          JSON.parse(supplierProxy.config_json).endpoint,
      )
    }
    const row = await enabledPlatformProxy(this.db, proxyId)
    const resolved = row && this.proxyPool?.getProxyByIdWithAuth(proxyId)
    if (!resolved || resolved.kind === 'local') return ''
    return socksProxyUrl(resolved)
  }

  /**
   * 代理改了地址或认证后，同步绑定它的 Gateway 账号的出站代理：账号密文里存的是保存时解析出的完整地址，
   * Worker 从库里读它。代理被停用或解析不到时不动（账号沿用原地址，由运营改绑）。返回改写的账号数。
   */
  async syncProxyAddresses(proxyIds, actor = 'system') {
    const ids = new Set([...proxyIds].filter(Boolean).map(String))
    if (!ids.size) return 0
    let changed = 0
    for (const account of await this.repo.listCodexAccounts({ includeArchived: true })) {
      if (!ids.has(String(account.config.proxy_id || ''))) continue
      try {
        await this.exclusive(account.id, async () => {
          const url = await this.proxyAddress(account.config.proxy_id)
          if (!url) return
          const stored = await getResourceSecretJson(this.db, account.id)
          const secret = JSON.parse(maybeDecrypt(stored?.secret_json) || '{}')
          if (secret.proxy_url === url) return
          await dbClient(this.db).tx(async () => {
            await updateAccountSecret(
              this.db,
              maybeEncrypt(JSON.stringify({ ...secret, proxy_url: url })),
              stamp(),
              account.id,
            )
            await audit(this.db, actor, 'gateway.account.proxy_synced', account.id, null, {
              proxy_id: account.config.proxy_id,
            })
          })
          changed++
        })
      } catch (error) {
        console.warn(`gateway account ${account.id}: syncing the proxy address failed: ${error?.message || error}`)
      }
    }
    return changed
  }

  async catalog(account = null) {
    return {
      groups: await this.availableGroups(account),
      proxies: await listPlatformProxies(this.db),
      worker_available: !!(await this.repo.pickInstance()),
      // 授权由控制面完成（S1）：OAuth 与账号文件都可用，不再按 Worker 能力描述
      authorizations: AUTHORIZATION_KINDS,
    }
  }

  // vendorId：新建供应商自有账号时的归属供应商（已有账号以 current.vendor_id 为准），决定可选分组与可用的供应商代理
  async normalize(body, current = null, { blankName = false, vendorId = null } = {}) {
    const ownerVendorId = current ? current.vendor_id || null : vendorId || null
    const allowed = [
      'name',
      'notes',
      'group_ids',
      'expected_group_version',
      'proxy_id',
      'proxy_endpoint',
      'max_concurrency',
      'max_rpm',
      'weight',
      'model_access',
      'reset_credit_auto',
      'status',
      'idempotency_key',
      'authorization_kind',
      'vendor_notes',
      'plan_override',
    ]
    if (Object.keys(body).some((key) => !allowed.includes(key)))
      throw relayError('invalid_resource_patch', '账号配置字段无效')
    const config = current?.config || {}
    if (current?.status === 'archived') throw relayError('resource_archived', '账号已归档', 409)
    // Revoked groups or unavailable proxies must never prevent stopping an account.
    if (
      current &&
      ['paused', 'archived'].includes(body.status) &&
      Object.keys(body).every((key) => key === 'status' || (key === 'proxy_endpoint' && !text(body[key])))
    ) {
      const stored = await getResourceSecretJson(this.db, current.id)
      return {
        name: current.name,
        status: body.status,
        proxy: JSON.parse(maybeDecrypt(stored?.secret_json) || '{}').proxy_url || '',
        config: { ...config },
      }
    }
    // A new account may leave the name blank; it takes the authorized email (same as the supplier form).
    const name = text(body.name ?? current?.name)
    if ((!name && !blankName) || name.length > 160)
      throw relayError('invalid_resource_name', '请填写账号名称（最多 160 字）')
    const notes = text(body.notes ?? config.notes)
    if (notes.length > 2000) throw relayError('invalid_notes', '备注最多 2000 字')
    // 供应商备注（账号池里供应商可见的备注）与运营备注分开保存，只有供应商自有账号有
    if (body.vendor_notes !== undefined && !ownerVendorId)
      throw relayError('invalid_resource_patch', '账号配置字段无效')
    const vendorNotes = body.vendor_notes === undefined ? undefined : text(body.vendor_notes)
    // 订阅档位手动覆盖（只影响面板显示）：空串清除，恢复自动识别
    const planOverride = body.plan_override === undefined ? undefined : text(body.plan_override).toLowerCase()
    if (planOverride !== undefined && !/^[a-z0-9_-]{0,64}$/.test(planOverride))
      throw relayError('invalid_plan_override', '订阅档位无效')
    if (vendorNotes !== undefined && vendorNotes.length > 2000)
      throw relayError('invalid_resource_notes', '账号备注长度不能超过 2000 字符')
    const requested = body.group_ids ?? config.group_ids
    if (!Array.isArray(requested)) throw relayError('group_required', '请选择至少一个 OpenAI 分组')
    // 已删除的分组直接去掉；账号已在的分组（之后被停用或改了授权范围）可以保留或移除，只校验新增的分组。
    // 否则残留的分组会让账号再也保存不了（分组与资源管理重整 P1）
    const existing = new Set(((await this.groups.list()) || []).map((g) => g.id))
    const ids = requested.filter((id) => !Number.isSafeInteger(id) || existing.has(id))
    if (!ids.length) throw relayError('group_required', '请选择至少一个 OpenAI 分组')
    const kept = new Set((current?.config?.group_ids || []).map(Number))
    const available = new Set(
      (await this.availableGroups(current || (ownerVendorId ? { vendor_id: ownerVendorId } : null))).map((g) => g.id),
    )
    if (ids.some((id) => !Number.isSafeInteger(id) || (!available.has(id) && !kept.has(id))))
      throw relayError('group_scope_forbidden', '分组不存在、已停用或不在账号授权范围内', 403)
    const groupIds = [...new Set(ids)]
    const status = body.status ?? current?.status ?? 'active'
    if (!['active', 'paused', 'archived'].includes(status)) throw relayError('invalid_status', '账号状态无效')
    const maxConcurrency = body.max_concurrency ?? config.max_concurrency ?? 4
    const maxRpm = body.max_rpm ?? config.max_rpm ?? 0
    if (
      !Number.isInteger(maxConcurrency) ||
      maxConcurrency < 1 ||
      maxConcurrency > 1000 ||
      !Number.isInteger(maxRpm) ||
      maxRpm < 0 ||
      maxRpm > 1000000
    )
      throw relayError('invalid_capacity', '并发或 RPM 超出允许范围')
    // CPR account settings: weight 1–100 (higher tier first) and modelAccess all/allowlist/denylist.
    const weight = body.weight ?? config.weight ?? 1
    if (!Number.isInteger(weight) || weight < 1 || weight > 100)
      throw relayError('invalid_weight', '权重须为 1–100 的整数')
    const modelAccess = normalizeModelAccess(body.model_access ?? config.model_access)
    const resetCreditAuto = body.reset_credit_auto ?? config.reset_credit_auto ?? false
    if (typeof resetCreditAuto !== 'boolean') throw relayError('invalid_reset_credit_auto', '自动使用重置卡须为开关值')
    const endpoint = text(body.proxy_endpoint)
    let proxyId = text(body.proxy_id ?? config.proxy_id)
    let proxy = ''
    if (endpoint && body.proxy_id) throw relayError('proxy_source_conflict', '请选择已有代理或填写代理地址')
    if (endpoint) {
      proxy = vendorProxyAddress(endpoint)
      proxyId = ''
    } else if (proxyId) {
      const supplierProxy = await activeSupplierProxy(this.db, proxyId)
      if (supplierProxy && supplierProxy.vendor_id !== ownerVendorId)
        throw relayError('proxy_scope_forbidden', '代理不属于该供应商', 403)
      proxy = await this.proxyAddress(proxyId)
      if (!proxy) throw relayError('proxy_unavailable', '代理不可用', 409)
    } else if (current && !Object.hasOwn(body, 'proxy_id')) {
      const stored = await getResourceSecretJson(this.db, current.id)
      proxy = JSON.parse(maybeDecrypt(stored?.secret_json) || '{}').proxy_url || config.proxy_endpoint || ''
    }
    // A blank edit preserves the current inline proxy, never clears credentials.
    if (!proxy && current && !endpoint && !body.proxy_id) {
      const stored = await getResourceSecretJson(this.db, current.id)
      proxy = JSON.parse(maybeDecrypt(stored?.secret_json) || '{}').proxy_url || config.proxy_endpoint || ''
    }
    if (!proxy) throw relayError('proxy_required', '请先配置账号出站代理')
    const url = new URL(proxy)
    return {
      name,
      status,
      proxy,
      config: {
        ...config,
        platform: 'openai',
        execution_kind: 'gateway_worker',
        auth_method: 'oauth',
        notes,
        group_ids: groupIds,
        proxy_id: proxyId,
        proxy_endpoint: `${url.protocol}//${url.host}`,
        max_concurrency: maxConcurrency,
        max_rpm: maxRpm,
        weight,
        model_access: modelAccess,
        reset_credit_auto: resetCreditAuto,
        ...(vendorNotes !== undefined ? { vendor_notes: vendorNotes } : {}),
        ...(planOverride !== undefined ? { plan_override: planOverride || undefined } : {}),
      },
    }
  }

  /**
   * A pasted SOCKS5 address on a platform-owned account joins the platform proxy pool (deduped by
   * host/port/credentials) and binds by id, so its exit gets probes, geo and health like a VM slot.
   * The inline body is validated first: a rejected edit never leaves a new pool row behind.
   */
  async poolPastedProxy(body, current = null, options = {}) {
    const endpoint = text(body.proxy_endpoint)
    if (!endpoint || !this.proxyPool || current?.vendor_id || options.vendorId) return body
    await this.normalize(body, current, options)
    const parsed = parseSocks5Line(endpoint)
    const ensured = parsed && this.proxyPool.ensureSocks(parsed, { platforms: ['openai'] })
    const row = ensured?.ok ? this.proxyPool.findSocks(parsed) : null
    // A supplier-owned pool row stays theirs; the account keeps the address inline as before.
    if (!row || row.vendor_id || row.kind === 'local') return body
    if (!row.enabled) throw relayError('proxy_unavailable', '此代理已在代理池中停用，请先在代理池启用', 409)
    if (!row.platforms.includes('openai')) this.proxyPool.addPlatform(row.id, 'openai')
    const { proxy_endpoint: _pasted, ...rest } = body
    return { ...rest, proxy_id: row.id }
  }

  /** Move an account's inline (pasted) proxy into the platform pool and bind the account to that row. */
  async poolInlineProxy(actor, id) {
    const current = await this.account(id)
    if (current.vendor_id) throw relayError('proxy_scope_forbidden', '供应商账号的代理由供应商管理', 403)
    if (!this.proxyPool) throw relayError('proxy_pool_unavailable', '代理池不可用', 503)
    if (current.config.proxy_id && this.proxyPool.getProxyByIdWithAuth(current.config.proxy_id))
      return { account: current }
    const stored = await getResourceSecretJson(this.db, id)
    const url = JSON.parse(maybeDecrypt(stored?.secret_json) || '{}').proxy_url
    const parsed = url && parseSocks5Line(url)
    if (!parsed) throw relayError('proxy_required', '账号没有可加入代理池的代理')
    const found = this.proxyPool.findSocks(parsed)
    if (found?.vendor_id) throw relayError('proxy_owned_by_supplier', '此代理属于供应商代理池，无法加入平台代理池', 409)
    return this.update(actor, id, { proxy_endpoint: url })
  }

  /**
   * owner：新建供应商自有账号（供应商开户草稿）。{ vendorId, externalId, createResource(resourceId) }：
   * 授权成功后由 createResource 在同一事务内建供应商账号行（开户策略、额度、幂等与供应商审计留在供应商层），
   * 其余落库（配置、代理密文、分组、绑定、投影与审计）与运营端新建账号相同。
   */
  async createDraft(actor, body, accountId = null, { owner = null } = {}) {
    const drafts = this.drafts
    for (const [key, value] of drafts) if (value.expires <= Date.now()) drafts.delete(key)
    const key = text(body.idempotency_key)
    if (!key || key.length > 200) throw relayError('idempotency_key_required', '缺少有效幂等键')
    const account = accountId ? await this.account(accountId) : null
    const options = { blankName: !account, vendorId: owner?.vendorId || null }
    const normalized = await this.normalize(await this.poolPastedProxy(body, account, options), account, options)
    const requestHash = digest(JSON.stringify({ accountId, normalized }))
    const draftKey = `platform-gateway:${digest(`${actor}:${key}`)}`
    const externalId = owner?.externalId || draftKey
    // 同一幂等键的草稿：读库改为 async 后，并发的同键请求可能都走到这里，登记草稿前（最后一次 await 之后）再查一次
    const reuse = () => {
      for (const draft of drafts.values()) {
        if (draft.draftKey !== draftKey) continue
        if (draft.requestHash !== requestHash) throw relayError('idempotency_conflict', '幂等键已用于不同账号配置', 409)
        return { id: draft.id, expires_at: draft.expires }
      }
      return null
    }
    const reused = reuse()
    if (reused) return reused
    const existing = account || (await accountByOwnerExternalId(this.db, owner?.vendorId || null, externalId))
    // 授权在控制面完成（S1），不需要在线的 Worker：账号写库后由 Worker 直读加载（迁移 130 起绑定与授权会话不记实例）
    const id = `gw_draft_${crypto.randomUUID()}`
    // 新账号建草稿即占号（gw-NN），放弃的草稿留下空号，编号不复用；读高水位与登记在同一事务里，并发建草稿不会拿到同一编号
    const resourceId =
      existing?.id ||
      (await dbClient(this.db).tx(async () => {
        const next = await nextGatewayAccountId(this.db)
        await reserveGatewayAccountId(this.db, next)
        return next
      }))
    const binding = account && (await this.repo.getAccountBinding(account.id))
    const result = !account && existing ? { account: await this.account(existing.id) } : null
    const raced = reuse()
    if (raced) return raced
    drafts.set(id, {
      id,
      actor,
      draftKey,
      externalId,
      owner,
      requestHash,
      normalized,
      resourceId,
      runtimeId: account?.config?.runtime_account_id || binding?.runtime_account_id || `gwacct_${resourceId}`,
      // 账号安装身份（授权链接的 stable id、Worker 请求身份）：新账号由控制面生成，重新授权沿用
      installationId: account?.config?.installation_id || crypto.randomUUID(),
      reauthorize: !!account,
      expires: Date.now() + 30 * 60 * 1000,
      result,
    })
    return { id, expires_at: drafts.get(id).expires }
  }

  // 代次下限：凭据库与绑定里已知的最大值（Worker 心跳上报的本地代次可能高于库里，刷新结果尚未写回时）。
  // 在完成授权、导入时现算，草稿有效期内的刷新也计入（R3 复审 M2）
  async draftFloors(draft) {
    return draft.reauthorize ? this.revisionFloors(draft.resourceId) : { minRevision: 0 }
  }

  async revisionFloors(accountResourceId) {
    const custody = this.service.custody || createCredentialCustody({ db: this.db })
    const binding = await this.repo.getAccountBinding(accountResourceId)
    const nativeVault = await custody.vaultRevision(accountResourceId, 'native')
    return { minRevision: Math.max(0, Number(binding?.credential_revision || 0), nativeVault) }
  }

  draft(actor, id) {
    const draft = this.drafts.get(id)
    if (!draft || draft.actor !== actor || draft.expires <= Date.now())
      throw relayError('draft_not_found', '授权草稿不存在或已过期，请重新填写账号资料', 404)
    return draft
  }

  async exclusive(key, run) {
    const locks = this.locks
    if (locks.has(key)) throw relayError('account_operation_pending', '账号操作进行中，请稍后重试', 409)
    const task = Promise.resolve().then(run)
    locks.set(key, task)
    try {
      return await task
    } finally {
      locks.delete(key)
    }
  }

  unwrap(result) {
    if (!result?.ok)
      throw relayError(
        result?.data?.error?.code || 'gateway_worker_unavailable',
        'Gateway Worker 操作失败，请检查实例或授权状态',
        result?.status >= 400 ? result.status : 502,
      )
    return result.data
  }

  async start(actor, id) {
    const draft = this.draft(actor, id)
    return this.exclusive(id, async () => {
      if (draft.result) throw relayError('draft_completed', '该账号已经创建，请刷新列表', 409)
      await clearExpiredOAuthSessions(this.db, stamp())
      const random = (size) => crypto.randomBytes(size).toString('base64url')
      const session = {
        session_id: random(18),
        state: random(32),
        code_verifier: random(32),
        expires_at: new Date(Date.now() + OAUTH_SESSION_TTL_MS).toISOString(),
      }
      // 授权链接与 PKCE 会话都在控制面生成（S1，与上游 VM 槽位相同），会话加密保存，完成时换码
      const authUrl = gatewayAuthUrl({
        state: session.state,
        codeVerifier: session.code_verifier,
        installationId: draft.installationId,
      })
      draft.sessionId = session.session_id
      await upsertPendingOAuthSession(
        this.db,
        session.session_id,
        draft.reauthorize ? draft.resourceId : null,
        actor,
        digest(session.state),
        id,
        session.expires_at,
        stamp(),
        stamp(),
        maybeEncrypt(JSON.stringify(session)),
      )
      return {
        auth_url: authUrl,
        session_id: session.session_id,
        expires_at: Date.parse(session.expires_at),
        proxy_hint: draft.normalized.config.proxy_endpoint,
      }
    })
  }

  async complete(actor, id, body) {
    const draft = this.draft(actor, id)
    return this.exclusive(id, async () => {
      if (draft.result) return draft.result
      if (body.session_id !== draft.sessionId) throw relayError('oauth_session_mismatch', '授权会话不属于当前草稿', 409)
      const session = await getOAuthSession(this.db, body.session_id, actor)
      if (!session || Date.parse(session.expires_at) <= Date.now())
        throw relayError('oauth_session_expired', '授权链接已过期，请重新生成', 409)
      const callback = text(body.callback || body.code)
      // A full callback is mandatory: never bypass OAuth state validation.
      let parsed
      try {
        parsed = new URL(callback)
      } catch {
        throw relayError('oauth_callback_required', '请粘贴包含 code 和 state 的完整回调链接')
      }
      if (!parsed.searchParams.get('code') || digest(parsed.searchParams.get('state') || '') !== session.state_hash)
        throw relayError('oauth_state_mismatch', 'OAuth state 不匹配，请使用当前授权链接', 409)
      // 控制面经账号代理换码（S1）。授权码只能用一次：换出的令牌先加密记在会话上，收尾失败时重试直接沿用
      // （会话状态的取值由上游表约束限定，记在仍为 pending 的会话的 result_json 上）
      const stored = session.status === 'pending' && session.result_json ? parseSecret(session.result_json) : null
      let tokens = stored?.tokens || null
      if (!tokens) {
        const pkce = session.session_json ? parseSecret(session.session_json) : null
        if (!pkce?.code_verifier) throw relayError('oauth_session_expired', '授权链接已过期，请重新生成', 409)
        tokens = await exchangeGatewayCode({
          code: parsed.searchParams.get('code'),
          codeVerifier: pkce.code_verifier,
          proxyUrl: draft.normalized.proxy,
          fetchImpl: this.tokenFetch,
        })
        await saveOAuthSessionResult(this.db, maybeEncrypt(JSON.stringify({ tokens })), stamp(), session.session_id)
      }
      const result = await this.finalize(draft, tokenIdentity(tokens), tokens)
      await completeOAuthSession(
        this.db,
        draft.resourceId,
        JSON.stringify({ completed_at: stamp() }),
        stamp(),
        session.session_id,
      )
      return result
    })
  }

  async import(actor, id, body) {
    const draft = this.draft(actor, id)
    return this.exclusive(id, async () => {
      if (draft.result) return draft.result
      const parsed = parseCodexImportPayload(body)
      if (!parsed.ok) throw relayError(parsed.error || 'invalid_codex_credential', parsed.message || 'Codex 凭证无效')
      const a = parsed.account
      const fromFile = {
        access_token: text(a.access_token),
        refresh_token: text(a.refresh_token),
        id_token: text(a.id_token),
        expires_at: a.expires_at
          ? new Date(Number(a.expires_at) * (Number(a.expires_at) < 1e12 ? 1000 : 1)).toISOString()
          : null,
      }
      // 只有刷新令牌：先在控制面换出访问令牌（与上游 VM 槽位相同），再一次写库；身份以刷新结果为准
      const refreshed =
        !fromFile.access_token && fromFile.refresh_token
          ? await refreshGatewayToken({
              refreshToken: fromFile.refresh_token,
              proxyUrl: draft.normalized.proxy,
              fetchImpl: this.tokenFetch,
            })
          : null
      const tokens = refreshed || fromFile
      const claimed = tokenIdentity(tokens)
      const identity = refreshed
        ? {
            email: claimed.email || text(a.email) || null,
            chatgpt_account_id: claimed.chatgpt_account_id || text(a.chatgpt_account_id) || null,
            plan: claimed.plan || text(a.chatgpt_plan_type) || null,
          }
        : {
            email: text(a.email) || claimed.email,
            chatgpt_account_id: text(a.chatgpt_account_id) || claimed.chatgpt_account_id,
            plan: text(a.chatgpt_plan_type) || claimed.plan,
          }
      return this.finalize(draft, identity, tokens)
    })
  }

  async finalize(draft, identity, tokens) {
    const current = draft.reauthorize ? await this.account(draft.resourceId) : null
    // Re-read current metadata: reauthorization cannot overwrite concurrent edits.
    const normalized = current
      ? await this.normalize({}, current)
      : await this.normalize(
          {
            name: draft.normalized.name || text(identity.email) || draft.runtimeId,
            notes: draft.normalized.config.notes,
            group_ids: draft.normalized.config.group_ids,
            ...(draft.normalized.config.proxy_id
              ? { proxy_id: draft.normalized.config.proxy_id }
              : { proxy_endpoint: draft.normalized.proxy }),
            max_concurrency: draft.normalized.config.max_concurrency,
            max_rpm: draft.normalized.config.max_rpm,
            weight: draft.normalized.config.weight,
            model_access: draft.normalized.config.model_access,
            status: draft.normalized.status,
          },
          null,
          { vendorId: draft.owner?.vendorId || null },
        )
    return this.saveAuthorized(draft, normalized, identity, tokens)
  }

  // 凭据库（S1：授权、导入的令牌由控制面直接写入）；首次打开要读库，须在事务前调用（R6 复审 P2-1）
  async vault() {
    return (this.service.custody || createCredentialCustody({ db: this.db })).vault()
  }

  async saveAuthorized(draft, normalized, identity, tokens) {
    const { resourceId, actor } = draft
    const secrets = {}
    for (const key of ['access_token', 'refresh_token', 'id_token'])
      if (text(tokens?.[key])) secrets[key] = text(tokens[key])
    if (!secrets.access_token && !secrets.refresh_token) throw relayError('credential_missing', '没有可保存的授权令牌')
    const vault = await this.vault()
    // 新代次高于凭据库、绑定与租约里已知的最大值，Worker 读到后换入（凭据只前进不后退）
    const revision =
      Math.max(
        Number((await vault.meta(resourceId, 'native'))?.revision || 0),
        (await this.draftFloors(draft)).minRevision,
      ) + 1
    const accountId = identity.chatgpt_account_id || null
    let config = {
      ...normalized.config,
      email: identity.email || normalized.config.email || null,
      plan: identity.plan || normalized.config.plan || null,
      chatgpt_account_id: accountId,
      // 订阅到期属于上游账号：重新授权换成另一个 ChatGPT 账号时不能沿用旧值
      subscription:
        accountId && accountId === normalized.config.chatgpt_account_id ? normalized.config.subscription : undefined,
      runtime_account_id: draft.runtimeId,
      installation_id: normalized.config.installation_id || draft.installationId,
    }
    // 供应商建号（owner.createResource → VendorPlatform.createAccount）已改 async（R6 B4），事务随之改为 db.tx；
    // 分组与审计仍是同步仓储调用，落在同一事务里。事务内不等待网络 I/O。
    await dbClient(this.db).tx(async () => {
      const owned = !draft.reauthorize && draft.owner ? await draft.owner.createResource(resourceId) : null
      if (owned) {
        if (owned.id !== resourceId) throw relayError('idempotency_conflict', '幂等键已用于其他账号', 409)
        // 供应商建号时写入的来源字段（平台、授权方式、内联代理转成的代理资源）保留；名称取授权结果
        const { name_from_authorization: _fromAuthorization, ...ownerConfig } = owned.config || {}
        config = { ...ownerConfig, ...config, proxy_id: config.proxy_id || ownerConfig.proxy_id || '' }
        await updateOwnedAccountAuthorized(
          this.db,
          normalized.name,
          normalized.status,
          storedConfig(config),
          maybeEncrypt(JSON.stringify({ proxy_url: normalized.proxy })),
          stamp(),
          resourceId,
        )
      } else if (!draft.reauthorize)
        await insertPlatformAccount(
          this.db,
          resourceId,
          normalized.name,
          draft.externalId,
          normalized.status,
          storedConfig(config),
          maybeEncrypt(JSON.stringify({ proxy_url: normalized.proxy })),
          actor,
          stamp(),
          stamp(),
        )
      else await updateResourceConfigStamped(this.db, storedConfig(config), stamp(), resourceId)
      await this.groups.assignResource(
        'gateway_worker_account',
        resourceId,
        config.group_ids,
        await this.groups.resourceVersion('gateway_worker_account', resourceId),
        actor,
      )
      // 令牌与账号在同一事务写入：任何一步失败都不会留下没有凭据的账号或没有账号的凭据
      await vault.put({
        accountResourceId: resourceId,
        grant: 'native',
        revision,
        secrets,
        expiresAt: tokens.expires_at || tokenExpiry(secrets.access_token),
        source: draft.reauthorize ? 'reauthorize' : 'authorize',
      })
      await this.repo.recordAccountBinding({
        accountResourceId: resourceId,
        runtimeAccountId: draft.runtimeId,
        credentialRevision: revision,
        status: 'pending',
      })
      if (draft.reauthorize) await this.repo.clearRuntimeCredentialState(draft.runtimeId)
      await audit(
        this.db,
        actor,
        draft.reauthorize ? 'gateway.account.reauthorized' : 'gateway.account.created',
        resourceId,
        null,
        { name: normalized.name, group_ids: config.group_ids, execution_kind: 'gateway_worker' },
      )
    })
    if (!config.subscription) void this.refreshSubscription(resourceId)
    draft.result = { account: await this.account(resourceId), oauth_email: config.email }
    return draft.result
  }

  // 导出账号文件（含原生授权令牌，对齐 sub2api 账号导出）：每个账号读取凭据库里的当前令牌；
  // 文件只含凭据与可移植设置（名称、备注、并发/RPM/权重、模型范围、代理地址），分组按目标部署导入时重新选择。
  async exportAccounts(actor, ids) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 500 || ids.some((id) => typeof id !== 'string' || !id))
      throw relayError('invalid_batch', '请选择 1–500 个账号')
    const accounts = []
    const failed = []
    for (const id of [...new Set(ids)]) {
      const account = await this.account(id)
      try {
        // 令牌只读凭据库（S1：凭据由控制面与刷新写入，库里就是最新）
        const data = await (this.service.custody || createCredentialCustody({ db: this.db })).exportSecrets({
          accountResourceId: id,
          account: account.config,
        })
        if (!data?.credentials?.refresh_token && !data?.credentials?.access_token)
          throw relayError('credential_missing', '账号没有可导出的授权令牌', 409)
        const stored = await getResourceSecretJson(this.db, id)
        const proxy = JSON.parse(maybeDecrypt(stored?.secret_json) || '{}').proxy_url || ''
        accounts.push({
          name: account.name,
          notes: account.config.notes || '',
          max_concurrency: account.config.max_concurrency,
          max_rpm: account.config.max_rpm,
          weight: account.config.weight,
          model_access: account.config.model_access || null,
          proxy_url: proxy,
          credentials: data.credentials,
        })
      } catch (error) {
        failed.push({ id, name: account.name, error: { code: error.code || 'export_failed', message: error.message } })
      }
    }
    await audit(this.db, actor, 'gateway.account.exported', 'gateway_accounts', null, {
      ids: accounts.length,
      failed: failed.length,
    })
    return { file: { type: 'kin-gateway-accounts', version: 1, exported_at: stamp(), accounts }, failed }
  }

  // 导入账号文件：逐个创建账号（导入原生授权）；每个账号单独报告结果
  async importAccounts(actor, input = {}) {
    const file = input.file
    if (!file || file.type !== 'kin-gateway-accounts' || file.version !== 1 || !Array.isArray(file.accounts))
      throw relayError('invalid_import_file', '账号文件格式不正确')
    if (!file.accounts.length || file.accounts.length > 500)
      throw relayError('invalid_import_file', '账号文件须含 1–500 个账号')
    const groupIds = input.group_ids
    if (!Array.isArray(groupIds) || !groupIds.length) throw relayError('group_required', '请选择至少一个 OpenAI 分组')
    const items = []
    for (const [index, entry] of file.accounts.entries()) {
      const name = text(entry?.name)
      try {
        const body = {
          idempotency_key: `import:${digest(JSON.stringify([input.idempotency_key || '', index, entry?.credentials?.refresh_token || '']))}`,
          name,
          notes: text(entry?.notes),
          group_ids: groupIds,
          ...(input.proxy_id
            ? { proxy_id: input.proxy_id }
            : { proxy_endpoint: text(input.proxy_endpoint) || text(entry?.proxy_url) }),
        }
        for (const key of ['max_concurrency', 'max_rpm', 'weight'])
          if (Number.isInteger(entry?.[key])) body[key] = entry[key]
        if (entry?.model_access?.mode) body.model_access = entry.model_access
        const draft = await this.createDraft(actor, body)
        const created = await this.import(actor, draft.id, entry?.credentials || {})
        items.push({ index, name: created.account.name, id: created.account.id, ok: true })
      } catch (error) {
        items.push({ index, name, ok: false, error: { code: error.code || 'import_failed', message: error.message } })
      }
    }
    return { items, imported: items.filter((item) => item.ok).length }
  }

  // 授权完成后在后台查一次订阅到期（失败留给定时补查），不阻塞授权结果
  async refreshSubscription(id) {
    try {
      await this.service.accountInsight?.(id, 'subscription')
    } catch {}
  }

  /**
   * 永久删除（docs/RESOURCE_WORKBENCH.md 第 6 节）；可逆的下线请用归档（status=archived）。
   * 一个事务内：清空分组、删除凭据库记录（各授权类别）与刷新租约、作废 OAuth 会话、写墓碑（清空代理密文、
   * 外部编号与配置里的代理字段）并审计；之后丢弃内存中的重新授权草稿。Worker 读到墓碑后删除本地账号
   * （Gateway 事实直读 G4）。墓碑不再出现在任何列表与查找中，结算与用量历史仍按 ID 解析名称。
   */
  async remove(actor, id) {
    return this.exclusive(id, async () => {
      const current = await this.account(id)
      const { proxy_endpoint: _proxyEndpoint, proxy_id: _proxyId, ...kept } = current.config
      const config = { ...kept }
      const at = stamp()
      const custody = this.service.custody || createCredentialCustody({ db: this.db })
      await custody.prepare()
      await dbClient(this.db).tx(async () => {
        await this.groups.assignResource(
          'gateway_worker_account',
          id,
          [],
          await this.groups.resourceVersion('gateway_worker_account', id),
          actor,
        )
        await custody.forget(id)
        await closeAccountOAuthSessions(this.db, id, at)
        await tombstoneResource(this.db, storedConfig(config), at, id)
        await audit(
          this.db,
          actor,
          'gateway.account.deleted',
          id,
          { name: current.name, status: current.status, group_ids: current.config.group_ids },
          { deleted_at: at },
        )
      })
      for (const [key, draft] of this.drafts) if (draft.resourceId === id) this.drafts.delete(key)
      // Worker 读到墓碑后删除本地账号与凭据（Gateway 事实直读 G4），不再逐实例调用删除接口
      return { deleted: id }
    })
  }

  /** Bulk edit uses the single-account update path per account. Every target is
   * validated before the first write, so predictable errors leave nothing changed. */
  async bulkUpdate(actor, input = {}) {
    const ids = input.ids
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > 500 ||
      ids.some((id) => typeof id !== 'string' || !id) ||
      new Set(ids).size !== ids.length
    )
      throw relayError('invalid_batch', '请选择 1–500 个不同的账号')
    const patch = input.patch
    const fields = [
      'status',
      'max_concurrency',
      'max_rpm',
      'weight',
      'model_access',
      'reset_credit_auto',
      'notes',
      'proxy_id',
      'proxy_endpoint',
      'groups',
    ]
    if (
      !patch ||
      typeof patch !== 'object' ||
      Array.isArray(patch) ||
      !Object.keys(patch).length ||
      Object.keys(patch).some((key) => !fields.includes(key))
    )
      throw relayError('invalid_patch', '批量编辑字段不正确')
    if (patch.status != null && !['active', 'paused'].includes(patch.status))
      throw relayError('invalid_status', '调度状态无效')
    const groups = patch.groups
    if (
      groups != null &&
      (!['add', 'remove', 'replace'].includes(groups.operation) ||
        !Array.isArray(groups.ids) ||
        !groups.ids.length ||
        groups.ids.some((id) => !Number.isSafeInteger(id) || id <= 0))
    )
      throw relayError('invalid_groups', '分组操作或选择不正确')
    // 逐个校验（与原来的 map 同序，第一个可预期的错误即中止，不做任何写入）
    const plan = async (id) => {
      const current = await this.account(id)
      if (current.status === 'archived') throw relayError('resource_archived', `${current.name}：账号已归档`, 409)
      const body = {}
      for (const key of [
        'status',
        'max_concurrency',
        'max_rpm',
        'weight',
        'model_access',
        'reset_credit_auto',
        'notes',
        'proxy_id',
        'proxy_endpoint',
      ])
        if (Object.hasOwn(patch, key)) body[key] = patch[key]
      if (groups) {
        const before = current.config.group_ids || []
        body.group_ids =
          groups.operation === 'replace'
            ? [...groups.ids]
            : groups.operation === 'add'
              ? [...new Set([...before, ...groups.ids])]
              : before.filter((g) => !groups.ids.includes(g))
      }
      try {
        await this.normalize(body, current)
      } catch (error) {
        throw relayError(error.code || 'invalid_patch', `${current.name}：${error.message}`, error.status || 400)
      }
      return { id, body }
    }
    const plans = []
    for (const id of ids) plans.push(await plan(id))
    const items = []
    for (const { id, body } of plans) {
      try {
        const result = await this.update(actor, id, body)
        items.push({ id, ok: true })
      } catch (error) {
        items.push({ id, ok: false, error: { code: error.code || 'update_failed', message: error.message } })
      }
    }
    return { items, updated: items.filter((item) => item.ok).length }
  }

  async update(actor, id, body) {
    return this.exclusive(id, async () => {
      const current = await this.account(id)
      const next = await this.normalize(await this.poolPastedProxy(body, current), current)
      await dbClient(this.db).tx(async () => {
        // 只在请求带了分组或要归档时改分组：其他修改（改名、备注、暂停恢复）不重写分组，避免用打开编辑框时的
        // 旧分组覆盖分组页等入口期间的修改。带 expected_group_version 时按它做条件写入（不一致 409）
        if (body.group_ids || next.status === 'archived')
          await this.groups.assignResource(
            'gateway_worker_account',
            id,
            next.status === 'archived' ? [] : next.config.group_ids,
            body.group_ids && body.expected_group_version != null
              ? Number(body.expected_group_version)
              : await this.groups.resourceVersion('gateway_worker_account', id),
            actor,
          )
        await updateAccountRecord(
          this.db,
          next.name,
          next.status,
          storedConfig(next.config),
          maybeEncrypt(JSON.stringify({ proxy_url: next.proxy })),
          next.status === 'archived' ? stamp() : null,
          stamp(),
          id,
        )
        await audit(
          this.db,
          actor,
          'gateway.account.updated',
          id,
          { name: current.name, status: current.status, group_ids: current.config.group_ids },
          { name: next.name, status: next.status, group_ids: next.config.group_ids },
        )
      })
      // Worker 从库里读到这次修改（Gateway 事实直读 G4），不再推送
      return { account: await this.account(id) }
    })
  }
}
