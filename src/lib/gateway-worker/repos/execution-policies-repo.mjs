/**
 * 供应商执行权限策略（vendor_execution_policies）的数据访问。
 */

export function listVendorExecutionPolicies(db, ...params) {
  return db
    .prepare('SELECT * FROM vendor_execution_policies WHERE vendor_id=? ORDER BY platform,execution_kind')
    .all(...params)
}

export function upsertVendorExecutionPolicy(db, ...params) {
  return db
    .prepare(
      `INSERT INTO vendor_execution_policies(vendor_id,platform,execution_kind,allow_create,allow_runtime,revision,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(vendor_id,platform,execution_kind) DO UPDATE SET allow_create=excluded.allow_create,allow_runtime=excluded.allow_runtime,revision=vendor_execution_policies.revision+1,updated_by=excluded.updated_by,updated_at=excluded.updated_at`,
    )
    .run(...params)
}

export function getVendorExecutionPolicy(db, ...params) {
  return db
    .prepare('SELECT * FROM vendor_execution_policies WHERE vendor_id=? AND platform=? AND execution_kind=?')
    .get(...params)
}
