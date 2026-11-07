#!/usr/bin/env node
/**
 * 金额整数化一致性校验（技术债 M6）。默认只读。
 *
 * 用法：
 *   node scripts/audit-money-micros.mjs [<db 路径>] [--json] [--samples N]
 *   node scripts/audit-money-micros.mjs <db 路径> --backfill          # 写：补齐整数列为 NULL 而 REAL 有值的行
 *   node scripts/audit-money-micros.mjs <db 路径> --sync-from-real    # 写：整数列与 REAL 不一致时以 REAL 为准改写整数列
 *                                                                     #     （users 例外：以 balance_micros 为准改 REAL）
 *
 * db 路径缺省为 $KIN_DB；否则取存在的 /opt/tapmodels/data/kin.db（Docker 镜像）或 /opt/kin-gateway/data/kin.db（主机安装）。
 *
 * 检查项：
 *   1. 逐表逐行：`x_micros` 与 `CAST(ROUND(x * 1e6) AS INTEGER)`。分别统计整数列缺失（REAL 有值）、
 *      整数列多出（REAL 为 NULL）、两者不等的行数，最大差值（微单位）与样例 rowid。
 *   2. 汇总口径在新旧两种口径下的结果：
 *      - 用量汇总 = 明细合计：usage_stats_hourly.cost（115/123/127）与 usage_cost_hourly 的五个成本列，
 *        新口径比较整数列（应逐项相等），旧口径比较 REAL 列（浮点和，报告差值）；另按小时统计不相等的桶数；
 *      - 结算 = 使用记录实际价：billing_charges.actual_micros 与同一 request_id 的 usage_logs.actual_cost(_micros)；
 *      - 钱包余额 = 流水累计 − 结算扣费：按钱包（用户或管理员域）比较 balance_micros 与
 *        Σwallet_ledger.amount_micros − Σbilling_charges.actual_micros（非套餐、非豁免），新口径用整数列，
 *        旧口径用 users.balance（REAL）；没有开户流水的历史余额会表现为固定差额，只报告不判错；
 *      - 供应商结算单已付 ≤ 应付：Σvendor_payments 与 vendor_settlements 的金额，新旧两种口径。
 * 退出码：第 1 项或用量汇总新口径有不一致时为 1，其余为 0（写模式按写入后的结果判定）。
 *
 * --backfill 用于回滚到上一版本又升级回来之后：上一版本只写 REAL 列，这些行的整数列为 NULL。小表（api_keys、groups、
 * vendor_*、redeem_codes）有迁移 126 的旧写入方触发器，usage_logs 在启动时自动补齐，这两个写模式是兜底。
 * --sync-from-real 只在确认 REAL 列更新（例如回滚期间上一版本改写过金额）时使用。
 * 写模式的例外：两张汇总表不改（由触发器维护）；users.balance 的权威值是 balance_micros（039 起），只反向把 REAL
 * 改成 balance_micros / 1e6，从不按 REAL 改余额；|REAL| 超出有效金额范围（约 22.5 亿美元）的行不改。
 * 写模式分批执行（每批 5000 行一个短事务），可以在服务运行时执行，但建议停服或低峰执行：每批持有写锁，
 * 与线上写入交错；改写 usage_logs 的整数列会经触发器同步更新汇总表（触发器对整数列为 NULL 的行已按 REAL 派生计入，
 * 补齐后汇总不变）。
 */
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { MONEY_MIRRORS, moneyMirrorPairs } from '../src/lib/core/money-columns.mjs'

const ROLLUPS = new Set(['usage_cost_hourly', 'usage_stats_hourly'])
const R = (column) => `CAST(ROUND(${column} * 1000000) AS INTEGER)`
const M = (column, prefix = '') => `COALESCE(${prefix}${column}_micros, ${R(prefix + column)})`

/** 缺省库路径：$KIN_DB；否则 Docker 镜像的 /opt/tapmodels/data/kin.db 与主机安装的 /opt/kin-gateway/data/kin.db 中存在的那个。 */
export function defaultDbPath(env = process.env, exists = fs.existsSync) {
  if (env.KIN_DB) return env.KIN_DB
  return (
    ['/opt/tapmodels/data/kin.db', '/opt/kin-gateway/data/kin.db'].find((p) => exists(p)) ||
    '/opt/tapmodels/data/kin.db'
  )
}

export function parseArgs(argv) {
  const out = { db: defaultDbPath(), json: false, samples: 5, mode: 'read' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') out.json = true
    else if (a === '--samples') out.samples = Math.max(0, Number(argv[++i]) || 0)
    else if (a === '--backfill') out.mode = 'backfill'
    else if (a === '--sync-from-real') out.mode = 'sync-from-real'
    else if (a === '--db') out.db = argv[++i]
    else if (!a.startsWith('--')) out.db = a
    else throw new Error(`unknown option ${a}`)
  }
  return out
}

