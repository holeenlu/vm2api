/** Commercial groups and stable resource membership. Credential UUIDs are not VM membership keys. */
/*
 * 数据访问经 DbClient 异步执行（R6 B6b），多步写入放在同一个 `db.tx` 里；推理热路径（Key 作用域、VM 摘要）同样经异步方法（R6 B7）。
 */
import { calculateCost } from '../../admin/pricing.mjs'
import { platformOfModel } from '../../admin/price-catalog.mjs'
import { getDb } from '../database.mjs'
import { dbClient } from '../db-client.mjs'
import { audit, integer, moneyMicros, relayError, strings } from '../../admin/relay-common.mjs'
export const DEFAULT_GROUP_ID = 1
const FIELDS = [
  'name',
  'description',
  'platform',
  'rate_multiplier',
  'is_exclusive',
  'rpm_limit',
  'sort_order',
  'status',
  'models_json',
  'subscription_type',
  'daily_limit_micros',
  'weekly_limit_micros',
  'monthly_limit_micros',
  'allow_image_generation',
  'image_count_billing',
  'image_rate_independent',
  'image_rate_multiplier',
  'image_price_1k',
  'image_price_2k',
  'image_price_4k',
  'web_search_price_per_call',
  'codex_fast_mode',
]
const CODEX_FAST_MODES = ['default', 'enabled', 'disabled']
const MEDIA_FLAGS = ['allow_image_generation', 'image_count_billing', 'image_rate_independent']
const MEDIA_PRICES = ['image_price_1k', 'image_price_2k', 'image_price_4k', 'web_search_price_per_call']
function present(row) {
  if (!row) return null
  return {
    ...row,
    models: JSON.parse(row.models_json || '[]'),
    is_exclusive: !!row.is_exclusive,
    allow_image_generation: row.allow_image_generation == null ? true : !!row.allow_image_generation,
    image_count_billing: !!row.image_count_billing,
    image_rate_independent: !!row.image_rate_independent,
    codex_fast_mode: CODEX_FAST_MODES.includes(row.codex_fast_mode) ? row.codex_fast_mode : 'default',
    daily_limit_usd: row.daily_limit_micros / 1e6,
    weekly_limit_usd: row.weekly_limit_micros / 1e6,
    monthly_limit_usd: row.monthly_limit_micros / 1e6,
  }
}
function patchFields(input, current = {}) {
  const next = { ...current }
  for (const field of ['name', 'description'])
    if (Object.hasOwn(input, field)) {
      if (typeof input[field] !== 'string') throw relayError('invalid_' + field, field + ' 必须是字符串')
      next[field] = input[field].trim()
      if (next[field].length > (field === 'name' ? 100 : 1000) || (field === 'name' && !next[field]))
        throw relayError('invalid_' + field, field + ' 长度不正确')
    }
  if (Object.hasOwn(input, 'platform')) {
    const platform = input.platform === 'claude' ? 'anthropic' : input.platform
    if (!['anthropic', 'openai', 'mixed'].includes(platform)) throw relayError('invalid_platform', '不支持的平台')
    next.platform = platform
  }
  if (Object.hasOwn(input, 'status')) {
    if (!['active', 'inactive'].includes(input.status)) throw relayError('invalid_status', '不支持的状态')
    next.status = input.status
  }
  if (Object.hasOwn(input, 'subscription_type')) {
    if (!['standard', 'subscription'].includes(input.subscription_type))
      throw relayError('invalid_subscription_type', '不支持的计费方式')
    next.subscription_type = input.subscription_type
  }
  if (Object.hasOwn(input, 'is_exclusive')) {
    if (typeof input.is_exclusive !== 'boolean') throw relayError('invalid_is_exclusive', '专属标记必须为布尔值')
    next.is_exclusive = input.is_exclusive ? 1 : 0
  }
  if (Object.hasOwn(input, 'rate_multiplier')) {
    const rate = Number(input.rate_multiplier)
    if (!Number.isFinite(rate) || rate < 0 || rate > 1000) throw relayError('invalid_rate', '倍率必须在 0–1000 之间')
    next.rate_multiplier = rate
  }
  for (const field of MEDIA_FLAGS)
    if (Object.hasOwn(input, field)) {
      if (typeof input[field] !== 'boolean') throw relayError('invalid_' + field, field + ' 必须为布尔值')
      next[field] = input[field] ? 1 : 0
    }
  if (Object.hasOwn(input, 'image_rate_multiplier')) {
    const rate = Number(input.image_rate_multiplier)
    if (!Number.isFinite(rate) || rate < 0 || rate > 1000)
      throw relayError('invalid_image_rate', '生图倍率必须在 0–1000 之间')
    next.image_rate_multiplier = rate
  }
  // 单价留空（null/''）表示使用默认价；0 表示免费
  for (const field of MEDIA_PRICES)
    if (Object.hasOwn(input, field)) {
      const raw = input[field]
      if (raw === null || raw === '') next[field] = null
      else {
        const price = Number(raw)
        if (!Number.isFinite(price) || price < 0 || price > 1000)
          throw relayError('invalid_' + field, '单价必须在 0–1000 之间')
        next[field] = price
      }
    }
  if (Object.hasOwn(input, 'codex_fast_mode')) {
    if (!CODEX_FAST_MODES.includes(input.codex_fast_mode))
      throw relayError('invalid_codex_fast_mode', 'Fast 策略只能是 default、enabled 或 disabled')
    next.codex_fast_mode = input.codex_fast_mode
  }
  for (const field of ['rpm_limit', 'sort_order'])
    if (Object.hasOwn(input, field)) next[field] = integer(input[field], 0, 1_000_000, field)
  if (Object.hasOwn(input, 'models')) next.models_json = JSON.stringify(strings(input.models, 'models'))
  for (const field of ['daily', 'weekly', 'monthly'])
    if (Object.hasOwn(input, field + '_limit_usd'))
      next[field + '_limit_micros'] = moneyMicros(input[field + '_limit_usd'])
  if (next.status === 'active' && next.rate_multiplier > 0)
    for (const model of JSON.parse(next.models_json || '[]'))
      if (!calculateCost({ input_tokens: 1 }, model).known) throw relayError('model_unpriced', '模型尚未定价：' + model)
  next.is_exclusive = next.is_exclusive ? 1 : 0
  for (const field of MEDIA_FLAGS) next[field] = next[field] ? 1 : 0
  for (const model of JSON.parse(next.models_json || '[]')) {
    const platform = platformOfModel(model)
    if (
      platform &&
      next.platform !== 'mixed' &&
      platform !== (next.platform === 'claude' ? 'anthropic' : next.platform)
    )
      throw relayError('group_model_platform_mismatch', '模型与所选平台不兼容：' + model)
  }
  return next
}
const LIST_SQL = 'SELECT * FROM groups WHERE deleted_at IS NULL ORDER BY sort_order,id'
const GET_SQL = 'SELECT * FROM groups WHERE id=? AND deleted_at IS NULL'
const GET_BY_NAME_SQL = 'SELECT * FROM groups WHERE name=? AND deleted_at IS NULL'
const RESOURCES_SQL =
  'SELECT resource_kind,resource_id,priority FROM group_resources WHERE group_id=? ORDER BY priority,resource_id'
