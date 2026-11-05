// 中转分组路由与操作审计的仓储：SQL 原样自 relay-routes.mjs / relay-common.mjs 迁入，调用方注入数据库句柄并负责事务边界。

export function insertOperationAudit(db, actor, action, target, beforeJson, afterJson, reason, createdAt) {
  return db
    .prepare(
      'INSERT INTO operation_audit (actor,action,target,before_json,after_json,reason,created_at) VALUES (?,?,?,?,?,?,?)',
    )
    .run(actor, action, target, beforeJson, afterJson, reason, createdAt)
}

export function insertGroupResource(db, groupId, resourceKind, resourceId, priority) {
  return db
    .prepare('INSERT INTO group_resources(group_id,resource_kind,resource_id,priority) VALUES(?,?,?,?)')
    .run(groupId, resourceKind, resourceId, priority)
}

/** Gateway Worker 账号由账号页绑定，这里只清除 VM / API 端点成员。 */
export function deleteNonGatewayGroupResources(db, groupId) {
  return db
    .prepare("DELETE FROM group_resources WHERE group_id=? AND resource_kind<>'gateway_worker_account'")
    .run(groupId)
}

export function bumpGroupVersion(db, updatedAt, id) {
  return db.prepare('UPDATE groups SET version=version+1,updated_at=? WHERE id=?').run(updatedAt, id)
}

export function walletLedgerOwner(db, id) {
  return db.prepare('SELECT user_id FROM wallet_ledger WHERE id=?').get(id)
}
