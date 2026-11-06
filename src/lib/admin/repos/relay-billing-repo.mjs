// 中转计费（钱包、流水、套餐、请求结算）的仓储：SQL 原样自 relay-billing.mjs 迁入。
// 调用方注入数据库句柄并负责事务边界；本文件不开启事务。
// 全部经 DbClient 异步访问：管理面（充值扣款、转账、冲正、流水、套餐）自 R6 B6b，推理热路径（准入 authorize、结算 settle）自 R6 B7a。
import { dbClient } from '../../db/db-client.mjs'

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

const DOMAIN_WALLET_BALANCE_SQL = 'SELECT balance_micros FROM admin_domains WHERE id=?'
const USER_WALLET_BALANCE_SQL = 'SELECT balance_micros FROM users WHERE id=?'
const ADD_DOMAIN_WALLET_BALANCE_SQL = 'UPDATE admin_domains SET balance_micros=balance_micros+?,updated_at=? WHERE id=?'
const ADD_USER_WALLET_BALANCE_SQL =
  'UPDATE users SET balance_micros=balance_micros+?,balance=(balance_micros+?)/1000000.0,updated_at=? WHERE id=?'
// 竞态 R1/R2：扣款是条件更新，余额不足时不改行（changes=0），并发扣款不会透支
const DEBIT_DOMAIN_WALLET_SQL =
  'UPDATE admin_domains SET balance_micros=balance_micros-?,updated_at=? WHERE id=? AND balance_micros>=?'
const DEBIT_USER_WALLET_SQL =
  'UPDATE users SET balance_micros=balance_micros-?,balance=(balance_micros-?)/1000000.0,updated_at=? WHERE id=? AND balance_micros>=?'
const SUBSCRIPTION_USED_SINCE_SQL =
  'SELECT COALESCE(SUM(actual_micros),0) used FROM billing_charges WHERE subscription_id=? AND created_at>?'

export async function domainWalletBalance(db, domainId) {
  return dbClient(db).one(DOMAIN_WALLET_BALANCE_SQL, domainId)
}

export async function userWalletBalance(db, userId) {
  return dbClient(db).one(USER_WALLET_BALANCE_SQL, userId)
}

export async function addDomainWalletBalance(db, delta, now, domainId) {
  return dbClient(db).run(ADD_DOMAIN_WALLET_BALANCE_SQL, delta, now, domainId)
}

export async function addUserWalletBalance(db, delta, now, userId) {
  return dbClient(db).run(ADD_USER_WALLET_BALANCE_SQL, delta, delta, now, userId)
}

/** 条件扣款（amount 为正数）：返回 changes=0 表示余额不足。 */
export async function debitDomainWallet(db, amount, now, domainId) {
  return dbClient(db).run(DEBIT_DOMAIN_WALLET_SQL, amount, now, domainId, amount)
}

/** 条件扣款（amount 为正数）：返回 changes=0 表示余额不足。 */
export async function debitUserWallet(db, amount, now, userId) {
  return dbClient(db).run(DEBIT_USER_WALLET_SQL, amount, amount, now, userId, amount)
}

export async function ledgerByIdempotencyKey(db, idempotencyKey) {
  return dbClient(db).one('SELECT * FROM wallet_ledger WHERE idempotency_key=?', idempotencyKey)
}

/**
 * 参数依次为 id,user_id,kind,amount_micros,balance_after_micros,idempotency_key,actor,reason,created_at,wallet_domain_id。
 * 竞态 R1：幂等键已存在时不插入（changes=0），由调用方回滚本次余额变动并按已有流水返回。
 */
export async function insertWalletLedger(db, ...values) {
  return dbClient(db).run(
    'INSERT INTO wallet_ledger(id,user_id,kind,amount_micros,balance_after_micros,idempotency_key,actor,reason,created_at,wallet_domain_id) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(idempotency_key) DO NOTHING',
    ...values,
  )
}

export async function ledgerById(db, id) {
  return dbClient(db).one('SELECT * FROM wallet_ledger WHERE id=?', id)
}