const FOR_RESOURCE_SQL =
  'SELECT g.* FROM groups g JOIN group_resources r ON r.group_id=g.id WHERE r.resource_kind=? AND r.resource_id=? AND g.deleted_at IS NULL ORDER BY g.sort_order,g.id'
const RESOURCE_VERSION_SQL = 'SELECT version FROM resource_group_versions WHERE resource_kind=? AND resource_id=?'
// 一类资源的全部分组归属与版本（VM 列表摘要一次读齐，R6 B7c）；同一资源内的顺序与 FOR_RESOURCE_SQL 相同
const FOR_RESOURCE_KIND_SQL =
  'SELECT r.resource_id AS r6_resource_id, g.* FROM groups g JOIN group_resources r ON r.group_id=g.id WHERE r.resource_kind=? AND g.deleted_at IS NULL ORDER BY g.sort_order,g.id'
const RESOURCE_VERSIONS_OF_KIND_SQL = 'SELECT resource_id, version FROM resource_group_versions WHERE resource_kind=?'
const TOUCH_RESOURCE_SQL =
  'INSERT INTO resource_group_versions(resource_kind,resource_id,version) VALUES(?,?,1) ON CONFLICT(resource_kind,resource_id) DO UPDATE SET version=version+1'
// 竞态 R18：按读到的版本号条件递增（没有记录时版本为 0，插入 1）；返回 changes=0 表示版本已被并发修改
const CLAIM_RESOURCE_VERSION_SQL =
  'INSERT INTO resource_group_versions(resource_kind,resource_id,version) VALUES(?,?,1) ON CONFLICT(resource_kind,resource_id) DO UPDATE SET version=version+1 WHERE resource_group_versions.version=?'
