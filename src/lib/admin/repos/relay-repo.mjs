// 中转分组路由与操作审计的仓储：SQL 原样自 relay-routes.mjs / relay-common.mjs 迁入，调用方注入数据库句柄并负责事务边界。
// 经 DbClient 异步执行（R6 B6b）。
import { dbClient } from '../../db/db-client.mjs'

const INSERT_OPERATION_AUDIT_SQL =
  'INSERT INTO operation_audit (actor,action,target,before_json,after_json,reason,created_at) VALUES (?,?,?,?,?,?,?)'

export async function insertOperationAudit(db, actor, action, target, beforeJson, afterJson, reason, createdAt) {
  return dbClient(db).run(INSERT_OPERATION_AUDIT_SQL, actor, action, target, beforeJson, afterJson, reason, createdAt)
}

export async function insertGroupResource(db, groupId, resourceKind, resourceId, priority) {
  return dbClient(db).run(
    'INSERT INTO group_resources(group_id,resource_kind,resource_id,priority) VALUES(?,?,?,?)',
    groupId,
    resourceKind,
    resourceId,
    priority,
  )
}

/** 分组页「管理资源」整体替换成员（VM、API 端点与 Gateway 账号）前清空该分组的全部成员。 */
export async function deleteGroupResources(db, groupId) {
  return dbClient(db).run('DELETE FROM group_resources WHERE group_id=?', groupId)
}

/** 竞态 R18：按读到的分组版本条件递增；changes=0 表示分组已被并发修改。 */
export async function bumpGroupVersion(db, updatedAt, id, expectedVersion) {
  return dbClient(db).run(
    'UPDATE groups SET version=version+1,updated_at=? WHERE id=? AND version=?',
    updatedAt,
    id,
    expectedVersion,
  )
}

export async function walletLedgerOwner(db, id) {
  return dbClient(db).one('SELECT user_id FROM wallet_ledger WHERE id=?', id)
}
