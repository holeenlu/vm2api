/**
 * 超管结算单与付款登记（vendor-admin）：vendor_settlements、vendor_payments。
 * db 由调用方注入，经 DbClient 异步访问（R6 B4），返回原始行或语句结果；事务边界与状态判断留在调用方。
 */
import { dbClient } from '../../db/db-client.mjs'

export async function listSettlementsByPayees(db, ids) {
  return dbClient(db).many(
    `SELECT s.*,v.name AS vendor_name,
      COALESCE((SELECT SUM(p.amount_usdt) FROM vendor_payments p WHERE p.settlement_id=s.id AND p.action='payment'),0) AS paid_usdt
    FROM vendor_settlements s JOIN vendors v ON v.id=s.payee_vendor_id
    WHERE s.payee_vendor_id IN (${ids.map(() => '?').join(',') || 'NULL'}) ORDER BY s.created_at DESC,s.id`,
    ...ids,
  )
}

export async function listOverlappingSettlements(db, payeeVendorId, payerVendorId, periodEnd, periodStart) {
  return dbClient(db).many(
    `SELECT s.* FROM vendor_settlements s
      WHERE s.payee_vendor_id=? AND s.payer_vendor_id IS ? AND s.status<>'void' AND s.period_start<? AND s.period_end>?`,
    payeeVendorId,
    payerVendorId,
    periodEnd,
    periodStart,
  )
}

export async function voidSettlement(db, updatedAt, settlementId) {
  return dbClient(db).run(
    "UPDATE vendor_settlements SET status='void',updated_at=? WHERE id=?",
    updatedAt,
    settlementId,
  )
}

export async function setSettlementStatus(db, status, updatedAt, settlementId) {
  return dbClient(db).run(
    'UPDATE vendor_settlements SET status=?,updated_at=? WHERE id=?',
    status,
    updatedAt,
    settlementId,
  )
}

export async function findPaymentByIdempotencyKey(db, idempotencyKey) {
  return dbClient(db).one('SELECT * FROM vendor_payments WHERE idempotency_key=?', idempotencyKey)
}

export async function sumSettlementPayments(db, settlementId) {
  return dbClient(db).one(
    "SELECT COALESCE(SUM(amount_usdt),0) AS n FROM vendor_payments WHERE settlement_id=? AND action='payment'",
    settlementId,
  )
}

/** 付款标识已存在时不写入（竞态 R20）：返回 `changes` 为 0，调用方按标识读回已有付款。 */
export async function insertPayment(
  db,
  paymentId,
  settlementId,
  idempotencyKey,
  amountUsdt,
  reason,
  actorUserId,
  createdAt,
) {
  return dbClient(db).run(
    `INSERT INTO vendor_payments (id,settlement_id,idempotency_key,amount_usdt,action,reason,actor_user_id,created_at) VALUES (?,?,?,?,'payment',?,?,?)
    ON CONFLICT(idempotency_key) DO NOTHING`,
    paymentId,
    settlementId,
    idempotencyKey,
    amountUsdt,
    reason,
    actorUserId,
    createdAt,
  )
}