const INSERT_GROUP_SQL =
  'INSERT INTO groups (' +
  FIELDS.join(',') +
  ',created_at,updated_at) VALUES (' +
  FIELDS.map(() => '?').join(',') +
  ',?,?)'
const UPDATE_GROUP_SQL =
  'UPDATE groups SET ' + FIELDS.map((f) => f + '=?').join(',') + ',version=version+1,updated_at=? WHERE id=?'
const KEYS_IN_GROUP_SQL = 'SELECT COUNT(*) n FROM api_keys WHERE group_id=? AND deleted_at IS NULL'
const SUBSCRIPTIONS_IN_GROUP_SQL =
  "SELECT COUNT(*) n FROM user_subscriptions WHERE group_id=? AND status IN ('active','suspended')"
const DELETE_GROUP_RESOURCES_SQL = 'DELETE FROM group_resources WHERE group_id=?'
const DELETE_GROUP_USERS_SQL = 'DELETE FROM user_groups WHERE group_id=?'
const DELETE_GROUP_OVERRIDES_SQL = 'DELETE FROM user_group_overrides WHERE group_id=?'
const SOFT_DELETE_GROUP_SQL = "UPDATE groups SET deleted_at=?,status='inactive' WHERE id=?"
const RESOURCE_PRIORITIES_SQL = 'SELECT group_id,priority FROM group_resources WHERE resource_kind=? AND resource_id=?'
const DELETE_RESOURCE_MEMBERSHIP_SQL = 'DELETE FROM group_resources WHERE resource_kind=? AND resource_id=?'
const INSERT_GROUP_RESOURCE_SQL =
  'INSERT INTO group_resources(group_id,resource_kind,resource_id,priority) VALUES(?,?,?,?)'
const BUMP_GROUP_VERSION_SQL = 'UPDATE groups SET version=version+1,updated_at=? WHERE id=?'
const GRANTS_SQL = `SELECT g.group_id,o.rate_multiplier,o.rpm_limit AS rpm_override FROM user_groups g
        LEFT JOIN user_group_overrides o ON o.user_id=g.user_id AND o.group_id=g.group_id
        WHERE g.user_id=? ORDER BY g.group_id`
const OVERRIDE_SQL = 'SELECT rate_multiplier,rpm_limit FROM user_group_overrides WHERE user_id=? AND group_id=?'
const OVERRIDES_SQL = `SELECT o.user_id,u.username,o.rate_multiplier,o.rpm_limit FROM user_group_overrides o
      JOIN users u ON u.id=o.user_id WHERE o.group_id=? AND u.deleted_at IS NULL ORDER BY u.username`