function tableColumns(db, table) {
  return new Set(
    db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((c) => c.name),
  )
}

/** 第 1 项：逐表逐行比对。 */
export function auditRows(db, { samples = 5 } = {}) {
  const out = []
  for (const [table, column] of moneyMirrorPairs()) {
    const cols = tableColumns(db, table)
    if (!cols.size) {
      out.push({ table, column, status: 'missing_table' })
      continue
    }
    if (!cols.has(column + '_micros') || !cols.has(column)) {
      out.push({ table, column, status: 'missing_column' })
      continue
    }
    const m = `${column}_micros`
    const row = db
      .prepare(
        `SELECT COUNT(*) AS rows,
          SUM(CASE WHEN ${m} IS NULL AND ${column} IS NOT NULL THEN 1 ELSE 0 END) AS missing_micros,
          SUM(CASE WHEN ${m} IS NOT NULL AND ${column} IS NULL THEN 1 ELSE 0 END) AS orphan_micros,
          SUM(CASE WHEN ${m} IS NOT NULL AND ${column} IS NOT NULL AND ${m} <> ${R(column)} THEN 1 ELSE 0 END) AS mismatched,
          MAX(CASE WHEN ${m} IS NOT NULL AND ABS(${m}) < 2251799813685248 AND ABS(${column}) < 2251799813.685248
            THEN ABS(${m} - ${R(column)}) END) AS max_diff_micros,
          SUM(CASE WHEN ABS(${column}) >= 2251799813.685248 OR ABS(${m}) >= 2251799813685248 THEN 1 ELSE 0 END) AS out_of_range
         FROM ${table}`,
      )
      .get()
    const bad =
      Number(row.missing_micros || 0) +
      Number(row.orphan_micros || 0) +
      Number(row.mismatched || 0) +
      Number(row.out_of_range || 0)
    const sample =
      bad && samples
        ? db
            .prepare(
              `SELECT rowid, ${column} AS real, CASE WHEN ABS(${m}) < 2251799813685248 THEN ${m} END AS micros FROM ${table}
             WHERE (${m} IS NULL) <> (${column} IS NULL) OR ${m} <> ${R(column)} LIMIT ?`,
            )
            .all(samples)
        : []
    out.push({
      table,
      column,
      status: bad ? 'mismatch' : 'ok',
      rows: Number(row.rows || 0),
      missing_micros: Number(row.missing_micros || 0),
      orphan_micros: Number(row.orphan_micros || 0),
      mismatched: Number(row.mismatched || 0),
      max_diff_micros: Number(row.max_diff_micros || 0),
      out_of_range: Number(row.out_of_range || 0),
      samples: sample.map((r) => ({ rowid: r.rowid, real: r.real, micros: r.micros })),
    })
  }
  return out
}

function compare(name, newer, older, extra = {}) {
  const n = { detail: Number(newer.detail || 0), rollup: Number(newer.rollup || 0) }
  const o = { detail: Number(older.detail || 0), rollup: Number(older.rollup || 0) }
  return {
    name,
    micros: { ...n, equal: n.detail === n.rollup },
    real: { ...o, diff: o.rollup - o.detail },
    ...extra,
  }
}

