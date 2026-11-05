// VM 批量编辑回执的仓储：SQL 原样自 vm-bulk-edit.mjs 迁入，调用方注入数据库句柄并负责事务边界。
// 经 DbClient 异步访问（R6 B6c）。
import { dbClient } from '../../db/db-client.mjs'

export async function vmBulkEditById(db, id) {
  return dbClient(db).one('SELECT * FROM vm_bulk_edits WHERE id=?', id)
}

export async function updateVmBulkEditReport(db, reportJson, updatedAt, id) {
  return dbClient(db).run('UPDATE vm_bulk_edits SET report_json=?,updated_at=? WHERE id=?', reportJson, updatedAt, id)
}

export async function insertVmBulkEdit(db, id, actor, requestHash, reportJson, updatedAt) {
  return dbClient(db).run(
    'INSERT INTO vm_bulk_edits(id,actor,request_hash,report_json,updated_at) VALUES(?,?,?,?,?)',
    id,
    actor,
    requestHash,
    reportJson,
    updatedAt,
  )
}
