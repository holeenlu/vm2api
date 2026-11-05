/**
 * 供应商主体仓储：vendors、vendor_capabilities、vendor_execution_policies。
 * 只放 SQL，返回原始行或语句结果；行映射与业务判断留在调用方。db 由调用方注入。
 */

export function getVendorRow(db, vendorId) {
  return db.prepare('SELECT * FROM vendors WHERE id = ? AND deleted_at IS NULL').get(vendorId)
}

export function listEnabledCapabilities(db, vendorId) {
  return db
    .prepare('SELECT capability FROM vendor_capabilities WHERE vendor_id = ? AND enabled = 1 ORDER BY capability')
    .all(vendorId)
}

/** 直属下级 id（与 listChildIds 仅 SQL 空白不同，原样保留）。 */
export function listChildVendorIds(db, parentId) {
  return db.prepare('SELECT id FROM vendors WHERE parent_id = ? AND deleted_at IS NULL').all(parentId)
}

export function listChildIds(db, parentId) {
  return db.prepare('SELECT id FROM vendors WHERE parent_id=? AND deleted_at IS NULL').all(parentId)
}

export function countChildVendors(db, parentId) {
  return db.prepare('SELECT COUNT(*) AS count FROM vendors WHERE parent_id = ? AND deleted_at IS NULL').get(parentId)
}

export function findChildVendor(db, vendorId, parentId) {
  return db.prepare('SELECT 1 FROM vendors WHERE id = ? AND parent_id = ?').get(vendorId, parentId)
}

export function listVendorsByIds(db, ids) {
  return db
    .prepare(`SELECT * FROM vendors WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY tier, name`)
    .all(...ids)
}

export function listLiveVendorIds(db) {
  return db.prepare('SELECT id FROM vendors WHERE deleted_at IS NULL').all()
}

export function listLiveVendorRemarks(db) {
  return db.prepare('SELECT id,remark FROM vendors WHERE deleted_at IS NULL ORDER BY tier,name,id').all()
}

export function listVendorOptions(db) {
  return db.prepare('SELECT id, name, tier FROM vendors WHERE deleted_at IS NULL ORDER BY tier, name').all()
}

export function insertRootVendor(
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
  return db
    .prepare(
      `
        INSERT INTO vendors
          (id,name,external_code,email,tier,parent_id,root_id,status,groups_json,platforms_json,account_limit,proxy_limit,child_limit,created_by,created_at,updated_at)
        VALUES (?, ?, ?, ?, 1, NULL, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(
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

export function insertChildVendor(
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
  return db
    .prepare(
      `
        INSERT INTO vendors (id,name,external_code,email,tier,parent_id,root_id,status,groups_json,platforms_json,account_limit,proxy_limit,child_limit,created_by,created_at,updated_at)
        VALUES (?, ?, ?, ?, 2, ?, ?, 'active', ?, ?, ?, ?, 0, ?, ?, ?)
      `,
    )
    .run(
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

export function updateVendorAdmin(
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
  return db
    .prepare(
      `UPDATE vendors SET status=?,groups_json=?,platforms_json=?,account_limit=?,proxy_limit=?,child_limit=?,remark=?,policy_revision=policy_revision+1,updated_at=? WHERE id=?`,
    )
    .run(status, groupsJson, platformsJson, accountLimit, proxyLimit, childLimit, remark, updatedAt, vendorId)
}

export function grantCapability(db, vendorId, capability, createdAt, updatedAt) {
  return db
    .prepare(
      'INSERT OR REPLACE INTO vendor_capabilities (vendor_id,capability,enabled,revision,created_at,updated_at) VALUES (?,?,1,1,?,?)',
    )
    .run(vendorId, capability, createdAt, updatedAt)
}

export function upsertCapability(db, vendorId, capability, enabled, createdAt, updatedAt) {
  return db
    .prepare(`INSERT INTO vendor_capabilities (vendor_id,capability,enabled,revision,created_at,updated_at)
        VALUES (?,?,?,1,?,?) ON CONFLICT(vendor_id,capability) DO UPDATE SET enabled=excluded.enabled,revision=revision+1,updated_at=excluded.updated_at`)
    .run(vendorId, capability, enabled, createdAt, updatedAt)
}

/** Gateway Worker 开户策略：本级优先，其次父级。 */
export function findGatewayCreatePolicy(db, vendorId, fallbackVendorId, preferredVendorId) {
  return db
    .prepare(
      `SELECT allow_create FROM vendor_execution_policies WHERE vendor_id IN (?,?) AND platform='openai' AND execution_kind='gateway_worker' ORDER BY vendor_id=? DESC LIMIT 1`,
    )
    .get(vendorId, fallbackVendorId, preferredVendorId)
}

/** Gateway Worker 运行控制策略：本级优先，其次父级。 */
export function findGatewayRuntimePolicy(db, vendorId, fallbackVendorId, preferredVendorId) {
  return db
    .prepare(
      "SELECT allow_runtime FROM vendor_execution_policies WHERE vendor_id IN (?,?) AND platform='openai' AND execution_kind='gateway_worker' ORDER BY vendor_id=? DESC LIMIT 1",
    )
    .get(vendorId, fallbackVendorId, preferredVendorId)
}
