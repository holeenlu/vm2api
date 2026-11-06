/**
 * 供应商资源仓储：vendor_resources（账号、虚拟机、代理），以及账号建档时写入的 group_resources。
 * db 由调用方注入，经 DbClient 异步访问（R6 B4），返回原始行或语句结果；行映射、业务判断与事务边界留在调用方。
 * 部分查询只有 SQL 空白不同（如 `id = ?` 与 `id=?`），按原调用处原样保留为不同函数。
 */
import { dbClient } from '../../db/db-client.mjs'

/** 按 ID 查资源（排除已永久删除的墓碑，查找即 404）。 */
export async function getResource(db, resourceId) {
  return dbClient(db).one('SELECT * FROM vendor_resources WHERE id = ? AND deleted_at IS NULL', resourceId)
}

/** 原始行（含墓碑）：只用于写入后回读投影与删除流程本身。 */
export async function getResourceRow(db, resourceId) {
  return dbClient(db).one('SELECT * FROM vendor_resources WHERE id=?', resourceId)
}

const GET_RESOURCE_SECRET_JSON_SQL = 'SELECT secret_json FROM vendor_resources WHERE id=?'

export async function getResourceSecretJson(db, resourceId) {
  return dbClient(db).one(GET_RESOURCE_SECRET_JSON_SQL, resourceId)
}

export async function getVendorResourceConfig(db, resourceId, vendorId) {
  return dbClient(db).one(
    'SELECT config_json FROM vendor_resources WHERE id=? AND vendor_id=? AND deleted_at IS NULL',
    resourceId,
    vendorId,
  )
}

export async function getProxyResourceVendor(db, resourceId) {
  return dbClient(db).one("SELECT vendor_id FROM vendor_resources WHERE id=? AND resource_type='proxy'", resourceId)
}

export async function getResourceVendorByType(db, resourceId, resourceType) {
  return dbClient(db).one(
    'SELECT vendor_id FROM vendor_resources WHERE id=? AND resource_type=? AND deleted_at IS NULL',
    resourceId,
    resourceType,
  )
}

export async function getAccountResourceStatus(db, resourceId) {
  return dbClient(db).one("SELECT status FROM vendor_resources WHERE id=? AND resource_type='account'", resourceId)
}

export async function getVendorProxyResource(db, resourceId, vendorId) {
  return dbClient(db).one(
    "SELECT * FROM vendor_resources WHERE id=? AND vendor_id=? AND resource_type='proxy'",
    resourceId,
    vendorId,
  )
}

export async function getAccountByExternalId(db, vendorId, externalId) {
  return dbClient(db).one(
    "SELECT * FROM vendor_resources WHERE vendor_id = ? AND resource_type = 'account' AND external_id = ?",
    vendorId,
    externalId,
  )
}

const GET_VENDOR_VM_RESOURCE_SQL =
  "SELECT * FROM vendor_resources WHERE id = ? AND vendor_id = ? AND resource_type = 'vm' AND deleted_at IS NULL"

export async function getVendorVmResource(db, resourceId, vendorId) {
  return dbClient(db).one(GET_VENDOR_VM_RESOURCE_SQL, resourceId, vendorId)
}

export async function listLiveVendorProxies(db, vendorId) {
  return dbClient(db).many(
    "SELECT * FROM vendor_resources WHERE vendor_id=? AND resource_type='proxy' AND status <> 'archived'",
    vendorId,
  )
}

export async function countLiveResources(db, scope, resourceType) {
  return dbClient(db).one(
    `SELECT COUNT(*) AS n FROM vendor_resources
        WHERE vendor_id IN (${scope.map(() => '?').join(',')}) AND resource_type=? AND status<>'archived'`,
    ...scope,
    resourceType,
  )
}

