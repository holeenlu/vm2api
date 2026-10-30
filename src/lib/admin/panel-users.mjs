import { integer } from './relay-common.mjs'
/**
 * Panel operator accounts: scrypt passwords + platform/vendor roles.
 *
 * Env KIN_ADMIN_USER / KIN_ADMIN_PASSWORD seed the first admin when missing.
 * After that, the database hash is the source of truth (panel can change it).
 */

import crypto from 'node:crypto'
import { resolveStoreDb, withTransaction } from '../db/database.mjs'
import { UsersRepo } from '../db/repos/users-repo.mjs'
import { GroupsRepo } from '../db/repos/groups-repo.mjs'

export const PANEL_ROLES = ['super_admin', 'admin', 'user', 'vendor']

const SCRYPT_N = 16384
const SCRYPT_R = 8
const SCRYPT_P = 1
const KEYLEN = 32
const USERNAME_RE = /^[a-zA-Z][a-zA-Z0-9._-]{1,31}$/
export const USERNAME_HELP = '请输入有效邮箱（最长 254 位），或 2–32 位、字母开头且仅含字母数字 . _ - 的用户名'

export function isPanelUsername(name) {
  if (USERNAME_RE.test(name)) return true
  if (name.length > 254) return false
  const parts = name.split('@')
  if (parts.length !== 2) return false
  const [local, domain] = parts
  return (
    local.length <= 64 &&
    /^[a-zA-Z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-zA-Z0-9!#$%&'*+/=?^_`{|}~-]+)*$/.test(local) &&
    domain.includes('.') &&
    domain.split('.').every((label) => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label))
  )
}

function nowIso() {
  return new Date().toISOString()
}

function actorIdOf(actorId, repo) {
  const id = String(actorId || '').trim()
  if (!id || id === 'master' || !repo?.getById?.(id)) return null
  return id
}

export function normalizeUsername(username) {
  return String(username || '').trim()
}

export function normalizeRole(role) {
  const r = String(role || '')
    .trim()
    .toLowerCase()
  if (r === 'viewer' || r === 'readonly' || r === '普通') return 'user'
  if (r === '管理员' || r === '管理') return 'admin'
  if (r === '超管理' || r === '超管') return 'super_admin'
  if (r === '供应商' || r === '服务提供商') return 'vendor'
  return r
}

