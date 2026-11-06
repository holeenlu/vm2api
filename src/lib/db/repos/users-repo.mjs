import { dbClient } from '../db-client.mjs'
import { normalizeResourcePermissions } from '../../admin/resource-permissions.mjs'
/**
 * users repository — sub2api-shaped users table.
 *
 * Superset of the old PanelUsersRepo contract: console operators are now
 * first-class users with balance/concurrency. `enabled` is projected from
 * status ('active' ↔ enabled) so panel-users.mjs keeps its record shape.
 * Soft delete: rows with deleted_at are invisible to every query here.
 *
 * 数据访问经 DbClient 异步执行（R6 B6b；推理热路径的 Key 准入、计费与面板鉴权自 R6 B7a，Codex 候选准入自 B7c）。
 */

const COLUMNS = [
  'id',
  'email',
  'username',
  'display_name',
  'password_hash',
  'role',
  'parent_user_id',
  'admin_domain_id',
  'balance',
  'balance_micros',
  'rpm_limit',
  'restrict_public_groups',
  'resource_permissions',
  'concurrency',
  'status',
  'notes',
  'last_login_at',
  'last_active_at',
  'created_at',
  'updated_at',
  'deleted_at',
]

function rowToRec(row) {
  if (!row) return null
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    display_name: row.display_name || '',
    password_hash: row.password_hash,
    role: row.role,
    parent_user_id: row.parent_user_id || null,
    admin_domain_id: row.admin_domain_id || null,
    balance: (Number(row.balance_micros) || 0) / 1e6,
    balance_micros: Number(row.balance_micros) || 0,
    rpm_limit: Number(row.rpm_limit) || 0,
    restrict_public_groups: row.restrict_public_groups !== 0,
    resource_permissions: normalizeResourcePermissions(row.resource_permissions),
    concurrency: Number(row.concurrency) || 0,
    status: row.status,
    enabled: row.status === 'active',
    notes: row.notes ?? '',
    last_login_at: row.last_login_at,
    last_active_at: row.last_active_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

/** 只有 admin 角色保存授予记录；其他角色一律清空，避免改回 admin 时旧授权复活。 */
function resourcePermissionsJson(rec) {
  return JSON.stringify(rec.role === 'admin' ? normalizeResourcePermissions(rec.resource_permissions) : [])
}

function statusOf(rec) {
  // explicit boolean `enabled` wins over a stale status carried on the record
  if (typeof rec.enabled === 'boolean') return rec.enabled ? 'active' : 'disabled'
  return rec.status ?? 'active'
}

const LIST_SQL = 'SELECT * FROM users WHERE deleted_at IS NULL ORDER BY created_at, username'
const GET_SQL = 'SELECT * FROM users WHERE id = ? AND deleted_at IS NULL'
const GET_BY_NAME_SQL = 'SELECT * FROM users WHERE username = ? COLLATE NOCASE AND deleted_at IS NULL'
const INSERT_SQL = `
      INSERT INTO users (${COLUMNS.join(', ')})
      VALUES (${COLUMNS.map(() => '?').join(', ')})
    `
const SOFT_DELETE_SQL = 'UPDATE users SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL'
const COUNT_ROLE_SQL = "SELECT COUNT(*) AS c FROM users WHERE role = ? AND status = 'active' AND deleted_at IS NULL"
const SCOPE_IDS_SQL =
  "SELECT id FROM users WHERE admin_domain_id = ? AND role IN ('admin', 'user') AND deleted_at IS NULL"
const DOMAIN_BALANCE_SQL = 'SELECT balance_micros FROM admin_domains WHERE id = ?'
const INSERT_DOMAIN_SQL = 'INSERT INTO admin_domains(id, created_by_user_id) VALUES(?, ?)'
const ADD_DOMAIN_BALANCE_SQL = 'UPDATE admin_domains SET balance_micros = balance_micros + ? WHERE id = ?'
const UPDATE_COLUMNS = COLUMNS.filter((c) => !['id', 'deleted_at', 'balance', 'balance_micros'].includes(c))
const UPDATE_SQL = `UPDATE users SET ${UPDATE_COLUMNS.map((c) => `${c} = ?`).join(', ')} WHERE id = ? AND deleted_at IS NULL`

function insertValues(rec) {
  return COLUMNS.map((c) => {
    if (c === 'email') return rec.email ?? `${rec.username}@panel.local`
    if (c === 'display_name') return rec.display_name || ''
    if (c === 'status') return statusOf(rec)
    if (c === 'balance') return rec.balance ?? 0
    if (c === 'balance_micros') return Math.round((rec.balance ?? 0) * 1e6)
    if (c === 'rpm_limit') return rec.rpm_limit ?? 0
    if (c === 'restrict_public_groups') return rec.restrict_public_groups === false ? 0 : 1
    if (c === 'resource_permissions') return resourcePermissionsJson(rec)
    if (c === 'concurrency') return rec.concurrency ?? 0
    if (c === 'notes') return rec.notes ?? ''
    if (c === 'deleted_at') return null
    return rec[c] ?? null
  })
}

function updateValues(rec) {
  return UPDATE_COLUMNS.map((c) => {
    if (c === 'email') return rec.email ?? `${rec.username}@panel.local`
    if (c === 'display_name') return rec.display_name || ''
    if (c === 'status') return statusOf(rec)
    if (c === 'rpm_limit') return rec.rpm_limit ?? 0
    if (c === 'restrict_public_groups') return rec.restrict_public_groups === false ? 0 : 1
    if (c === 'resource_permissions') return resourcePermissionsJson(rec)
    if (c === 'concurrency') return rec.concurrency ?? 0
    if (c === 'notes') return rec.notes ?? ''
    return rec[c] ?? null
  })
}

export class UsersRepo {
  constructor(db) {
    this.db = db
    this.client = dbClient(db)
  }

  async list() {
    return (await this.client.many(LIST_SQL)).map(rowToRec)
  }

  async getById(id) {
    return rowToRec(await this.client.one(GET_SQL, id))
  }

  async getByUsername(username) {
    return rowToRec(await this.client.one(GET_BY_NAME_SQL, String(username || '').trim()))
  }

  async scopeRootId(actorId) {
    const user = await this.getById(String(actorId || ''))
    return ['admin', 'user'].includes(user?.role) ? user.admin_domain_id || null : null
  }

  async scopeIds(actorId) {
    const domainId = await this.scopeRootId(actorId)
    if (!domainId) return []
    return (await this.client.many(SCOPE_IDS_SQL, domainId)).map((row) => row.id)
  }

  async canFund(id, { actorId, role } = {}) {
    const target = await this.getById(id)
    if (!target) return false
    if (target.role === 'admin') return role === 'super_admin'
    if (target.role !== 'user' || !['admin', 'super_admin'].includes(role)) return false
    if (role === 'admin') {
      const actor = actorId ? await this.getById(actorId) : null
      return actor?.role === 'admin' && !!actor.admin_domain_id && actor.admin_domain_id === target.admin_domain_id
    }
    // Master-key-created records have no panel creator. A panel account cannot
    // claim unattributed legacy users merely by being a super administrator.
    return (target.parent_user_id || null) === (actorId || null)
  }

  async walletBalance(rec) {
    if (rec?.role !== 'admin') return rec?.balance_micros || 0
    return (await this.client.one(DOMAIN_BALANCE_SQL, rec.admin_domain_id))?.balance_micros || 0
  }

  async isInScope(id, actorId) {
    const target = String(id || '').trim()
    return target !== '' && (await this.scopeIds(actorId)).includes(target)
  }

  async insert(rec) {
    return this.client.tx(async (tx) => {
      // Creator-derived membership cannot be supplied by the panel request body.
      const parent = rec.parent_user_id ? await this.getById(rec.parent_user_id) : null
      let domainId =
        ['admin', 'user'].includes(rec.role) && parent?.role === 'admin' ? parent.admin_domain_id || null : null
      if (rec.role === 'admin' && !domainId) {
        domainId = rec.id
        await tx.run(INSERT_DOMAIN_SQL, domainId, parent?.id || null)
      }
      const adminBalance = rec.role === 'admin' ? Math.round((rec.balance || 0) * 1e6) : 0
      rec = { ...rec, admin_domain_id: domainId, ...(rec.role === 'admin' ? { balance: 0 } : {}) }
      await tx.run(INSERT_SQL, ...insertValues(rec))
      if (adminBalance) await tx.run(ADD_DOMAIN_BALANCE_SQL, adminBalance, domainId)
      return this.getById(rec.id)
    })
  }

  async update(rec) {
    await this.client.run(UPDATE_SQL, ...updateValues(rec), rec.id)
    return this.getById(rec.id)
  }

  /** Soft delete (sub2api SoftDeleteMixin semantics). */
  async remove(id) {
    const now = new Date().toISOString()
    return (await this.client.run(SOFT_DELETE_SQL, now, now, id)).changes > 0
  }

  async countEnabledRole(role) {
    const row = await this.client.one(COUNT_ROLE_SQL, role)
    return Number(row?.c || 0)
  }
}
