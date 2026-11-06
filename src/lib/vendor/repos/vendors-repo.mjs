/**
 * 供应商主体仓储：vendors、vendor_capabilities、vendor_execution_policies。
 * 只放 SQL，返回原始行或语句结果；行映射与业务判断留在调用方。db 由调用方注入，经 DbClient 异步访问（R6 B4）。
 */
import { dbClient } from '../../db/db-client.mjs'

const GET_VENDOR_ROW_SQL = 'SELECT * FROM vendors WHERE id = ? AND deleted_at IS NULL'

export async function getVendorRow(db, vendorId) {
  return dbClient(db).one(GET_VENDOR_ROW_SQL, vendorId)
}

export async function listEnabledCapabilities(db, vendorId) {
  return dbClient(db).many(
    'SELECT capability FROM vendor_capabilities WHERE vendor_id = ? AND enabled = 1 ORDER BY capability',
    vendorId,
  )
}

/** 直属下级 id（与 listChildIds 仅 SQL 空白不同，原样保留）。 */
export async function listChildVendorIds(db, parentId) {
  return dbClient(db).many('SELECT id FROM vendors WHERE parent_id = ? AND deleted_at IS NULL', parentId)
}

export async function listChildIds(db, parentId) {
  return dbClient(db).many('SELECT id FROM vendors WHERE parent_id=? AND deleted_at IS NULL', parentId)
}

export async function countChildVendors(db, parentId) {
  return dbClient(db).one('SELECT COUNT(*) AS count FROM vendors WHERE parent_id = ? AND deleted_at IS NULL', parentId)
}

export async function findChildVendor(db, vendorId, parentId) {
  return dbClient(db).one('SELECT 1 FROM vendors WHERE id = ? AND parent_id = ?', vendorId, parentId)
}

export async function listVendorsByIds(db, ids) {
  return dbClient(db).many(
    `SELECT * FROM vendors WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY tier, name`,
    ...ids,
  )
}

export async function listLiveVendorIds(db) {
  return dbClient(db).many('SELECT id FROM vendors WHERE deleted_at IS NULL')
}

export async function listLiveVendorRemarks(db) {
  return dbClient(db).many('SELECT id,remark FROM vendors WHERE deleted_at IS NULL ORDER BY tier,name,id')
}

export async function listVendorOptions(db) {
  return dbClient(db).many('SELECT id, name, tier FROM vendors WHERE deleted_at IS NULL ORDER BY tier, name')
}

export async function insertRootVendor(
  db,
  vendorId,
  name,
  externalCode,
  email,
  rootId,
  groupsJson,
  platformsJson,
  accountLimit,
  proxyLimit,
  childLimit,
  createdBy,
  createdAt,
  updatedAt,
) {
  return dbClient(db).run(
    `
        INSERT INTO vendors
          (id,name,external_code,email,tier,parent_id,root_id,status,groups_json,platforms_json,account_limit,proxy_limit,child_limit,created_by,created_at,updated_at)
        VALUES (?, ?, ?, ?, 1, NULL, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    vendorId,
    name,
    externalCode,
    email,
    rootId,
    groupsJson,
    platformsJson,
    accountLimit,
    proxyLimit,
    childLimit,
    createdBy,
    createdAt,
    updatedAt,
  )
}

export async function insertChildVendor(
  db,
  vendorId,
  name,
  externalCode,
  email,
  parentId,
  rootId,
  groupsJson,
  platformsJson,
  accountLimit,
  proxyLimit,
  createdBy,
  createdAt,
  updatedAt,
) {
  return dbClient(db).run(
    `
        INSERT INTO vendors (id,name,external_code,email,tier,parent_id,root_id,status,groups_json,platforms_json,account_limit,proxy_limit,child_limit,created_by,created_at,updated_at)
        VALUES (?, ?, ?, ?, 2, ?, ?, 'active', ?, ?, ?, ?, 0, ?, ?, ?)
      `,
    vendorId,
    name,
    externalCode,
    email,
    parentId,
    rootId,
    groupsJson,
    platformsJson,
    accountLimit,
    proxyLimit,
    createdBy,
    createdAt,
    updatedAt,
  )
}

export async function updateVendorAdmin(
  db,
  status,
  groupsJson,
  platformsJson,
  accountLimit,
  proxyLimit,
  childLimit,
  remark,
  updatedAt,
  vendorId,
) {
  return dbClient(db).run(
    `UPDATE vendors SET status=?,groups_json=?,platforms_json=?,account_limit=?,proxy_limit=?,child_limit=?,remark=?,policy_revision=policy_revision+1,updated_at=? WHERE id=?`,
    status,
    groupsJson,
    platformsJson,
    accountLimit,
    proxyLimit,
    childLimit,
    remark,
    updatedAt,
    vendorId,
  )
}

export async function grantCapability(db, vendorId, capability, createdAt, updatedAt) {
  return dbClient(db).run(
    'INSERT OR REPLACE INTO vendor_capabilities (vendor_id,capability,enabled,revision,created_at,updated_at) VALUES (?,?,1,1,?,?)',
    vendorId,
    capability,
    createdAt,
    updatedAt,
  )
}

export async function upsertCapability(db, vendorId, capability, enabled, createdAt, updatedAt) {
  return dbClient(db).run(
    `INSERT INTO vendor_capabilities (vendor_id,capability,enabled,revision,created_at,updated_at)
        VALUES (?,?,?,1,?,?) ON CONFLICT(vendor_id,capability) DO UPDATE SET enabled=excluded.enabled,revision=revision+1,updated_at=excluded.updated_at`,
    vendorId,
    capability,
    enabled,
    createdAt,
    updatedAt,
  )
}

/** Gateway Worker 开户策略：本级优先，其次父级。 */
export async function findGatewayCreatePolicy(db, vendorId, fallbackVendorId, preferredVendorId) {
  return dbClient(db).one(
    `SELECT allow_create FROM vendor_execution_policies WHERE vendor_id IN (?,?) AND platform='openai' AND execution_kind='gateway_worker' ORDER BY vendor_id=? DESC LIMIT 1`,
    vendorId,
    fallbackVendorId,
    preferredVendorId,
  )
}

/** Gateway Worker 运行控制策略：本级优先，其次父级。 */
export async function findGatewayRuntimePolicy(db, vendorId, fallbackVendorId, preferredVendorId) {
  return dbClient(db).one(
    "SELECT allow_runtime FROM vendor_execution_policies WHERE vendor_id IN (?,?) AND platform='openai' AND execution_kind='gateway_worker' ORDER BY vendor_id=? DESC LIMIT 1",
    vendorId,
    fallbackVendorId,
    preferredVendorId,
  )
}
