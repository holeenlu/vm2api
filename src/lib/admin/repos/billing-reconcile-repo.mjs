// 计费对账（审计阶段 2 W9）的只读查询：原 scripts/audit-money-micros.mjs 的检查 SQL 迁入，另加三方核对、
// unmetered 占比与 settlement_pending 超时。调用方注入数据库句柄（每日对账在 Worker 线程的只读连接上、在一个读事务里执行，
// 运维脚本在自己的连接上执行）；经 DbClient 异步访问。表名、列名只来自代码里的常量（金额列登记表），不来自输入。
import { dbClient } from '../../db/db-client.mjs'
import { moneySql } from '../../db/repos/money-sql.mjs'
import { vendorFactEligibleSql, vendorFactOwnerSql } from '../../vendor/repos/usage-repo.mjs'

const R = (column) => `CAST(ROUND(${column} * 1000000) AS INTEGER)`
const LIMIT_MICROS = '2251799813685248'
const LIMIT_USD = '2251799813.685248'
// 明细仍完整的小时：保留期清理边界（小时）之后
const DETAIL = (alias = '') => `${alias}created_at IS NOT NULL AND substr(${alias}created_at, 1, 13) > ?`

export async function tableColumns(db, table) {
  return new Set((await dbClient(db).many(`PRAGMA table_info(${table})`)).map((c) => c.name))
}

/** 逐行比对一列金额：整数列缺失、多出、不等、超范围的行数与最大差值（微单位）。 */
export async function moneyColumnStats(db, table, column) {
  const m = `${column}_micros`
  return dbClient(db).one(
    `SELECT COUNT(*) AS rows,
      SUM(CASE WHEN ${m} IS NULL AND ${column} IS NOT NULL THEN 1 ELSE 0 END) AS missing_micros,
      SUM(CASE WHEN ${m} IS NOT NULL AND ${column} IS NULL THEN 1 ELSE 0 END) AS orphan_micros,
      SUM(CASE WHEN ${m} IS NOT NULL AND ${column} IS NOT NULL AND ${m} <> ${R(column)} THEN 1 ELSE 0 END) AS mismatched,
      MAX(CASE WHEN ${m} IS NOT NULL AND ABS(${m}) < ${LIMIT_MICROS} AND ABS(${column}) < ${LIMIT_USD}
        THEN ABS(${m} - ${R(column)}) END) AS max_diff_micros,
      SUM(CASE WHEN ABS(${column}) >= ${LIMIT_USD} OR ABS(${m}) >= ${LIMIT_MICROS} THEN 1 ELSE 0 END) AS out_of_range
     FROM ${table}`,
  )
}

export async function moneyColumnSamples(db, table, column, limit) {
  const m = `${column}_micros`
  return dbClient(db).many(
    `SELECT rowid, ${column} AS real, CASE WHEN ABS(${m}) < ${LIMIT_MICROS} THEN ${m} END AS micros FROM ${table}
     WHERE (${m} IS NULL) <> (${column} IS NULL) OR ${m} <> ${R(column)} LIMIT ?`,
    limit,
  )
}

/** settings.usage_logs_pruned_through 的原始值（JSON 文本），没有时为 null。 */
export async function usagePrunedThroughSetting(db) {
  return (await dbClient(db).one("SELECT value FROM settings WHERE key = 'usage_logs_pruned_through'"))?.value ?? null
}

/** 用量小时汇总 = 明细：新口径（整数列）、旧口径（REAL 列）与不相等的小时数。 */
export async function usageStatsRollup(db, after) {
  const c = dbClient(db)
  const v = async (sql) => (await c.one(sql, after)).v
  return {
    micros: {
      detail: await v(`SELECT COALESCE(SUM(${moneySql('actual_cost')}), 0) AS v FROM usage_logs WHERE ${DETAIL()}`),
      rollup: await v('SELECT COALESCE(SUM(cost_micros), 0) AS v FROM usage_stats_hourly WHERE hour > ?'),
    },
    real: {
      detail: await v(`SELECT COALESCE(SUM(actual_cost), 0) AS v FROM usage_logs WHERE ${DETAIL()}`),
      rollup: await v('SELECT COALESCE(SUM(cost), 0) AS v FROM usage_stats_hourly WHERE hour > ?'),
    },
    mismatched_hours: (
      await c.one(
        `SELECT COUNT(*) AS n FROM (
           SELECT strftime('%Y-%m-%dT%H', created_at) AS hour, COALESCE(SUM(${moneySql('actual_cost')}), 0) AS v
             FROM usage_logs WHERE ${DETAIL()} GROUP BY 1) d
         FULL OUTER JOIN (SELECT hour, SUM(cost_micros) AS v FROM usage_stats_hourly WHERE hour > ? GROUP BY hour) r ON r.hour = d.hour
         WHERE COALESCE(d.v, 0) <> COALESCE(r.v, 0)`,
        after,
        after,
      )
    ).n,
  }
}

