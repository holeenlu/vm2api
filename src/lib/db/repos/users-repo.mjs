import { withTransaction } from '../database.mjs'
/**
 * users repository — sub2api-shaped users table.
 *
 * Superset of the old PanelUsersRepo contract: console operators are now
 * first-class users with balance/concurrency. `enabled` is projected from
 * status ('active' ↔ enabled) so panel-users.mjs keeps its record shape.
 * Soft delete: rows with deleted_at are invisible to every query here.
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

function statusOf(rec) {
  // explicit boolean `enabled` wins over a stale status carried on the record
  if (typeof rec.enabled === 'boolean') return rec.enabled ? 'active' : 'disabled'
  return rec.status ?? 'active'
}

export class UsersRepo {
  constructor(db) {
    this.db = db
    this._list = db.prepare('SELECT * FROM users WHERE deleted_at IS NULL ORDER BY created_at, username')
    this._get = db.prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL')
    this._getByName = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE AND deleted_at IS NULL')
    this._insert = db.prepare(`
      INSERT INTO users (${COLUMNS.join(', ')})
      VALUES (${COLUMNS.map(() => '?').join(', ')})
    `)
    this._softDelete = db.prepare('UPDATE users SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
    this._countRole = db.prepare(
      "SELECT COUNT(*) AS c FROM users WHERE role = ? AND status = 'active' AND deleted_at IS NULL",
    )
  }

  list() {
    return this._list.all().map(rowToRec)
  }

  getById(id) {
    return rowToRec(this._get.get(id))
  }

  getByUsername(username) {
    return rowToRec(this._getByName.get(String(username || '').trim()))
  }

  scopeRootId(actorId) {
    const user = this.getById(String(actorId || ''))
    return ['admin', 'user'].includes(user?.role) ? user.admin_domain_id || null : null
  }

  scopeIds(actorId) {
    const domainId = this.scopeRootId(actorId)
    if (!domainId) return []
    return this.db
      .prepare("SELECT id FROM users WHERE admin_domain_id = ? AND role IN ('admin', 'user') AND deleted_at IS NULL")
      .all(domainId)
      .map((row) => row.id)
  }

  canFund(id, { actorId, role } = {}) {
    const target = this.getById(id)
    if (!target) return false
    if (target.role === 'admin') return role === 'super_admin'
    if (target.role !== 'user' || !['admin', 'super_admin'].includes(role)) return false
    // Master-key-created records have no panel creator. A panel account cannot
    // claim unattributed legacy users merely by being a super administrator.
    return (target.parent_user_id || null) === (actorId || null) && (role === 'super_admin' || !!actorId)
  }

  walletBalance(rec) {
    if (rec?.role !== 'admin') return rec?.balance_micros || 0
    return (
      this.db.prepare('SELECT balance_micros FROM admin_domains WHERE id = ?').get(rec.admin_domain_id)
        ?.balance_micros || 0
    )
  }

  isInScope(id, actorId) {
    const target = String(id || '').trim()
    return target !== '' && this.scopeIds(actorId).includes(target)
  }

  insert(rec) {
    return withTransaction(this.db, () => {
      // Creator-derived membership cannot be supplied by the panel request body.
      const parent = rec.parent_user_id ? this.getById(rec.parent_user_id) : null
      let domainId =
        ['admin', 'user'].includes(rec.role) && parent?.role === 'admin' ? parent.admin_domain_id || null : null
      if (rec.role === 'admin' && !domainId) {
        domainId = rec.id
        this.db
          .prepare('INSERT INTO admin_domains(id, created_by_user_id) VALUES(?, ?)')
          .run(domainId, parent?.id || null)
      }
      const adminBalance = rec.role === 'admin' ? Math.round((rec.balance || 0) * 1e6) : 0
      rec = { ...rec, admin_domain_id: domainId, ...(rec.role === 'admin' ? { balance: 0 } : {}) }
      this._insert.run(
        ...COLUMNS.map((c) => {
          if (c === 'email') return rec.email ?? `${rec.username}@panel.local`
          if (c === 'display_name') return rec.display_name || ''
          if (c === 'status') return statusOf(rec)
          if (c === 'balance') return rec.balance ?? 0
          if (c === 'balance_micros') return Math.round((rec.balance ?? 0) * 1e6)
          if (c === 'rpm_limit') return rec.rpm_limit ?? 0
          if (c === 'restrict_public_groups') return rec.restrict_public_groups === false ? 0 : 1
          if (c === 'concurrency') return rec.concurrency ?? 0
          if (c === 'notes') return rec.notes ?? ''
          if (c === 'deleted_at') return null
          return rec[c] ?? null
        }),
      )
      if (adminBalance)
        this.db
          .prepare('UPDATE admin_domains SET balance_micros = balance_micros + ? WHERE id = ?')
          .run(adminBalance, domainId)
      return this.getById(rec.id)
    })
  }

  update(rec) {
    const cols = COLUMNS.filter((c) => !['id', 'deleted_at', 'balance', 'balance_micros'].includes(c))
    const sql = `UPDATE users SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ? AND deleted_at IS NULL`
    this.db.prepare(sql).run(
      ...cols.map((c) => {
        if (c === 'email') return rec.email ?? `${rec.username}@panel.local`
        if (c === 'display_name') return rec.display_name || ''
        if (c === 'status') return statusOf(rec)
        if (c === 'rpm_limit') return rec.rpm_limit ?? 0
        if (c === 'restrict_public_groups') return rec.restrict_public_groups === false ? 0 : 1
        if (c === 'concurrency') return rec.concurrency ?? 0
        if (c === 'notes') return rec.notes ?? ''
        return rec[c] ?? null
      }),
      rec.id,
    )
    return this.getById(rec.id)
  }

  /** Soft delete (sub2api SoftDeleteMixin semantics). */
  remove(id) {
    const now = new Date().toISOString()
    return this._softDelete.run(now, now, id).changes > 0
  }

  countEnabledRole(role) {
    const row = this._countRole.get(role)
    return Number(row?.c || 0)
  }
}