/** 第 2 项：汇总口径。 */
export function auditAggregates(db) {
  const out = []
  const has = (table) => tableColumns(db, table).size > 0
  if (has('usage_stats_hourly')) {
    const newer = {
      detail: db
        .prepare(`SELECT COALESCE(SUM(${M('actual_cost')}), 0) AS v FROM usage_logs WHERE created_at IS NOT NULL`)
        .get().v,
      rollup: db.prepare('SELECT COALESCE(SUM(cost_micros), 0) AS v FROM usage_stats_hourly').get().v,
    }
    const older = {
      detail: db.prepare('SELECT COALESCE(SUM(actual_cost), 0) AS v FROM usage_logs WHERE created_at IS NOT NULL').get()
        .v,
      rollup: db.prepare('SELECT COALESCE(SUM(cost), 0) AS v FROM usage_stats_hourly').get().v,
    }
    const buckets = db
      .prepare(
        `SELECT COUNT(*) AS n FROM (
           SELECT substr(created_at, 1, 13) AS hour, COALESCE(SUM(${M('actual_cost')}), 0) AS v
             FROM usage_logs WHERE created_at IS NOT NULL GROUP BY 1) d
         FULL OUTER JOIN (SELECT hour, SUM(cost_micros) AS v FROM usage_stats_hourly GROUP BY hour) r ON r.hour = d.hour
         WHERE COALESCE(d.v, 0) <> COALESCE(r.v, 0)`,
      )
      .get().n
    out.push(compare('usage_stats_hourly.cost = Σ usage_logs.actual_cost', newer, older, { mismatched_hours: buckets }))
  }
  if (has('usage_cost_hourly'))
    for (const column of MONEY_MIRRORS.usage_cost_hourly) {
      const newer = {
        detail: db
          .prepare(`SELECT COALESCE(SUM(${M(column)}), 0) AS v FROM usage_logs WHERE created_at IS NOT NULL`)
          .get().v,
        rollup: db.prepare(`SELECT COALESCE(SUM(${column}_micros), 0) AS v FROM usage_cost_hourly`).get().v,
      }
      const older = {
        detail: db.prepare(`SELECT COALESCE(SUM(${column}), 0) AS v FROM usage_logs WHERE created_at IS NOT NULL`).get()
          .v,
        rollup: db.prepare(`SELECT COALESCE(SUM(${column}), 0) AS v FROM usage_cost_hourly`).get().v,
      }
      out.push(compare(`usage_cost_hourly.${column} = Σ usage_logs.${column}`, newer, older))
    }
  if (has('billing_charges')) {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n,
          SUM(CASE WHEN c.actual_micros IS NOT ${M('actual_cost', 'l.')} THEN 1 ELSE 0 END) AS micros_diff,
          SUM(CASE WHEN c.actual_micros IS NOT NULL AND l.actual_cost IS NOT NULL
                    AND ABS(c.actual_micros / 1000000.0 - l.actual_cost) > 0.0000005 THEN 1 ELSE 0 END) AS real_diff
         FROM billing_charges c JOIN usage_logs l ON l.request_id = c.request_id
         WHERE l.billing_status = 'settled'`,
      )
      .get()
    out.push({
      name: 'billing_charges.actual_micros = usage_logs.actual_cost（已结算）',
      rows: Number(row.n || 0),
      micros: { mismatched: Number(row.micros_diff || 0) },
      real: { mismatched: Number(row.real_diff || 0) },
    })
  }
  if (has('wallet_ledger')) {
    const charges = (key) => `SELECT ${key} AS k, SUM(actual_micros) AS v FROM billing_charges
      WHERE actual_micros IS NOT NULL AND subscription_id IS NULL AND COALESCE(balance_exempt, 0) = 0 GROUP BY 1`
    const ledger = (key) => `SELECT ${key} AS k, SUM(amount_micros) AS v FROM wallet_ledger GROUP BY 1`
    const users = db
      .prepare(
        `SELECT u.id, u.balance_micros, u.balance,
           COALESCE((SELECT v FROM (${ledger('user_id')}) WHERE k = u.id), 0) AS ledger,
           COALESCE((SELECT v FROM (${charges('user_id')}) WHERE k = u.id), 0) AS charged
         FROM users u WHERE u.deleted_at IS NULL AND (u.role IS NULL OR u.role <> 'admin')`,
      )
      .all()
    const domains = has('admin_domains')
      ? db
          .prepare(
            `SELECT d.id, d.balance_micros,
               COALESCE((SELECT SUM(amount_micros) FROM wallet_ledger WHERE wallet_domain_id = d.id), 0) AS ledger,
               COALESCE((SELECT SUM(actual_micros) FROM billing_charges WHERE wallet_domain_id = d.id
                 AND actual_micros IS NOT NULL AND subscription_id IS NULL AND COALESCE(balance_exempt, 0) = 0), 0) AS charged
             FROM admin_domains d`,
          )
          .all()
      : []
    const offset = (r) => Number(r.balance_micros || 0) - (Number(r.ledger || 0) - Number(r.charged || 0))
    out.push({
      name: '钱包余额 = Σ流水 − Σ结算扣费（只报告；无开户流水的历史余额表现为固定差额）',
      wallets: users.length + domains.length,
      micros: { wallets_with_offset: [...users, ...domains].filter((r) => offset(r) !== 0).length },
      real: {
        users_balance_mirror_drift: users.filter(
          (r) => Math.abs(Number(r.balance || 0) - Number(r.balance_micros || 0) / 1e6) > 5e-7,
        ).length,
      },
    })
  }
  if (has('vendor_settlements') && tableColumns(db, 'vendor_settlements').has('amount_usdt_micros')) {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n,
          SUM(CASE WHEN paid_micros > due_micros THEN 1 ELSE 0 END) AS over_micros,
          SUM(CASE WHEN paid_real > due_real + 0.0000005 THEN 1 ELSE 0 END) AS over_real
         FROM (SELECT s.amount_usdt_micros AS due_micros, s.amount_usdt AS due_real,
                 COALESCE((SELECT SUM(${M('amount_usdt', 'p.')}) FROM vendor_payments p WHERE p.settlement_id = s.id AND p.action = 'payment'), 0) AS paid_micros,
                 COALESCE((SELECT SUM(p.amount_usdt) FROM vendor_payments p WHERE p.settlement_id = s.id AND p.action = 'payment'), 0) AS paid_real
               FROM vendor_settlements s WHERE s.status <> 'void')`,
      )
      .get()
    out.push({
      name: '供应商结算单已付 ≤ 应付',
      rows: Number(row.n || 0),
      micros: { overpaid: Number(row.over_micros || 0) },
      real: { overpaid: Number(row.over_real || 0) },
    })
  }
  return out
}