export function isPanelRole(role) {
  return PANEL_ROLES.includes(normalizeRole(role))
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16)
  const hash = crypto.scryptSync(String(password), salt, KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  })
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${hash.toString('hex')}`
}

export function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$')
  if (parts[0] !== 'scrypt' || parts.length !== 6) return false
  const N = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false
  try {
    const salt = Buffer.from(parts[4], 'hex')
    const expected = Buffer.from(parts[5], 'hex')
    if (!salt.length || !expected.length) return false
    const actual = crypto.scryptSync(String(password), salt, expected.length, { N, r, p })
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

function assertUsername(username) {
  const name = normalizeUsername(username)
  if (!isPanelUsername(name)) {
    const err = new Error(USERNAME_HELP)
    err.code = 'invalid_username'
    throw err
  }
  return name
}

function assertPassword(password) {
  const pass = String(password ?? '')
  if (pass.length < 8) {
    const err = new Error('密码至少 8 位')
    err.code = 'invalid_password'
    throw err
  }
  if (pass.length > 128) {
    const err = new Error('密码过长')
    err.code = 'invalid_password'
    throw err
  }
  return pass
}

function assertRole(role) {
  const r = normalizeRole(role)
  if (!isPanelRole(r)) {
    const err = new Error('角色必须是 super_admin / admin / user / vendor')
    err.code = 'invalid_role'
    throw err
  }
  return r
}

export function publicUserView(rec) {
  if (!rec) return null
  return {
    id: rec.id,
    username: rec.username,
    role: rec.role,
    enabled: rec.enabled !== false,
    balance: rec.balance ?? 0,
    concurrency: rec.concurrency ?? 0,
    rpm_limit: rec.rpm_limit ?? 0,
    restrict_public_groups: rec.restrict_public_groups !== false,
    created_at: rec.created_at,
    updated_at: rec.updated_at,
    last_login_at: rec.last_login_at || null,
  }
}

export class PanelUserStore {
  constructor({ dataDir, db, projectRoot = null } = {}) {
    this.db = resolveStoreDb({ db, dataDir })
    this.repo = new UsersRepo(this.db)
    this.projectRoot = projectRoot
  }

  rebind(db) {
    this.db = db
    this.repo = new UsersRepo(db)
  }

  list({ actorId = null, role = null } = {}) {
    const groups = new GroupsRepo(this.db)
    const vendors = new Map(
      this.db
        .prepare(
          `
            SELECT vm.user_id, v.id AS vendor_id, v.name AS vendor_name, v.tier AS vendor_tier
            FROM vendor_members vm
            JOIN vendors v ON v.id = vm.vendor_id
            WHERE vm.status = 'active' AND v.status = 'active' AND v.deleted_at IS NULL
            ORDER BY vm.is_primary DESC, vm.created_at ASC
          `,
        )
        .all()
        .map((row) => [row.user_id, row]),
    )
    const scope = role === 'admin' ? new Set(this.repo.scopeIds(actorId)) : null
    return this.repo
      .list()
      .filter((u) => !scope || (scope.has(u.id) && u.id !== actorId && ['user', 'admin'].includes(u.role)))
      .map((u) => {
        const vendor = vendors.get(u.id)
        return {
          ...publicUserView(u),
          balance: this.repo.walletBalance(u) / 1e6,
          shared_balance: u.role === 'admin',
          can_credit: this.repo.canFund(u.id, { actorId, role }),
          ...(vendor
            ? {
                vendor_id: vendor.vendor_id,
                vendor_name: vendor.vendor_name,
                vendor_tier: vendor.vendor_tier,
              }
            : {}),
          groups: groups.grants(u.id),
        }
      })
  }

  getById(id) {
    return this.repo.getById(id)
  }

  getByUsername(username) {
    return this.repo.getByUsername(username)
  }

  canAccess(id, { actorId = null, role = null } = {}) {
    if (role !== 'admin') return true
    const rec = this.repo.getById(id)
    return !!rec && rec.id !== actorId && this.repo.isInScope(rec.id, actorId) && ['user', 'admin'].includes(rec.role)
  }

  countEnabledAdmins() {
    return this.repo.countEnabledRole('super_admin')
  }

  bootstrapFromEnv({ username, password } = {}) {
    const name = normalizeUsername(username)
    if (!name || !password) return null
    const existing = this.repo.getByUsername(name)
    if (existing) return publicUserView(existing)
    // Import the already accepted env credential; new passwords still go through assertPassword.
    return publicUserView(
      this.repo.insert({
        id: crypto.randomUUID(),
        username: assertUsername(name),
        password_hash: hashPassword(password),
        role: 'super_admin',
        enabled: true,
        created_at: nowIso(),
        updated_at: nowIso(),
        last_login_at: null,
      }),
    )
  }

  authenticate(username, password) {
    const rec = this.repo.getByUsername(username)
    if (!rec || rec.enabled === false) return null
    if (!verifyPassword(password, rec.password_hash)) return null
    const next = { ...rec, last_login_at: nowIso(), updated_at: rec.updated_at }
    this.repo.update(next)
    return publicUserView(next)
  }

  create({
    username,
    password,
    role = 'user',
    enabled = true,
    concurrency = 0,
    rpm_limit = 0,
    restrict_public_groups = true,
    groups,
    actor = 'system',
    actorId = null,
  } = {}) {
    const name = assertUsername(username)
    if (this.repo.getByUsername(name)) {
      const err = new Error('用户名已存在')
      err.code = 'username_exists'
      throw err
    }
    const rec = {
      id: crypto.randomUUID(),
      username: name,
      password_hash: hashPassword(assertPassword(password)),
      role: assertRole(role),
      parent_user_id: actorIdOf(actorId, this.repo),
      enabled: enabled !== false,
      concurrency: integer(concurrency, 0, 1000, 'concurrency'),
      rpm_limit: integer(rpm_limit, 0, 1000000, 'rpm_limit'),
      restrict_public_groups,
      created_at: nowIso(),
      updated_at: nowIso(),
      last_login_at: null,
    }
    return withTransaction(this.db, () => {
      const created = this.repo.insert(rec)
      const groupRepo = new GroupsRepo(this.db)
      if (groups !== undefined) groupRepo.setGrants(rec.id, groups, actor)
      else groupRepo.inheritGrants(rec.id, actor)
      return created
    })
  }

  update(id, patch = {}, { actorId = null } = {}) {
    const rec = this.repo.getById(id)
    if (!rec) return null
    const next = { ...rec }

    if (patch.role != null) {
      const role = assertRole(patch.role)
      if (rec.role === 'super_admin' && role !== 'super_admin' && this.countEnabledAdmins() <= 1) {
        const err = new Error('不能取消最后一个管理员')
        err.code = 'last_admin'
        throw err
      }
      next.role = role
    }

    if (patch.enabled != null) {
      const enabled = !!patch.enabled
      if (rec.role === 'super_admin' && rec.enabled && !enabled && this.countEnabledAdmins() <= 1) {
        const err = new Error('不能停用最后一个管理员')
        err.code = 'last_admin'
        throw err
      }
      if (actorId && actorId === rec.id && !enabled) {
        const err = new Error('不能停用当前登录账号')
        err.code = 'self_disable'
        throw err
      }
      next.enabled = enabled
    }

    if (patch.password != null && String(patch.password) !== '') {
      next.password_hash = hashPassword(assertPassword(patch.password))
    }

    if (patch.concurrency != null) next.concurrency = integer(patch.concurrency, 0, 1000, 'concurrency')
    if (patch.rpm_limit != null) next.rpm_limit = integer(patch.rpm_limit, 0, 1000000, 'rpm_limit')
    if (patch.restrict_public_groups != null) next.restrict_public_groups = patch.restrict_public_groups === true

    next.updated_at = nowIso()
    return withTransaction(this.db, () => {
      if (rec.role !== next.role && next.role === 'admin') {
        if (rec.balance_micros !== 0)
          throw Object.assign(new Error('请先结清个人余额，再变更为管理员'), { code: 'wallet_role_conflict' })
        if (!next.admin_domain_id) {
          next.admin_domain_id = id
          this.db
            .prepare('INSERT OR IGNORE INTO admin_domains(id,created_by_user_id) VALUES(?,?)')
            .run(id, rec.parent_user_id)
        }
      }
      const updated = this.repo.update(next)
      const groups = new GroupsRepo(this.db)
      if (Object.hasOwn(patch, 'groups')) groups.setGrants(id, patch.groups, actorId || 'system')
      else if (rec.role !== next.role && next.role === 'admin') groups.inheritGrants(id, actorId || 'system')
      return updated
    })
  }

  remove(id, { actorId = null } = {}) {
    const rec = this.repo.getById(id)
    if (!rec) return false
    if (actorId && actorId === rec.id) {
      const err = new Error('不能删除当前登录账号')
      err.code = 'self_delete'
      throw err
    }
    if (rec.role === 'super_admin' && rec.enabled && this.countEnabledAdmins() <= 1) {
      const err = new Error('不能删除最后一个管理员')
      err.code = 'last_admin'
      throw err
    }
    // Validate deletion first; a failed slot write must leave the user available for retry.
    return this.repo.remove(id)
  }
}
