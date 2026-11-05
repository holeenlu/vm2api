/**
 * 供应商账号可用分组的查询：groups、group_resources。db 由调用方注入，返回原始行。
 */

/** 只含虚拟机 / Gateway Worker 账号资源的有效分组。 */
export function listAccountEligibleGroups(db) {
  return db
    .prepare(
      "SELECT g.id,g.name,g.platform,g.models_json FROM groups g WHERE g.deleted_at IS NULL AND g.status='active' AND NOT EXISTS (SELECT 1 FROM group_resources r WHERE r.group_id=g.id AND r.resource_kind NOT IN ('vm','gateway_worker_account')) ORDER BY g.sort_order,g.id",
    )
    .all()
}

export function listLiveGroupIds(db) {
  return db.prepare('SELECT id FROM groups WHERE deleted_at IS NULL').all()
}

export function listVmGroupIds(db, runtimeVmId) {
  return db.prepare("SELECT group_id FROM group_resources WHERE resource_kind='vm' AND resource_id=?").all(runtimeVmId)
}
