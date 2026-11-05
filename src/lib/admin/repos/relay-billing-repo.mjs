// 中转计费（钱包、流水、套餐、请求结算）的仓储：SQL 原样自 relay-billing.mjs 迁入。
// 调用方注入数据库句柄并负责事务边界；本文件不开启事务。

/**
 * Every billing_charges column except the two JSON blobs. `usage_json` averages
 * 43 KB on the live database (502 KB at the widest) because rows written before
 * usageForStorage still carry the upstream attribution map, and `settle()` reads
 * a charge row twice per metered request. Neither blob has a reader: the caller
 * takes status, actual_micros, group_id, subscription_id and rate_multiplier,
 * and the price comes from the context's own quote_json.
 */
const CHARGE_COLUMNS =
  'request_id,user_id,api_key_id,group_id,subscription_id,rate_multiplier,actual_micros,model,created_at,wallet_domain_id,balance_exempt'

export function domainWalletBalance(db, domainId) {
  return db.prepare('SELECT balance_micros FROM admin_domains WHERE id=?').get(domainId)
}

export function userWalletBalance(db, userId) {
  return db.prepare('SELECT balance_micros FROM users WHERE id=?').get(userId)
}

export function addDomainWalletBalance(db, delta, now, domainId) {
  return db
    .prepare('UPDATE admin_domains SET balance_micros=balance_micros+?,updated_at=? WHERE id=?')
    .run(delta, now, domainId)
}

export function addUserWalletBalance(db, delta, now, userId) {
  return db
    .prepare(
      'UPDATE users SET balance_micros=balance_micros+?,balance=(balance_micros+?)/1000000.0,updated_at=? WHERE id=?',
    )
    .run(delta, delta, now, userId)
}

export function ledgerByIdempotencyKey(db, idempotencyKey) {
  return db.prepare('SELECT * FROM wallet_ledger WHERE idempotency_key=?').get(idempotencyKey)
}

/** 参数依次为 id,user_id,kind,amount_micros,balance_after_micros,idempotency_key,actor,reason,created_at,wallet_domain_id。 */
export function insertWalletLedger(db, ...values) {
  return db
    .prepare(
      'INSERT INTO wallet_ledger(id,user_id,kind,amount_micros,balance_after_micros,idempotency_key,actor,reason,created_at,wallet_domain_id) VALUES(?,?,?,?,?,?,?,?,?,?)',
    )
    .run(...values)
}

export function ledgerById(db, id) {
  return db.prepare('SELECT * FROM wallet_ledger WHERE id=?').get(id)
}

/**
 * 转账流水写入语句，预编译一次供借贷两条复用：
 * `run(id,user_id,kind,amount_micros,balance_after_micros,idempotency_key,actor,reason,metadata_json,created_at,wallet_domain_id)`。
 */
export function prepareTransferLedgerInsert(db) {
  return db.prepare(
    'INSERT INTO wallet_ledger(id,user_id,kind,amount_micros,balance_after_micros,idempotency_key,actor,reason,metadata_json,created_at,wallet_domain_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
  )
}

export function setLedgerMetadata(db, metadataJson, id) {
  return db.prepare('UPDATE wallet_ledger SET metadata_json=? WHERE id=?').run(metadataJson, id)
}

/** `where` 为按 AND 连接的条件片段，`args` 为其参数；`count` 为 LIMIT。 */
export function ledgerRows(db, where, args, count) {
  return db
    .prepare(
      'SELECT wallet_ledger.*, (SELECT username FROM users WHERE users.id=wallet_ledger.user_id) AS user_name FROM wallet_ledger' +
        (where.length ? ' WHERE ' + where.join(' AND ') : '') +
        ' ORDER BY created_at DESC,id DESC LIMIT ?',
    )
    .all(...args, count)
}

/** `own` 为 ownerPred 生成的 `{ sql, params }`。 */
export function subscriptionRows(db, own) {
  return db
    .prepare(
      'SELECT s.*,g.name group_name FROM user_subscriptions s JOIN groups g ON g.id=s.group_id' +
        (own.sql ? ` WHERE ${own.sql}` : '') +
        ' ORDER BY s.created_at DESC',
    )
    .all(...own.params)
}

export function overlappingSubscription(db, userId, groupId, startsAt, expiresAt) {
  return db
    .prepare(
      "SELECT id FROM user_subscriptions WHERE user_id=? AND group_id=? AND status IN ('active','suspended') AND (expires_at IS NULL OR expires_at>?) AND (? IS NULL OR starts_at<?)",
    )
    .get(userId, groupId, startsAt, expiresAt, expiresAt)
}

export function insertSubscription(db, id, userId, groupId, startsAt, expiresAt, createdAt, updatedAt) {
  return db
    .prepare(
      "INSERT INTO user_subscriptions(id,user_id,group_id,status,starts_at,expires_at,created_at,updated_at) VALUES(?,?,?,'active',?,?,?,?)",
    )
    .run(id, userId, groupId, startsAt, expiresAt, createdAt, updatedAt)
}

export function subscriptionById(db, id) {
  return db.prepare('SELECT * FROM user_subscriptions WHERE id=?').get(id)
}

export function updateSubscriptionStatus(db, status, updatedAt, id) {
  return db.prepare('UPDATE user_subscriptions SET status=?,updated_at=? WHERE id=?').run(status, updatedAt, id)
}

/** 返回 `{ used }` 行：套餐自 `since` 起的实扣合计（micros）。 */
export function subscriptionUsedSince(db, subscriptionId, since) {
  return db
    .prepare('SELECT COALESCE(SUM(actual_micros),0) used FROM billing_charges WHERE subscription_id=? AND created_at>?')
    .get(subscriptionId, since)
}

export function chargeByRequestId(db, requestId) {
  return db.prepare(`SELECT ${CHARGE_COLUMNS} FROM billing_charges WHERE request_id=?`).get(requestId)
}

/** 参数依次为 request_id,user_id,api_key_id,group_id,subscription_id,rate_multiplier,actual_micros,model,usage_json,quote_json,created_at,wallet_domain_id,balance_exempt。 */
export function insertBillingCharge(db, ...values) {
  return db
    .prepare(
      'INSERT INTO billing_charges(request_id,user_id,api_key_id,group_id,subscription_id,rate_multiplier,actual_micros,model,usage_json,quote_json,created_at,wallet_domain_id,balance_exempt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
    )
    .run(...values)
}
