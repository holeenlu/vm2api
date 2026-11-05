/**
 * Gateway Worker OAuth 授权会话（gateway_worker_oauth_sessions）的数据访问。
 */

export function clearExpiredOAuthSessions(db, expiresAt) {
  return db
    .prepare(
      'UPDATE gateway_worker_oauth_sessions SET session_json=NULL WHERE session_json IS NOT NULL AND expires_at<?',
    )
    .run(expiresAt)
}

export function upsertPendingOAuthSession(
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
  return db
    .prepare(
      `INSERT INTO gateway_worker_oauth_sessions(session_id,account_resource_id,actor_user_id,gateway_instance_id,state_hash,provider,status,idempotency_key,expires_at,created_at,updated_at,session_json) VALUES(?,?,?,?,?,'openai','pending',?,?,?,?,?) ON CONFLICT(gateway_instance_id,idempotency_key) DO UPDATE SET session_id=excluded.session_id,state_hash=excluded.state_hash,expires_at=excluded.expires_at,updated_at=excluded.updated_at,session_json=excluded.session_json,status='pending',result_json=NULL`,
    )
    .run(
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

export function getOAuthSession(db, sessionId, actorUserId) {
  return db
    .prepare('SELECT * FROM gateway_worker_oauth_sessions WHERE session_id=? AND actor_user_id=?')
    .get(sessionId, actorUserId)
}

export function saveOAuthSessionResult(db, resultJson, updatedAt, sessionId) {
  return db
    .prepare('UPDATE gateway_worker_oauth_sessions SET result_json=?,session_json=NULL,updated_at=? WHERE session_id=?')
    .run(resultJson, updatedAt, sessionId)
}

export function completeOAuthSession(db, accountResourceId, resultJson, updatedAt, sessionId) {
  return db
    .prepare(
      "UPDATE gateway_worker_oauth_sessions SET status='completed',account_resource_id=?,result_json=?,session_json=NULL,updated_at=? WHERE session_id=?",
    )
    .run(accountResourceId, resultJson, updatedAt, sessionId)
}
