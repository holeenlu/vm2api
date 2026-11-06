/**
 * Gateway Worker OAuth 授权会话（gateway_worker_oauth_sessions）的数据访问。经 DbClient 异步访问（R6 B5）。
 */
import { dbClient } from '../../db/db-client.mjs'

export async function clearExpiredOAuthSessions(db, expiresAt) {
  return dbClient(db).run(
    'UPDATE gateway_worker_oauth_sessions SET session_json=NULL WHERE session_json IS NOT NULL AND expires_at<?',
    expiresAt,
  )
}

export async function upsertPendingOAuthSession(
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
  sessionJson,
) {
  return dbClient(db).run(
    `INSERT INTO gateway_worker_oauth_sessions(session_id,account_resource_id,actor_user_id,gateway_instance_id,state_hash,provider,status,idempotency_key,expires_at,created_at,updated_at,session_json) VALUES(?,?,?,?,?,'openai','pending',?,?,?,?,?) ON CONFLICT(gateway_instance_id,idempotency_key) DO UPDATE SET session_id=excluded.session_id,state_hash=excluded.state_hash,expires_at=excluded.expires_at,updated_at=excluded.updated_at,session_json=excluded.session_json,status='pending',result_json=NULL`,
    sessionId,
    accountResourceId,
    actorUserId,
    gatewayInstanceId,
    stateHash,
    idempotencyKey,
    expiresAt,
    createdAt,
    updatedAt,
    sessionJson,
  )
}

export async function getOAuthSession(db, sessionId, actorUserId) {
  return dbClient(db).one(
    'SELECT * FROM gateway_worker_oauth_sessions WHERE session_id=? AND actor_user_id=?',
    sessionId,
    actorUserId,
  )
}

export async function saveOAuthSessionResult(db, resultJson, updatedAt, sessionId) {
  return dbClient(db).run(
    'UPDATE gateway_worker_oauth_sessions SET result_json=?,session_json=NULL,updated_at=? WHERE session_id=?',
    resultJson,
    updatedAt,
    sessionId,
  )
}

export async function completeOAuthSession(db, accountResourceId, resultJson, updatedAt, sessionId) {
  return dbClient(db).run(
    "UPDATE gateway_worker_oauth_sessions SET status='completed',account_resource_id=?,result_json=?,session_json=NULL,updated_at=? WHERE session_id=?",
    accountResourceId,
    resultJson,
    updatedAt,
    sessionId,
  )
}

/** 账号永久删除：进行中的授权会话作废，所有会话的 PKCE 会话数据与结果一并清空。 */
export async function closeAccountOAuthSessions(db, accountResourceId, updatedAt) {
  return dbClient(db).run(
    `UPDATE gateway_worker_oauth_sessions
        SET status=CASE WHEN status='pending' THEN 'cancelled' ELSE status END,session_json=NULL,result_json=NULL,updated_at=?
      WHERE account_resource_id=?`,
    updatedAt,
    accountResourceId,
  )
}
