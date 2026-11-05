/**
 * 供应商审计事件仓储：vendor_audit_events。db 由调用方注入，返回原始行或语句结果。
 */

export function insertAuditEvent(
  db,
  eventId,
  actorUserId,
  vendorId,
  action,
  resourceType,
  resourceId,
  idempotencyKey,
  payloadJson,
  createdAt,
) {
  return db
    .prepare(
      `
        INSERT INTO vendor_audit_events
          (id, actor_user_id, vendor_id, action, resource_type, resource_id, idempotency_key, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    )
    .run(eventId, actorUserId, vendorId, action, resourceType, resourceId, idempotencyKey, payloadJson, createdAt)
}

export function findAuditByIdempotencyKey(db, vendorId, idempotencyKey) {
  return db
    .prepare('SELECT action,resource_id,payload_json FROM vendor_audit_events WHERE vendor_id=? AND idempotency_key=?')
    .get(vendorId, idempotencyKey)
}
