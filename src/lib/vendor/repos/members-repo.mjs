/**
 * 供应商成员仓储：vendor_members 及其登录账号（users 中的供应商相关读写）。
 * db 由调用方注入，经 DbClient 异步访问（R6 B4），返回原始行或语句结果；业务判断留在调用方。
 */

/** 当前用户的有效供应商身份（主身份优先）。 */
import { dbClient } from '../../db/db-client.mjs'

export async function findActiveMemberVendor(db, userId) {
  return dbClient(db).one(
    `
        SELECT v.*, vm.id AS member_id, vm.user_id
        FROM vendor_members vm
        JOIN vendors v ON v.id = vm.vendor_id
        JOIN users u ON u.id=vm.user_id
        WHERE vm.user_id = ? AND vm.status = 'active' AND v.status = 'active' AND v.deleted_at IS NULL
          AND u.role='vendor' AND u.status='active' AND u.deleted_at IS NULL
        ORDER BY vm.is_primary DESC, vm.created_at ASC LIMIT 1
      `,
    userId,
  )
}

/** 用户当前主供应商（不校验用户角色）。 */
export async function findPrimaryActiveVendor(db, userId) {
  return dbClient(db).one(
    `SELECT v.id FROM vendor_members vm JOIN vendors v ON v.id = vm.vendor_id
                  WHERE vm.user_id = ? AND vm.status = 'active' AND v.status = 'active' AND v.deleted_at IS NULL
                  ORDER BY vm.is_primary DESC, vm.created_at ASC, vm.id ASC LIMIT 1`,
    userId,
  )
}

export async function findMemberLoginUser(db, userId) {
  return dbClient(db).one('SELECT id,username,email FROM users WHERE id=? AND deleted_at IS NULL', userId)
}

export async function findUsernameTaken(db, username) {
  return dbClient(db).one('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE AND deleted_at IS NULL', username)
}

export async function insertVendorLoginUser(db, userId, email, username, passwordHash, createdAt, updatedAt) {
  return dbClient(db).run(
    "INSERT INTO users (id,email,username,password_hash,role,status,created_at,updated_at) VALUES (?,?,?,?,'vendor','active',?,?)",
    userId,
    email,
    username,
    passwordHash,
    createdAt,
    updatedAt,
  )
}

export async function findMemberUserState(db, userId) {
  return dbClient(db).one('SELECT role,status FROM users WHERE id = ? AND deleted_at IS NULL', userId)
}

export async function findUserRole(db, userId) {
  return dbClient(db).one('SELECT role FROM users WHERE id=? AND deleted_at IS NULL', userId)
}

export async function findOtherVendorMembership(db, userId, vendorId) {
  return dbClient(db).one(
    "SELECT 1 FROM vendor_members WHERE user_id=? AND vendor_id<>? AND status='active'",
    userId,
    vendorId,
  )
}

export async function findActiveMembership(db, userId) {
  return dbClient(db).one("SELECT 1 FROM vendor_members WHERE user_id=? AND status='active'", userId)
}

export async function promoteUserToVendor(db, updatedAt, userId) {
  return dbClient(db).run(
    "UPDATE users SET role = 'vendor', updated_at = ? WHERE id = ? AND role = 'user'",
    updatedAt,
    userId,
  )
}

export async function upsertActiveMember(db, memberId, userId, vendorId, createdBy, createdAt, updatedAt) {
  return dbClient(db).run(
    `
      INSERT INTO vendor_members (id,user_id,vendor_id,status,is_primary,created_by,created_at,updated_at)
      VALUES (?,?,?,'active',1,?,?,?)
      ON CONFLICT(user_id,vendor_id) DO UPDATE SET status='active', updated_at=excluded.updated_at
    `,
    memberId,
    userId,
    vendorId,
    createdBy,
    createdAt,
    updatedAt,
  )
}

export async function revokeUserMemberships(db, updatedAt, userId) {
  return dbClient(db).run(
    "UPDATE vendor_members SET status = 'revoked', updated_at = ? WHERE user_id = ?",
    updatedAt,
    userId,
  )
}

export async function listActiveMemberLogins(db) {
  return dbClient(db).many(`SELECT m.vendor_id,u.id,u.username FROM vendor_members m JOIN users u ON u.id=m.user_id
    WHERE m.status='active' AND u.deleted_at IS NULL ORDER BY m.is_primary DESC,m.created_at,m.id`)
}

export async function listActiveMemberUserIds(db, vendorId) {
  return dbClient(db).many("SELECT user_id FROM vendor_members WHERE vendor_id=? AND status='active'", vendorId)
}

export async function listUserVendorMemberships(db, userId) {
  return dbClient(db).many(
    `SELECT m.vendor_id FROM vendor_members m JOIN vendors v ON v.id=m.vendor_id
    WHERE m.user_id=? AND m.status='active' AND v.deleted_at IS NULL`,
    userId,
  )
}
