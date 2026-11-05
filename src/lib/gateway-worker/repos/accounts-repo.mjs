/**
 * Gateway Worker 账号相关的数据访问（vendor_resources 账号行、绑定、代理、分组成员、刷新租约代次）。只做数据访问，SQL 与参数和原调用处逐字一致；规则与事务在调用方。
 */

export function vendorById(db, id) {
  return db.prepare('SELECT * FROM vendors WHERE id=?').get(id)
}

export function groupHasOtherResources(db, groupId) {
  return db
    .prepare(
      "SELECT 1 FROM group_resources WHERE group_id=? AND resource_kind NOT IN ('vm','gateway_worker_account') LIMIT 1",
    )
    .get(groupId)
}

export function listPlatformProxies(db) {
  return db
    .prepare(
      "SELECT id,name,host,port FROM proxies WHERE enabled=1 AND vendor_id IS NULL AND protocol<>'local' ORDER BY name,id",
    )
    .all()
}

export function activeSupplierProxy(db, id) {
  return db.prepare("SELECT * FROM vendor_resources WHERE id=? AND resource_type='proxy' AND status='active'").get(id)
}

export function enabledPlatformProxy(db, id) {
  return db.prepare('SELECT * FROM proxies WHERE id=? AND enabled=1 AND vendor_id IS NULL').get(id)
}

/** 同一归属（平台为 NULL，或某供应商）下按外部编号找已有账号，用于草稿幂等。 */
export function accountByOwnerExternalId(db, vendorId, externalId) {
  return db.prepare('SELECT id FROM vendor_resources WHERE vendor_id IS ? AND external_id=?').get(vendorId, externalId)
}

/** 供应商建号后由授权结果补全名称、状态、配置与代理密文。 */
export function updateOwnedAccountAuthorized(db, name, status, configJson, secretJson, updatedAt, id) {
  return db
    .prepare('UPDATE vendor_resources SET name=?,status=?,config_json=?,secret_json=?,updated_at=? WHERE id=?')
    .run(name, status, configJson, secretJson, updatedAt, id)
}

export function leaseCredentialRevision(db, accountResourceId, grantKind) {
  return db
    .prepare('SELECT credential_revision FROM credential_refresh_leases WHERE account_resource_id=? AND grant_kind=?')
    .get(accountResourceId, grantKind)
}

export function insertPlatformAccount(
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
  return db
    .prepare(
      "INSERT INTO vendor_resources(id,vendor_id,resource_type,name,external_id,status,config_json,secret_json,created_by,created_at,updated_at) VALUES(?,NULL,'account',?,?,?,?,?,?,?,?)",
    )
    .run(id, name, externalId, status, configJson, secretJson, createdBy, createdAt, updatedAt)
}

export function clearBpsBlock(db, accountResourceId) {
  return db
    .prepare(
      'UPDATE gateway_worker_account_bindings SET bps_state=NULL,bps_error=NULL,bps_blocked_at=NULL,bps_recovery=NULL,bps_next_probe_at=NULL,bps_cooldown_until=NULL WHERE account_resource_id=?',
    )
    .run(accountResourceId)
}

export function stopBpsRecovery(db, accountResourceId) {
  return db
    .prepare(
      "UPDATE gateway_worker_account_bindings SET bps_recovery='stopped',bps_next_probe_at=NULL WHERE account_resource_id=? AND bps_state='blocked'",
    )
    .run(accountResourceId)
}

export function deleteBpsRefreshLease(db, accountResourceId) {
  return db
    .prepare("DELETE FROM credential_refresh_leases WHERE account_resource_id=? AND grant_kind='bps'")
    .run(accountResourceId)
}

export function updateAccountRecord(db, name, status, configJson, secretJson, archivedAt, updatedAt, id) {
  return db
    .prepare(
      'UPDATE vendor_resources SET name=?,status=?,config_json=?,secret_json=?,archived_at=?,updated_at=? WHERE id=?',
    )
    .run(name, status, configJson, secretJson, archivedAt, updatedAt, id)
}

export function markBindingsProjectionPending(db, projectionRevision, updatedAt, accountResourceId) {
  return db
    .prepare(
      "UPDATE gateway_worker_account_bindings SET projection_status='pending',projection_revision=?,updated_at=? WHERE account_resource_id=?",
    )
    .run(projectionRevision, updatedAt, accountResourceId)
}

export function activeBpsGrantAccounts(db) {
  return db
    .prepare(`SELECT id,config_json FROM vendor_resources WHERE status='active' AND config_json LIKE '%"bps_grant"%'`)
    .all()
}

export function groupHasGatewayAccounts(db, groupId) {
  return db
    .prepare(`SELECT 1 FROM group_resources WHERE group_id=? AND resource_kind='gateway_worker_account' LIMIT 1`)
    .get(groupId)
}

export function groupHasVms(db, groupId) {
  return db.prepare(`SELECT 1 FROM group_resources WHERE group_id=? AND resource_kind='vm' LIMIT 1`).get(groupId)
}

export function activeGroupAccountConfigs(db, groupId) {
  return db
    .prepare(`SELECT r.config_json FROM group_resources g JOIN vendor_resources r ON r.id=g.resource_id
           WHERE g.group_id=? AND g.resource_kind='gateway_worker_account' AND r.status='active'`)
    .all(groupId)
}

export function recordBindingCredentialSeen(
  db,
  credentialRevision,
  credentialRevisionAgain,
  projectionStatus,
  lastSeenAt,
  updatedAt,
  accountResourceId,
  gatewayInstanceId,
) {
  return db
    .prepare(
      'UPDATE gateway_worker_account_bindings SET credential_revision=CASE WHEN ? > credential_revision THEN ? ELSE credential_revision END,projection_status=?,last_seen_at=?,updated_at=? WHERE account_resource_id=? AND gateway_instance_id=?',
    )
    .run(
      credentialRevision,
      credentialRevisionAgain,
      projectionStatus,
      lastSeenAt,
      updatedAt,
      accountResourceId,
      gatewayInstanceId,
    )
}

export function setAccountStatus(db, status, updatedAt, id) {
  return db.prepare('UPDATE vendor_resources SET status=?,updated_at=? WHERE id=?').run(status, updatedAt, id)
}

export function proxyById(db, id) {
  return db.prepare('SELECT * FROM proxies WHERE id=?').get(id)
}