const GRANT_USER_SQL = 'SELECT id,role,admin_domain_id FROM users WHERE id=? AND deleted_at IS NULL'
const DOMAIN_MEMBERS_SQL =
  "SELECT id,role FROM users WHERE admin_domain_id=? AND role IN ('admin','user') AND deleted_at IS NULL ORDER BY created_at,id"
const DELETE_OVERRIDE_SQL = 'DELETE FROM user_group_overrides WHERE user_id=? AND group_id=?'
const UPSERT_OVERRIDE_SQL = `INSERT INTO user_group_overrides(user_id,group_id,rate_multiplier,rpm_limit) VALUES(?,?,?,?)
        ON CONFLICT(user_id,group_id) DO UPDATE SET rate_multiplier=excluded.rate_multiplier,rpm_limit=excluded.rpm_limit`
const GRANT_SOURCE_SQL =
  "SELECT id FROM users WHERE admin_domain_id=? AND role='admin' AND deleted_at IS NULL AND id<>? ORDER BY (id=admin_domain_id) DESC,created_at,id LIMIT 1"
const DELETE_USER_GRANTS_SQL = 'DELETE FROM user_groups WHERE user_id=?'
const INSERT_USER_GRANT_SQL = 'INSERT INTO user_groups(user_id,group_id,created_at) VALUES(?,?,?)'
const USER_GRANT_SQL = 'SELECT * FROM user_groups WHERE user_id=? AND group_id=?'
const ACTIVE_SUBSCRIPTION_SQL =
  "SELECT * FROM user_subscriptions WHERE user_id=? AND group_id=? AND status='active' AND starts_at<=? AND (expires_at IS NULL OR expires_at>?) ORDER BY starts_at DESC,id LIMIT 1"
const RESOURCE_KINDS = ['vm', 'api_endpoint', 'gateway_worker_account']

function checkAssignInput(kind, groupIds) {
  if (!RESOURCE_KINDS.includes(kind)) throw relayError('invalid_resource_kind', '资源类型不正确')
  if (!Array.isArray(groupIds)) throw relayError('invalid_group_ids', '分组必须是数组')
  return [...new Set(groupIds.map((g) => integer(g, 1, 1e9, 'group_id')))]
}

function checkVersion(expectedVersion, version) {
  if (expectedVersion == null || Number(expectedVersion) !== version)
    throw relayError('version_conflict', '资源分组已变更，请刷新', 409)
}

function staleVersion() {
  return relayError('version_conflict', '资源分组已变更，请刷新', 409)
}

/** 分组准入判定（access）：group、grant、subscription 由调用方读出。 */
function accessDecision(user, group, grant, subscription) {
  if (!group || group.status !== 'active') throw relayError('group_unavailable', '分组不存在或已停用', 403)
  if (!user || user.status !== 'active') throw relayError('user_disabled', '用户不可用', 403)
  const staff = user.role === 'super_admin' || user.role === 'admin'
  if (
    (user.role === 'admin' && !grant) ||
    (!staff && !grant && !subscription && (user.restrict_public_groups || group.is_exclusive))
  )
    throw relayError('group_forbidden', '没有该分组的使用权限', 403)
  if (!staff && group.subscription_type === 'subscription' && !subscription)
    throw relayError('subscription_required', '套餐未生效或已到期', 403)
}

