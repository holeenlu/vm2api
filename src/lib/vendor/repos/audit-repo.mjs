/**
 * 供应商审计事件仓储：vendor_audit_events。db 由调用方注入，经 DbClient 异步访问（R6 B4），返回原始行或语句结果。
 */
import { dbClient } from '../../db/db-client.mjs'

export async function insertAuditEvent(
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
  return dbClient(db).run(
    `
        INSERT INTO vendor_audit_events
          (id, actor_user_id, vendor_id, action, resource_type, resource_id, idempotency_key, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    eventId,
    actorUserId,
    vendorId,
    action,
    resourceType,
    resourceId,
    idempotencyKey,
    payloadJson,
    createdAt,
  )
}

export async function findAuditByIdempotencyKey(db, vendorId, idempotencyKey) {
  return dbClient(db).one(
    'SELECT action,resource_id,payload_json FROM vendor_audit_events WHERE vendor_id=? AND idempotency_key=?',
    vendorId,
    idempotencyKey,
  )
}
