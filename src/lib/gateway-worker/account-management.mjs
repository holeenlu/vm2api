import crypto from 'node:crypto'
import { withTransaction } from '../db/database.mjs'
import { GroupsRepo } from '../db/repos/groups-repo.mjs'
import { maybeDecrypt, maybeEncrypt } from '../db/secure.mjs'
import { audit, relayError } from '../admin/relay-common.mjs'
import { vendorGroupPlatforms } from '../vendor/vendor-groups.mjs'
import { vendorProxyAddress } from '../vendor/vendor-platform.mjs'
import { parseCodexImportPayload } from '../vm/codex-slot.mjs'
import { parseSocks5Line } from '../vm/proxy-pool.mjs'
import { socksProxyUrl } from '../vm/socks-address.mjs'
import { nextGatewayAccountId, reserveGatewayAccountId } from './account-ids.mjs'
import { bodyHash } from './gateway-auth.mjs'
import { gatewayProxyProjection } from './request-location.mjs'
import { createCredentialCustody } from '../executor/credential-custody.mjs'
import { codexSettings } from '../executor/settings-store.mjs'
import { CODEX_ACCOUNT_SCHEMA, validateAgainstSchema } from '../executor/settings-schema.mjs'

const stamp = () => new Date().toISOString()
const text = (value) => String(value ?? '').trim()
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex')
function oauthStateHash(authUrl) {
  const url = new URL(authUrl)
  const state = url.searchParams.get('state')
  if (state) return digest(state)
  const nested = url.searchParams.get('authorize_url')
  if (nested) return digest(new URL(nested).searchParams.get('state') || '')
  throw relayError('oauth_state_missing', 'Worker 未返回有效 OAuth state', 502)
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

/** Worker projection of weight + model access. */
export function gatewayModelFields(config = {}) {
  const access = config.model_access || { mode: 'all', models: [] }
  return {
    weight: config.weight || 1,
    models: access.mode === 'allowlist' ? access.models : [],
    denied_models: access.mode === 'denylist' ? access.models : [],
  }
}

// 期望投影到 Worker 的运行配置（不含版本号）。指纹随 PATCH 下发、由心跳回报，代理设置或出口位置变化时指纹随之变化。
// account 可带已取出的 secret_json，避免逐个账号再查一次
export function desiredGatewayAccountConfig(db, account) {
  const config = account.config || {}
  const stored =
    account.secret_json !== undefined
      ? account
      : db.prepare('SELECT secret_json FROM vendor_resources WHERE id=?').get(account.id)
  const proxy = JSON.parse(maybeDecrypt(stored?.secret_json) || '{}').proxy_url
  return {
    groups: account.status === 'active' ? (config.group_ids || []).map(String) : [],
    enabled: account.status === 'active',
    paused: account.status !== 'active',
    max_concurrency: config.max_concurrency || 4,
    max_rpm: config.max_rpm || 0,
    // 自动使用重置卡（默认关闭）；始终下发布尔值，关闭时 Worker 也能收到
    reset_credit_auto: config.reset_credit_auto === true,
    ...gatewayModelFields(config),
    bps_settings: gatewayBpsProjection(config.bps),
    ...(proxy ? { proxy_url: proxy } : {}),
    ...gatewayProxyProjection(db, config),
  }
}

// 投影到 Worker 的完整运行配置：期望配置、其指纹与投影版本。心跳投影、运营编辑同步与供应商编辑共用，
// Worker 保存的指纹因此总与控制面期望一致，编辑后的下一次心跳不会重复投影
export function gatewayAccountPatch(db, account, projectionRevision = account.config?.projection_revision || 1) {
  const desired = desiredGatewayAccountConfig(db, account)
  return { ...desired, config_fingerprint: bodyHash(desired), projection_revision: Number(projectionRevision) }
}

/** Operator-owned Gateway accounts use the same resource/binding facts as suppliers,
 * with a null supplier. No synthetic supplier, portal login or supplier settlement. */
// BPS（Excel Basispoints）是 OAuth 账号上的附加授权：config.bps 是账号的 BPS 设置（运营可编辑），
// config.bps_grant 记录 Worker 上 BPS 授权的代次与时间（只由授权、导入、撤销写入）。
// 首次授权 BPS 时的默认设置（与 sub2api excel_bps_defaults 一致：403 自动停用、缓存写入按输入计费默认开启；
// 403 自动恢复默认开启、每 1 分钟探测，429 冷却缺省 5 秒，对齐 codex2api 原作者）。
export const BPS_DEFAULTS = Object.freeze({
  enabled: true,
  models: [],
  omit_unsupported_tools: false,
  ignore_encrypted_content: false,
  auto_disable_on_403: true,
  auto_recover_on_403: true,
  recovery_interval_minutes: 1,
  rate_limit_cooldown_seconds: 5,
  auto_move_on_403: false,
  target_group_id: null,
  cache_creation_as_input: true,
})

// 授权会话有效期（与 Worker 过去的 oauthSessionTTL 相同）
const OAUTH_SESSION_TTL_MS = 10 * 60_000

const BPS_BOOLEANS = [
  'enabled',
  'omit_unsupported_tools',
  'ignore_encrypted_content',
  'auto_disable_on_403',
  'auto_recover_on_403',
  'auto_move_on_403',
  'cache_creation_as_input',
]

/** 校验账号 BPS 设置；未提供的字段沿用当前值（首次为默认值）。 */
export function normalizeBpsSettings(raw, current, availableGroupIds) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw relayError('invalid_bps_settings', 'BPS 设置无效')
  const next = { ...BPS_DEFAULTS, ...(current || {}), ...raw }
  // 类型、范围与联动约束按账号设置描述校验（与面板表单同一份描述，R4 审查 P2-1）；错误码沿用原有的细分码
  const errors = validateAgainstSchema(CODEX_ACCOUNT_SCHEMA, raw, next)
  if (errors.length) {
    const [first] = errors
    const codes = {
      models: ['invalid_bps_models', 'BPS 模型须为最多 100 个不重复的精确模型 ID'],
      recovery_interval_minutes: ['invalid_bps_recovery_interval', '403 恢复间隔须为 1–10080 分钟'],
      rate_limit_cooldown_seconds: ['invalid_bps_rate_limit_cooldown', '429 冷却须为 1–600 秒'],
      auto_recover_on_403: ['invalid_bps_recovery', '自动恢复需要先开启 403 自动停用'],
      target_group_id: ['invalid_bps_target_group', '请选择 403 后移入的分组（0 表示退出所有分组）'],
    }
    const [code, message] = codes[first.field] || [
      'invalid_bps_settings',
      `BPS 设置无效：${first.field} ${first.reason}`,
    ]
    throw relayError(code, message)
  }
  if (next.auto_move_on_403) {
    const target = next.target_group_id
    if (target !== 0 && !availableGroupIds.has(target))
      throw relayError('invalid_bps_target_group', '请选择 403 后移入的分组（0 表示退出所有分组）')
  } else next.target_group_id = null
  return { ...next, models: [...next.models] }
}

