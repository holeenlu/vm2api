/**
 * 供应商执行权限策略（vendor_execution_policies）的数据访问。经 DbClient 异步访问（R6 B5）。
 */
import { dbClient } from '../../db/db-client.mjs'

export async function listVendorExecutionPolicies(db, vendorId) {
  return dbClient(db).many(
    'SELECT * FROM vendor_execution_policies WHERE vendor_id=? ORDER BY platform,execution_kind',
    vendorId,
  )
}

export async function upsertVendorExecutionPolicy(
  db,
  vendorId,
  platform,
  executionKind,
  allowCreate,
  allowRuntime,
  revision,
  updatedBy,
  createdAt,
  updatedAt,
) {
  return dbClient(db).run(
    `INSERT INTO vendor_execution_policies(vendor_id,platform,execution_kind,allow_create,allow_runtime,revision,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(vendor_id,platform,execution_kind) DO UPDATE SET allow_create=excluded.allow_create,allow_runtime=excluded.allow_runtime,revision=vendor_execution_policies.revision+1,updated_by=excluded.updated_by,updated_at=excluded.updated_at`,
    vendorId,
    platform,
    executionKind,
    allowCreate,
    allowRuntime,
    revision,
    updatedBy,
    createdAt,
    updatedAt,
  )
}

export async function getVendorExecutionPolicy(db, vendorId, platform, executionKind) {
  return dbClient(db).one(
    'SELECT * FROM vendor_execution_policies WHERE vendor_id=? AND platform=? AND execution_kind=?',
    vendorId,
    platform,
    executionKind,
  )
}
