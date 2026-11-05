/**
 * 供应商成员仓储：vendor_members 及其登录账号（users 中的供应商相关读写）。
 * db 由调用方注入，返回原始行或语句结果；业务判断留在调用方。
 */

/** 当前用户的有效供应商身份（主身份优先）。 */
export function findActiveMemberVendor(db, userId) {
  return db
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
    .get(userId)
}

/** 用户当前主供应商（不校验用户角色）。 */
export function findPrimaryActiveVendor(db, userId) {
  return db
    .prepare(`SELECT v.id FROM vendor_members vm JOIN vendors v ON v.id = vm.vendor_id
                  WHERE vm.user_id = ? AND vm.status = 'active' AND v.status = 'active' AND v.deleted_at IS NULL
                  ORDER BY vm.is_primary DESC, vm.created_at ASC, vm.id ASC LIMIT 1`)
    .get(userId)
}

export function findMemberLoginUser(db, userId) {
  return db.prepare('SELECT id,username,email FROM users WHERE id=? AND deleted_at IS NULL').get(userId)
}

export function findUsernameTaken(db, username) {
  return db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE AND deleted_at IS NULL').get(username)
}

export function insertVendorLoginUser(db, userId, email, username, passwordHash, createdAt, updatedAt) {
  return db
    .prepare(
      "INSERT INTO users (id,email,username,password_hash,role,status,created_at,updated_at) VALUES (?,?,?,?,'vendor','active',?,?)",
    )
    .run(userId, email, username, passwordHash, createdAt, updatedAt)
}

export function findMemberUserState(db, userId) {
  return db.prepare('SELECT role,status FROM users WHERE id = ? AND deleted_at IS NULL').get(userId)
}

export function findUserRole(db, userId) {
  return db.prepare('SELECT role FROM users WHERE id=? AND deleted_at IS NULL').get(userId)
}

export function findOtherVendorMembership(db, userId, vendorId) {
  return db
    .prepare("SELECT 1 FROM vendor_members WHERE user_id=? AND vendor_id<>? AND status='active'")
    .get(userId, vendorId)
}

export function findActiveMembership(db, userId) {
  return db.prepare("SELECT 1 FROM vendor_members WHERE user_id=? AND status='active'").get(userId)
}

export function promoteUserToVendor(db, updatedAt, userId) {
  return db
    .prepare("UPDATE users SET role = 'vendor', updated_at = ? WHERE id = ? AND role = 'user'")
    .run(updatedAt, userId)
}

export function upsertActiveMember(db, memberId, userId, vendorId, createdBy, createdAt, updatedAt) {
  return db
    .prepare(
      `
      INSERT INTO vendor_members (id,user_id,vendor_id,status,is_primary,created_by,created_at,updated_at)
      VALUES (?,?,?,'active',1,?,?,?)
      ON CONFLICT(user_id,vendor_id) DO UPDATE SET status='active', updated_at=excluded.updated_at
    `,
    )
    .run(memberId, userId, vendorId, createdBy, createdAt, updatedAt)
}

export function revokeUserMemberships(db, updatedAt, userId) {
  return db
    .prepare("UPDATE vendor_members SET status = 'revoked', updated_at = ? WHERE user_id = ?")
    .run(updatedAt, userId)
}

export function listActiveMemberLogins(db) {
  return db
    .prepare(`SELECT m.vendor_id,u.id,u.username FROM vendor_members m JOIN users u ON u.id=m.user_id
    WHERE m.status='active' AND u.deleted_at IS NULL ORDER BY m.is_primary DESC,m.created_at,m.id`)
    .all()
}

export function listActiveMemberUserIds(db, vendorId) {
  return db.prepare("SELECT user_id FROM vendor_members WHERE vendor_id=? AND status='active'").all(vendorId)
}

export function listUserVendorMemberships(db, userId) {
  return db
    .prepare(`SELECT m.vendor_id FROM vendor_members m JOIN vendors v ON v.id=m.vendor_id
    WHERE m.user_id=? AND m.status='active' AND v.deleted_at IS NULL`)
    .all(userId)
}