/** Worker 投影的 BPS 设置（403 移组只在控制面生效，不下发）。 */
export function gatewayBpsProjection(bps) {
  if (!bps) return null
  return {
    enabled: bps.enabled === true,
    models: bps.models || [],
    omit_unsupported_tools: bps.omit_unsupported_tools === true,
    ignore_encrypted_content: bps.ignore_encrypted_content === true,
    auto_disable_on_403: bps.auto_disable_on_403 === true,
    auto_recover_on_403: bps.auto_recover_on_403 === true,
    recovery_interval_minutes: bps.recovery_interval_minutes || 1,
    rate_limit_cooldown_seconds: bps.rate_limit_cooldown_seconds || 5,
    cache_creation_as_input: bps.cache_creation_as_input === true,
  }
}

export class GatewayAccountManagement {
  constructor({ repo, service, proxyPool } = {}) {
    this.repo = repo
    this.service = service
    this.proxyPool = proxyPool
    this.drafts = new Map()
    this.locks = new Map()
  }

  get db() {
    return this.repo.db
  }
  get groups() {
    return new GroupsRepo(this.db)
  }

  account(id) {
    const row = this.repo.listCodexAccounts({ includeArchived: true }).find((item) => item.id === id)
    if (!row) throw relayError('account_not_found', 'Codex 账号不存在', 404)
    return row
  }

  availableGroups(account = null) {
    let vendors = []
    if (account?.vendor_id) {
      const owner = this.db.prepare('SELECT * FROM vendors WHERE id=?').get(account.vendor_id)
      if (!owner || owner.status !== 'active') return []
      vendors = [owner]
      if (owner.parent_id) vendors.push(this.db.prepare('SELECT * FROM vendors WHERE id=?').get(owner.parent_id))
    }
    return this.groups
      .list()
      .filter(
        (group) =>
          group.status === 'active' &&
          vendorGroupPlatforms(group).includes('openai') &&
          !this.db
            .prepare(
              "SELECT 1 FROM group_resources WHERE group_id=? AND resource_kind NOT IN ('vm','gateway_worker_account') LIMIT 1",
            )
            .get(group.id) &&
          vendors.every(
            (v) =>
              v &&
              v.status === 'active' &&
              (!JSON.parse(v.platforms_json).length ||
                JSON.parse(v.platforms_json).some((p) => ['openai', 'codex'].includes(p))) &&
              JSON.parse(v.groups_json).some((g) => String(g) === String(group.id) || g === group.name),
          ),
      )
  }

  catalog(account = null) {
    return {
      groups: this.availableGroups(account),
      proxies: this.db
        .prepare(
          "SELECT id,name,host,port FROM proxies WHERE enabled=1 AND vendor_id IS NULL AND protocol<>'local' ORDER BY name,id",
        )
        .all(),
      worker_available: !!this.repo.pickInstance(),
      authorizations: this.authorizationKinds(),
    }
  }

  // 在线 Worker 能力描述里的授权方式（P6.3）：账号向导按它决定是否提供“添加 BPS 授权”步骤。
  // 兼容：旧版 Worker 不报告该字段，按它们实际支持的全部方式处理；所有 Worker 都报告该字段后删除这一回退（R4 审查 P2-8）。
  authorizationKinds() {
    const LEGACY = ['oauth', 'import', 'bps_oauth', 'bps_import']
    const kinds = new Set()
    for (const instance of this.repo.listInstances()) {
      if (!['healthy', 'degraded'].includes(instance.health_state)) continue
      const reported = instance.capabilities?.authorizations
      for (const kind of Array.isArray(reported) ? reported.map((item) => item?.kind).filter(Boolean) : LEGACY)
        kinds.add(String(kind))
    }
    return [...kinds].sort()
  }