export async function usageCostRollup(db, column, after) {
  const c = dbClient(db)
  const v = async (sql) => (await c.one(sql, after)).v
  return {
    micros: {
      detail: await v(`SELECT COALESCE(SUM(${moneySql(column)}), 0) AS v FROM usage_logs WHERE ${DETAIL()}`),
      rollup: await v(`SELECT COALESCE(SUM(${column}_micros), 0) AS v FROM usage_cost_hourly WHERE hour > ?`),
    },
    real: {
      detail: await v(`SELECT COALESCE(SUM(${column}), 0) AS v FROM usage_logs WHERE ${DETAIL()}`),
      rollup: await v(`SELECT COALESCE(SUM(${column}), 0) AS v FROM usage_cost_hourly WHERE hour > ?`),
    },
  }
}

/** 已结算的使用记录：结算扣费与使用记录实际价不一致的行数（新旧两种口径）。 */
export async function chargeAmountMismatches(db) {
  return dbClient(db).one(
    `SELECT COUNT(*) AS n,
      SUM(CASE WHEN c.actual_micros IS NOT ${moneySql('actual_cost', 'l.')} THEN 1 ELSE 0 END) AS micros_diff,
      SUM(CASE WHEN c.actual_micros IS NOT NULL AND l.actual_cost IS NOT NULL
                AND ABS(c.actual_micros / 1000000.0 - l.actual_cost) > 0.0000005 THEN 1 ELSE 0 END) AS real_diff
     FROM billing_charges c JOIN usage_logs l ON l.request_id = c.request_id
     WHERE l.billing_status = 'settled'`,
  )
}

// 计入钱包的结算扣费：非套餐、非豁免、已计价
const WALLET_CHARGE = 'actual_micros IS NOT NULL AND subscription_id IS NULL AND COALESCE(balance_exempt, 0) = 0'

/** 个人钱包（未删除、非管理员）：余额、Σ流水、Σ结算扣费。管理域钱包的流水与扣费（wallet_domain_id 非空）不计入个人钱包。 */
export async function userWallets(db) {
  return dbClient(db).many(
    `WITH l AS (SELECT user_id AS k, SUM(amount_micros) AS v FROM wallet_ledger WHERE wallet_domain_id IS NULL GROUP BY 1),
          c AS (SELECT user_id AS k, SUM(actual_micros) AS v FROM billing_charges
                 WHERE wallet_domain_id IS NULL AND ${WALLET_CHARGE} GROUP BY 1)
     SELECT u.id, u.balance_micros, u.balance, COALESCE(l.v, 0) AS ledger, COALESCE(c.v, 0) AS charged
     FROM users u LEFT JOIN l ON l.k = u.id LEFT JOIN c ON c.k = u.id
     WHERE u.deleted_at IS NULL AND (u.role IS NULL OR u.role <> 'admin')`,
  )
}

/** 管理域共享钱包：余额、Σ流水、Σ结算扣费。 */
export async function domainWallets(db) {
  return dbClient(db).many(
    `WITH l AS (SELECT wallet_domain_id AS k, SUM(amount_micros) AS v FROM wallet_ledger
                 WHERE wallet_domain_id IS NOT NULL GROUP BY 1),
          c AS (SELECT wallet_domain_id AS k, SUM(actual_micros) AS v FROM billing_charges
                 WHERE wallet_domain_id IS NOT NULL AND ${WALLET_CHARGE} GROUP BY 1)
     SELECT d.id, d.balance_micros, COALESCE(l.v, 0) AS ledger, COALESCE(c.v, 0) AS charged
     FROM admin_domains d LEFT JOIN l ON l.k = d.id LEFT JOIN c ON c.k = d.id`,
  )
}

/** 供应商结算单（非作废）已付超过应付的张数（新旧两种口径）。 */
export async function vendorOverpaid(db) {
  return dbClient(db).one(
    `SELECT COUNT(*) AS n,
      SUM(CASE WHEN paid_micros > due_micros THEN 1 ELSE 0 END) AS over_micros,
      SUM(CASE WHEN paid_real > due_real + 0.0000005 THEN 1 ELSE 0 END) AS over_real
     FROM (SELECT s.amount_usdt_micros AS due_micros, s.amount_usdt AS due_real,
             COALESCE((SELECT SUM(${moneySql('amount_usdt', 'p.')}) FROM vendor_payments p WHERE p.settlement_id = s.id AND p.action = 'payment'), 0) AS paid_micros,
             COALESCE((SELECT SUM(p.amount_usdt) FROM vendor_payments p WHERE p.settlement_id = s.id AND p.action = 'payment'), 0) AS paid_real
           FROM vendor_settlements s WHERE s.status <> 'void')`,
  )
}

/**
 * 结算扣费 ↔ 使用记录（明细完整的小时内）：两边行数与金额、只有扣费没有使用记录的行、
 * 标为 settled 却没有扣费的使用记录。
 */