/** 写模式：补齐或按 REAL 改写整数列（汇总表不动，由触发器维护）。返回各列改写的行数。 */
/** 余额以整数列为权威（039 起），写模式只反向修 REAL 镜像，不按 REAL 改写余额。 */
const MICROS_AUTHORITATIVE = new Set(['users'])
const LIMIT_USD = '2251799813.685248'

/**
 * 写模式：分批（每批一个短事务）补齐或按 REAL 改写整数列。汇总表不动（由触发器维护）；
 * `users.balance` 只反向同步（REAL = balance_micros / 1e6）。|REAL| 超出有效金额范围的行不改，只在报告里出现。
 * 返回各列改写的行数。
 */
export function repair(db, mode, { batch = 5000 } = {}) {
  const changed = []
  for (const [table, column] of moneyMirrorPairs()) {
    if (ROLLUPS.has(table)) continue
    const cols = tableColumns(db, table)
    const m = `${column}_micros`
    if (!cols.has(m)) continue
    let set
    let where
    if (MICROS_AUTHORITATIVE.has(table)) {
      if (mode !== 'sync-from-real') continue
      set = `${column} = ${m} / 1000000.0`
      where = `${m} IS NOT NULL AND ${m} IS NOT ${R(column)}`
    } else {
      set = `${m} = ${R(column)}`
      const inRange = `(${column} IS NULL OR ABS(${column}) < ${LIMIT_USD})`
      where =
        mode === 'backfill'
          ? `${m} IS NULL AND ${column} IS NOT NULL AND ${inRange}`
          : `${m} IS NOT ${R(column)} AND ${inRange}`
    }
    const stmt = db.prepare(
      `UPDATE ${table} SET ${set} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${where} LIMIT ?)`,
    )
    let rows = 0
    for (;;) {
      db.exec('BEGIN IMMEDIATE')
      let n
      try {
        n = Number(stmt.run(batch).changes)
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
      rows += n
      if (n < batch) break
    }
    if (rows)
      changed.push({
        table,
        column,
        rows,
        ...(MICROS_AUTHORITATIVE.has(table) ? { direction: 'real_from_micros' } : {}),
      })
  }
  return changed
}

export function runAudit(db, { samples = 5 } = {}) {
  const rows = auditRows(db, { samples })
  const aggregates = auditAggregates(db)
  const failed =
    rows.some((r) => r.status !== 'ok') || aggregates.some((a) => a.micros?.equal === false || a.mismatched_hours > 0)
  return { ok: !failed, rows, aggregates }
}

function printText(result, repaired) {
  if (repaired) {
    console.log(`写入：${repaired.length ? '' : '没有需要改写的行'}`)
    for (const r of repaired) console.log(`  ${r.table}.${r.column}: ${r.rows} 行`)
  }
  console.log('逐行比对（x_micros 与 ROUND(x × 1e6)）')
  for (const r of result.rows) {
    if (r.status === 'missing_table' || r.status === 'missing_column') {
      console.log(`  ${r.table}.${r.column}: ${r.status}`)
      continue
    }
    console.log(
      `  ${r.status === 'ok' ? 'ok  ' : 'FAIL'} ${r.table}.${r.column}: ${r.rows} 行，缺整数 ${r.missing_micros}，多整数 ${r.orphan_micros}，不等 ${r.mismatched}，最大差 ${r.max_diff_micros} 微单位`,
    )
    for (const s of r.samples || []) console.log(`        rowid=${s.rowid} real=${s.real} micros=${s.micros}`)
  }
  console.log('汇总口径（新口径：整数列；旧口径：REAL 列）')
  for (const a of result.aggregates) console.log(`  ${a.name}: ${JSON.stringify({ ...a, name: undefined })}`)
  console.log(result.ok ? '结论：一致' : '结论：存在不一致')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2))
  const db = new DatabaseSync(args.db, { readOnly: args.mode === 'read' })
  if (args.mode !== 'read') db.exec('PRAGMA busy_timeout = 5000')
  try {
    const repaired = args.mode === 'read' ? null : repair(db, args.mode)
    const result = runAudit(db, args)
    if (args.json) console.log(JSON.stringify({ db: args.db, mode: args.mode, repaired, ...result }, null, 2))
    else printText(result, repaired)
    process.exitCode = result.ok ? 0 : 1
  } finally {
    db.close()
  }
}
