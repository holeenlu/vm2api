/**
 * 超管结算单与付款登记（vendor-admin）：vendor_settlements、vendor_payments。
 * db 由调用方注入，返回原始行或语句结果；事务边界与状态判断留在调用方。
 */

export function listSettlementsByPayees(db, ids) {
  return db
    .prepare(`SELECT s.*,v.name AS vendor_name,
      COALESCE((SELECT SUM(p.amount_usdt) FROM vendor_payments p WHERE p.settlement_id=s.id AND p.action='payment'),0) AS paid_usdt
    FROM vendor_settlements s JOIN vendors v ON v.id=s.payee_vendor_id
    WHERE s.payee_vendor_id IN (${ids.map(() => '?').join(',') || 'NULL'}) ORDER BY s.created_at DESC,s.id`)
    .all(...ids)
}

export function findLivePeriodSettlement(db, payeeVendorId, payerVendorId, periodStart, periodEnd) {
  return db
    .prepare(`SELECT s.* FROM vendor_settlements s
      WHERE s.payee_vendor_id=? AND s.payer_vendor_id IS ? AND s.period_start=? AND s.period_end=? AND s.status<>'void'`)
    .get(payeeVendorId, payerVendorId, periodStart, periodEnd)
}

export function findVoidedPeriodSettlement(db, payeeVendorId, payerVendorId, periodStart, periodEnd) {
  return db
    .prepare(`SELECT 1 FROM vendor_settlements s
      WHERE s.payee_vendor_id=? AND s.payer_vendor_id IS ? AND s.period_start=? AND s.period_end=? AND s.status='void'`)
    .get(payeeVendorId, payerVendorId, periodStart, periodEnd)
}

export function listOverlappingSettlements(db, payeeVendorId, payerVendorId, periodEnd, periodStart) {
  return db
    .prepare(`SELECT s.* FROM vendor_settlements s
      WHERE s.payee_vendor_id=? AND s.payer_vendor_id IS ? AND s.status<>'void' AND s.period_start<? AND s.period_end>?`)
    .all(payeeVendorId, payerVendorId, periodEnd, periodStart)
}

export function insertReviewSettlement(
  db,
  settlementId,
  contractId,
  periodStart,
  periodEnd,
  amountUsdt,
  usageSnapshotJson,
  createdBy,
  createdAt,
  updatedAt,
  payerVendorId,
  payeeVendorId,
) {
  return db
    .prepare(`INSERT INTO vendor_settlements (id,contract_id,period_start,period_end,status,amount_usdt,usage_snapshot_json,created_by,created_at,updated_at,payer_vendor_id,payee_vendor_id)
      VALUES (?,?,?,?,'review',?,?,?,?,?,?,?)`)
    .run(
      settlementId,
      contractId,
      periodStart,
      periodEnd,
      amountUsdt,
      usageSnapshotJson,
      createdBy,
      createdAt,
      updatedAt,
      payerVendorId,
      payeeVendorId,
    )
}

export function voidSettlement(db, updatedAt, settlementId) {
  return db.prepare("UPDATE vendor_settlements SET status='void',updated_at=? WHERE id=?").run(updatedAt, settlementId)
}

export function setSettlementStatus(db, status, updatedAt, settlementId) {
  return db
    .prepare('UPDATE vendor_settlements SET status=?,updated_at=? WHERE id=?')
    .run(status, updatedAt, settlementId)
}

export function findPaymentByIdempotencyKey(db, idempotencyKey) {
  return db.prepare('SELECT * FROM vendor_payments WHERE idempotency_key=?').get(idempotencyKey)
}

export function sumSettlementPayments(db, settlementId) {
  return db
    .prepare("SELECT COALESCE(SUM(amount_usdt),0) AS n FROM vendor_payments WHERE settlement_id=? AND action='payment'")
    .get(settlementId)
}

export function insertPayment(db, paymentId, settlementId, idempotencyKey, amountUsdt, reason, actorUserId, createdAt) {
  return db
    .prepare(
      `INSERT INTO vendor_payments (id,settlement_id,idempotency_key,amount_usdt,action,reason,actor_user_id,created_at) VALUES (?,?,?,?,'payment',?,?,?)`,
    )
    .run(paymentId, settlementId, idempotencyKey, amountUsdt, reason, actorUserId, createdAt)
}
