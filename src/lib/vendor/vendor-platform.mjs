import crypto from 'node:crypto'
import { getDb, withTransaction } from '../db/database.mjs'
import { maybeEncrypt, maybeDecrypt } from '../db/secure.mjs'
import { proxyUrl } from '../vm/proxy-address.mjs'
import { hashPassword, isPanelUsername, USERNAME_HELP } from '../admin/panel-users.mjs'
import { parseProxyLine } from '../vm/proxy-pool.mjs'
import { vendorGroupPlatforms } from './vendor-groups.mjs'

const CAPABILITIES = [
  'vendor.create_child',
  'vendor.vm.create',
  'vendor.resource.manage',
  'vendor.resource.export',
  'vendor.usage.read',
  'vendor.settlement.read',
  'vendor.settlement.confirm',
  'vendor.settlement.pay',
]

const RESOURCE_TYPES = new Set(['account', 'vm', 'proxy'])
const now = () => new Date().toISOString()
const id = (prefix) => `${prefix}_${crypto.randomUUID()}`
const asJson = (value, fallback) => {
  try {
    return value == null ? fallback : JSON.parse(value)
  } catch {
    return fallback
  }
}
const arrayOf = (value) => (Array.isArray(value) ? [...new Set(value.map(String))] : [])
const clean = (value) => String(value ?? '').trim()

export function vendorProxyAddress(value) {
  const raw = clean(value)
  if (!raw || raw.length > 2000) throw new VendorError('invalid_proxy', '请输入有效代理地址')
  const parsed = parseProxyLine(raw)
  try {
    if (!parsed) throw new Error('invalid_proxy')
    return proxyUrl(raw.includes('://') ? parsed : { ...parsed, scheme: 'http' })
  } catch {
    throw new VendorError('invalid_proxy', '请输入有效的 HTTP、HTTPS 或 SOCKS5 代理地址')
  }
}

export class VendorError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message)
    this.code = code
    this.status = status
    this.details = details
  }
}

export function normalizeVendorRate(value) {
  const parsed = Number(value)
  if (!['number', 'string'].includes(typeof value) || !Number.isFinite(parsed) || parsed <= 0 || parsed >= 1e12)
    throw new VendorError('invalid_rate', '结算参数必须为支持范围内的正数')
  const canonical = Number(parsed.toFixed(10))
  if (canonical <= 0 || canonical >= 1e12) throw new VendorError('invalid_rate', '结算参数精度最多十位小数')
  return canonical
}

export function rejectInlinePricing(body = {}) {
  const removed = [
    'binance_id',
    'default_price_cny_per_usd',
    'group_prices',
    'fx_cny_per_usdt',
    'default_multiplier',
    'contract_version',
    'openai_price',
    'claude_price',
    'exchange_rate',
    'effective_date',
  ]
  if (
    removed.some((k) => Object.hasOwn(body, k)) ||
    Object.keys(body).some((k) =>
      /^vendor_(binance|default_price|openai_price|claude_price|fx_|default_multiplier|group_prices)/.test(k),
    )
  )
    throw new VendorError('pricing_settings_required', '请在供应商平台的结算设置中维护全局价格')
}

function assertText(value, code, message, max = 160) {
  const text = clean(value)
  if (!text || text.length > max) throw new VendorError(code, message)
  return text
}

