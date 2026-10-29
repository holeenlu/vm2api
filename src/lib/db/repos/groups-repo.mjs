/** Commercial groups and stable resource membership. Credential UUIDs are not VM membership keys. */
import { calculateCost } from '../../admin/pricing.mjs'
import { platformOfModel } from '../../admin/price-catalog.mjs'
import { getDb, withTransaction } from '../database.mjs'
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
]
function present(row) {
  if (!row) return null
  return {
    ...row,
    models: JSON.parse(row.models_json || '[]'),
    is_exclusive: !!row.is_exclusive,
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
export class GroupsRepo {
  constructor(db = getDb()) {
    this.db = db
  }
  list() {
    return this.db.prepare('SELECT * FROM groups WHERE deleted_at IS NULL ORDER BY sort_order,id').all().map(present)
  }
  getById(id) {
    return present(this.db.prepare('SELECT * FROM groups WHERE id=? AND deleted_at IS NULL').get(id))
  }
  getByName(name) {
    return present(this.db.prepare('SELECT * FROM groups WHERE name=? AND deleted_at IS NULL').get(String(name).trim()))
  }
  getDefault() {
    return this.getById(DEFAULT_GROUP_ID)
  }
  rateMultiplier(id) {
    return this.getById(id ?? DEFAULT_GROUP_ID)?.rate_multiplier ?? 1
  }
  resources(id) {
    return this.db
      .prepare(
        'SELECT resource_kind,resource_id,priority FROM group_resources WHERE group_id=? ORDER BY priority,resource_id',
      )
      .all(id)
  }
  forResource(kind, id) {
    return this.db
      .prepare(
        'SELECT g.* FROM groups g JOIN group_resources r ON r.group_id=g.id WHERE r.resource_kind=? AND r.resource_id=? AND g.deleted_at IS NULL ORDER BY g.sort_order,g.id',
      )
      .all(kind, id)
      .map(present)
  }
  resourceVersion(kind, id) {
    return (
      this.db
        .prepare('SELECT version FROM resource_group_versions WHERE resource_kind=? AND resource_id=?')
        .get(kind, id)?.version || 0
    )
  }
  touchResource(kind, id) {
    this.db
      .prepare(
        'INSERT INTO resource_group_versions(resource_kind,resource_id,version) VALUES(?,?,1) ON CONFLICT(resource_kind,resource_id) DO UPDATE SET version=version+1',
      )
      .run(kind, id)
  }
  create(input, actor = 'system') {
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
    })
    if (!data.name) throw relayError('invalid_name', '请输入分组名称')
    if (this.getByName(data.name)) throw relayError('group_name_exists', '分组名称已存在', 409)
    return withTransaction(this.db, () => {
      const sql =
        'INSERT INTO groups (' +
        FIELDS.join(',') +
        ',created_at,updated_at) VALUES (' +
        FIELDS.map(() => '?').join(',') +
        ',?,?)'
      const id = Number(this.db.prepare(sql).run(...FIELDS.map((field) => data[field]), now, now).lastInsertRowid)
      const result = this.getById(id)
      audit(this.db, actor, 'group.create', id, null, result)
      return result
    })
  }
  update(id, input, actor = 'system') {
    const current = this.getById(id)
    if (!current) return null
    if (input.expected_version != null && Number(input.expected_version) !== current.version)
      throw relayError('version_conflict', '分组已被修改，请刷新', 409)
    const data = patchFields(input, current)
    const duplicate = this.getByName(data.name)
    if (duplicate && duplicate.id !== current.id) throw relayError('group_name_exists', '分组名称已存在', 409)
    return withTransaction(this.db, () => {
      this.db
        .prepare(
          'UPDATE groups SET ' + FIELDS.map((f) => f + '=?').join(',') + ',version=version+1,updated_at=? WHERE id=?',
        )
        .run(...FIELDS.map((f) => data[f]), new Date().toISOString(), id)
      const result = this.getById(id)
      audit(this.db, actor, 'group.update', id, current, result)
      return result
    })
  }
  remove(id, actor = 'system') {
    const group = this.getById(id)
    if (!group) return false
    const inUse =
      this.db.prepare('SELECT COUNT(*) n FROM api_keys WHERE group_id=? AND deleted_at IS NULL').get(id).n +
      this.db
        .prepare("SELECT COUNT(*) n FROM user_subscriptions WHERE group_id=? AND status IN ('active','suspended')")
        .get(id).n
    if (inUse) throw relayError('group_in_use', '分组仍被 Key 或套餐引用，请先停用', 409)
    return withTransaction(this.db, () => {
      for (const r of this.resources(id)) this.touchResource(r.resource_kind, r.resource_id)
      this.db.prepare('DELETE FROM group_resources WHERE group_id=?').run(id)
      this.db.prepare('DELETE FROM user_groups WHERE group_id=?').run(id)
      this.db.prepare('DELETE FROM user_group_overrides WHERE group_id=?').run(id)
      this.db.prepare("UPDATE groups SET deleted_at=?,status='inactive' WHERE id=?").run(new Date().toISOString(), id)
      audit(this.db, actor, 'group.delete', id, group, null)
      return true
    })
  }
  assignResource(kind, id, groupIds, expectedVersion, actor = 'system') {
    if (!['vm', 'api_endpoint'].includes(kind)) throw relayError('invalid_resource_kind', '资源类型不正确')
    if (!Array.isArray(groupIds)) throw relayError('invalid_group_ids', '分组必须是数组')
    const ids = [...new Set(groupIds.map((g) => integer(g, 1, 1e9, 'group_id')))]
    for (const gid of ids) if (!this.getById(gid)) throw relayError('group_not_found', '分组不存在', 404)
    return withTransaction(this.db, () => {
      const version = this.resourceVersion(kind, id)
      if (expectedVersion == null || Number(expectedVersion) !== version)
        throw relayError('version_conflict', '资源分组已变更，请刷新', 409)
      const priorities = new Map(
        this.db
          .prepare('SELECT group_id,priority FROM group_resources WHERE resource_kind=? AND resource_id=?')
          .all(kind, id)
          .map((r) => [r.group_id, r.priority]),
      )
      const before = this.forResource(kind, id).map((g) => g.id)
      this.db.prepare('DELETE FROM group_resources WHERE resource_kind=? AND resource_id=?').run(kind, id)
      const add = this.db.prepare(
        'INSERT INTO group_resources(group_id,resource_kind,resource_id,priority) VALUES(?,?,?,?)',
      )
      for (const gid of ids) add.run(gid, kind, id, priorities.get(gid) ?? 50)
      this.touchResource(kind, id)
      for (const gid of new Set([...before, ...ids]))
        this.db
          .prepare('UPDATE groups SET version=version+1,updated_at=? WHERE id=?')
          .run(new Date().toISOString(), gid)
      audit(this.db, actor, 'resource.groups', kind + ':' + id, before, ids)
      return { group_ids: ids, groups: this.forResource(kind, id), groups_version: version + 1 }
    })
  }
  grants(userId) {
    return this.db
      .prepare(`SELECT g.group_id,o.rate_multiplier,o.rpm_limit AS rpm_override FROM user_groups g
        LEFT JOIN user_group_overrides o ON o.user_id=g.user_id AND o.group_id=g.group_id
        WHERE g.user_id=? ORDER BY g.group_id`)
      .all(userId)
  }
  override(userId, groupId) {
    return (
      this.db
        .prepare('SELECT rate_multiplier,rpm_limit FROM user_group_overrides WHERE user_id=? AND group_id=?')
        .get(userId, groupId) || null
    )
  }
  overrides(groupId) {
    return this.db
      .prepare(`SELECT o.user_id,u.username,o.rate_multiplier,o.rpm_limit FROM user_group_overrides o
      JOIN users u ON u.id=o.user_id WHERE o.group_id=? AND u.deleted_at IS NULL ORDER BY u.username`)
      .all(groupId)
  }
  setOverride(userId, groupId, input, actor = 'system') {
    if (!this.getById(groupId)) throw relayError('group_not_found', '分组不存在', 404)
    if (!this.db.prepare('SELECT id FROM users WHERE id=? AND deleted_at IS NULL').get(userId))
      throw relayError('user_not_found', '用户不存在', 404)
    const before = this.override(userId, groupId)
    const next = { rate_multiplier: null, rpm_limit: null, ...before }
    if (Object.hasOwn(input, 'rate_multiplier')) {
      if (input.rate_multiplier != null) patchFields({ rate_multiplier: input.rate_multiplier })
      next.rate_multiplier = input.rate_multiplier == null ? null : Number(input.rate_multiplier)
    }
    if (Object.hasOwn(input, 'rpm_limit'))
      next.rpm_limit = input.rpm_limit == null ? null : integer(input.rpm_limit, 0, 1000000, 'rpm_limit')
    return withTransaction(this.db, () => {
      if (next.rate_multiplier == null && next.rpm_limit == null)
        this.db.prepare('DELETE FROM user_group_overrides WHERE user_id=? AND group_id=?').run(userId, groupId)
      else
        this.db
          .prepare(`INSERT INTO user_group_overrides(user_id,group_id,rate_multiplier,rpm_limit) VALUES(?,?,?,?)
        ON CONFLICT(user_id,group_id) DO UPDATE SET rate_multiplier=excluded.rate_multiplier,rpm_limit=excluded.rpm_limit`)
          .run(userId, groupId, next.rate_multiplier, next.rpm_limit)
      audit(this.db, actor, 'group.user_override', `${groupId}:${userId}`, before, next)
      return this.override(userId, groupId)
    })
  }
  setGrants(userId, grants, actor = 'system') {
    if (!this.db.prepare('SELECT id FROM users WHERE id=? AND deleted_at IS NULL').get(userId))
      throw relayError('user_not_found', '用户不存在', 404)
    if (!Array.isArray(grants)) throw relayError('invalid_groups', '授权必须是数组')
    const entries = grants.map((g) => (typeof g === 'number' ? { group_id: g, rate_multiplier: null } : g))
    for (const entry of entries) {
      if (!this.getById(entry.group_id)) throw relayError('group_not_found', '分组不存在', 404)
      if (entry.rate_multiplier != null) patchFields({ rate_multiplier: entry.rate_multiplier })
      if (entry.rpm_override != null) integer(entry.rpm_override, 0, 1000000, 'rpm_override')
    }
    if (new Set(entries.map((g) => g.group_id)).size !== entries.length)
      throw relayError('duplicate_group', '分组不能重复')
    return withTransaction(this.db, () => {
      const before = this.grants(userId)
      this.db.prepare('DELETE FROM user_groups WHERE user_id=?').run(userId)
      const add = this.db.prepare('INSERT INTO user_groups(user_id,group_id,created_at) VALUES(?,?,?)')
      for (const entry of entries) {
        add.run(userId, entry.group_id, new Date().toISOString())
        this.setOverride(
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
          this.db.prepare('DELETE FROM user_group_overrides WHERE user_id=? AND group_id=?').run(userId, entry.group_id)
      audit(this.db, actor, 'user.groups', userId, before, entries)
      return this.grants(userId)
    })
  }
  access(user, groupId, now = new Date().toISOString()) {
    const group = this.getById(groupId)
    if (!group || group.status !== 'active') throw relayError('group_unavailable', '分组不存在或已停用', 403)
    if (!user || user.status !== 'active') throw relayError('user_disabled', '用户不可用', 403)
    const grant = this.db.prepare('SELECT * FROM user_groups WHERE user_id=? AND group_id=?').get(user.id, group.id)
    const subscription = this.db
      .prepare(
        "SELECT * FROM user_subscriptions WHERE user_id=? AND group_id=? AND status='active' AND starts_at<=? AND (expires_at IS NULL OR expires_at>?) ORDER BY starts_at DESC,id LIMIT 1",
      )
      .get(user.id, group.id, now, now)
    const staff = user.role === 'super_admin' || user.role === 'admin'
    if (!staff && !grant && !subscription && (user.restrict_public_groups || group.is_exclusive))
      throw relayError('group_forbidden', '没有该分组的使用权限', 403)
    if (!staff && group.subscription_type === 'subscription' && !subscription)
      throw relayError('subscription_required', '套餐未生效或已到期', 403)
    return {
      group,
      subscription: subscription || null,
      rate: this.override(user.id, group.id)?.rate_multiplier ?? group.rate_multiplier,
    }
  }
}
