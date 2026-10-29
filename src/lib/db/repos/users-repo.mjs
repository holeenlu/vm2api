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
    const id = String(actorId || '').trim()
    if (!id) return null
    const rows = this.db.prepare(`WITH RECURSIVE ancestors(id, parent_user_id, role) AS (
      SELECT id, parent_user_id, role FROM users WHERE id = ? AND deleted_at IS NULL
      UNION ALL SELECT u.id, u.parent_user_id, u.role FROM users u JOIN ancestors a ON u.id = a.parent_user_id
      WHERE u.deleted_at IS NULL
    ) SELECT id, parent_user_id, role FROM ancestors`).all(id)
    if (!rows.length) return null
    const byId = new Map(rows.map((row) => [row.id, row]))
    let current = byId.get(id)
    while (current?.parent_user_id) {
      const parent = byId.get(current.parent_user_id)
      if (!parent || parent.role === 'super_admin') break
      current = parent
    }
    return current?.id || null
  }

  scopeIds(actorId) {
    const id = this.scopeRootId(actorId)
    if (!id) return []
    return this.db
      .prepare(
        `WITH RECURSIVE managed(id, role) AS (
           SELECT id, role FROM users WHERE id = ? AND deleted_at IS NULL
           UNION ALL
           SELECT u.id, u.role FROM users u JOIN managed m ON u.parent_user_id = m.id
           WHERE u.deleted_at IS NULL
         ) SELECT id FROM managed WHERE role IN ('admin', 'user')`,
      )
      .all(id)
      .map((row) => row.id)
  }

  isInScope(id, actorId) {
    const target = String(id || '').trim()
    return target !== '' && this.scopeIds(actorId).includes(target)
  }

  insert(rec) {
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
    return this.getById(rec.id)
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
