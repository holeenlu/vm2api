/**
 * 供应商 Gateway Worker 账号的投影绑定与 OAuth 会话：gateway_worker_account_bindings、gateway_worker_oauth_sessions。
 * db 由调用方注入，经 DbClient 异步访问（R6 B4），返回原始行或语句结果。
 */
import { dbClient } from '../../db/db-client.mjs'

export async function upsertAccountBinding(
  db,
  bindingId,
  accountResourceId,
  gatewayInstanceId,
  runtimeAccountId,
  credentialRevision,
  projectionStatus,
  lastSeenAt,
  createdAt,
  updatedAt,
) {
  return dbClient(db).run(
    `INSERT INTO gateway_worker_account_bindings(id,account_resource_id,gateway_instance_id,runtime_account_id,credential_revision,projection_status,last_seen_at,created_at,updated_at) VALUES(?,?,?,?,?, ?,?,?,?) ON CONFLICT(account_resource_id,gateway_instance_id) DO UPDATE SET runtime_account_id=excluded.runtime_account_id,credential_revision=excluded.credential_revision,projection_status=excluded.projection_status,last_seen_at=excluded.last_seen_at,updated_at=excluded.updated_at`,
    bindingId,
    accountResourceId,
    gatewayInstanceId,
    runtimeAccountId,
    credentialRevision,
    projectionStatus,
    lastSeenAt,
    createdAt,
    updatedAt,
  )
}

export async function markAccountBindingsDrifted(db, updatedAt, accountResourceId) {
  return dbClient(db).run(
    "UPDATE gateway_worker_account_bindings SET projection_status='drifted',updated_at=? WHERE account_resource_id=?",
    updatedAt,
    accountResourceId,
  )
}

export async function setBindingProjectionStatus(db, projectionStatus, updatedAt, bindingId) {
  return dbClient(db).run(
    'UPDATE gateway_worker_account_bindings SET projection_status=?,updated_at=? WHERE id=?',
    projectionStatus,
    updatedAt,
    bindingId,
  )
}

export async function upsertOauthSession(
  db,
  sessionId,
  accountResourceId,
  actorUserId,
  gatewayInstanceId,
  stateHash,
  idempotencyKey,
  expiresAt,
  createdAt,
  updatedAt,
) {
  return dbClient(db).run(
    `INSERT INTO gateway_worker_oauth_sessions(session_id,account_resource_id,actor_user_id,gateway_instance_id,state_hash,provider,status,idempotency_key,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,'openai','pending',?,?,?,?) ON CONFLICT(gateway_instance_id,idempotency_key) DO UPDATE SET session_id=excluded.session_id,state_hash=excluded.state_hash,status='pending',expires_at=excluded.expires_at,updated_at=excluded.updated_at`,
    sessionId,
    accountResourceId,
    actorUserId,
    gatewayInstanceId,
    stateHash,
    idempotencyKey,
    expiresAt,
    createdAt,
    updatedAt,
  )
}

export async function findOauthSession(db, sessionId) {
  return dbClient(db).one(
    'SELECT gateway_instance_id,actor_user_id,idempotency_key FROM gateway_worker_oauth_sessions WHERE session_id=?',
    sessionId,
  )
}

export async function completeOauthSession(db, resultJson, updatedAt, sessionId) {
  return dbClient(db).run(
    "UPDATE gateway_worker_oauth_sessions SET status='completed',result_json=?,updated_at=? WHERE session_id=?",
    resultJson,
    updatedAt,
    sessionId,
  )
}