export async function listResourcesByVendors(db, ids, resourceType, includeArchived) {
  return dbClient(db).many(
    `SELECT * FROM vendor_resources WHERE vendor_id IN (${ids.map(() => '?').join(',')}) AND resource_type = ? AND deleted_at IS NULL ${includeArchived ? '' : "AND status <> 'archived'"} ORDER BY created_at DESC`,
    ...ids,
    resourceType,
  )
}

/** 超管资源列表：账号含已归档，其余类型排除已归档；永久删除的墓碑都不列出。 */
export async function listAdminResources(db, type, ids) {
  return dbClient(db).many(
    `SELECT r.* FROM vendor_resources r WHERE r.resource_type=? AND r.deleted_at IS NULL ${type === 'account' ? '' : "AND r.status<>'archived'"}
    AND r.vendor_id IN (${ids.map(() => '?').join(',') || 'NULL'}) ORDER BY r.created_at DESC,r.id`,
    type,
    ...ids,
  )
}

export async function countLiveResourcesByVendorType(db) {
  return dbClient(db).many(`SELECT vendor_id,resource_type,COUNT(*) AS n FROM vendor_resources
    WHERE status<>'archived' GROUP BY vendor_id,resource_type`)
}

export async function insertResource(
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
  return dbClient(db).run(
    `INSERT INTO vendor_resources (id,vendor_id,resource_type,name,external_id,status,config_json,secret_json,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
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

const UPDATE_RESOURCE_CONFIG_STAMPED_SQL = 'UPDATE vendor_resources SET config_json = ?, updated_at = ? WHERE id = ?'

export async function updateResourceConfigStamped(db, configJson, updatedAt, resourceId) {
  return dbClient(db).run(UPDATE_RESOURCE_CONFIG_STAMPED_SQL, configJson, updatedAt, resourceId)
}

export async function setResourceConfig(db, configJson, resourceId) {
  return dbClient(db).run('UPDATE vendor_resources SET config_json=? WHERE id=?', configJson, resourceId)
}

export async function setResourceSecret(db, secretJson, resourceId) {
  return dbClient(db).run('UPDATE vendor_resources SET secret_json=? WHERE id=?', secretJson, resourceId)
}

export async function setResourceNameConfig(db, name, configJson, resourceId) {
  return dbClient(db).run('UPDATE vendor_resources SET name=?,config_json=? WHERE id=?', name, configJson, resourceId)
}

const SET_RESOURCE_NAME_CONFIG_STAMPED_SQL = 'UPDATE vendor_resources SET name=?,config_json=?,updated_at=? WHERE id=?'

export async function setResourceNameConfigStamped(db, name, configJson, updatedAt, resourceId) {
  return dbClient(db).run(SET_RESOURCE_NAME_CONFIG_STAMPED_SQL, name, configJson, updatedAt, resourceId)
}

export async function setPairName(db, name, firstId, secondId) {
  return dbClient(db).run('UPDATE vendor_resources SET name=? WHERE id IN (?,?)', name, firstId, secondId)
}

export async function activateResource(db, resourceId) {
  return dbClient(db).run("UPDATE vendor_resources SET status='active' WHERE id=?", resourceId)
}

export async function activateResourceStamped(db, updatedAt, resourceId) {
  return dbClient(db).run("UPDATE vendor_resources SET status='active',updated_at=? WHERE id=?", updatedAt, resourceId)
}

export async function setResourceProvisioning(db, updatedAt, resourceId) {
  return dbClient(db).run(
    "UPDATE vendor_resources SET status='provisioning',updated_at=? WHERE id=?",
    updatedAt,
    resourceId,
  )
}

export async function setPairProvisioning(db, updatedAt, firstId, secondId) {
  return dbClient(db).run(
    "UPDATE vendor_resources SET status='provisioning',updated_at=? WHERE id IN (?,?)",
    updatedAt,
    firstId,
    secondId,
  )
}

export async function setPairStatus(db, status, updatedAt, firstId, secondId) {
  return dbClient(db).run(
    'UPDATE vendor_resources SET status=?,updated_at=? WHERE id IN (?,?)',
    status,
    updatedAt,
    firstId,
    secondId,
  )
}

export async function updateProxyResourceRow(
  db,
  name,
  status,
  configJson,
  secretJson,
  updatedAt,
  archivedAt,
  resourceId,
) {
  return dbClient(db).run(
    'UPDATE vendor_resources SET name=?,status=?,config_json=?,secret_json=?,updated_at=?,archived_at=? WHERE id=?',
    name,
    status,
    configJson,
    secretJson,
    updatedAt,
    archivedAt,
    resourceId,
  )
}

export async function updateResourceRow(db, name, status, configJson, updatedAt, archivedAt, resourceId) {
  return dbClient(db).run(
    'UPDATE vendor_resources SET name = ?, status = ?, config_json = ?, updated_at = ?, archived_at = ? WHERE id = ?',
    name,
    status,
    configJson,
    updatedAt,
    archivedAt,
    resourceId,
  )
}

/** 同步配对资源（账号 ↔ 虚拟机）的状态，已归档的不动。 */
export async function updatePairedResourceStatus(db, status, updatedAt, archivedAt, pairedId, vendorId) {
  return dbClient(db).run(
    "UPDATE vendor_resources SET status=?,updated_at=?,archived_at=? WHERE id=? AND vendor_id=? AND status<>'archived'",
    status,
    updatedAt,
    archivedAt,
    pairedId,
    vendorId,
  )
}

/** Gateway Worker 账号建档时挂入所选分组。 */
export async function insertGatewayAccountGroup(db, groupId, resourceKind, resourceId, priority) {
  return dbClient(db).run(
    `INSERT OR IGNORE INTO group_resources(group_id,resource_kind,resource_id,priority) VALUES(?,?,?,?)`,
    groupId,
    resourceKind,
    resourceId,
    priority,
  )
}

/** 供应商未归档的虚拟机及其配对账号配置。 */
export async function listLiveVmAccountPairs(db, vendorId) {
  return dbClient(db).many(
    `SELECT vm.config_json,a.config_json AS account_config_json FROM vendor_resources vm
      JOIN vendor_resources a ON a.id=json_extract(vm.config_json,'$.account_resource_id') AND a.vendor_id=vm.vendor_id
      WHERE vm.vendor_id=? AND vm.resource_type='vm' AND vm.status<>'archived'
        AND a.resource_type='account' AND a.status<>'archived'`,
    vendorId,
  )
}

const FIND_AUTHORIZATION_NAMED_ACCOUNT_SQL = `SELECT a.id,a.config_json FROM vendor_resources a
    JOIN vendor_resources v ON v.id=json_extract(a.config_json,'$.vm_resource_id')
      AND v.vendor_id=a.vendor_id AND v.resource_type='vm'
    WHERE a.id=? AND a.resource_type='account' AND a.status<>'archived' AND v.status<>'archived'
      AND json_extract(v.config_json,'$.runtime_vm_id')=?`

/** 待按授权邮箱命名的未归档供应商账号（须与运行时虚拟机配对）。 */
export async function findAuthorizationNamedAccount(db, accountResourceId, runtimeVmId) {
  return dbClient(db).one(FIND_AUTHORIZATION_NAMED_ACCOUNT_SQL, accountResourceId, runtimeVmId)
}

const FIND_SUPPLIER_RUNTIME_VM_SQL =
  "SELECT 1 FROM vendor_resources WHERE resource_type='vm' AND deleted_at IS NULL AND json_extract(config_json,'$.runtime_vm_id')=?"

export async function findSupplierRuntimeVm(db, runtimeVmId) {
  return dbClient(db).one(FIND_SUPPLIER_RUNTIME_VM_SQL, runtimeVmId)
}

const FIND_RUNTIME_VM_VENDOR_SQL =
  "SELECT vendor_id FROM vendor_resources WHERE resource_type='vm' AND deleted_at IS NULL AND json_extract(config_json,'$.runtime_vm_id')=?"

export async function findRuntimeVmVendor(db, runtimeVmId) {
  return dbClient(db).one(FIND_RUNTIME_VM_VENDOR_SQL, runtimeVmId)
}

/** 单台运行时虚拟机所属供应商（未归档资源，新建优先）。 */
export async function findLiveRuntimeVmVendor(db, runtimeVmId) {
  return dbClient(db).one(
    `SELECT vendor_id FROM vendor_resources WHERE resource_type='vm' AND status<>'archived'
        AND json_extract(config_json,'$.runtime_vm_id')=? ORDER BY created_at DESC, id DESC LIMIT 1`,
    runtimeVmId,
  )
}

/** 运行时虚拟机所属供应商（未归档资源，新建优先）。 */
export async function listRuntimeVmVendors(db, ids) {
  return dbClient(db).many(
    `
        SELECT json_extract(r.config_json, '$.runtime_vm_id') AS runtime_vm_id,
               r.vendor_id,
               v.name AS vendor_name,
               (SELECT json_extract(a.config_json, '$.vendor_notes') FROM vendor_resources a
                 WHERE a.resource_type='account' AND a.status<>'archived' AND a.vendor_id=r.vendor_id
                   AND json_extract(a.config_json, '$.vm_resource_id')=r.id
                 ORDER BY a.created_at DESC, a.id DESC LIMIT 1) AS vendor_notes
        FROM vendor_resources r
        JOIN vendors v ON v.id = r.vendor_id AND v.deleted_at IS NULL
        WHERE r.resource_type='vm'
          AND r.status <> 'archived'
          AND json_extract(r.config_json, '$.runtime_vm_id') IN (${ids.map(() => '?').join(',')})
        ORDER BY r.created_at DESC, r.id DESC
      `,
    ...ids,
  )
}

/** 授权完成后回写账号名称（为空则保留）、配置与加密凭据。 */
export async function updateAuthorizedAccount(db, name, configJson, secretJson, updatedAt, resourceId) {
  return dbClient(db).run(
    'UPDATE vendor_resources SET name=COALESCE(?,name),config_json=?,secret_json=?,updated_at=? WHERE id=?',
    name,
    configJson,
    secretJson,
    updatedAt,
    resourceId,
  )
}

/**
 * 运行时虚拟机对应的供应商账号 / 虚拟机资源对（含已归档，排除墓碑）。删除供应商自有 VM 时据此一并删除资源对，
 * 不留下指向已删除 VM 的孤儿记录。
 */
export async function findVmPairByRuntimeVm(db, runtimeVmId) {
  return dbClient(db).one(
    `SELECT vm.id AS vm_resource_id,vm.vendor_id,json_extract(vm.config_json,'$.account_resource_id') AS account_resource_id
       FROM vendor_resources vm
      WHERE vm.resource_type='vm' AND vm.deleted_at IS NULL AND json_extract(vm.config_json,'$.runtime_vm_id')=?
      ORDER BY vm.created_at DESC, vm.id DESC LIMIT 1`,
    runtimeVmId,
  )
}

/**
 * 永久删除写墓碑：状态置为 archived（保留首次归档时间）、写 deleted_at，清空凭据密文与外部编号（释放幂等键，
 * 同一来源可重新开户）；config_json 由调用方去掉凭据字段后传入。已是墓碑的行不再改写。
 */
export async function tombstoneResource(db, configJson, deletedAt, resourceId) {
  return dbClient(db).run(
    `UPDATE vendor_resources SET status='archived',archived_at=COALESCE(archived_at,?),deleted_at=?,
        secret_json=NULL,external_id=NULL,config_json=?,updated_at=? WHERE id=? AND deleted_at IS NULL`,
    deletedAt,
    deletedAt,
    configJson,
    deletedAt,
    resourceId,
  )
}