export class GroupsRepo {
  constructor(db = getDb()) {
    this.db = db
    this.client = dbClient(db)
  }
  async list() {
    return (await this.client.many(LIST_SQL)).map(present)
  }
  async getById(id) {
    return present(await this.client.one(GET_SQL, id))
  }
  async getByName(name) {
    return present(await this.client.one(GET_BY_NAME_SQL, String(name).trim()))
  }
  async getDefault() {
    return this.getById(DEFAULT_GROUP_ID)
  }
  /** 推理热路径商业日志（commitRelayLog 的 db.tx）读取分组倍率。 */
  async rateMultiplier(id) {
    return (await this.getById(id ?? DEFAULT_GROUP_ID))?.rate_multiplier ?? 1
  }
  async resources(id) {
    return this.client.many(RESOURCES_SQL, id)
  }
  async forResource(kind, id) {
    return (await this.client.many(FOR_RESOURCE_SQL, kind, id)).map(present)
  }
  async resourceVersion(kind, id) {
    return (await this.client.one(RESOURCE_VERSION_SQL, kind, id))?.version || 0
  }
  /** 一类资源的分组归属：`资源 id → 分组列表`（每个资源的分组与 forResource 相同）。 */
  async forResourceKind(kind) {
    const out = new Map()
    for (const { r6_resource_id: id, ...row } of await this.client.many(FOR_RESOURCE_KIND_SQL, kind)) {
      const key = String(id)
      if (!out.has(key)) out.set(key, [])
      out.get(key).push(present(row))
    }
    return out
  }
  /** 一类资源的分组版本：`资源 id → 版本`（没有记录的资源不在其中，版本按 0 计）。 */
  async resourceVersionsOfKind(kind) {
    const out = new Map()
    for (const row of await this.client.many(RESOURCE_VERSIONS_OF_KIND_SQL, kind))
      out.set(String(row.resource_id), row.version || 0)
    return out
  }
  async touchResource(kind, id) {
    await this.client.run(TOUCH_RESOURCE_SQL, kind, id)
  }
  async create(input, actor = 'system') {
    const now = new Date().toISOString()
    const data = patchFields(input, {
      name: '',
      description: '',
      platform: 'mixed',
      rate_multiplier: 1,
      is_exclusive: 0,
      rpm_limit: 0,
      sort_order: 0,
      status: 'active',
      models_json: '[]',
      subscription_type: 'standard',
      daily_limit_micros: 0,
      weekly_limit_micros: 0,
      monthly_limit_micros: 0,
      allow_image_generation: 1,
      image_count_billing: 0,
      image_rate_independent: 0,
      image_rate_multiplier: 1,
      image_price_1k: null,
      image_price_2k: null,
      image_price_4k: null,
      web_search_price_per_call: null,
      codex_fast_mode: 'default',
    })
    if (!data.name) throw relayError('invalid_name', '请输入分组名称')
    return this.client.tx(async (tx) => {
      if (await this.getByName(data.name)) throw relayError('group_name_exists', '分组名称已存在', 409)
      const id = Number(
        (await tx.run(INSERT_GROUP_SQL, ...FIELDS.map((field) => data[field]), now, now)).lastInsertRowid,
      )
      const result = await this.getById(id)
      await audit(this.db, actor, 'group.create', id, null, result)
      return result
    })
  }
  async update(id, input, actor = 'system') {
    return this.client.tx(async (tx) => {
      const current = await this.getById(id)
      if (!current) return null
      if (input.expected_version != null && Number(input.expected_version) !== current.version)
        throw relayError('version_conflict', '分组已被修改，请刷新', 409)
      const data = patchFields(input, current)
      const duplicate = await this.getByName(data.name)
      if (duplicate && duplicate.id !== current.id) throw relayError('group_name_exists', '分组名称已存在', 409)
      await tx.run(UPDATE_GROUP_SQL, ...FIELDS.map((f) => data[f]), new Date().toISOString(), id)
      const result = await this.getById(id)
      await audit(this.db, actor, 'group.update', id, current, result)
      return result
    })
  }
  async remove(id, actor = 'system') {
    return this.client.tx(async (tx) => {
      const group = await this.getById(id)
      if (!group) return false
      const inUse = (await tx.one(KEYS_IN_GROUP_SQL, id)).n + (await tx.one(SUBSCRIPTIONS_IN_GROUP_SQL, id)).n
      if (inUse) throw relayError('group_in_use', '分组仍被 Key 或套餐引用，请先停用', 409)
      for (const r of await this.resources(id)) await this.touchResource(r.resource_kind, r.resource_id)
      await tx.run(DELETE_GROUP_RESOURCES_SQL, id)
      await tx.run(DELETE_GROUP_USERS_SQL, id)
      await tx.run(DELETE_GROUP_OVERRIDES_SQL, id)
      await tx.run(SOFT_DELETE_GROUP_SQL, new Date().toISOString(), id)
      await audit(this.db, actor, 'group.delete', id, group, null)
      return true
    })
  }
  /**
   * 替换资源的分组归属。读版本、改关系与版本递增在同一事务里；版本按读到的值条件递增（竞态 R18），
   * 并发修改过的资源返回 version_conflict，关系不变。
   */
  async assignResource(kind, id, groupIds, expectedVersion, actor = 'system') {
    const ids = checkAssignInput(kind, groupIds)
    return this.client.tx(async (tx) => {
      for (const gid of ids) if (!(await this.getById(gid))) throw relayError('group_not_found', '分组不存在', 404)
      const version = await this.resourceVersion(kind, id)
      checkVersion(expectedVersion, version)
      const priorities = new Map(
        (await tx.many(RESOURCE_PRIORITIES_SQL, kind, id)).map((r) => [r.group_id, r.priority]),
      )
      const before = (await this.forResource(kind, id)).map((g) => g.id)
      await tx.run(DELETE_RESOURCE_MEMBERSHIP_SQL, kind, id)
      for (const gid of ids) await tx.run(INSERT_GROUP_RESOURCE_SQL, gid, kind, id, priorities.get(gid) ?? 50)
      if ((await tx.run(CLAIM_RESOURCE_VERSION_SQL, kind, id, version)).changes !== 1) throw staleVersion()
      for (const gid of new Set([...before, ...ids]))
        await tx.run(BUMP_GROUP_VERSION_SQL, new Date().toISOString(), gid)
      await audit(this.db, actor, 'resource.groups', kind + ':' + id, before, ids)
      return { group_ids: ids, groups: await this.forResource(kind, id), groups_version: version + 1 }
    })
  }
  async grants(userId) {
    return this.client.many(GRANTS_SQL, userId)
  }
  async override(userId, groupId) {
    return (await this.client.one(OVERRIDE_SQL, userId, groupId)) || null
  }
  async overrides(groupId) {
    return this.client.many(OVERRIDES_SQL, groupId)
  }
  async setOverride(userId, groupId, input, actor = 'system') {
    return this.client.tx(async () => {
      if (!(await this.getById(groupId))) throw relayError('group_not_found', '分组不存在', 404)
      const user = await this.#grantUser(userId)
      const result = await this.#setUserOverride(userId, groupId, input, actor)
      if (user.role === 'admin' && user.admin_domain_id) {
        for (const peer of await this.#domainMembers(user.admin_domain_id))
          if (peer.role === 'admin' && peer.id !== userId)
            await this.#setUserOverride(peer.id, groupId, result || { rate_multiplier: null, rpm_limit: null }, actor)
      }
      return result
    })
  }
  async #grantUser(userId) {
    const user = await this.client.one(GRANT_USER_SQL, userId)
    if (!user) throw relayError('user_not_found', '用户不存在', 404)
    return user
  }
  async #domainMembers(domainId) {
    return this.client.many(DOMAIN_MEMBERS_SQL, domainId)
  }
  async #setUserOverride(userId, groupId, input, actor) {
    const before = await this.override(userId, groupId)
    const next = { rate_multiplier: null, rpm_limit: null, ...before }
    if (Object.hasOwn(input, 'rate_multiplier')) {
      if (input.rate_multiplier != null) patchFields({ rate_multiplier: input.rate_multiplier })
      next.rate_multiplier = input.rate_multiplier == null ? null : Number(input.rate_multiplier)
    }
    if (Object.hasOwn(input, 'rpm_limit'))
      next.rpm_limit = input.rpm_limit == null ? null : integer(input.rpm_limit, 0, 1000000, 'rpm_limit')
    return this.client.tx(async (tx) => {
      if (next.rate_multiplier == null && next.rpm_limit == null) await tx.run(DELETE_OVERRIDE_SQL, userId, groupId)
      else await tx.run(UPSERT_OVERRIDE_SQL, userId, groupId, next.rate_multiplier, next.rpm_limit)
      await audit(this.db, actor, 'group.user_override', `${groupId}:${userId}`, before, next)
      return this.override(userId, groupId)
    })
  }
  async inheritGrants(userId, actor = 'system') {
    return this.client.tx(async () => {
      const user = await this.#grantUser(userId)
      if (!user.admin_domain_id || !['admin', 'user'].includes(user.role)) return
      const source = await this.client.one(GRANT_SOURCE_SQL, user.admin_domain_id, userId)
      if (!source) return
      const grants = (await this.grants(source.id)).map((grant) =>
        user.role === 'admin' ? grant : { group_id: grant.group_id, rate_multiplier: null, rpm_override: null },
      )
      await this.#replaceGrants(userId, grants, actor)
      return this.grants(userId)
    })
  }
  async setGrants(userId, grants, actor = 'system') {
    return this.client.tx(async () => {
      const user = await this.#grantUser(userId)
      if (!Array.isArray(grants)) throw relayError('invalid_groups', '授权必须是数组')
      const entries = grants.map((g) => (typeof g === 'number' ? { group_id: g, rate_multiplier: null } : g))
      for (const entry of entries) {
        if (!(await this.getById(entry.group_id))) throw relayError('group_not_found', '分组不存在', 404)
        if (entry.rate_multiplier != null) patchFields({ rate_multiplier: entry.rate_multiplier })
        if (entry.rpm_override != null) integer(entry.rpm_override, 0, 1000000, 'rpm_override')
      }
      if (new Set(entries.map((g) => g.group_id)).size !== entries.length)
        throw relayError('duplicate_group', '分组不能重复')
      await this.#replaceGrants(userId, entries, actor)
      if (user.role === 'admin' && user.admin_domain_id) {
        const shared = await this.grants(userId)
        for (const member of await this.#domainMembers(user.admin_domain_id)) {
          if (member.id === userId) continue
          // Group membership is shared; customer-specific pricing/RPM is not.
          const memberGrants = member.role === 'admin' ? shared : shared.map(({ group_id }) => ({ group_id }))
          await this.#replaceGrants(member.id, memberGrants, actor)
        }
      }
      return this.grants(userId)
    })
  }
  async #replaceGrants(userId, entries, actor) {
    const before = await this.grants(userId)
    await this.client.run(DELETE_USER_GRANTS_SQL, userId)
    for (const entry of entries) {
      await this.client.run(INSERT_USER_GRANT_SQL, userId, entry.group_id, new Date().toISOString())
      await this.#setUserOverride(
        userId,
        entry.group_id,
        {
          ...(Object.hasOwn(entry, 'rate_multiplier') ? { rate_multiplier: entry.rate_multiplier } : {}),
          ...(Object.hasOwn(entry, 'rpm_override') ? { rpm_limit: entry.rpm_override } : {}),
        },
        actor,
      )
    }
    for (const entry of before)
      if (!entries.some((e) => e.group_id === entry.group_id))
        await this.client.run(DELETE_OVERRIDE_SQL, userId, entry.group_id)
    await audit(this.db, actor, 'user.groups', userId, before, entries)
  }
  async access(user, groupId, now = new Date().toISOString()) {
    const group = await this.getById(groupId)
    if (!group || group.status !== 'active') return accessDecision(user, group)
    if (!user || user.status !== 'active') return accessDecision(user, group)
    const grant = await this.client.one(USER_GRANT_SQL, user.id, group.id)
    const subscription = await this.client.one(ACTIVE_SUBSCRIPTION_SQL, user.id, group.id, now, now)
    accessDecision(user, group, grant, subscription)
    return {
      group,
      subscription: subscription || null,
      rate: (await this.override(user.id, group.id))?.rate_multiplier ?? group.rate_multiplier,
    }
  }
}
