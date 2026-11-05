// VM 批量编辑回执的仓储：SQL 原样自 vm-bulk-edit.mjs 迁入，调用方注入数据库句柄并负责事务边界。

export function vmBulkEditById(db, id) {
  return db.prepare('SELECT * FROM vm_bulk_edits WHERE id=?').get(id)
}

export function updateVmBulkEditReport(db, reportJson, updatedAt, id) {
  return db.prepare('UPDATE vm_bulk_edits SET report_json=?,updated_at=? WHERE id=?').run(reportJson, updatedAt, id)
}

export function insertVmBulkEdit(db, id, actor, requestHash, reportJson, updatedAt) {
  return db
    .prepare('INSERT INTO vm_bulk_edits(id,actor,request_hash,report_json,updated_at) VALUES(?,?,?,?,?)')
    .run(id, actor, requestHash, reportJson, updatedAt)
}
