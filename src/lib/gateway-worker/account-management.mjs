import crypto from 'node:crypto'
import { withTransaction } from '../db/database.mjs'
import { GroupsRepo } from '../db/repos/groups-repo.mjs'
import { maybeDecrypt, maybeEncrypt } from '../db/secure.mjs'
import { audit, relayError } from '../admin/relay-common.mjs'
import { vendorGroupPlatforms } from '../vendor/vendor-groups.mjs'
import { vendorProxyAddress } from '../vendor/vendor-platform.mjs'
import { parseCodexImportPayload } from '../vm/codex-slot.mjs'
import { proxyUrl } from '../vm/proxy-address.mjs'
import { bodyHash } from './gateway-auth.mjs'
import { gatewayProxyProjection } from './request-location.mjs'

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
    }
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
        proxy = proxyUrl(resolved)
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
      },
    }
  }

  createDraft(actor, body, accountId = null) {
    const drafts = this.drafts
    for (const [key, value] of drafts) if (value.expires <= Date.now()) drafts.delete(key)
    const key = text(body.idempotency_key)
    if (!key || key.length > 200) throw relayError('idempotency_key_required', '缺少有效幂等键')
    const account = accountId ? this.account(accountId) : null
    const normalized = this.normalize(body, account, { blankName: !account })
    const requestHash = digest(JSON.stringify({ accountId, normalized }))
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
    const resourceId = existing?.id || `account_${crypto.randomUUID()}`
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
      reauthorize: !!account,
      expires: Date.now() + 30 * 60 * 1000,
      result: !account && existing ? { account: this.account(existing.id) } : null,
    })
    return { id, expires_at: drafts.get(id).expires }
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
      const data = this.unwrap(
        await this.service.oauthStart(
          { draft_id: id, runtime_account_id: draft.runtimeId, proxy_url: draft.normalized.proxy, idempotency_key: id },
          draft.instanceId,
        ),
      )
      draft.sessionId = data.session_id
      this.db
        .prepare(
          `INSERT INTO gateway_worker_oauth_sessions(session_id,account_resource_id,actor_user_id,gateway_instance_id,state_hash,provider,status,idempotency_key,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,'openai','pending',?,?,?,?) ON CONFLICT(gateway_instance_id,idempotency_key) DO UPDATE SET session_id=excluded.session_id,state_hash=excluded.state_hash,expires_at=excluded.expires_at,updated_at=excluded.updated_at`,
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
      const data = this.unwrap(
        await this.service.oauthComplete(
          {
            session_id: session.session_id,
            callback,
            draft_id: id,
            expected_credential_revision: draft.expectedRevision,
            idempotency_key: id,
          },
          draft.instanceId,
        ),
      )
      const result = await this.finalize(draft, data.account || {})
      this.db
        .prepare(
          "UPDATE gateway_worker_oauth_sessions SET status='completed',account_resource_id=?,result_json=?,updated_at=? WHERE session_id=?",
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
      const parsed = parseCodexImportPayload(body)
      if (!parsed.ok) throw relayError(parsed.error || 'invalid_codex_credential', parsed.message || 'Codex 凭证无效')
      const a = parsed.account
      const payload = {
        id: draft.runtimeId,
        enabled: false,
        paused: true,
        auth_type: 'oauth',
        proxy_url: draft.normalized.proxy,
        credential_revision: draft.expectedRevision + 1,
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
    const config = {
      ...normalized.config,
      email: identity.email || normalized.config.email || null,
      plan: identity.plan || normalized.config.plan || null,
      chatgpt_account_id: identity.chatgpt_account_id || null,
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
    draft.result = { account: this.account(resourceId), projection_pending: !synced, oauth_email: config.email }
    return draft.result
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
    const plans = ids.map((id) => {
      const current = this.account(id)
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
        this.normalize(body, current)
      } catch (error) {
        throw relayError(error.code || 'invalid_patch', `${current.name}：${error.message}`, error.status || 400)
      }
      return { id, body }
    })
    const items = []
    for (const { id, body } of plans) {
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
      const next = this.normalize(body, current)
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