export async function chargeUsagePairing(db, after) {
  const c = dbClient(db)
  const charges = await c.one(
    `SELECT COUNT(*) AS rows, COALESCE(SUM(c.actual_micros), 0) AS micros,
       SUM(CASE WHEN l.request_id IS NULL THEN 1 ELSE 0 END) AS without_usage
     FROM billing_charges c LEFT JOIN usage_logs l ON l.request_id = c.request_id
     WHERE ${DETAIL('c.')}`,
    after,
  )
  const settled = await c.one(
    `SELECT COUNT(*) AS rows, COALESCE(SUM(${moneySql('actual_cost', 'l.')}), 0) AS micros,
       SUM(CASE WHEN NOT EXISTS (SELECT 1 FROM billing_charges c WHERE c.request_id = l.request_id) THEN 1 ELSE 0 END) AS without_charge
     FROM usage_logs l WHERE l.billing_status = 'settled' AND ${DETAIL('l.')}`,
    after,
  )
  return { charges, settled }
}

/**
 * 使用记录 ↔ 供应商用量事实（明细完整的小时内）：事实两边的行数与金额、找不到使用记录的事实、
 * 金额与使用记录不同的事实，以及按当前计入口径应有事实却没有的使用记录（只看 `settledBefore` 之前的记录：
 * Gateway 记录要等回执到达才写事实）。
 */
export async function vendorFactPairing(db, after, settledBefore) {
  const c = dbClient(db)
  const facts = await c.one(
    `SELECT COUNT(*) AS rows, COALESCE(SUM(${moneySql('cost_usd', 'f.')}), 0) AS micros,
       SUM(CASE WHEN f.source_request_id IS NULL THEN 1 ELSE 0 END) AS without_request,
       SUM(CASE WHEN f.source_request_id IS NOT NULL AND l.request_id IS NULL THEN 1 ELSE 0 END) AS without_usage,
       SUM(CASE WHEN l.request_id IS NOT NULL
                 AND ${moneySql('cost_usd', 'f.')} <> MAX(0, COALESCE(${moneySql('total_cost', 'l.')}, 0)) THEN 1 ELSE 0 END) AS amount_mismatch
     FROM vendor_usage_facts f LEFT JOIN usage_logs l ON l.request_id = f.source_request_id
     WHERE f.occurred_at IS NOT NULL AND strftime('%Y-%m-%dT%H', f.occurred_at) > ?`,
    after,
  )
  const eligible = await c.one(
    `SELECT COUNT(*) AS rows, COALESCE(SUM(MAX(0, COALESCE(${moneySql('total_cost', 'l.')}, 0))), 0) AS micros,
       SUM(CASE WHEN l.created_at < ? AND NOT EXISTS (SELECT 1 FROM vendor_usage_facts f WHERE f.source_request_id = l.request_id)
           THEN 1 ELSE 0 END) AS missing_fact
     FROM usage_logs l
     WHERE ${DETAIL('l.')} AND ${vendorFactEligibleSql('l')} AND (${vendorFactOwnerSql('l')}) IS NOT NULL`,
    settledBefore,
    after,
  )
  return { facts, eligible }
}

/**
 * [since, until) 内客户 Key 的成功请求（2xx）：总行数与官方价合计、unmetered 的行数与官方价合计、
 * 其中没有官方价（未定价）的行数。
 */
export async function unmeteredShare(db, since, until) {
  const cost = moneySql('total_cost')
  return dbClient(db).one(
    `SELECT COUNT(*) AS rows, COALESCE(SUM(${cost}), 0) AS micros,
       SUM(CASE WHEN billing_status = 'unmetered' THEN 1 ELSE 0 END) AS unmetered_rows,
       COALESCE(SUM(CASE WHEN billing_status = 'unmetered' THEN ${cost} END), 0) AS unmetered_micros,
       SUM(CASE WHEN billing_status = 'unmetered' AND ${cost} IS NULL THEN 1 ELSE 0 END) AS unmetered_unpriced
     FROM usage_logs
     WHERE created_at >= ? AND created_at < ? AND status >= 200 AND status < 300 AND COALESCE(api_key_id, '') <> ''`,
    since,
    until,
  )
}

/** 停在 settlement_pending、创建时间早于 `before` 的使用记录数与最早时间。 */
export async function staleSettlementPending(db, before) {
  return dbClient(db).one(
    "SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM usage_logs WHERE billing_status = 'settlement_pending' AND created_at < ?",
    before,
  )
}

/** 最近一次每日对账写入的审计行（after_json 里有上次的钱包差额基线）。 */
export async function lastReconcileAudit(db, action) {
  return dbClient(db).one(
    'SELECT created_at, after_json FROM operation_audit WHERE action = ? ORDER BY id DESC LIMIT 1',
    action,
  )
}
