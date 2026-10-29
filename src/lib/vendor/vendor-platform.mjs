import crypto from 'node:crypto'
import { getDb, withTransaction } from '../db/database.mjs'
import { maybeEncrypt, maybeDecrypt } from '../db/secure.mjs'
import { proxyUrl } from '../vm/proxy-address.mjs'
import { hashPassword } from '../admin/panel-users.mjs'

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

export class VendorError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message)
    this.code = code
    this.status = status
    this.details = details
  }
}

function assertText(value, code, message, max = 160) {
  const text = clean(value)
  if (!text || text.length > max) throw new VendorError(code, message)
  return text
}

function projectVendor(row, capabilities = []) {
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    external_code: row.external_code,
    email: row.email,
    tier: row.tier,
    role: 'vendor',
    parent_id: row.parent_id,
    root_id: row.root_id,
    status: row.status,
    groups: asJson(row.groups_json, []),
    platforms: asJson(row.platforms_json, []),
    account_limit: row.account_limit,
    proxy_limit: row.proxy_limit,
    child_limit: row.child_limit,
    contact_name: row.contact_name || '',
    settlement_email: row.settlement_email || '',
    binance_id: row.binance_id || '',
    default_price_cny_per_usd: row.default_price_cny_per_usd ?? 1.6,
    group_prices: asJson(row.group_prices_json, {}),
    fx_cny_per_usdt: row.fx_cny_per_usdt ?? 6.7,
    default_multiplier: row.default_multiplier ?? 1,
    contract_version: row.contract_version ?? 1,
    capability_revision: row.capability_revision,
    policy_revision: row.policy_revision,
    capabilities,
    views: [
      'accounts',
      'proxies',
      ...(capabilities.includes('vendor.usage.read') ? ['usage'] : []),
      ...(capabilities.includes('vendor.settlement.read') ? ['settlements'] : []),
      'audit',
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
        WHERE vm.user_id = ? AND vm.status = 'active' AND v.status = 'active' AND v.deleted_at IS NULL
        ORDER BY vm.is_primary DESC, vm.created_at ASC LIMIT 1
      `,
      )
      .get(uid)
    if (!row) throw new VendorError('vendor_forbidden', '当前账号没有有效的供应商身份', 403)
    return {
      user_id: uid,
      member_id: row.member_id,
      vendor: projectVendor(row, this.capabilities(row.id)),
    }
  }

  requireCapability(identity, capability) {
    if (!identity.vendor.capabilities.includes(capability)) {
      throw new VendorError('capability_required', `缺少供应商能力：${capability}`, 403)
    }
  }

  requireActive(identity) {
    if (identity.vendor.status !== 'active') throw new VendorError('vendor_inactive', '供应商当前不可操作', 409)
  }

  visibleVendorIds(identity, { aggregate = false } = {}) {
    const ids = [identity.vendor.id]
    if (aggregate && identity.vendor.tier === 1) {
      this.db
        .prepare(
          "SELECT id FROM vendors WHERE parent_id = ? AND status IN ('active','disabled') AND deleted_at IS NULL",
        )
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
    const name = assertText(body?.name, 'invalid_vendor_name', '供应商名称不能为空')
    const email = assertText(body?.email, 'invalid_vendor_email', '供应商邮箱不能为空', 240).toLowerCase()
    const externalCode = assertText(body?.external_code, 'invalid_vendor_code', '供应商编码不能为空', 80).toLowerCase()
    const childLimit = Number(body.child_limit ?? 0)
    if (!Number.isSafeInteger(childLimit) || childLimit < 0)
      throw new VendorError('invalid_child_limit', '下级供应商数量上限须为非负整数，0 表示不限制')
    const createdAt = now()
    const vendorId = id('vendor')
    const memberUserId = clean(userId || body?.user_id)
    return withTransaction(this.db, () => {
      if (this.db.prepare('SELECT 1 FROM vendors WHERE external_code = ? AND deleted_at IS NULL').get(externalCode))
        throw new VendorError('vendor_code_exists', '供应商编码已存在', 409)
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
      this.saveBillingProfile(vendorId, body)
      this.ensureContract({ payeeVendorId: vendorId, body, actorUserId, leg: 'platform_to_l1', stamp: createdAt })
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

  grantDefaults(vendorId, requested) {
    const capabilities = arrayOf(requested).filter((x) => CAPABILITIES.includes(x))
    const effective = capabilities.length
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

  billingProfile(body = {}) {
    const positive = (value, fallback) => {
      const parsed = Number(value ?? fallback)
      return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
    }
    return {
      contact_name: clean(body.contact_name),
      settlement_email: clean(body.settlement_email || body.email).toLowerCase(),
      binance_id: clean(body.binance_id),
      default_price_cny_per_usd: positive(body.default_price_cny_per_usd, 1.6),
      group_prices_json: JSON.stringify(
        body.group_prices && typeof body.group_prices === 'object' ? body.group_prices : {},
      ),
      fx_cny_per_usdt: positive(body.fx_cny_per_usdt, 6.7),
      default_multiplier: positive(body.default_multiplier, 1),
      contract_version: Math.max(1, Number(body.contract_version || 1)),
    }
  }

  saveBillingProfile(vendorId, body = {}) {
    const profile = this.billingProfile(body)
    this.db
      .prepare(`
      UPDATE vendors SET contact_name=?,settlement_email=?,binance_id=?,default_price_cny_per_usd=?,
        group_prices_json=?,fx_cny_per_usdt=?,default_multiplier=?,contract_version=?,updated_at=? WHERE id=?
    `)
      .run(
        profile.contact_name,
        profile.settlement_email,
        profile.binance_id,
        profile.default_price_cny_per_usd,
        profile.group_prices_json,
        profile.fx_cny_per_usdt,
        profile.default_multiplier,
        profile.contract_version,
        now(),
        vendorId,
      )
  }

  ensureContract({ payerVendorId = null, payeeVendorId, body = {}, actorUserId, leg, stamp = now() }) {
    const profile = this.billingProfile(body)
    this.db
      .prepare(`
      INSERT OR IGNORE INTO vendor_contracts
        (id,leg,payer_vendor_id,payee_vendor_id,version,effective_at,price_cny_per_usd,fx_cny_per_usdt,multiplier,status,created_by,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,'active',?,?)
    `)
      .run(
        id('contract'),
        leg,
        payerVendorId,
        payeeVendorId,
        profile.contract_version,
        stamp,
        profile.default_price_cny_per_usd,
        profile.fx_cny_per_usdt,
        profile.default_multiplier,
        this.actorId(actorUserId),
        stamp,
      )
  }

  addMember(vendorId, userId, actorUserId) {
    if (!this.db.prepare('SELECT 1 FROM users WHERE id = ? AND deleted_at IS NULL').get(userId))
      throw new VendorError('member_user_not_found', '成员用户不存在', 404)
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
    this.requireActive(identity)
    if (identity.vendor.tier !== 1) throw new VendorError('child_vendor_forbidden', '二级供应商不能创建下级供应商', 403)
    this.requireCapability(identity, 'vendor.create_child')
    const parent = this.vendorRow(identity.vendor.id)
    const children = this.db
      .prepare('SELECT COUNT(*) AS count FROM vendors WHERE parent_id = ? AND deleted_at IS NULL')
      .get(parent.id).count
    // A zero child_limit means unlimited, matching the platform's other quota fields.
    if (parent.child_limit > 0 && children >= parent.child_limit)
      throw new VendorError('child_limit_exceeded', '已达到下级供应商数量上限', 409)
    const name = assertText(body?.name, 'invalid_vendor_name', '供应商名称不能为空')
    const email = assertText(body?.email, 'invalid_vendor_email', '供应商邮箱不能为空', 240).toLowerCase()
    const externalCode = assertText(body?.external_code, 'invalid_vendor_code', '供应商编码不能为空', 80).toLowerCase()
    const groups = arrayOf(body.groups)
    const platforms = arrayOf(body.platforms)
    const parentGroups = asJson(parent.groups_json, [])
    const parentPlatforms = asJson(parent.platforms_json, [])
    if (groups.some((value) => !parentGroups.includes(value)))
      throw new VendorError('parent_scope_violation', '下级供应商的分组超出父级范围', 409)
    if (platforms.some((value) => !parentPlatforms.includes(value)))
      throw new VendorError('parent_scope_violation', '下级供应商的平台超出父级范围', 409)
    const accountLimit = Number(body.account_limit || 0)
    const proxyLimit = Number(body.proxy_limit || 0)
    if (accountLimit > parent.account_limit || proxyLimit > parent.proxy_limit)
      throw new VendorError('quota_exceeds_parent', '下级供应商额度不能超过父级', 409)
    const vendorId = id('vendor')
    const stamp = now()
    return withTransaction(this.db, () => {
      let memberUserId = clean(body?.user_id)
      if (!memberUserId) {
        const username = clean(body?.username)
        const password = String(body?.password || '')
        if (!/^[a-zA-Z][a-zA-Z0-9._-]{1,31}$/.test(username))
          throw new VendorError('invalid_username', '供应商用户名为 2–32 位，需字母开头')
        if (password.length < 8 || password.length > 128)
          throw new VendorError('invalid_password', '供应商密码长度必须为 8–128 位')
        if (
          this.db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE AND deleted_at IS NULL').get(username)
        )
          throw new VendorError('username_exists', '供应商用户名已存在', 409)
        const memberEmail = clean(body.email) || `${username}@vendor.local`
        if (
          this.db.prepare('SELECT 1 FROM users WHERE email = ? COLLATE NOCASE AND deleted_at IS NULL').get(memberEmail)
        )
          throw new VendorError('email_exists', '供应商邮箱已存在', 409)
        memberUserId = id('user')
        this.db
          .prepare(
            `INSERT INTO users
              (id,email,username,password_hash,role,status,created_at,updated_at)
             VALUES (?,?,?,?, 'vendor','active',?,?)`,
          )
          .run(memberUserId, memberEmail, username, hashPassword(password), stamp, stamp)
      }
      if (this.db.prepare('SELECT 1 FROM vendors WHERE external_code = ? AND deleted_at IS NULL').get(externalCode))
        throw new VendorError('vendor_code_exists', '供应商编码已存在', 409)
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
      this.grantDefaults(vendorId, body.capabilities)
      this.saveBillingProfile(vendorId, body)
      this.ensureContract({
        payerVendorId: parent.id,
        payeeVendorId: vendorId,
        body,
        actorUserId: identity.user_id,
        leg: 'l1_to_l2',
        stamp,
      })
      if (memberUserId) this.addMember(vendorId, memberUserId, identity.user_id)
      this.audit({
        actorUserId: identity.user_id,
        vendorId: parent.id,
        action: 'vendor.child_created',
        resourceType: 'vendor',
        resourceId: vendorId,
        idempotencyKey: body.idempotency_key || null,
        payload: { child_id: vendorId, tier: 2 },
      })
      return this.getVendor(vendorId)
    })
  }

  getVendor(vendorId) {
    const row = this.vendorRow(vendorId)
    return projectVendor(row, row ? this.capabilities(row.id) : [])
  }

  listVendors(identity) {
    this.requireCapability(identity, 'vendor.create_child')
    const ids = this.visibleVendorIds(identity, { aggregate: true })
    return this.db
      .prepare(`SELECT * FROM vendors WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY tier, name`)
      .all(...ids)
      .map((row) => projectVendor(row, this.capabilities(row.id)))
  }

  createProxy(identity, body) {
    let endpoint
    try {
      endpoint = proxyUrl({ url: body.config?.endpoint })
    } catch {
      throw new VendorError('invalid_proxy', '请输入有效的 HTTP、HTTPS 或 SOCKS5 代理地址')
    }
    if (!endpoint) throw new VendorError('invalid_proxy', '代理地址不能为空')
    const publicUrl = new URL(endpoint)
    publicUrl.username = ''
    publicUrl.password = ''
    return this.createResource(identity, 'proxy', {
      name: body.name,
      config: {
        endpoint: publicUrl.href,
        platforms: Array.isArray(body.platforms) ? [...new Set(body.platforms.map(String))] : [],
      },
      secret: { endpoint },
    })
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

  createResource(identity, resourceType, body) {
    this.requireActive(identity)
    this.requireCapability(identity, 'vendor.resource.manage')
    if (!RESOURCE_TYPES.has(resourceType)) throw new VendorError('invalid_resource_type', '不支持的供应商资源类型')
    const count = this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM vendor_resources WHERE vendor_id = ? AND resource_type = ? AND status <> 'archived'",
      )
      .get(identity.vendor.id, resourceType).count
    const limit = resourceType === 'proxy' ? identity.vendor.proxy_limit : identity.vendor.account_limit
    if (limit > 0 && count >= limit) throw new VendorError('resource_limit_exceeded', '已达到供应商资源额度', 409)
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

  createAccount(identity, body) {
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
        const existingConfig = asJson(existing.config_json, {})
        const vm = existingConfig.vm_resource_id
          ? this.db
              .prepare("SELECT * FROM vendor_resources WHERE id = ? AND vendor_id = ? AND resource_type = 'vm'")
              .get(existingConfig.vm_resource_id, identity.vendor.id)
          : null
        if (vm)
          return {
            account: projectResource(existing),
            vm: projectResource(vm),
          }
      }
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
    if (authorizationKind && !authorizationDefaults) throw new VendorError('authorization_kind_invalid', '授权方式无效')
    body = {
      ...body,
      ...(authorizationDefaults || {}),
      authorization_mode: authorizationKind || clean(body.authorization_mode) || null,
      proxy: boundProxy,
    }
    const normalizedPlatform = (value) => ({ claude: 'anthropic', codex: 'openai' })[value] || value
    body.platform = normalizedPlatform(clean(body.platform) || 'anthropic')
    const allowedPlatforms = arrayOf(identity.vendor.platforms).map(normalizedPlatform)
    if (allowedPlatforms.length && !allowedPlatforms.includes(body.platform))
      throw new VendorError('platform_scope_forbidden', '所选平台不在当前供应商范围内', 403)
    body.group_ids = this.accountGroupIds(identity, body.group_ids, body.platform)
    return withTransaction(this.db, () => this.createAccountResources(identity, body, externalId, key))
  }

  accountGroupIds(identity, requested, platform) {
    const rows = this.db
      .prepare(
        "SELECT id,name,platform FROM groups WHERE deleted_at IS NULL AND status = 'active' ORDER BY sort_order,id",
      )
      .all()
      .filter((row) => ['mixed', platform, platform === 'anthropic' ? 'claude' : platform].includes(row.platform))
    const configured = arrayOf(identity.vendor.groups)
    const allowed = configured.length
      ? rows.filter((row) => configured.includes(String(row.id)) || configured.includes(String(row.name)))
      : rows
    const allowedIds = new Set(allowed.map((row) => Number(row.id)))
    const ids = Array.isArray(requested) ? [...new Set(requested.map((value) => Number(value)))] : []
    if (!ids.length) return allowed[0] ? [Number(allowed[0].id)] : []
    if (ids.some((value) => !Number.isSafeInteger(value) || !allowedIds.has(value)))
      throw new VendorError('group_scope_forbidden', '所选分组不在当前供应商范围内', 403)
    return ids
  }

  createAccountResources(identity, body, externalId, key) {
    const platform = clean(body.platform) || 'anthropic'
    const defaultName = platform === 'openai' ? 'Codex 账号' : 'Claude 账号'
    const account = this.createResource(identity, 'account', {
      ...body,
      name: clean(body.name) || defaultName,
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
      name: `${account.name} VM`,
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
        name: vm.name,
        body,
        userId: identity.user_id,
      })
    }
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

  listResources(identity, resourceType, { vendorId = '' } = {}) {
    const ids = this.resourceScope(identity, vendorId)
    const rows = this.db
      .prepare(
        `SELECT * FROM vendor_resources WHERE vendor_id IN (${ids.map(() => '?').join(',')}) AND resource_type = ? AND status <> 'archived' ORDER BY created_at DESC`,
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
    this.requireActive(identity)
    const row = this.getResource(identity, resourceId, { write: true })
    this.requireCapability(identity, 'vendor.resource.manage')
    if (row.status === 'archived') throw new VendorError('resource_archived', '已归档资源不可修改', 409)
    const stamp = now()
    const name = body.name == null ? row.name : assertText(body.name, 'invalid_resource_name', '资源名称不能为空')
    const status = body.status == null ? row.status : String(body.status)
    if (!['provisioning', 'active', 'paused', 'archived'].includes(status))
      throw new VendorError('invalid_resource_status', '资源状态无效')
    this.db
      .prepare(
        'UPDATE vendor_resources SET name = ?, status = ?, config_json = ?, updated_at = ?, archived_at = ? WHERE id = ?',
      )
      .run(
        name,
        status,
        JSON.stringify(body.config == null ? asJson(row.config_json, {}) : body.config),
        stamp,
        status === 'archived' ? stamp : row.archived_at,
        row.id,
      )
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

  usageSummary(identity) {
    this.requireCapability(identity, 'vendor.usage.read')
    const ids = this.visibleVendorIds(identity, { aggregate: true })
    const params = [...ids]
    const summary = this.db
      .prepare(
        `SELECT COUNT(*) AS requests, COALESCE(SUM(input_tokens),0) AS input_tokens, COALESCE(SUM(output_tokens),0) AS output_tokens, COALESCE(SUM(cost_usd),0) AS cost_usd FROM vendor_usage_facts WHERE vendor_id IN (${ids.map(() => '?').join(',')})`,
      )
      .get(...params)
    const byVendor = this.db
      .prepare(
        `SELECT vendor_id, COUNT(*) AS requests, COALESCE(SUM(cost_usd),0) AS cost_usd FROM vendor_usage_facts WHERE vendor_id IN (${ids.map(() => '?').join(',')}) GROUP BY vendor_id ORDER BY cost_usd DESC`,
      )
      .all(...params)
    return { scope_vendor_ids: ids, totals: summary, vendors: byVendor }
  }

  auditLogs(identity) {
    const ids = this.visibleVendorIds(identity, { aggregate: true })
    return this.db
      .prepare(
        `SELECT * FROM vendor_audit_events WHERE vendor_id IN (${ids.map(() => '?').join(',')}) ORDER BY created_at DESC LIMIT 200`,
      )
      .all(...ids)
      .map((row) => ({ ...row, payload: asJson(row.payload_json, {}) }))
  }
}

export { CAPABILITIES, projectResource, projectVendor }
