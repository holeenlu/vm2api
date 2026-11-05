/**
 * 供应商资源仓储：vendor_resources（账号、虚拟机、代理），以及账号建档时写入的 group_resources。
 * db 由调用方注入，返回原始行或语句结果；行映射、业务判断与事务边界留在调用方。
 * 部分查询只有 SQL 空白不同（如 `id = ?` 与 `id=?`），按原调用处原样保留为不同函数。
 */

export function getResource(db, resourceId) {
  return db.prepare('SELECT * FROM vendor_resources WHERE id = ?').get(resourceId)
}

export function getResourceRow(db, resourceId) {
  return db.prepare('SELECT * FROM vendor_resources WHERE id=?').get(resourceId)
}

export function getResourceSecretJson(db, resourceId) {
  return db.prepare('SELECT secret_json FROM vendor_resources WHERE id=?').get(resourceId)
}

export function getVendorResourceConfig(db, resourceId, vendorId) {
  return db.prepare('SELECT config_json FROM vendor_resources WHERE id=? AND vendor_id=?').get(resourceId, vendorId)
}

export function getProxyResourceVendor(db, resourceId) {
  return db.prepare("SELECT vendor_id FROM vendor_resources WHERE id=? AND resource_type='proxy'").get(resourceId)
}

export function getResourceVendorByType(db, resourceId, resourceType) {
  return db
    .prepare('SELECT vendor_id FROM vendor_resources WHERE id=? AND resource_type=?')
    .get(resourceId, resourceType)
}

export function getAccountResourceStatus(db, resourceId) {
  return db.prepare("SELECT status FROM vendor_resources WHERE id=? AND resource_type='account'").get(resourceId)
}

export function getVendorProxyResource(db, resourceId, vendorId) {
  return db
    .prepare("SELECT * FROM vendor_resources WHERE id=? AND vendor_id=? AND resource_type='proxy'")
    .get(resourceId, vendorId)
}

export function getAccountByExternalId(db, vendorId, externalId) {
  return db
    .prepare("SELECT * FROM vendor_resources WHERE vendor_id = ? AND resource_type = 'account' AND external_id = ?")
    .get(vendorId, externalId)
}

export function getVendorVmResource(db, resourceId, vendorId) {
  return db
    .prepare("SELECT * FROM vendor_resources WHERE id = ? AND vendor_id = ? AND resource_type = 'vm'")
    .get(resourceId, vendorId)
}

export function listLiveVendorProxies(db, vendorId) {
  return db
    .prepare("SELECT * FROM vendor_resources WHERE vendor_id=? AND resource_type='proxy' AND status <> 'archived'")
    .all(vendorId)
}

export function countLiveResources(db, scope, resourceType) {
  return db
    .prepare(`SELECT COUNT(*) AS n FROM vendor_resources
        WHERE vendor_id IN (${scope.map(() => '?').join(',')}) AND resource_type=? AND status<>'archived'`)
    .get(...scope, resourceType)
}

export function listResourcesByVendors(db, ids, resourceType, includeArchived) {
  return db
    .prepare(
      `SELECT * FROM vendor_resources WHERE vendor_id IN (${ids.map(() => '?').join(',')}) AND resource_type = ? ${includeArchived ? '' : "AND status <> 'archived'"} ORDER BY created_at DESC`,
    )
    .all(...ids, resourceType)
}

/** 超管资源列表：账号含已归档，其余类型排除已归档。 */
export function listAdminResources(db, type, ids) {
  return db
    .prepare(`SELECT r.* FROM vendor_resources r WHERE r.resource_type=? ${type === 'account' ? '' : "AND r.status<>'archived'"}
    AND r.vendor_id IN (${ids.map(() => '?').join(',') || 'NULL'}) ORDER BY r.created_at DESC,r.id`)
    .all(type, ...ids)
}

export function countLiveResourcesByVendorType(db) {
  return db
    .prepare(`SELECT vendor_id,resource_type,COUNT(*) AS n FROM vendor_resources
    WHERE status<>'archived' GROUP BY vendor_id,resource_type`)
    .all()
}