/**
 * 转账流水：`(id,user_id,kind,amount_micros,balance_after_micros,idempotency_key,actor,reason,metadata_json,created_at,wallet_domain_id)`。
 * 竞态 R2：幂等键已存在时不插入（changes=0），由调用方回滚。
 */
export async function insertTransferLedger(db, ...values) {
  return dbClient(db).run(
    'INSERT INTO wallet_ledger(id,user_id,kind,amount_micros,balance_after_micros,idempotency_key,actor,reason,metadata_json,created_at,wallet_domain_id) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(idempotency_key) DO NOTHING',
    ...values,
  )
}

export async function setLedgerMetadata(db, metadataJson, id) {
  return dbClient(db).run('UPDATE wallet_ledger SET metadata_json=? WHERE id=?', metadataJson, id)
}

/** `where` 为按 AND 连接的条件片段，`args` 为其参数；`count` 为 LIMIT。 */
export async function ledgerRows(db, where, args, count) {
  return dbClient(db).many(
    'SELECT wallet_ledger.*, (SELECT username FROM users WHERE users.id=wallet_ledger.user_id) AS user_name FROM wallet_ledger' +
      (where.length ? ' WHERE ' + where.join(' AND ') : '') +
      ' ORDER BY created_at DESC,id DESC LIMIT ?',
    ...args,
    count,
  )
}

/** `own` 为 ownerPred 生成的 `{ sql, params }`。 */
export async function subscriptionRows(db, own) {
  return dbClient(db).many(
    'SELECT s.*,g.name group_name FROM user_subscriptions s JOIN groups g ON g.id=s.group_id' +
      (own.sql ? ` WHERE ${own.sql}` : '') +
      ' ORDER BY s.created_at DESC',
    ...own.params,
  )
}

export async function overlappingSubscription(db, userId, groupId, startsAt, expiresAt) {
  return dbClient(db).one(
    "SELECT id FROM user_subscriptions WHERE user_id=? AND group_id=? AND status IN ('active','suspended') AND (expires_at IS NULL OR expires_at>?) AND (? IS NULL OR starts_at<?)",
    userId,
    groupId,
    startsAt,
    expiresAt,
    expiresAt,
  )
}

export async function insertSubscription(db, id, userId, groupId, startsAt, expiresAt, createdAt, updatedAt) {
  return dbClient(db).run(
    "INSERT INTO user_subscriptions(id,user_id,group_id,status,starts_at,expires_at,created_at,updated_at) VALUES(?,?,?,'active',?,?,?,?)",
    id,
    userId,
    groupId,
    startsAt,
    expiresAt,
    createdAt,
    updatedAt,
  )
}

export async function subscriptionById(db, id) {
  return dbClient(db).one('SELECT * FROM user_subscriptions WHERE id=?', id)
}

export async function updateSubscriptionStatus(db, status, updatedAt, id) {
  return dbClient(db).run('UPDATE user_subscriptions SET status=?,updated_at=? WHERE id=?', status, updatedAt, id)
}

/** 返回 `{ used }` 行：套餐自 `since` 起的实扣合计（micros）。 */
export async function subscriptionUsedSince(db, subscriptionId, since) {
  return dbClient(db).one(SUBSCRIPTION_USED_SINCE_SQL, subscriptionId, since)
}

export async function chargeByRequestId(db, requestId) {
  return dbClient(db).one(`SELECT ${CHARGE_COLUMNS} FROM billing_charges WHERE request_id=?`, requestId)
}

/**
 * 参数依次为 request_id,user_id,api_key_id,group_id,subscription_id,rate_multiplier,actual_micros,model,usage_json,quote_json,created_at,wallet_domain_id,balance_exempt。
 * 竞态 R4：按 request_id 抢占（`ON CONFLICT(request_id) DO NOTHING`），changes=0 表示同一请求已被结算，调用方不得再扣款。
 */
export async function insertBillingCharge(db, ...values) {
  return dbClient(db).run(
    'INSERT INTO billing_charges(request_id,user_id,api_key_id,group_id,subscription_id,rate_multiplier,actual_micros,model,usage_json,quote_json,created_at,wallet_domain_id,balance_exempt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(request_id) DO NOTHING',
    ...values,
  )
}
