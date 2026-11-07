/**
 * 后台用户管理的定制查询：用户列表的供应商身份、管理员域、资料邮箱查重。
 * db 由调用方注入，经 DbClient 异步访问（R6 B6b），返回原始行或语句结果。
 */
import { dbClient } from '../../db/db-client.mjs'
import { dbTime } from '../../../shared/system-time.mjs'

/** 有效供应商成员（含是否可开下级），按主身份优先排序。 */
export async function listActiveVendorMemberships(db) {
  return dbClient(db).many(
    `
            SELECT vm.user_id, v.id AS vendor_id, v.name AS vendor_name, v.tier AS vendor_tier,
              v.child_limit AS vendor_child_limit,
              EXISTS(SELECT 1 FROM vendor_capabilities vc
                WHERE vc.vendor_id = v.id AND vc.capability = 'vendor.create_child' AND vc.enabled = 1
              ) AS vendor_create_child
            FROM vendor_members vm
            JOIN vendors v ON v.id = vm.vendor_id
            WHERE vm.status = 'active' AND v.status = 'active' AND v.deleted_at IS NULL
            ORDER BY vm.is_primary DESC, vm.created_at ASC, vm.id ASC
          `,
  )
}

// 066 的列默认值写 UTC-Z；显式传入 UTC+8 存储形式，不为改默认值重建表
const nowPair = () => {
  const at = dbTime()
  return [at, at]
}

export async function insertAdminDomain(db, domainId, createdByUserId) {
  return dbClient(db).run(
    'INSERT OR IGNORE INTO admin_domains(id,created_by_user_id,created_at,updated_at) VALUES(?,?,?,?)',
    domainId,
    createdByUserId,
    ...nowPair(),
  )
}

export async function findOtherUserByEmail(db, email, userId) {
  return dbClient(db).one(
    'SELECT id FROM users WHERE email=? COLLATE NOCASE AND id<>? AND deleted_at IS NULL',
    email,
    userId,
  )
}