function projectVendor(row, capabilities = [], parent = null) {
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    tier: row.tier,
    role: 'vendor',
    parent_id: row.parent_id,
    root_id: row.root_id,
    status: row.status,
    groups: asJson(row.groups_json, []).length ? asJson(row.groups_json, []) : asJson(parent?.groups_json, []),
    effective_platforms: ['anthropic', 'openai'].filter((platform) =>
      [row, ...(parent ? [parent] : [])].every((v) => {
        const allowed = asJson(v.platforms_json, []).map((p) => ({ claude: 'anthropic', codex: 'openai' })[p] || p)
        return !allowed.length || allowed.includes(platform)
      }),
    ),
    platforms: asJson(row.platforms_json, []).length
      ? asJson(row.platforms_json, [])
      : asJson(parent?.platforms_json, []),
    account_limit: row.account_limit,
    proxy_limit: row.proxy_limit,
    child_limit: row.child_limit,
    capability_revision: row.capability_revision,
    policy_revision: row.policy_revision,
    capabilities,
    views: [
      'accounts',
      'proxies',
      ...(capabilities.includes('vendor.usage.read') ? ['usage'] : []),
      ...(capabilities.includes('vendor.settlement.read') ? ['billing'] : []),
      ...(capabilities.includes('vendor.create_child') ? ['vendors'] : []),
    ],
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function projectResource(row, { includeSecret = false } = {}) {
  if (!row) return null
  const config = asJson(row.config_json, {})
  if (row.resource_type === 'proxy' && config.endpoint) {
    try {
      const address = new URL(config.endpoint)
      address.username = ''
      address.password = ''
      config.endpoint = address.href
    } catch {
      config.endpoint = ''
    }
  }
  delete config.proxy

  return {
    id: row.id,
    vendor_id: row.vendor_id,
    resource_type: row.resource_type,
    name: row.name,
    external_id: row.external_id,
    status: row.status,
    config,
    ...(includeSecret ? { secret: asJson(maybeDecrypt(row.secret_json), null) } : {}),
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    archived_at: row.archived_at,
  }
}

export class VendorPlatform {
  constructor(db = getDb(), { vmProvisioner = null } = {}) {
    this.db = db
    this.vmProvisioner = vmProvisioner
  }

  actorId(actorUserId) {
    return clean(actorUserId) || 'master'
  }

  capabilities(vendorId) {
    return this.db
      .prepare('SELECT capability FROM vendor_capabilities WHERE vendor_id = ? AND enabled = 1 ORDER BY capability')
      .all(vendorId)
      .map((row) => row.capability)
  }

  vendorRow(vendorId) {
    return this.db.prepare('SELECT * FROM vendors WHERE id = ? AND deleted_at IS NULL').get(vendorId) || null
  }

  identity(userId) {
    const uid = clean(userId)
    if (!uid) throw new VendorError('vendor_auth_required', '供应商会话无效', 401)
    const row = this.db
      .prepare(
        `
        SELECT v.*, vm.id AS member_id, vm.user_id
        FROM vendor_members vm
        JOIN vendors v ON v.id = vm.vendor_id
        JOIN users u ON u.id=vm.user_id
        WHERE vm.user_id = ? AND vm.status = 'active' AND v.status = 'active' AND v.deleted_at IS NULL
          AND u.role='vendor' AND u.status='active' AND u.deleted_at IS NULL
        ORDER BY vm.is_primary DESC, vm.created_at ASC LIMIT 1
      `,
      )
      .get(uid)
    if (!row) throw new VendorError('vendor_forbidden', '当前账号没有有效的供应商身份', 403)
    return {
      user_id: uid,
      member_id: row.member_id,
      vendor: projectVendor(row, this.capabilities(row.id), row.parent_id ? this.vendorRow(row.parent_id) : null),
    }
  }

  refreshIdentity(identity) {
    if (identity.member_id) {
      const current = this.identity(identity.user_id)
      if (current.vendor.id !== identity.vendor.id)
        throw new VendorError('vendor_scope_forbidden', '供应商身份已变化', 403)
      identity.vendor = current.vendor
    } else if (!identity.system_admin) {
      const vendor = this.getVendor(identity.vendor.id)
      if (!vendor) throw new VendorError('vendor_forbidden', '供应商身份已撤销', 403)
      identity.vendor = vendor
    }
    return identity
  }

  requireCapability(identity, capability) {
    this.refreshIdentity(identity)
    if (!identity.vendor.capabilities.includes(capability)) {
      throw new VendorError('capability_required', `缺少供应商能力：${capability}`, 403)
    }
  }

  requireActive(identity) {
    this.refreshIdentity(identity)
    const current = this.vendorRow(identity.vendor.id)
    const parent = current?.parent_id ? this.vendorRow(current.parent_id) : null
    if (!current || current.status !== 'active' || (current.parent_id && parent?.status !== 'active'))
      throw new VendorError('vendor_inactive', '供应商当前不可操作', 409)
  }

  visibleVendorIds(identity, { aggregate = false } = {}) {
    const ids = [identity.vendor.id]
    if (aggregate && identity.vendor.tier === 1) {
      this.requireCapability(identity, 'vendor.create_child')
      this.db
        .prepare('SELECT id FROM vendors WHERE parent_id = ? AND deleted_at IS NULL')
        .all(identity.vendor.id)
        .forEach((row) => ids.push(row.id))
    }
    return ids
  }

  audit({
    actorUserId,
    vendorId,
    action,
    resourceType = null,
    resourceId = null,
    idempotencyKey = null,
    payload = {},
  }) {
    this.db
      .prepare(
        `
        INSERT INTO vendor_audit_events
          (id, actor_user_id, vendor_id, action, resource_type, resource_id, idempotency_key, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        id('audit'),
        this.actorId(actorUserId),
        vendorId,
        action,
        resourceType,
        resourceId,
        idempotencyKey,
        JSON.stringify(payload),
        now(),
      )
  }

  createRoot({ actorUserId, userId, body }) {
    const childLimit = Number(body.child_limit ?? 0)
    if (!Number.isSafeInteger(childLimit) || childLimit < 0)
      throw new VendorError('invalid_child_limit', '下级供应商数量上限须为非负整数，0 表示不限制')
    for (const field of ['account_limit', 'proxy_limit']) {
      const value = Number(body[field] ?? 0)
      if (!Number.isSafeInteger(value) || value < 0) throw new VendorError('invalid_limit', '资源上限须为非负整数')
    }
    rejectInlinePricing(body)
    const createdAt = now()
    const vendorId = id('vendor')
    return withTransaction(this.db, () => {
      const member = this.loginUser(body, clean(userId || body?.user_id))
      const memberUserId = member.id
      const name = member.username
      const email = member.email
      const externalCode = vendorId
      const groups = arrayOf(body.groups)
      const platforms = arrayOf(body.platforms)
      this.db
        .prepare(
          `
        INSERT INTO vendors
          (id,name,external_code,email,tier,parent_id,root_id,status,groups_json,platforms_json,account_limit,proxy_limit,child_limit,created_by,created_at,updated_at)
        VALUES (?, ?, ?, ?, 1, NULL, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        )
        .run(
          vendorId,
          name,
          externalCode,
          email,
          vendorId,
          JSON.stringify(groups),
          JSON.stringify(platforms),
          Number(body.account_limit || 0),
          Number(body.proxy_limit || 0),
          childLimit,
          this.actorId(actorUserId),
          createdAt,
          createdAt,
        )
      this.grantDefaults(vendorId, body.capabilities)
      if (memberUserId) this.addMember(vendorId, memberUserId, actorUserId)
      this.audit({
        actorUserId,
        vendorId,
        action: 'vendor.created',
        payload: { tier: 1, external_code: externalCode },
      })
      return this.getVendor(vendorId)
    })
  }

  loginUser(body, existingId = '') {
    if (existingId) {
      const member = this.db
        .prepare('SELECT id,username,email FROM users WHERE id=? AND deleted_at IS NULL')
        .get(existingId)
      if (!member) throw new VendorError('user_not_found', '登录账号不存在', 404)
      return member
    }
    const username = clean(body.username)
    const password = String(body.password || '')
    if (!isPanelUsername(username)) throw new VendorError('invalid_username', USERNAME_HELP)
    if (password.length < 8 || password.length > 128)
      throw new VendorError('invalid_password', '供应商密码长度必须为 8–128 位')
    if (this.db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE AND deleted_at IS NULL').get(username))
      throw new VendorError('username_exists', '供应商用户名已存在', 409)
    const member = { id: id('user'), username }
    member.email = member.id + '@vendor.local'
    const stamp = now()
    this.db
      .prepare(
        "INSERT INTO users (id,email,username,password_hash,role,status,created_at,updated_at) VALUES (?,?,?,?,'vendor','active',?,?)",
      )
      .run(member.id, member.email, username, hashPassword(password), stamp, stamp)
    return member
  }

  grantDefaults(vendorId, requested, { useDefaults = true } = {}) {
    const capabilities = arrayOf(requested).filter((x) => CAPABILITIES.includes(x))
    const effective =
      capabilities.length || !useDefaults
        ? capabilities
        : ['vendor.resource.manage', 'vendor.vm.create', 'vendor.usage.read', 'vendor.settlement.read']
    const stamp = now()
    for (const capability of effective)
      this.db
        .prepare(
          'INSERT OR REPLACE INTO vendor_capabilities (vendor_id,capability,enabled,revision,created_at,updated_at) VALUES (?,?,1,1,?,?)',
        )
        .run(vendorId, capability, stamp, stamp)
  }

  addMember(vendorId, userId, actorUserId) {
    const user = this.db.prepare('SELECT role,status FROM users WHERE id = ? AND deleted_at IS NULL').get(userId)
    if (!user) throw new VendorError('member_user_not_found', '成员用户不存在', 404)
    if (!['user', 'vendor'].includes(user.role) || user.status !== 'active')
      throw new VendorError('invalid_member', '只能绑定有效的普通用户或供应商账号', 403)
    if (
      this.db
        .prepare("SELECT 1 FROM vendor_members WHERE user_id=? AND vendor_id<>? AND status='active'")
        .get(userId, vendorId)
    )
      throw new VendorError('member_already_bound', '账号已绑定其他供应商', 409)
    const stamp = now()
    this.db
      .prepare("UPDATE users SET role = 'vendor', updated_at = ? WHERE id = ? AND role = 'user'")
      .run(stamp, userId)
    this.db
      .prepare(
        `
      INSERT INTO vendor_members (id,user_id,vendor_id,status,is_primary,created_by,created_at,updated_at)
      VALUES (?,?,?,'active',1,?,?,?)
      ON CONFLICT(user_id,vendor_id) DO UPDATE SET status='active', updated_at=excluded.updated_at
    `,
      )
      .run(id('member'), userId, vendorId, this.actorId(actorUserId), stamp, stamp)
  }

  createChild(identity, body) {
    return withTransaction(this.db, () => this.createChildInTransaction(identity, body))
  }

  createChildInTransaction(identity, body) {
    this.requireActive(identity)
    if (identity.vendor.tier !== 1) throw new VendorError('child_vendor_forbidden', '二级供应商不能创建下级供应商', 403)
    this.requireCapability(identity, 'vendor.create_child')
    const parent = this.vendorRow(identity.vendor.id)
    const key = clean(body.idempotency_key)
    const requestHash = crypto
      .createHash('sha256')
      .update(
        JSON.stringify(
          Object.fromEntries(
            Object.entries(body)
              .filter(([k]) => !['password', 'idempotency_key'].includes(k))
              .sort(([a], [b]) => a.localeCompare(b)),
          ),
        ),
      )
      .digest('hex')
    if (key) {
      const previous = this.db
        .prepare(
          'SELECT action,resource_id,payload_json FROM vendor_audit_events WHERE vendor_id=? AND idempotency_key=?',
        )
        .get(parent.id, key)
      if (previous) {
        if (
          previous.action !== 'vendor.child_created' ||
          asJson(previous.payload_json, {}).request_hash !== requestHash
        )
          throw new VendorError('idempotency_conflict', '开户标识已用于其他请求', 409)
        return this.getVendor(previous.resource_id)
      }
    }
    const children = this.db
      .prepare('SELECT COUNT(*) AS count FROM vendors WHERE parent_id = ? AND deleted_at IS NULL')
      .get(parent.id).count
    // A zero child_limit means unlimited, matching the platform's other quota fields.
    if (parent.child_limit > 0 && children >= parent.child_limit)
      throw new VendorError('child_limit_exceeded', '已达到下级供应商数量上限', 409)
    const parentGroups = asJson(parent.groups_json, [])
    const parentPlatforms = asJson(parent.platforms_json, [])
    const groups = arrayOf(body.groups).length ? arrayOf(body.groups) : parentGroups
    const platforms = arrayOf(body.platforms).length ? arrayOf(body.platforms) : parentPlatforms
    if (parentGroups.length && groups.some((value) => !parentGroups.includes(value)))
      throw new VendorError('parent_scope_violation', '下级供应商的分组超出父级范围', 409)
    if (parentPlatforms.length && platforms.some((value) => !parentPlatforms.includes(value)))
      throw new VendorError('parent_scope_violation', '下级供应商的平台超出父级范围', 409)
    const accountLimit = Number(body.account_limit ?? parent.account_limit)
    const proxyLimit = Number(body.proxy_limit ?? parent.proxy_limit)
    if (![accountLimit, proxyLimit].every((v) => Number.isSafeInteger(v) && v >= 0))
      throw new VendorError('invalid_limit', '资源上限须为非负整数')
    if (body.user_id != null) throw new VendorError('member_binding_forbidden', '供应商开户必须创建独立登录账号', 403)
    if (
      arrayOf(body.capabilities).some((c) => c === 'vendor.create_child' || !identity.vendor.capabilities.includes(c))
    )
      throw new VendorError('capability_scope_forbidden', '下级能力不能超出父级或包含下级开户能力', 403)

    if (
      (parent.account_limit > 0 && (accountLimit === 0 || accountLimit > parent.account_limit)) ||
      (parent.proxy_limit > 0 && (proxyLimit === 0 || proxyLimit > parent.proxy_limit))
    )
      throw new VendorError('quota_exceeds_parent', '下级供应商额度不能超过父级', 409)
    rejectInlinePricing(body)
    const vendorId = id('vendor')
    const stamp = now()
    return withTransaction(this.db, () => {
      const member = this.loginUser(body, clean(body.user_id))
      const memberUserId = member.id
      const name = member.username
      const email = member.email
      const externalCode = vendorId
      this.db
        .prepare(
          `
        INSERT INTO vendors (id,name,external_code,email,tier,parent_id,root_id,status,groups_json,platforms_json,account_limit,proxy_limit,child_limit,created_by,created_at,updated_at)
        VALUES (?, ?, ?, ?, 2, ?, ?, 'active', ?, ?, ?, ?, 0, ?, ?, ?)
      `,
        )
        .run(
          vendorId,
          name,
          externalCode,
          email,
          parent.id,
          parent.root_id,
          JSON.stringify(groups),
          JSON.stringify(platforms),
          accountLimit,
          proxyLimit,
          this.actorId(identity.user_id),
          stamp,
          stamp,
        )
      const requested = arrayOf(body.capabilities)
      const childCapabilities = requested.length
        ? requested
        : ['vendor.resource.manage', 'vendor.vm.create', 'vendor.usage.read', 'vendor.settlement.read'].filter((c) =>
            identity.vendor.capabilities.includes(c),
          )
      this.grantDefaults(vendorId, childCapabilities, { useDefaults: false })
      if (memberUserId) this.addMember(vendorId, memberUserId, identity.user_id)
      this.audit({
        actorUserId: identity.user_id,
        vendorId: parent.id,
        action: 'vendor.child_created',
        resourceType: 'vendor',
        resourceId: vendorId,
        idempotencyKey: key || null,
        payload: { child_id: vendorId, tier: 2, request_hash: requestHash },
      })
      return this.getVendor(vendorId)
    })
  }

  getVendor(vendorId) {
    const row = this.vendorRow(vendorId)
    return projectVendor(
      row,
      row ? this.capabilities(row.id) : [],
      row?.parent_id ? this.vendorRow(row.parent_id) : null,
    )
  }

  listVendors(identity) {
    this.requireCapability(identity, 'vendor.create_child')
    const ids = this.visibleVendorIds(identity, { aggregate: true })
    return this.db
      .prepare(`SELECT * FROM vendors WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY tier, name`)
      .all(...ids)
      .map((row) => this.getVendor(row.id))
  }

  createProxy(identity, body) {
    const endpoint = vendorProxyAddress(body.config?.endpoint)
    const publicUrl = new URL(endpoint)
    publicUrl.username = ''
    publicUrl.password = ''
    return this.createResource(identity, 'proxy', {
      name: clean(body.name) || publicUrl.host,
      config: {
        endpoint: publicUrl.href,
        platforms: Array.isArray(body.platforms) ? [...new Set(body.platforms.map(String))] : [],
      },
      secret: { endpoint },
    })
  }

  inlineProxy(identity, value) {
    this.requireActive(identity)
    this.requireCapability(identity, 'vendor.resource.manage')
    const endpoint = vendorProxyAddress(value)
    const rows = this.db
      .prepare("SELECT * FROM vendor_resources WHERE vendor_id=? AND resource_type='proxy' AND status <> 'archived'")
      .all(identity.vendor.id)
    const existing = rows.find((row) => asJson(maybeDecrypt(row.secret_json), {}).endpoint === endpoint)
    if (existing) {
      if (existing.status !== 'active')
        throw new VendorError('proxy_unavailable', '此代理已停用，请在 IP 代理中启用', 409)
      return projectResource(existing)
    }
    return this.createProxy(identity, { config: { endpoint } })
  }

  resourceSecret(identity, resourceId) {
    const row = this.getResource(identity, resourceId, { write: true })
    return asJson(maybeDecrypt(row.secret_json), {})
  }

  setResourcePoolProxy(identity, resourceId, poolProxyId) {
    const row = this.getResource(identity, resourceId, { write: true })
    const config = asJson(row.config_json, {})
    config.pool_proxy_id = clean(poolProxyId) || null
    this.db
      .prepare('UPDATE vendor_resources SET config_json=?, updated_at=? WHERE id=?')
      .run(JSON.stringify(config), now(), row.id)
    return projectResource(this.db.prepare('SELECT * FROM vendor_resources WHERE id=?').get(row.id))
  }

  updateProxyResource(identity, resourceId, body = {}) {
    return withTransaction(this.db, () => {
      const row = this.getResource(identity, resourceId, { write: true })
      if (row.resource_type !== 'proxy') throw new VendorError('resource_not_found', '代理资源不存在', 404)
      if (row.status === 'archived') throw new VendorError('resource_archived', '已归档代理不可修改', 409)
      if (!identity.system_admin) this.requireActive(identity)
      if (!identity.system_admin) this.requireCapability(identity, 'vendor.resource.manage')

      const currentConfig = asJson(row.config_json, {})
      const currentSecret = asJson(maybeDecrypt(row.secret_json), {})
      let endpoint = currentSecret.endpoint || currentConfig.endpoint || ''
      if (body.endpoint != null) endpoint = vendorProxyAddress(body.endpoint)
      const publicEndpoint = endpoint
        ? (() => {
            const parsed = new URL(endpoint)
            parsed.username = ''
            parsed.password = ''
            return parsed.href
          })()
        : ''
      const config = { ...currentConfig, endpoint: publicEndpoint }
      if (body.platforms != null) {
        if (!Array.isArray(body.platforms)) throw new VendorError('invalid_platforms', '代理平台必须为数组')
        config.platforms = [
          ...new Set(
            body.platforms
              .map(String)
              .map((value) => value.trim())
              .filter(Boolean),
          ),
        ]
      }
      const status = body.status == null ? row.status : String(body.status)
      if (!['active', 'paused', 'archived'].includes(status))
        throw new VendorError('invalid_resource_status', '代理状态无效')
      const name = body.name == null ? row.name : assertText(body.name, 'invalid_resource_name', '资源名称不能为空')
      const secret = { ...currentSecret, endpoint }
      this.db
        .prepare(
          'UPDATE vendor_resources SET name=?,status=?,config_json=?,secret_json=?,updated_at=?,archived_at=? WHERE id=?',
        )
        .run(
          name,
          status,
          JSON.stringify(config),
          maybeEncrypt(JSON.stringify(secret)),
          now(),
          status === 'archived' ? now() : row.archived_at,
          row.id,
        )
      this.audit({
        actorUserId: identity.user_id,
        vendorId: identity.vendor.id,
        action: 'resource.proxy_updated',
        resourceType: 'proxy',
        resourceId: row.id,
        payload: { fields: Object.keys(body), status },
      })
      return projectResource(this.db.prepare('SELECT * FROM vendor_resources WHERE id=?').get(row.id))
    })
  }

  createResource(identity, resourceType, body) {
    this.requireActive(identity)
    this.requireCapability(identity, 'vendor.resource.manage')
    if (!RESOURCE_TYPES.has(resourceType)) throw new VendorError('invalid_resource_type', '不支持的供应商资源类型')
    const owner = this.vendorRow(identity.vendor.id)
    const checkLimit = (vendor) => {
      const scope =
        vendor.tier === 1
          ? [
              vendor.id,
              ...this.db
                .prepare('SELECT id FROM vendors WHERE parent_id=? AND deleted_at IS NULL')
                .all(vendor.id)
                .map((row) => row.id),
            ]
          : [vendor.id]
      const count = this.db
        .prepare(`SELECT COUNT(*) AS n FROM vendor_resources
        WHERE vendor_id IN (${scope.map(() => '?').join(',')}) AND resource_type=? AND status<>'archived'`)
        .get(...scope, resourceType).n
      const limit = resourceType === 'proxy' ? vendor.proxy_limit : vendor.account_limit
      if (limit > 0 && count >= limit) throw new VendorError('resource_limit_exceeded', '已达到供应商资源额度', 409)
    }
    checkLimit(owner)
    if (owner.parent_id) checkLimit(this.vendorRow(owner.parent_id))
    const resourceId = id(resourceType)
    const stamp = now()
    const secret = body.secret == null ? null : maybeEncrypt(JSON.stringify(body.secret))
    this.db
      .prepare(
        `INSERT INTO vendor_resources (id,vendor_id,resource_type,name,external_id,status,config_json,secret_json,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        resourceId,
        identity.vendor.id,
        resourceType,
        assertText(body.name, 'invalid_resource_name', '资源名称不能为空'),
        clean(body.external_id) || null,
        resourceType === 'vm' ? 'provisioning' : 'active',
        JSON.stringify(body.config || {}),
        secret,
        identity.user_id,
        stamp,
        stamp,
      )
    this.audit({
      actorUserId: identity.user_id,
      vendorId: identity.vendor.id,
      action: `resource.${resourceType}.created`,
      resourceType,
      resourceId,
      payload: { name: body.name },
    })
    return projectResource(this.db.prepare('SELECT * FROM vendor_resources WHERE id = ?').get(resourceId))
  }

  createAccount(identity, body, { configure, requireExplicitGroup = false } = {}) {
    this.requireActive(identity)
    this.requireCapability(identity, 'vendor.resource.manage')
    this.requireCapability(identity, 'vendor.vm.create')
    const key = clean(body.idempotency_key)
    const externalId = key ? `account:${key}` : clean(body.external_id) || null
    if (externalId) {
      const existing = this.db
        .prepare("SELECT * FROM vendor_resources WHERE vendor_id = ? AND resource_type = 'account' AND external_id = ?")
        .get(identity.vendor.id, externalId)
      if (existing) {
        if (existing.status === 'archived') throw new VendorError('resource_archived', '账号已归档，不能重试开户', 409)
        const existingConfig = asJson(existing.config_json, {})
        const vm = existingConfig.vm_resource_id
          ? this.db
              .prepare("SELECT * FROM vendor_resources WHERE id = ? AND vendor_id = ? AND resource_type = 'vm'")
              .get(existingConfig.vm_resource_id, identity.vendor.id)
          : null
        if (vm?.status === 'archived') throw new VendorError('resource_archived', '配对虚拟机已归档', 409)
        if (vm)
          return {
            account: projectResource(existing),
            vm: projectResource(vm),
            reused: true,
          }
        throw new VendorError('resource_pair_missing', '账号的配对虚拟机记录缺失，需要修复后再重试', 409)
      }
    }
    let provisioned
    try {
      return withTransaction(this.db, () => {
        if (clean(body.proxy_endpoint)) {
          if (body.proxy_id) throw new VendorError('proxy_source_conflict', '请选择已有代理或粘贴代理地址')
          body = { ...body, proxy_id: this.inlineProxy(identity, body.proxy_endpoint).id }
        }
        let boundProxy = null
        if (body.proxy_id) {
          const proxy = this.getResource(identity, clean(body.proxy_id), { write: true })
          if (proxy.resource_type !== 'proxy' || proxy.status !== 'active')
            throw new VendorError('proxy_unavailable', '代理不可用', 409)
          const secret = asJson(maybeDecrypt(proxy.secret_json), {})
          const endpoint = secret.endpoint || asJson(proxy.config_json, {}).endpoint
          try {
            boundProxy = { id: proxy.id, url: proxyUrl({ url: endpoint }) }
          } catch {
            throw new VendorError('invalid_proxy', '代理地址无效')
          }
        }
        const authorizationKind = clean(body.authorization_kind)
        const authorizationDefaults = {
          claude_oauth: { platform: 'anthropic', auth_method: 'oauth' },
          claude_setup_token: { platform: 'anthropic', auth_method: 'setup-token' },
          claude_console: { platform: 'anthropic', auth_method: 'apikey' },
          codex_oauth: { platform: 'openai', auth_method: 'oauth' },
          codex_account_file: { platform: 'openai', auth_method: 'oauth' },
        }[authorizationKind]
        if (authorizationKind && !authorizationDefaults)
          throw new VendorError('authorization_kind_invalid', '授权方式无效')
        const normalizedPlatform = (value) => ({ claude: 'anthropic', codex: 'openai' })[value] || value
        const requestedPlatform = normalizedPlatform(clean(body.platform))
        if (requestedPlatform && authorizationDefaults && requestedPlatform !== authorizationDefaults.platform)
          throw new VendorError('authorization_platform_mismatch', '授权方式与所选平台不一致')
        body = {
          ...body,
          ...(authorizationDefaults || {}),
          authorization_mode: authorizationKind || clean(body.authorization_mode) || null,
          proxy: boundProxy,
        }
        body.platform = normalizedPlatform(clean(body.platform) || 'anthropic')
        if (!['anthropic', 'openai'].includes(body.platform)) throw new VendorError('platform_invalid', '不支持的平台')
        if (body.auth_method && !['oauth', 'setup-token', 'apikey'].includes(body.auth_method))
          throw new VendorError('authorization_kind_invalid', '授权方式无效')
        if (body.platform === 'openai' && body.auth_method && body.auth_method !== 'oauth')
          throw new VendorError('authorization_platform_mismatch', 'OpenAI 账号仅支持 OAuth 或账号文件授权')
        const scopes = [
          identity.vendor,
          ...(identity.vendor.parent_id ? [this.getVendor(identity.vendor.parent_id)] : []),
        ]
        if (
          scopes.some(
            (v) =>
              arrayOf(v?.platforms).length && !arrayOf(v.platforms).map(normalizedPlatform).includes(body.platform),
          )
        )
          throw new VendorError('platform_scope_forbidden', '所选平台不在当前供应商范围内', 403)
        body.group_ids = this.accountGroupIds(identity, body.group_ids, body.platform, { requireExplicitGroup })
        return this.createAccountResources(identity, body, externalId, key, configure, (vm) => {
          provisioned = vm
        })
      })
    } catch (error) {
      provisioned?.rollback?.()
      throw error
    }
  }

  availableAccountGroups(identity, platform) {
    this.requireActive(identity)
    if (!this.getVendor(identity.vendor.id).effective_platforms.includes(platform)) return []
    const rows = this.db
      .prepare(
        "SELECT g.id,g.name,g.platform,g.models_json FROM groups g WHERE g.deleted_at IS NULL AND g.status='active' AND NOT EXISTS (SELECT 1 FROM group_resources r WHERE r.group_id=g.id AND r.resource_kind<>'vm') ORDER BY g.sort_order,g.id",
      )
      .all()
      .filter((row) => vendorGroupPlatforms(row).includes(platform))
    const scopes = [identity.vendor, ...(identity.vendor.parent_id ? [this.getVendor(identity.vendor.parent_id)] : [])]
    const allowed = rows.filter((row) =>
      scopes.every((v) => {
        const configured = arrayOf(v?.groups)
        return configured.includes(String(row.id)) || configured.includes(String(row.name))
      }),
    )
    return allowed
  }

  accountGroupIds(identity, requested, platform, { requireExplicitGroup = false } = {}) {
    const allowed = this.availableAccountGroups(identity, platform)
    const allowedIds = new Set(allowed.map((row) => Number(row.id)))
    const ids = Array.isArray(requested) ? [...new Set(requested.map((value) => Number(value)))] : []
    if (!allowed.length)
      throw new VendorError('no_available_group', '当前平台没有可用的授权分组，请联系超级管理员', 409)
    if (!ids.length) {
      if (requireExplicitGroup) throw new VendorError('group_required', '请选择至少一个授权分组', 409)
      return [Number(allowed[0].id)]
    }
    if (ids.some((value) => !Number.isSafeInteger(value) || !allowedIds.has(value)))
      throw new VendorError('group_scope_forbidden', '所选分组不在当前供应商范围内', 403)
    return ids
  }

  createAccountResources(identity, body, externalId, key, configure, onProvisioned) {
    const platform = clean(body.platform) || 'anthropic'
    // Resource creation is transactional; the runtime supplies the final shared VM name.
    const pendingName = clean(body.name) || id('account')
    const account = this.createResource(identity, 'account', {
      ...body,
      name: pendingName,
      external_id: externalId,
      config: {
        platform,
        auth_method: clean(body.auth_method) || 'oauth',
        authorization_mode: clean(body.authorization_mode) || null,
        group_ids: arrayOf(body.group_ids),
        proxy_id: clean(body.proxy_id) || null,
      },
    })
    const vm = this.createResource(identity, 'vm', {
      name: account.name,
      external_id: `vm:${account.id}`,
      config: {
        account_resource_id: account.id,
        proxy_id: clean(body.proxy_id) || null,
      },
    })
    let runtimeVm = null
    if (this.vmProvisioner) {
      runtimeVm = this.vmProvisioner({
        resourceId: vm.id,
        accountResourceId: account.id,
        name: clean(body.name),
        body,
        userId: identity.user_id,
        beforeWrite: (runtime) => {
          this.db
            .prepare('UPDATE vendor_resources SET config_json=? WHERE id=?')
            .run(JSON.stringify({ ...vm.config, runtime_vm_id: runtime.id }), vm.id)
          configure?.(runtime, account, vm)
        },
      })
      onProvisioned?.(runtimeVm)
    }
    if (runtimeVm?.name)
      this.db.prepare('UPDATE vendor_resources SET name=? WHERE id IN (?,?)').run(runtimeVm.name, account.id, vm.id)
    if (runtimeVm) this.db.prepare("UPDATE vendor_resources SET status='active' WHERE id=?").run(vm.id)
    this.db
      .prepare('UPDATE vendor_resources SET config_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify({ ...(account.config || {}), vm_resource_id: vm.id }), now(), account.id)
    this.db.prepare('UPDATE vendor_resources SET config_json = ?, updated_at = ? WHERE id = ?').run(
      JSON.stringify({
        ...(vm.config || {}),
        runtime_vm_id: runtimeVm?.id || null,
      }),
      now(),
      vm.id,
    )
    this.audit({
      actorUserId: identity.user_id,
      vendorId: identity.vendor.id,
      action: 'account.vm_created',
      resourceType: 'account',
      resourceId: account.id,
      idempotencyKey: key || null,
      payload: {
        vm_resource_id: vm.id,
        platform: body.platform || 'anthropic',
      },
    })
    return {
      account: projectResource(this.db.prepare('SELECT * FROM vendor_resources WHERE id = ?').get(account.id)),
      vm: projectResource(this.db.prepare('SELECT * FROM vendor_resources WHERE id = ?').get(vm.id)),
    }
  }

  resourceScope(identity, vendorId = '') {
    const target = clean(vendorId)
    if (!target || target === identity.vendor.id) return [identity.vendor.id]
    if (identity.vendor.tier !== 1) throw new VendorError('vendor_scope_forbidden', '仅可查看自己的资源', 403)
    this.requireCapability(identity, 'vendor.create_child')
    const ids = this.visibleVendorIds(identity, { aggregate: true })
    if (target === 'all') return ids
    if (!ids.includes(target)) throw new VendorError('vendor_scope_forbidden', '供应商不属于当前范围', 403)
    return [target]
  }

  listResources(identity, resourceType, { vendorId = '', includeArchived = false } = {}) {
    const ids = this.resourceScope(identity, vendorId)
    const rows = this.db
      .prepare(
        `SELECT * FROM vendor_resources WHERE vendor_id IN (${ids.map(() => '?').join(',')}) AND resource_type = ? ${includeArchived ? '' : "AND status <> 'archived'"} ORDER BY created_at DESC`,
      )
      .all(...ids, resourceType)
    return rows.map((row) => projectResource(row))
  }

  getResource(identity, resourceId, { write = false } = {}) {
    const row = this.db.prepare('SELECT * FROM vendor_resources WHERE id = ?').get(resourceId)
    if (!row) throw new VendorError('resource_not_found', '资源不存在', 404)
    if (row.vendor_id !== identity.vendor.id) {
      if (
        write ||
        identity.vendor.tier !== 1 ||
        !identity.vendor.capabilities.includes('vendor.create_child') ||
        !this.db.prepare('SELECT 1 FROM vendors WHERE id = ? AND parent_id = ?').get(row.vendor_id, identity.vendor.id)
      )
        throw new VendorError('vendor_scope_forbidden', '资源不属于当前供应商范围', 403)
    }
    return row
  }

  updateResource(identity, resourceId, body) {
    return withTransaction(this.db, () => this.updateResourceInTransaction(identity, resourceId, body))
  }
  updateResourceInTransaction(identity, resourceId, body) {
    this.requireActive(identity)
    const row = this.getResource(identity, resourceId, { write: true })
    this.requireCapability(identity, 'vendor.resource.manage')
    if (row.status === 'archived') throw new VendorError('resource_archived', '已归档资源不可修改', 409)
    const stamp = now()
    const name = body.name == null ? row.name : assertText(body.name, 'invalid_resource_name', '资源名称不能为空')
    const config = asJson(row.config_json, {})
    if (body.notes != null) {
      if (row.resource_type !== 'account' || typeof body.notes !== 'string' || body.notes.length > 2000)
        throw new VendorError('invalid_resource_notes', '账号备注长度不能超过 2000 字符')
      config.vendor_notes = body.notes.trim()
    }
    const status = body.status == null ? row.status : String(body.status)
    if (
      !['provisioning', 'active', 'paused', 'archived'].includes(status) ||
      (body.status != null && status === 'provisioning')
    )
      throw new VendorError('invalid_resource_status', '资源状态无效')
    this.db
      .prepare(
        'UPDATE vendor_resources SET name = ?, status = ?, config_json = ?, updated_at = ?, archived_at = ? WHERE id = ?',
      )
      .run(name, status, JSON.stringify(config), stamp, status === 'archived' ? stamp : row.archived_at, row.id)
    if (body.status && ['account', 'vm'].includes(row.resource_type)) {
      const config = asJson(row.config_json, {})
      const pairedId = row.resource_type === 'account' ? config.vm_resource_id : config.account_resource_id
      if (pairedId)
        this.db
          .prepare(
            "UPDATE vendor_resources SET status=?,updated_at=?,archived_at=? WHERE id=? AND vendor_id=? AND status<>'archived'",
          )
          .run(status, stamp, status === 'archived' ? stamp : null, pairedId, row.vendor_id)
    }
    this.audit({
      actorUserId: identity.user_id,
      vendorId: identity.vendor.id,
      action: 'resource.updated',
      resourceType: row.resource_type,
      resourceId: row.id,
      payload: { status },
    })
    return projectResource(this.db.prepare('SELECT * FROM vendor_resources WHERE id = ?').get(row.id))
  }
}

export { CAPABILITIES, projectResource, projectVendor }
