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
 * 检查项与每日对账（审计阶段 2 W9）共用 src/lib/admin/billing-reconcile.mjs，说明见该文件：
 *   1. 逐表逐行：`x_micros` 与 `CAST(ROUND(x * 1e6) AS INTEGER)`（缺失、多出、不等、超范围与样例 rowid）；
 *   2. 汇总口径：用量汇总 = 明细（只比较保留期清理边界之后的小时）、结算 = 使用记录实际价、
 *      钱包余额 = Σ流水 − Σ结算扣费（本脚本没有基线，任何差额都判错；另报告负余额钱包）、供应商已付 ≤ 应付；
 *   3. 三方核对：结算扣费 ↔ 使用记录 ↔ 供应商用量事实的行数与金额、缺失与多出；
 *   4. 近 24 小时 unmetered 金额占比（超过 5% 判错）；5. settlement_pending 超过 1 小时的记录数。
 * 退出码：有 error 级发现项（findings）时为 1，其余为 0（写模式按写入后的结果判定）。
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
import { moneyMirrorPairs } from '../src/lib/core/money-columns.mjs'
import { auditAggregates, auditRows, runReconcile } from '../src/lib/admin/billing-reconcile.mjs'

export { auditAggregates, auditRows }

const ROLLUPS = new Set(['usage_cost_hourly', 'usage_stats_hourly'])
const R = (column) => `CAST(ROUND(${column} * 1000000) AS INTEGER)`

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

/** 全部检查（与每日对账同一份，见 src/lib/admin/billing-reconcile.mjs）；脚本没有钱包差额基线，任何差额都判错。 */
export async function runAudit(db, { samples = 5, now = Date.now(), unmeteredRatio } = {}) {
  return runReconcile(db, { samples, now, ...(unmeteredRatio == null ? {} : { unmeteredRatio }) })
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
  console.log('汇总口径与三方核对（新口径：整数列；旧口径：REAL 列）')
  for (const a of result.aggregates)
    console.log(`  ${a.name}: ${JSON.stringify({ ...a, name: undefined, key: undefined })}`)
  for (const f of result.findings) console.log(`  ${f.severity === 'error' ? 'FAIL' : 'WARN'} ${f.code}: ${f.count}`)
  console.log(result.ok ? '结论：一致' : '结论：存在不一致')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2))
  const db = new DatabaseSync(args.db, { readOnly: args.mode === 'read' })
  if (args.mode !== 'read') db.exec('PRAGMA busy_timeout = 5000')
  try {
    const repaired = args.mode === 'read' ? null : repair(db, args.mode)
    const result = await runAudit(db, args)
    if (args.json) console.log(JSON.stringify({ db: args.db, mode: args.mode, repaired, ...result }, null, 2))
    else printText(result, repaired)
    process.exitCode = result.ok ? 0 : 1
  } finally {
    db.close()
  }
}
