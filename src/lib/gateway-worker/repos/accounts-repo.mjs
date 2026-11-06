/**
 * Gateway Worker 账号相关的数据访问（vendor_resources 账号行、绑定、代理、分组成员、刷新租约代次）。只做数据访问，SQL 与参数和原调用处逐字一致；规则与事务在调用方。
 * 经 DbClient 异步访问（R6 B5）。
 */
import { dbClient } from '../../db/db-client.mjs'

export async function vendorById(db, id) {
  return dbClient(db).one('SELECT * FROM vendors WHERE id=?', id)
}

export async function groupHasOtherResources(db, groupId) {
  return dbClient(db).one(
    "SELECT 1 FROM group_resources WHERE group_id=? AND resource_kind NOT IN ('vm','gateway_worker_account') LIMIT 1",
    groupId,
  )
}

export async function listPlatformProxies(db) {
  return dbClient(db).many(
    "SELECT id,name,host,port FROM proxies WHERE enabled=1 AND vendor_id IS NULL AND protocol<>'local' ORDER BY name,id",
  )
}

export async function activeSupplierProxy(db, id) {
  return dbClient(db).one("SELECT * FROM vendor_resources WHERE id=? AND resource_type='proxy' AND status='active'", id)
}

export async function enabledPlatformProxy(db, id) {
  return dbClient(db).one('SELECT * FROM proxies WHERE id=? AND enabled=1 AND vendor_id IS NULL', id)
}

/** 同一归属（平台为 NULL，或某供应商）下按外部编号找已有账号，用于草稿幂等。 */
export async function accountByOwnerExternalId(db, vendorId, externalId) {
  return dbClient(db).one(
    'SELECT id FROM vendor_resources WHERE vendor_id IS ? AND external_id=?',
    vendorId,
    externalId,
  )
}

/** 供应商建号后由授权结果补全名称、状态、配置与代理密文。 */
export async function updateOwnedAccountAuthorized(db, name, status, configJson, secretJson, updatedAt, id) {
  return dbClient(db).run(
    'UPDATE vendor_resources SET name=?,status=?,config_json=?,secret_json=?,updated_at=? WHERE id=?',
    name,
    status,
    configJson,
    secretJson,
    updatedAt,
    id,
  )
}

export async function leaseCredentialRevision(db, accountResourceId, grantKind) {
  return dbClient(db).one(
    'SELECT credential_revision FROM credential_refresh_leases WHERE account_resource_id=? AND grant_kind=?',
    accountResourceId,
    grantKind,
  )
}

export async function insertPlatformAccount(
  db,
  id,
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
    "INSERT INTO vendor_resources(id,vendor_id,resource_type,name,external_id,status,config_json,secret_json,created_by,created_at,updated_at) VALUES(?,NULL,'account',?,?,?,?,?,?,?,?)",
    id,
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

// 清除绑定上的 BPS 终态（403 停用、恢复探测、冷却、失效/过期）：手动解除与写入新 BPS 授权时使用，
// Worker 已同步清除，不等下一次心跳覆盖
export async function clearBpsState(db, accountResourceId) {
  return dbClient(db).run(
    'UPDATE gateway_worker_account_bindings SET bps_state=NULL,bps_error=NULL,bps_blocked_at=NULL,bps_recovery=NULL,bps_next_probe_at=NULL,bps_cooldown_until=NULL WHERE account_resource_id=?',
    accountResourceId,
  )
}

export async function stopBpsRecovery(db, accountResourceId) {
  return dbClient(db).run(
    "UPDATE gateway_worker_account_bindings SET bps_recovery='stopped',bps_next_probe_at=NULL WHERE account_resource_id=? AND bps_state='blocked'",
    accountResourceId,
  )
}

export async function deleteBpsRefreshLease(db, accountResourceId) {
  return dbClient(db).run(
    "DELETE FROM credential_refresh_leases WHERE account_resource_id=? AND grant_kind='bps'",
    accountResourceId,
  )
}

/** 账号永久删除：各授权类别的刷新租约一并删除。 */
export async function deleteRefreshLeases(db, accountResourceId) {
  return dbClient(db).run('DELETE FROM credential_refresh_leases WHERE account_resource_id=?', accountResourceId)
}

export async function updateAccountRecord(db, name, status, configJson, secretJson, archivedAt, updatedAt, id) {
  return dbClient(db).run(
    'UPDATE vendor_resources SET name=?,status=?,config_json=?,secret_json=?,archived_at=?,updated_at=? WHERE id=?',
    name,
    status,
    configJson,
    secretJson,
    archivedAt,
    updatedAt,
    id,
  )
}

export async function activeBpsGrantAccounts(db) {
  return dbClient(db).many(
    `SELECT id,config_json FROM vendor_resources WHERE status='active' AND config_json LIKE '%"bps_grant"%'`,
  )
}

export async function groupHasGatewayAccounts(db, groupId) {
  return dbClient(db).one(
    `SELECT 1 FROM group_resources WHERE group_id=? AND resource_kind='gateway_worker_account' LIMIT 1`,
    groupId,
  )
}

export async function groupHasVms(db, groupId) {
  return dbClient(db).one(`SELECT 1 FROM group_resources WHERE group_id=? AND resource_kind='vm' LIMIT 1`, groupId)
}

export async function activeGroupAccountConfigs(db, groupId) {
  return dbClient(db).many(
    `SELECT r.config_json FROM group_resources g JOIN vendor_resources r ON r.id=g.resource_id
           WHERE g.group_id=? AND g.resource_kind='gateway_worker_account' AND r.status='active'`,
    groupId,
  )
}

export async function recordBindingCredentialSeen(
  db,
  credentialRevision,
  credentialRevisionAgain,
  projectionStatus,
  lastSeenAt,
  updatedAt,
  accountResourceId,
  gatewayInstanceId,
) {
  return dbClient(db).run(
    'UPDATE gateway_worker_account_bindings SET credential_revision=CASE WHEN ? > credential_revision THEN ? ELSE credential_revision END,projection_status=?,last_seen_at=?,updated_at=? WHERE account_resource_id=? AND gateway_instance_id=?',
    credentialRevision,
    credentialRevisionAgain,
    projectionStatus,
    lastSeenAt,
    updatedAt,
    accountResourceId,
    gatewayInstanceId,
  )
}

/**
 * 记下 Worker 生成的账号安装身份（Gateway 事实直读 G2）：只在账号还没有时写入，之后不变。
 * 安装身份用于出站关联 ID 隔离，事实直读后由控制面持有，Worker 数据目录丢失也不会变。
 */
export async function recordAccountInstallationId(db, id, installationId) {
  return dbClient(db).run(
    `UPDATE vendor_resources SET config_json=json_set(config_json,'$.installation_id',?)
     WHERE id=? AND resource_type='account' AND json_extract(config_json,'$.installation_id') IS NULL`,
    installationId,
    id,
  )
}
