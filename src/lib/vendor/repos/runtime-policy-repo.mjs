// 供应商运行时准入策略的仓储：SQL 原样自 vendor-runtime-policy.mjs 迁入，调用方注入数据库句柄。

export function accountResource(db, id) {
  return db.prepare("SELECT * FROM vendor_resources WHERE id=? AND resource_type='account'").get(id)
}

export function vmGroupMemberships(db, vmId) {
  return db
    .prepare(`SELECT r.group_id,g.platform,g.models_json,g.status,g.deleted_at,
    EXISTS(SELECT 1 FROM group_resources other WHERE other.group_id=r.group_id AND other.resource_kind NOT IN ('vm','gateway_worker_account')) AS mixed_kind
    FROM group_resources r LEFT JOIN groups g ON g.id=r.group_id WHERE r.resource_kind='vm' AND r.resource_id=?`)
    .all(vmId)
}

export function activeGroupNames(db) {
  return db.prepare("SELECT id,name FROM groups WHERE deleted_at IS NULL AND status='active'").all()
}

export function proxyStatus(db, id, vendorId) {
  return db
    .prepare("SELECT status FROM vendor_resources WHERE id=? AND vendor_id=? AND resource_type='proxy'")
    .get(id, vendorId)
}