export function insertResource(
  db,
  resourceId,
  vendorId,
  resourceType,
  name,
  externalId,
  status,
  configJson,
  secretJson,
  createdBy,
  createdAt,
  updatedAt,
) {
  return db
    .prepare(
      `INSERT INTO vendor_resources (id,vendor_id,resource_type,name,external_id,status,config_json,secret_json,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      resourceId,
      vendorId,
      resourceType,
      name,
      externalId,
      status,
      configJson,
      secretJson,
      createdBy,
      createdAt,
      updatedAt,
    )
}

export function updateResourceConfigStamped(db, configJson, updatedAt, resourceId) {
  return db
    .prepare('UPDATE vendor_resources SET config_json = ?, updated_at = ? WHERE id = ?')
    .run(configJson, updatedAt, resourceId)
}

export function setResourceConfig(db, configJson, resourceId) {
  return db.prepare('UPDATE vendor_resources SET config_json=? WHERE id=?').run(configJson, resourceId)
}

export function setResourceSecret(db, secretJson, resourceId) {
  return db.prepare('UPDATE vendor_resources SET secret_json=? WHERE id=?').run(secretJson, resourceId)
}

export function setResourceNameConfig(db, name, configJson, resourceId) {
  return db.prepare('UPDATE vendor_resources SET name=?,config_json=? WHERE id=?').run(name, configJson, resourceId)
}

export function setResourceNameConfigStamped(db, name, configJson, updatedAt, resourceId) {
  return db
    .prepare('UPDATE vendor_resources SET name=?,config_json=?,updated_at=? WHERE id=?')
    .run(name, configJson, updatedAt, resourceId)
}

export function setPairName(db, name, firstId, secondId) {
  return db.prepare('UPDATE vendor_resources SET name=? WHERE id IN (?,?)').run(name, firstId, secondId)
}

export function activateResource(db, resourceId) {
  return db.prepare("UPDATE vendor_resources SET status='active' WHERE id=?").run(resourceId)
}

export function activateResourceStamped(db, updatedAt, resourceId) {
  return db.prepare("UPDATE vendor_resources SET status='active',updated_at=? WHERE id=?").run(updatedAt, resourceId)
}

export function setResourceProvisioning(db, updatedAt, resourceId) {
  return db
    .prepare("UPDATE vendor_resources SET status='provisioning',updated_at=? WHERE id=?")
    .run(updatedAt, resourceId)
}

export function setPairProvisioning(db, updatedAt, firstId, secondId) {
  return db
    .prepare("UPDATE vendor_resources SET status='provisioning',updated_at=? WHERE id IN (?,?)")
    .run(updatedAt, firstId, secondId)
}

export function setPairStatus(db, status, updatedAt, firstId, secondId) {
  return db
    .prepare('UPDATE vendor_resources SET status=?,updated_at=? WHERE id IN (?,?)')
    .run(status, updatedAt, firstId, secondId)
}

export function updateProxyResourceRow(db, name, status, configJson, secretJson, updatedAt, archivedAt, resourceId) {
  return db
    .prepare(
      'UPDATE vendor_resources SET name=?,status=?,config_json=?,secret_json=?,updated_at=?,archived_at=? WHERE id=?',
    )
    .run(name, status, configJson, secretJson, updatedAt, archivedAt, resourceId)
}

export function updateResourceRow(db, name, status, configJson, updatedAt, archivedAt, resourceId) {
  return db
    .prepare(
      'UPDATE vendor_resources SET name = ?, status = ?, config_json = ?, updated_at = ?, archived_at = ? WHERE id = ?',
    )
    .run(name, status, configJson, updatedAt, archivedAt, resourceId)
}

/** 同步配对资源（账号 ↔ 虚拟机）的状态，已归档的不动。 */
export function updatePairedResourceStatus(db, status, updatedAt, archivedAt, pairedId, vendorId) {
  return db
    .prepare(
      "UPDATE vendor_resources SET status=?,updated_at=?,archived_at=? WHERE id=? AND vendor_id=? AND status<>'archived'",
    )
    .run(status, updatedAt, archivedAt, pairedId, vendorId)
}

/** Gateway Worker 账号建档时挂入所选分组。 */
export function insertGatewayAccountGroup(db, groupId, resourceKind, resourceId, priority) {
  return db
    .prepare(`INSERT OR IGNORE INTO group_resources(group_id,resource_kind,resource_id,priority) VALUES(?,?,?,?)`)
    .run(groupId, resourceKind, resourceId, priority)
}

/** 供应商未归档的虚拟机及其配对账号配置。 */
export function listLiveVmAccountPairs(db, vendorId) {
  return db
    .prepare(`SELECT vm.config_json,a.config_json AS account_config_json FROM vendor_resources vm
      JOIN vendor_resources a ON a.id=json_extract(vm.config_json,'$.account_resource_id') AND a.vendor_id=vm.vendor_id
      WHERE vm.vendor_id=? AND vm.resource_type='vm' AND vm.status<>'archived'
        AND a.resource_type='account' AND a.status<>'archived'`)
    .all(vendorId)
}

/** 待按授权邮箱命名的未归档供应商账号（须与运行时虚拟机配对）。 */
export function findAuthorizationNamedAccount(db, accountResourceId, runtimeVmId) {
  return db
    .prepare(`SELECT a.id,a.config_json FROM vendor_resources a
    JOIN vendor_resources v ON v.id=json_extract(a.config_json,'$.vm_resource_id')
      AND v.vendor_id=a.vendor_id AND v.resource_type='vm'
    WHERE a.id=? AND a.resource_type='account' AND a.status<>'archived' AND v.status<>'archived'
      AND json_extract(v.config_json,'$.runtime_vm_id')=?`)
    .get(accountResourceId, runtimeVmId)
}

export function findSupplierRuntimeVm(db, runtimeVmId) {
  return db
    .prepare(
      "SELECT 1 FROM vendor_resources WHERE resource_type='vm' AND json_extract(config_json,'$.runtime_vm_id')=?",
    )
    .get(runtimeVmId)
}

export function findRuntimeVmVendor(db, runtimeVmId) {
  return db
    .prepare(
      "SELECT vendor_id FROM vendor_resources WHERE resource_type='vm' AND json_extract(config_json,'$.runtime_vm_id')=?",
    )
    .get(runtimeVmId)
}

/** 单台运行时虚拟机所属供应商（未归档资源，新建优先）。 */
export function findLiveRuntimeVmVendor(db, runtimeVmId) {
  return db
    .prepare(
      `SELECT vendor_id FROM vendor_resources WHERE resource_type='vm' AND status<>'archived'
        AND json_extract(config_json,'$.runtime_vm_id')=? ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(runtimeVmId)
}

/** 运行时虚拟机所属供应商（未归档资源，新建优先）。 */
export function listRuntimeVmVendors(db, ids) {
  return db
    .prepare(`
        SELECT json_extract(r.config_json, '$.runtime_vm_id') AS runtime_vm_id,
               r.vendor_id,
               v.name AS vendor_name
        FROM vendor_resources r
        JOIN vendors v ON v.id = r.vendor_id AND v.deleted_at IS NULL
        WHERE r.resource_type='vm'
          AND r.status <> 'archived'
          AND json_extract(r.config_json, '$.runtime_vm_id') IN (${ids.map(() => '?').join(',')})
        ORDER BY r.created_at DESC, r.id DESC
      `)
    .all(...ids)
}

/** 授权完成后回写账号名称（为空则保留）、配置与加密凭据。 */
export function updateAuthorizedAccount(db, name, configJson, secretJson, updatedAt, resourceId) {
  return db
    .prepare('UPDATE vendor_resources SET name=COALESCE(?,name),config_json=?,secret_json=?,updated_at=? WHERE id=?')
    .run(name, configJson, secretJson, updatedAt, resourceId)
}