  normalize(body, current = null, { blankName = false } = {}) {
    const allowed = [
      'name',
      'notes',
      'group_ids',
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
      'bps',
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
      const stored = this.db.prepare('SELECT secret_json FROM vendor_resources WHERE id=?').get(current.id)
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
    const ids = body.group_ids ?? config.group_ids
    if (!Array.isArray(ids) || !ids.length) throw relayError('group_required', '请选择至少一个 OpenAI 分组')
    const available = new Set(this.availableGroups(current).map((g) => g.id))
    if (ids.some((id) => !Number.isSafeInteger(id) || !available.has(id)))
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
      const supplierProxy = this.db
        .prepare("SELECT * FROM vendor_resources WHERE id=? AND resource_type='proxy' AND status='active'")
        .get(proxyId)
      if (supplierProxy) {
        if (supplierProxy.vendor_id !== current?.vendor_id)
          throw relayError('proxy_scope_forbidden', '代理不属于该供应商', 403)
        proxy = vendorProxyAddress(
          JSON.parse(maybeDecrypt(supplierProxy.secret_json) || '{}').endpoint ||
            JSON.parse(supplierProxy.config_json).endpoint,
        )
      } else {
        const row = this.db.prepare('SELECT * FROM proxies WHERE id=? AND enabled=1 AND vendor_id IS NULL').get(proxyId)
        const resolved = row && this.proxyPool?.getProxyByIdWithAuth(proxyId)
        if (!resolved || resolved.kind === 'local') throw relayError('proxy_unavailable', '代理不可用', 409)
        proxy = socksProxyUrl(resolved)
      }
    } else if (current && !Object.hasOwn(body, 'proxy_id')) {
      const stored = this.db.prepare('SELECT secret_json FROM vendor_resources WHERE id=?').get(current.id)
      proxy = JSON.parse(maybeDecrypt(stored?.secret_json) || '{}').proxy_url || config.proxy_endpoint || ''
    }
    // A blank edit preserves the current inline proxy, never clears credentials.
    if (!proxy && current && !endpoint && !body.proxy_id) {
      const stored = this.db.prepare('SELECT secret_json FROM vendor_resources WHERE id=?').get(current.id)
      proxy = JSON.parse(maybeDecrypt(stored?.secret_json) || '{}').proxy_url || config.proxy_endpoint || ''
    }
    if (!proxy) throw relayError('proxy_required', '请先配置账号出站代理')
    const url = new URL(proxy)
    // BPS 设置只能在已授权 BPS 的账号上编辑（新建账号先完成 OAuth，再添加 BPS 授权）
    let bps = config.bps
    if (body.bps !== undefined) {
      if (!current || !config.bps_grant) throw relayError('bps_not_authorized', '请先为该账号添加 BPS 授权', 409)
      bps = normalizeBpsSettings(body.bps, config.bps, available)
    }
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
        ...(bps ? { bps } : {}),
      },
    }
  }

  /**
   * A pasted SOCKS5 address on a platform-owned account joins the platform proxy pool (deduped by
   * host/port/credentials) and binds by id, so its exit gets probes, geo and health like a VM slot.
   * The inline body is validated first: a rejected edit never leaves a new pool row behind.
   */
  poolPastedProxy(body, current = null, options = {}) {
    const endpoint = text(body.proxy_endpoint)
    if (!endpoint || !this.proxyPool || current?.vendor_id) return body
    this.normalize(body, current, options)
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
    const current = this.account(id)
    if (current.vendor_id) throw relayError('proxy_scope_forbidden', '供应商账号的代理由供应商管理', 403)
    if (!this.proxyPool) throw relayError('proxy_pool_unavailable', '代理池不可用', 503)
    if (current.config.proxy_id && this.proxyPool.getProxyByIdWithAuth(current.config.proxy_id))
      return { account: current, projection_pending: false }
    const stored = this.db.prepare('SELECT secret_json FROM vendor_resources WHERE id=?').get(id)
    const url = JSON.parse(maybeDecrypt(stored?.secret_json) || '{}').proxy_url
    const parsed = url && parseSocks5Line(url)
    if (!parsed) throw relayError('proxy_required', '账号没有可加入代理池的代理')
    const found = this.proxyPool.findSocks(parsed)
    if (found?.vendor_id) throw relayError('proxy_owned_by_supplier', '此代理属于供应商代理池，无法加入平台代理池', 409)
    return this.update(actor, id, { proxy_endpoint: url })
  }

  createDraft(actor, body, accountId = null) {
    const drafts = this.drafts
    for (const [key, value] of drafts) if (value.expires <= Date.now()) drafts.delete(key)
    const key = text(body.idempotency_key)
    if (!key || key.length > 200) throw relayError('idempotency_key_required', '缺少有效幂等键')
    const account = accountId ? this.account(accountId) : null
    // BPS 授权草稿只针对已完成 OAuth 的账号（BPS 是附加授权）
    const grant = text(body.authorization_kind) === 'bps_oauth' ? 'bps' : null
    if (grant && !account) throw relayError('bps_requires_account', '请先完成 OAuth 授权，再添加 BPS 授权', 409)
    const options = { blankName: !account }
    const normalized = this.normalize(this.poolPastedProxy(body, account, options), account, options)
    const requestHash = digest(JSON.stringify({ accountId, normalized, grant }))
    const externalId = `platform-gateway:${digest(`${actor}:${key}`)}`
    for (const draft of drafts.values()) {
      if (draft.externalId !== externalId) continue
      if (draft.requestHash !== requestHash) throw relayError('idempotency_conflict', '幂等键已用于不同账号配置', 409)
      return { id: draft.id, expires_at: draft.expires }
    }
    const existing =
      account ||
      this.db.prepare('SELECT id FROM vendor_resources WHERE vendor_id IS NULL AND external_id=?').get(externalId)
    const instance = account
      ? this.repo
          .listAccountBindings(account.id)
          .map((b) => this.repo.getInstance(b.gateway_instance_id))
          .find((i) => i && ['healthy', 'degraded'].includes(i.health_state) && i.drain_state === 'accepting')
      : this.repo.pickInstance()
    if (!instance) throw relayError('gateway_worker_unavailable', '暂无可用 Gateway Worker，请先检查实例状态', 503)
    const id = `gw_draft_${crypto.randomUUID()}`
    // 新账号建草稿即占号（gw-NN），放弃的草稿留下空号，编号不复用
    const resourceId = existing?.id || nextGatewayAccountId(this.db)
    if (!existing) reserveGatewayAccountId(this.db, resourceId)
    const binding = account && this.repo.getAccountBinding(account.id, instance.id)
    drafts.set(id, {
      id,
      actor,
      externalId,
      requestHash,
      normalized,
      resourceId,
      runtimeId: binding?.runtime_account_id || `gwacct_${resourceId}`,
      instanceId: instance.id,
      expectedRevision: binding?.credential_revision || 0,
      grant,
      expectedBpsRevision: account?.config?.bps_grant?.revision || 0,
      reauthorize: !!account,
      expires: Date.now() + 30 * 60 * 1000,
      result: !account && existing ? { account: this.account(existing.id) } : null,
    })
    return { id, expires_at: drafts.get(id).expires }
  }

  // 代次下限：各实例绑定、凭据库与刷新租约里已知的最大值。选中的实例副本落后时，新授权也不会与其他实例刷新出的代次撞号（R3 复审 N2）。
  // 在完成授权、导入时现算，草稿有效期内其他实例的刷新也计入（R3 复审 M2）
  draftFloors(draft) {
    return draft.reauthorize ? this.revisionFloors(draft.resourceId) : { minRevision: 0, minBpsGeneration: 0 }
  }

  revisionFloors(accountResourceId) {
    const custody = this.service.custody || createCredentialCustody({ db: this.db })
    const bindings = this.repo.listAccountBindings(accountResourceId)
    const lease = (grant) =>
      Number(
        this.db
          .prepare(
            'SELECT credential_revision FROM credential_refresh_leases WHERE account_resource_id=? AND grant_kind=?',
          )
          .get(accountResourceId, grant)?.credential_revision || 0,
      )
    return {
      minRevision: Math.max(
        0,
        ...bindings.map((binding) => Number(binding.credential_revision || 0)),
        custody.vaultRevision(accountResourceId, 'native'),
        lease('native'),
      ),
      minBpsGeneration: Math.max(0, custody.vaultRevision(accountResourceId, 'bps') - 1, lease('bps')),
    }
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
      // 授权会话由控制面生成并保存（P3.7）：state 与 PKCE verifier 交给 Worker 构造授权链接，Worker 不落盘
      this.db
        .prepare(
          'UPDATE gateway_worker_oauth_sessions SET session_json=NULL WHERE session_json IS NOT NULL AND expires_at<?',
        )
        .run(stamp())
      const random = (size) => crypto.randomBytes(size).toString('base64url')
      const session = {
        session_id: random(18),
        state: random(32),
        code_verifier: random(32),
        expires_at: new Date(Date.now() + OAUTH_SESSION_TTL_MS).toISOString(),
      }
      const data = this.unwrap(
        await this.service.oauthStart(
          {
            draft_id: id,
            runtime_account_id: draft.runtimeId,
            proxy_url: draft.normalized.proxy,
            idempotency_key: id,
            session,
            ...(draft.grant ? { grant: draft.grant } : {}),
          },
          draft.instanceId,
        ),
      )
      draft.sessionId = data.session_id
      this.db
        .prepare(
          `INSERT INTO gateway_worker_oauth_sessions(session_id,account_resource_id,actor_user_id,gateway_instance_id,state_hash,provider,status,idempotency_key,expires_at,created_at,updated_at,session_json) VALUES(?,?,?,?,?,'openai','pending',?,?,?,?,?) ON CONFLICT(gateway_instance_id,idempotency_key) DO UPDATE SET session_id=excluded.session_id,state_hash=excluded.state_hash,expires_at=excluded.expires_at,updated_at=excluded.updated_at,session_json=excluded.session_json,status='pending',result_json=NULL`,
        )
        .run(
          data.session_id,
          draft.reauthorize ? draft.resourceId : null,
          actor,
          draft.instanceId,
          data.state_hash || oauthStateHash(data.auth_url),
          id,
          data.expires_at,
          stamp(),
          stamp(),
          // 新版 Worker 交回补上安装身份的会话；旧版 Worker 自行保存会话、不交回（过渡期兼容）
          data.session ? maybeEncrypt(JSON.stringify(data.session)) : null,
        )
      return {
        auth_url: data.auth_url,
        session_id: data.session_id,
        expires_at: Date.parse(data.expires_at),
        proxy_hint: draft.normalized.config.proxy_endpoint,
      }
    })
  }

  async complete(actor, id, body) {
    const draft = this.draft(actor, id)
    return this.exclusive(id, async () => {
      if (draft.result) return draft.result
      if (body.session_id !== draft.sessionId) throw relayError('oauth_session_mismatch', '授权会话不属于当前草稿', 409)
      const session = this.db
        .prepare('SELECT * FROM gateway_worker_oauth_sessions WHERE session_id=? AND actor_user_id=?')
        .get(body.session_id, actor)
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
      // Worker 已换码、但随后的收尾失败时，重试直接沿用记下的换码结果（授权码只能用一次，R3 审查 P2-4）。
      // 换码结果记在仍为 pending 的会话的 result_json 上（会话状态的取值由上游表约束限定）
      const exchanged = session.status === 'pending' && session.result_json ? JSON.parse(session.result_json) : null
      const data =
        exchanged ||
        this.unwrap(
          await this.service.oauthComplete(
            {
              session_id: session.session_id,
              ...(session.session_json ? { session: JSON.parse(maybeDecrypt(session.session_json)) } : {}),
              callback,
              draft_id: id,
              ...(draft.grant
                ? {
                    expected_bps_revision: draft.expectedBpsRevision,
                    min_bps_token_generation: this.draftFloors(draft).minBpsGeneration,
                  }
                : {
                    expected_credential_revision: draft.expectedRevision,
                    min_credential_revision: this.draftFloors(draft).minRevision,
                  }),
              idempotency_key: id,
            },
            draft.instanceId,
          ),
        )
      if (!exchanged)
        this.db
          .prepare(
            'UPDATE gateway_worker_oauth_sessions SET result_json=?,session_json=NULL,updated_at=? WHERE session_id=?',
          )
          .run(
            JSON.stringify({
              account: data.account || {},
              credential_revision: data.credential_revision ?? null,
              bps_revision: data.bps_revision ?? null,
            }),
            stamp(),
            session.session_id,
          )
      const result = draft.grant
        ? await this.saveBpsGrant(draft.resourceId, actor, data.bps_revision, draft)
        : await this.finalize(draft, data.account || {})
      this.db
        .prepare(
          "UPDATE gateway_worker_oauth_sessions SET status='completed',account_resource_id=?,result_json=?,session_json=NULL,updated_at=? WHERE session_id=?",
        )
        .run(
          draft.resourceId,
          JSON.stringify({ credential_revision: data.credential_revision }),
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
      if (draft.grant) throw relayError('bps_import_via_draft', 'BPS 授权文件请在账号的 BPS 区域导入', 400)
      const parsed = parseCodexImportPayload(body)
      if (!parsed.ok) throw relayError(parsed.error || 'invalid_codex_credential', parsed.message || 'Codex 凭证无效')
      const a = parsed.account
      const payload = {
        id: draft.runtimeId,
        enabled: false,
        paused: true,
        auth_type: 'oauth',
        proxy_url: draft.normalized.proxy,
        credential_revision: Math.max(draft.expectedRevision, this.draftFloors(draft).minRevision) + 1,
      }
      for (const key of ['access_token', 'refresh_token', 'id_token', 'email', 'chatgpt_account_id']) {
        if (typeof a[key] === 'string' && a[key]) payload[key] = a[key]
      }
      if (a.chatgpt_plan_type) payload.plan = a.chatgpt_plan_type
      if (a.expires_at)
        payload.expires_at = new Date(Number(a.expires_at) * (Number(a.expires_at) < 1e12 ? 1000 : 1)).toISOString()
      let saved = this.unwrap(
        draft.reauthorize
          ? await this.service.client.accountAction(draft.instanceId, draft.runtimeId, 'reauthorize', payload)
          : await this.service.upsertAccount(payload, draft.instanceId),
      )
      if (!a.access_token && a.refresh_token)
        saved = this.unwrap(await this.service.client.accountAction(draft.instanceId, draft.runtimeId, 'refresh', {}))
      return this.finalize(draft, saved.account || a)
    })
  }

  async finalize(draft, identity) {
    const current = draft.reauthorize ? this.account(draft.resourceId) : null
    // Re-read current metadata: reauthorization cannot overwrite concurrent edits.
    const normalized = current
      ? this.normalize({}, current)
      : this.normalize({
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
        })
    return this.saveAuthorized(draft, normalized, identity)
  }

  async saveAuthorized(draft, normalized, identity) {
    const { resourceId, actor } = draft
    const accountId = identity.chatgpt_account_id || null
    const config = {
      ...normalized.config,
      email: identity.email || normalized.config.email || null,
      plan: identity.plan || normalized.config.plan || null,
      chatgpt_account_id: accountId,
      // 订阅到期属于上游账号：重新授权换成另一个 ChatGPT 账号时不能沿用旧值
      subscription:
        accountId && accountId === normalized.config.chatgpt_account_id ? normalized.config.subscription : undefined,
      runtime_account_id: draft.runtimeId,
      projection_revision: Number(normalized.config.projection_revision || 0) + 1,
    }
    withTransaction(this.db, () => {
      if (!draft.reauthorize)
        this.db
          .prepare(
            "INSERT INTO vendor_resources(id,vendor_id,resource_type,name,external_id,status,config_json,secret_json,created_by,created_at,updated_at) VALUES(?,NULL,'account',?,?,?,?,?,?,?,?)",
          )
          .run(
            resourceId,
            normalized.name,
            draft.externalId,
            normalized.status,
            JSON.stringify(config),
            maybeEncrypt(JSON.stringify({ proxy_url: normalized.proxy })),
            actor,
            stamp(),
            stamp(),
          )
      else
        this.db
          .prepare('UPDATE vendor_resources SET config_json=?,updated_at=? WHERE id=?')
          .run(JSON.stringify(config), stamp(), resourceId)
      this.groups.assignResource(
        'gateway_worker_account',
        resourceId,
        config.group_ids,
        this.groups.resourceVersion('gateway_worker_account', resourceId),
        actor,
      )
      this.repo.recordProjection({
        accountResourceId: resourceId,
        instanceId: draft.instanceId,
        runtimeAccountId: draft.runtimeId,
        credentialRevision: Number(identity.credential_revision || draft.expectedRevision + 1),
        projectionRevision: config.projection_revision,
        status: 'pending',
      })
      audit(
        this.db,
        actor,
        draft.reauthorize ? 'gateway.account.reauthorized' : 'gateway.account.created',
        resourceId,
        null,
        { name: normalized.name, group_ids: config.group_ids, execution_kind: 'gateway_worker' },
      )
    })
    const synced = await this.sync(resourceId)
    if (!config.subscription) void this.refreshSubscription(resourceId)
    draft.result = { account: this.account(resourceId), projection_pending: !synced, oauth_email: config.email }
    return draft.result
  }

  // 首次添加 BPS 授权时套用的默认设置：Codex 本地设置中的 BPS 默认模板（bps_defaults），读取失败时用内置默认
  bpsDefaults() {
    try {
      // BPS 默认设置模板来自控制面设置存储（P4.2）
      return { ...BPS_DEFAULTS, ...codexSettings(this.db).bps_defaults }
    } catch {
      return { ...BPS_DEFAULTS }
    }
  }

  // BPS 授权写入后记录代次；首次授权时套用默认设置（运营随后在 BPS 区域选择模型）
  async saveBpsGrant(id, actor, revision, draft = null) {
    const account = this.account(id)
    const config = {
      ...account.config,
      bps: account.config.bps || this.bpsDefaults(),
      bps_grant: { revision: Number(revision) || 1, authorized_at: stamp() },
      projection_revision: Number(account.config.projection_revision || 0) + 1,
    }
    withTransaction(this.db, () => {
      this.db
        .prepare('UPDATE vendor_resources SET config_json=?,updated_at=? WHERE id=?')
        .run(JSON.stringify(config), stamp(), id)
      audit(this.db, actor, 'gateway.account.bps_authorized', id, null, { bps_revision: config.bps_grant.revision })
    })
    const synced = await this.sync(id)
    const result = { account: this.account(id), projection_pending: !synced }
    if (draft) draft.result = result
    return result
  }

  // 导入 Excel 授权（auth JSON：access_token、refresh_token、id_token，可选 expires_at、chatgpt_account_id）
  async importBps(actor, id, body) {
    return this.exclusive(id, async () => {
      const account = this.account(id)
      if (account.status === 'archived') throw relayError('resource_archived', '账号已归档', 409)
      const source = body?.tokens && typeof body.tokens === 'object' ? body.tokens : body || {}
      const payload = {}
      for (const key of ['access_token', 'refresh_token', 'id_token', 'chatgpt_account_id'])
        if (typeof source[key] === 'string' && source[key]) payload[key] = source[key]
      if (!payload.access_token || !payload.refresh_token)
        throw relayError('invalid_bps_credential', 'BPS 授权文件须包含 access_token 与 refresh_token')
      if (source.expires_at)
        payload.expires_at =
          Number(source.expires_at) > 1e12 ? Math.floor(Number(source.expires_at) / 1000) : Number(source.expires_at)
      payload.expected_bps_revision = account.config.bps_grant?.revision || 0
      payload.min_bps_token_generation = this.revisionFloors(id).minBpsGeneration
      const binding = this.repo.getAccountBinding(id)
      if (!binding) throw relayError('gateway_account_projection_pending', '账号尚未投影到 Gateway Worker', 409)
      const data = this.unwrap(
        await this.service.client.internal(
          binding.gateway_instance_id,
          `/internal/v1/accounts/${encodeURIComponent(binding.runtime_account_id)}/bps/import`,
          { method: 'POST', body: payload },
        ),
      )
      return this.saveBpsGrant(id, actor, data.bps_revision)
    })
  }

  // BPS 模型目录（官方 /responses/access?include_models=true，经 Worker 按账号代理查询）：保存最近一次结果，
  // 供 BPS 模型选择与 /models 的推理强度使用；查询失败不改动已保存的目录
  async bpsModels(id, { refresh = false } = {}) {
    const account = this.account(id)
    if (!account.config.bps_grant) throw relayError('bps_not_authorized', '账号尚未添加 BPS 授权', 409)
    const binding = this.repo.getAccountBinding(id)
    if (!binding) throw relayError('gateway_account_projection_pending', '账号尚未投影到 Gateway Worker', 409)
    const data = this.unwrap(
      await this.service.client.internal(
        binding.gateway_instance_id,
        `/internal/v1/accounts/${encodeURIComponent(binding.runtime_account_id)}/bps/models${refresh ? '?refresh=1' : ''}`,
        { method: 'GET' },
      ),
    )
    const catalog = {
      allowed: data?.allowed === true,
      models: (Array.isArray(data?.models) ? data.models : [])
        .filter((model) => typeof model?.id === 'string' && model.id)
        .slice(0, 200)
        .map((model) => ({
          id: model.id,
          ...(model.display_name ? { display_name: String(model.display_name).slice(0, 120) } : {}),
          reasoning_efforts: (Array.isArray(model.reasoning_efforts) ? model.reasoning_efforts : []).filter((effort) =>
            ['low', 'medium', 'high', 'xhigh'].includes(effort),
          ),
          ...(model.cooling_down ? { cooling_down: true } : {}),
        })),
      restricted_models: (Array.isArray(data?.restricted_models) ? data.restricted_models : [])
        .filter((value) => typeof value === 'string')
        .slice(0, 200),
      fetched_at: data?.fetched_at || stamp(),
    }
    const latest = this.account(id)
    this.db
      .prepare('UPDATE vendor_resources SET config_json=?,updated_at=? WHERE id=?')
      .run(JSON.stringify({ ...latest.config, bps_catalog: catalog }), stamp(), id)
    return catalog
  }

  // 导出账号文件（含原生与 BPS 授权令牌，对齐 sub2api 账号导出）：每个账号读取当前令牌（凭据库或 Worker 凭据包）；
  // 文件只含凭据与可移植设置（名称、备注、并发/RPM/权重、模型范围、BPS 设置、代理地址），分组按目标部署导入时重新选择。
  async exportAccounts(actor, ids) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 500 || ids.some((id) => typeof id !== 'string' || !id))
      throw relayError('invalid_batch', '请选择 1–500 个账号')
    const accounts = []
    const failed = []
    for (const id of [...new Set(ids)]) {
      const account = this.account(id)
      const binding = this.repo.getAccountBinding(id)
      try {
        if (!binding) throw relayError('gateway_account_projection_pending', '账号尚未投影到 Gateway Worker', 409)
        // 令牌不再经 Worker 明文接口读取（P3.9）：control 托管读凭据库，worker 托管解开导出的凭据包
        const exported = this.unwrap(
          await this.service.client.exportAccount(binding.gateway_instance_id, binding.runtime_account_id),
        )
        const data = (this.service.custody || createCredentialCustody({ db: this.db })).exportSecrets({
          accountResourceId: id,
          runtimeAccountId: binding.runtime_account_id,
          exported,
        })
        if (!data?.credentials?.refresh_token && !data?.credentials?.access_token)
          throw relayError('credential_missing', '账号没有可导出的授权令牌', 409)
        const stored = this.db.prepare('SELECT secret_json FROM vendor_resources WHERE id=?').get(id)
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
          ...(account.config.bps ? { bps: account.config.bps } : {}),
          ...(data.bps_credentials ? { bps_credentials: data.bps_credentials } : {}),
        })
      } catch (error) {
        failed.push({ id, name: account.name, error: { code: error.code || 'export_failed', message: error.message } })
      }
    }
    audit(this.db, actor, 'gateway.account.exported', 'gateway_accounts', null, {
      ids: accounts.length,
      bps: accounts.filter((a) => a.bps_credentials).length,
      failed: failed.length,
    })
    return { file: { type: 'kin-gateway-accounts', version: 1, exported_at: stamp(), accounts }, failed }
  }

  // 导入账号文件：逐个创建账号（导入原生授权），再导入 BPS 授权并套用 BPS 设置；每个账号单独报告结果
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
        const draft = this.createDraft(actor, body)
        const created = await this.import(actor, draft.id, entry?.credentials || {})
        const id = created.account.id
        let bps = 'none'
        if (entry?.bps_credentials) {
          await this.importBps(actor, id, { tokens: entry.bps_credentials })
          bps = 'authorized'
          if (entry.bps && typeof entry.bps === 'object') {
            const { target_group_id: _target, auto_move_on_403: _move, ...settings } = entry.bps
            await this.update(actor, id, { bps: settings })
          }
        }
        items.push({ index, name: created.account.name, id, ok: true, bps })
      } catch (error) {
        items.push({ index, name, ok: false, error: { code: error.code || 'import_failed', message: error.message } })
      }
    }
    return { items, imported: items.filter((item) => item.ok).length }
  }

  // BPS 严格探测（精确模型 + 工具往返）的最近结果；只写控制面配置，不影响调度
  recordBpsVerification(id, result) {
    const account = this.account(id)
    const verification = {
      ok: result?.ok === true,
      model: String(result?.model || '').slice(0, 120),
      mode: result?.probe?.mode || result?.authorization_mode || null,
      response_model: result?.probe?.response_model || null,
      error_code: result?.ok ? null : String(result?.error?.code || 'probe_failed').slice(0, 64),
      verified_at: stamp(),
    }
    this.db
      .prepare('UPDATE vendor_resources SET config_json=?,updated_at=? WHERE id=?')
      .run(JSON.stringify({ ...account.config, bps_verification: verification }), stamp(), id)
    return verification
  }

  // 手动解除 BPS 403 停用（同时清除 BPS 冷却）或停止本次自动恢复：各实例执行，下一次心跳确认状态
  async bpsRecoveryAction(actor, id, action) {
    return this.exclusive(id, async () => {
      const account = this.account(id)
      if (!account.config.bps_grant) throw relayError('bps_not_authorized', '账号尚未添加 BPS 授权', 409)
      const path = action === 'unblock' ? 'unblock' : 'recovery/stop'
      for (const binding of this.repo.listAccountBindings(id))
        this.unwrap(
          await this.service.client.internal(
            binding.gateway_instance_id,
            `/internal/v1/accounts/${encodeURIComponent(binding.runtime_account_id)}/bps/${path}`,
            { method: 'POST', body: {} },
          ),
        )
      withTransaction(this.db, () => {
        if (action === 'unblock')
          this.db
            .prepare(
              'UPDATE gateway_worker_account_bindings SET bps_state=NULL,bps_error=NULL,bps_blocked_at=NULL,bps_recovery=NULL,bps_next_probe_at=NULL,bps_cooldown_until=NULL WHERE account_resource_id=?',
            )
            .run(id)
        else
          this.db
            .prepare(
              "UPDATE gateway_worker_account_bindings SET bps_recovery='stopped',bps_next_probe_at=NULL WHERE account_resource_id=? AND bps_state='blocked'",
            )
            .run(id)
        audit(
          this.db,
          actor,
          action === 'unblock' ? 'gateway.account.bps_unblocked' : 'gateway.account.bps_recovery_stopped',
          id,
          null,
          {},
        )
      })
      return { account: this.account(id) }
    })
  }

  // 撤销 BPS 授权：各实例删除 Excel 授权，BPS 设置保留以便重新授权后沿用
  async revokeBps(actor, id) {
    return this.exclusive(id, async () => {
      const account = this.account(id)
      for (const binding of this.repo.listAccountBindings(id))
        this.unwrap(
          await this.service.client.internal(
            binding.gateway_instance_id,
            `/internal/v1/accounts/${encodeURIComponent(binding.runtime_account_id)}/bps`,
            { method: 'DELETE' },
          ),
        )
      const { bps_grant: _removed, ...rest } = account.config
      const config = { ...rest, projection_revision: Number(account.config.projection_revision || 0) + 1 }
      // 凭据库里的 BPS 令牌一并删除（重新授权后令牌代次从头计，R3 审查 P1-2）
      ;(this.service.custody || createCredentialCustody({ db: this.db })).forget(id, 'bps')
      // 刷新租约里的 BPS 代次与指纹一并删除：否则重新授权后其他实例会一直被判为过时（R3 复审 N3）
      this.db.prepare("DELETE FROM credential_refresh_leases WHERE account_resource_id=? AND grant_kind='bps'").run(id)
      withTransaction(this.db, () => {
        this.db
          .prepare('UPDATE vendor_resources SET config_json=?,updated_at=? WHERE id=?')
          .run(JSON.stringify(config), stamp(), id)
        audit(this.db, actor, 'gateway.account.bps_revoked', id, null, {})
      })
      const synced = await this.sync(id)
      return { account: this.account(id), projection_pending: !synced }
    })
  }

  // BPS 账号级 403 停用后按设置移组（只处理一次，按 Worker 记录的停用时刻去重）；0 表示退出所有分组
  reconcileBpsBlocks(actor = 'system') {
    const moved = []
    for (const account of this.repo.listCodexAccounts()) {
      const bps = account.config.bps
      const blockedAt = account.bps_blocked_at
      if (account.bps_state !== 'blocked' || !blockedAt || !bps?.auto_move_on_403) continue
      if (account.config.bps_moved?.blocked_at === blockedAt) continue
      const target = bps.target_group_id
      const groupIds = target ? [target] : []
      const config = {
        ...account.config,
        group_ids: groupIds,
        bps_moved: { blocked_at: blockedAt, group_id: target, moved_at: stamp() },
        projection_revision: Number(account.config.projection_revision || 0) + 1,
      }
      withTransaction(this.db, () => {
        this.db
          .prepare('UPDATE vendor_resources SET config_json=?,updated_at=? WHERE id=?')
          .run(JSON.stringify(config), stamp(), account.id)
        this.groups.assignResource(
          'gateway_worker_account',
          account.id,
          groupIds,
          this.groups.resourceVersion('gateway_worker_account', account.id),
          actor,
        )
        audit(this.db, actor, 'gateway.account.bps_moved', account.id, null, {
          group_id: target,
          blocked_at: blockedAt,
        })
      })
      moved.push(account.id)
    }
    for (const id of moved) void this.sync(id).catch(() => {})
    return moved
  }

  // 授权完成后在后台查一次订阅到期（失败留给定时补查），不阻塞授权结果
  async refreshSubscription(id) {
    try {
      await this.service.accountInsight?.(id, 'subscription')
    } catch {}
  }

  // 代理已在调用前随配置写入 secret_json，投影载荷由 accountPatch 统一生成（含配置指纹）
  async sync(id) {
    const account = this.account(id)
    const config = account.config
    let all = true
    for (const binding of this.repo.listAccountBindings(id)) {
      let ok = false
      try {
        const result = await this.service.client.patchAccount(
          binding.gateway_instance_id,
          binding.runtime_account_id,
          gatewayAccountPatch(this.repo.db, account),
        )
        ok = result.ok
        this.repo.recordProjection({
          accountResourceId: id,
          instanceId: binding.gateway_instance_id,
          runtimeAccountId: binding.runtime_account_id,
          projectionRevision: config.projection_revision || 1,
          credentialRevision: Number(result.data?.account?.credential_revision || binding.credential_revision),
          status: ok ? 'synced' : 'drifted',
          error: ok ? null : 'projection_failed',
        })
      } catch {
        this.repo.recordProjection({
          accountResourceId: id,
          instanceId: binding.gateway_instance_id,
          runtimeAccountId: binding.runtime_account_id,
          projectionRevision: config.projection_revision || 1,
          credentialRevision: binding.credential_revision,
          status: 'drifted',
          error: 'gateway_worker_unavailable',
        })
      }
      all = all && ok
    }
    if (all) {
      const source = this.repo.getAccountBinding(id)
      if (source)
        all = (
          await this.service.projectAccountToAll(
            {
              id: source.runtime_account_id,
              account_resource_id: id,
              credential_revision: source.credential_revision,
              projection_revision: config.projection_revision,
            },
            source.gateway_instance_id,
          )
        ).ok
    }
    return all
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
      'bps',
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
    // BPS 批量设置：开关与恢复间隔直接覆盖，模型名单按 add/remove/replace 合并；403 移组按账号单独设置，不参与批量
    const bpsPatch = patch.bps
    const bpsKeys = [
      'enabled',
      'models',
      ...BPS_BOOLEANS.filter((key) => key !== 'auto_move_on_403'),
      'recovery_interval_minutes',
    ]
    if (
      bpsPatch != null &&
      (typeof bpsPatch !== 'object' ||
        Array.isArray(bpsPatch) ||
        !Object.keys(bpsPatch).length ||
        Object.keys(bpsPatch).some((key) => !bpsKeys.includes(key)) ||
        (bpsPatch.models != null &&
          (!['add', 'remove', 'replace'].includes(bpsPatch.models.operation) ||
            !Array.isArray(bpsPatch.models.ids) ||
            (bpsPatch.models.operation !== 'replace' && !bpsPatch.models.ids.length))))
    )
      throw relayError('invalid_bps_settings', 'BPS 批量设置字段不正确')
    const plans = ids.map((id) => {
      const current = this.account(id)
      if (current.status === 'archived') throw relayError('resource_archived', `${current.name}：账号已归档`, 409)
      const body = {}
      if (bpsPatch) {
        if (!current.config.bps_grant)
          return { id, skip: { code: 'bps_not_authorized', message: '账号尚未添加 BPS 授权' } }
        const { models: modelOp, ...flags } = bpsPatch
        const before = current.config.bps?.models || []
        const models = !modelOp
          ? before
          : modelOp.operation === 'replace'
            ? [...new Set(modelOp.ids)]
            : modelOp.operation === 'add'
              ? [...new Set([...before, ...modelOp.ids])]
              : before.filter((model) => !modelOp.ids.includes(model))
        body.bps = { ...flags, models }
      }
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
        this.normalize(body, current)
      } catch (error) {
        throw relayError(error.code || 'invalid_patch', `${current.name}：${error.message}`, error.status || 400)
      }
      return { id, body }
    })
    const items = []
    for (const { id, body, skip } of plans) {
      if (skip) {
        items.push({ id, ok: false, error: skip })
        continue
      }
      try {
        const result = await this.update(actor, id, body)
        items.push({ id, ok: true, projection_pending: result.projection_pending })
      } catch (error) {
        items.push({ id, ok: false, error: { code: error.code || 'update_failed', message: error.message } })
      }
    }
    return { items, updated: items.filter((item) => item.ok).length }
  }

  async update(actor, id, body) {
    return this.exclusive(id, async () => {
      const current = this.account(id)
      const next = this.normalize(this.poolPastedProxy(body, current), current)
      next.config.projection_revision = Number(current.config.projection_revision || 0) + 1
      withTransaction(this.db, () => {
        if (body.group_ids || next.status === 'active' || next.status === 'archived')
          this.groups.assignResource(
            'gateway_worker_account',
            id,
            next.status === 'archived' ? [] : next.config.group_ids,
            this.groups.resourceVersion('gateway_worker_account', id),
            actor,
          )
        this.db
          .prepare(
            'UPDATE vendor_resources SET name=?,status=?,config_json=?,secret_json=?,archived_at=?,updated_at=? WHERE id=?',
          )
          .run(
            next.name,
            next.status,
            JSON.stringify(next.config),
            maybeEncrypt(JSON.stringify({ proxy_url: next.proxy })),
            next.status === 'archived' ? stamp() : null,
            stamp(),
            id,
          )
        this.db
          .prepare(
            "UPDATE gateway_worker_account_bindings SET projection_status='pending',projection_revision=?,updated_at=? WHERE account_resource_id=?",
          )
          .run(next.config.projection_revision, stamp(), id)
        audit(
          this.db,
          actor,
          'gateway.account.updated',
          id,
          { name: current.name, status: current.status, group_ids: current.config.group_ids },
          { name: next.name, status: next.status, group_ids: next.config.group_ids },
        )
      })
      const synced = await this.sync(id)
      return { account: this.account(id), projection_pending: !synced }
    })
  }
}
