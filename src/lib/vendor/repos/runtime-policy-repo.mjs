// 供应商运行时准入策略的仓储：SQL 原样自 vendor-runtime-policy.mjs 迁入，调用方注入数据库句柄；经 DbClient 异步访问（R6 B4）。
import { dbClient } from '../../db/db-client.mjs'

const ACCOUNT_RESOURCE_SQL =
  "SELECT * FROM vendor_resources WHERE id=? AND resource_type='account' AND deleted_at IS NULL"

export async function accountResource(db, id) {
  return dbClient(db).one(ACCOUNT_RESOURCE_SQL, id)
}

const VM_GROUP_MEMBERSHIPS_SQL = `SELECT r.group_id,g.platform,g.models_json,g.status,g.deleted_at,
    EXISTS(SELECT 1 FROM group_resources other WHERE other.group_id=r.group_id AND other.resource_kind NOT IN ('vm','gateway_worker_account')) AS mixed_kind
    FROM group_resources r LEFT JOIN groups g ON g.id=r.group_id WHERE r.resource_kind='vm' AND r.resource_id=?`

export async function vmGroupMemberships(db, vmId) {
  return dbClient(db).many(VM_GROUP_MEMBERSHIPS_SQL, vmId)
}

const ACTIVE_GROUP_NAMES_SQL = "SELECT id,name FROM groups WHERE deleted_at IS NULL AND status='active'"

export async function activeGroupNames(db) {
  return dbClient(db).many(ACTIVE_GROUP_NAMES_SQL)
}

const PROXY_STATUS_SQL = "SELECT status FROM vendor_resources WHERE id=? AND vendor_id=? AND resource_type='proxy'"

export async function proxyStatus(db, id, vendorId) {
  return dbClient(db).one(PROXY_STATUS_SQL, id, vendorId)
}
