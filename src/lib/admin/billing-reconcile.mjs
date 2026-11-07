/**
 * 计费对账检查（审计阶段 2 W9，原 scripts/audit-money-micros.mjs 的检查部分）。只读。
 *
 * 每日对账（billing-reconcile-schedule.mjs，Worker 线程的只读连接、一个读事务）与运维脚本
 * `scripts/audit-money-micros.mjs` 共用这里的检查；SQL 在 repos/billing-reconcile-repo.mjs。
 *
 * 检查项：
 *   1. 逐表逐行：`x_micros` 与 `CAST(ROUND(x * 1e6) AS INTEGER)`（缺失、多出、不等、超范围）。
 *   2. 汇总口径（只比较保留期清理边界 settings.usage_logs_pruned_through 所在小时之后：迁移 132 起清理不扣减汇总）：
 *      - 用量汇总 = 明细：usage_stats_hourly.cost 与 usage_cost_hourly 的五个成本列，新口径整数列逐项相等，
 *        旧口径 REAL 列只报告差值；另按小时统计不相等的桶数；
 *      - 结算 = 使用记录实际价：billing_charges.actual_micros 与同一 request_id 的已结算使用记录；
 *      - 钱包余额 = Σ流水 − Σ结算扣费（非套餐、非豁免）：按钱包（个人或管理域）比较；
 *        每日对账以上一次对账记下的差额为基线，差额出现或变化才判错（只告警一次），不变的历史差额只报告；
 *        没有基线（运维脚本、第一次对账）时任何差额都判错；另报告负余额钱包数与最低余额；
 *      - 供应商结算单已付 ≤ 应付。
 *   3. 三方核对（明细完整的小时内）：
 *      - 结算扣费 ↔ 使用记录：只有扣费没有使用记录、标为 settled 却没有扣费的行；
 *      - 使用记录 ↔ 供应商用量事实：找不到使用记录的事实、按当前计入口径（vendorFactEligibleSql，
 *        W10 调整供应商结算口径时一起改）应有事实却没有的使用记录（只看 1 小时前的记录）；
 *        事实金额与使用记录官方价不同只报告（事实是不可变的结算依据，手动重新定价会改使用记录）。
 *   4. unmetered 金额占比：近 24 小时客户 Key 的成功请求中，unmetered 的官方价合计 / 全部官方价合计，
 *      超过阈值（relay_billing.reconcile_unmetered_ratio，默认 5%，0 不判）判错。
 *   5. 停在 settlement_pending 超过 1 小时的使用记录数。
 * 结论：findings 中 severity 为 error 的项为不一致（ok=false）；warn 只报告。
 */
import { MONEY_MIRRORS, moneyMirrorPairs } from '../core/money-columns.mjs'
import {
  chargeAmountMismatches,
  chargeUsagePairing,
  domainWallets,
  moneyColumnSamples,
  moneyColumnStats,
  staleSettlementPending,
  tableColumns,
  unmeteredShare,
  usageCostRollup,
  usagePrunedThroughSetting,
  usageStatsRollup,
  userWallets,
  vendorFactPairing,
  vendorOverpaid,
} from './repos/billing-reconcile-repo.mjs'

export const RECONCILE_DEFAULTS = Object.freeze({
  samples: 5,
  unmeteredRatio: 0.05,
  windowMs: 24 * 3600_000,
  pendingStaleMs: 3600_000,
  factGraceMs: 3600_000,
})
/** 审计行里最多记这么多个钱包差额（基线）；超出时只记前面的，其余下次按“出现”判。 */
export const WALLET_OFFSET_LIMIT = 1000

const num = (v) => Number(v || 0)

/** 第 1 项：逐表逐行比对。 */
export async function auditRows(db, { samples = RECONCILE_DEFAULTS.samples } = {}) {
  const out = []
  for (const [table, column] of moneyMirrorPairs()) {
    const cols = await tableColumns(db, table)
    if (!cols.size) {
      out.push({ table, column, status: 'missing_table' })
      continue
    }
    if (!cols.has(column + '_micros') || !cols.has(column)) {
      out.push({ table, column, status: 'missing_column' })
      continue
    }
    const row = await moneyColumnStats(db, table, column)
    const bad = num(row.missing_micros) + num(row.orphan_micros) + num(row.mismatched) + num(row.out_of_range)
    const sample = bad && samples ? await moneyColumnSamples(db, table, column, samples) : []
    out.push({
      table,
      column,
      status: bad ? 'mismatch' : 'ok',
      rows: num(row.rows),
      missing_micros: num(row.missing_micros),
      orphan_micros: num(row.orphan_micros),
      mismatched: num(row.mismatched),
      max_diff_micros: num(row.max_diff_micros),
      out_of_range: num(row.out_of_range),
      samples: sample.map((r) => ({ rowid: r.rowid, real: r.real, micros: r.micros })),
    })
  }
  return out
}

function compare(name, { micros, real }, extra = {}) {
  const n = { detail: num(micros.detail), rollup: num(micros.rollup) }
  const o = { detail: num(real.detail), rollup: num(real.rollup) }
  return { name, micros: { ...n, equal: n.detail === n.rollup }, real: { ...o, diff: o.rollup - o.detail }, ...extra }
}

/**
 * 保留期清理已删到哪个小时：返回清理边界所在小时（`YYYY-MM-DDTHH`），汇总口径与三方核对只比较之后的小时；
 * 从未清理时返回 ''（比较全部小时）。
 */
async function prunedThroughHour(db) {
  if (!(await tableColumns(db, 'settings')).size) return ''
  try {
    const value = await usagePrunedThroughSetting(db)
    return value ? String(JSON.parse(value) || '').slice(0, 13) : ''
  } catch {
    return ''
  }
}

/** 钱包差额：返回报告项与本次的非零差额（钱包键 → 微单位），按基线区分新出现或变化的与不变的。 */
async function auditWallets(db, has, baseline) {
  const users = await userWallets(db)
  const domains = has.admin_domains ? await domainWallets(db) : []
  const wallets = [
    ...users.map((r) => ({ key: `user:${r.id}`, ...r })),
    ...domains.map((r) => ({ key: `domain:${r.id}`, ...r })),
  ]
  const offsets = {}
  let changed = 0
  let known = 0
  for (const w of wallets) {
    const offset = num(w.balance_micros) - (num(w.ledger) - num(w.charged))
    if (offset === 0) continue
    if (Object.keys(offsets).length < WALLET_OFFSET_LIMIT) offsets[w.key] = offset
    if (baseline && baseline[w.key] === offset) known++
    else changed++
  }
  const negative = wallets.filter((w) => num(w.balance_micros) < 0)
  return {
    offsets,
    report: {
      name: '钱包余额 = Σ流水 − Σ结算扣费',
      wallets: wallets.length,
      baseline: baseline ? 'previous_reconcile' : 'none',
      micros: { wallets_with_offset: changed + known, offset_changed: changed, offset_known: known },
      negative: {
        wallets: negative.length,
        min_balance_micros: negative.length ? Math.min(...negative.map((w) => num(w.balance_micros))) : null,
      },
      real: {
        users_balance_mirror_drift: users.filter((r) => Math.abs(num(r.balance) - num(r.balance_micros) / 1e6) > 5e-7)
          .length,
      },
    },
  }
}

/**
 * 第 2–5 项。opts：now（毫秒）、unmeteredRatio（0 不判）、walletBaseline（上次对账的钱包差额，null 表示无基线）。
 * 返回 `{ aggregates, walletOffsets }`；各项的判定见 findingsOf。
 */
export async function auditAggregates(db, opts = {}) {
  const { now = Date.now(), unmeteredRatio = RECONCILE_DEFAULTS.unmeteredRatio, walletBaseline = null } = opts
  const names = ['usage_logs', 'usage_stats_hourly', 'usage_cost_hourly', 'billing_charges', 'wallet_ledger']
  const extra = ['admin_domains', 'vendor_settlements', 'vendor_usage_facts', 'vendor_resources', 'users']
  const has = {}
  for (const table of [...names, ...extra]) has[table] = (await tableColumns(db, table)).size > 0
  const out = []
  const after = await prunedThroughHour(db)
  if (has.usage_stats_hourly) {
    const r = await usageStatsRollup(db, after)
    out.push(
      compare('usage_stats_hourly.cost = Σ usage_logs.actual_cost', r, { mismatched_hours: num(r.mismatched_hours) }),
    )
  }
  if (has.usage_cost_hourly)
    for (const column of MONEY_MIRRORS.usage_cost_hourly)
      out.push(
        compare(`usage_cost_hourly.${column} = Σ usage_logs.${column}`, await usageCostRollup(db, column, after)),
      )
  if (has.billing_charges) {
    const row = await chargeAmountMismatches(db)
    out.push({
      name: 'billing_charges.actual_micros = usage_logs.actual_cost（已结算）',
      key: 'charge_amount',
      rows: num(row.n),
      micros: { mismatched: num(row.micros_diff) },
      real: { mismatched: num(row.real_diff) },
    })
  }
  let walletOffsets = {}
  if (has.wallet_ledger && has.users) {
    const wallets = await auditWallets(db, has, walletBaseline)
    walletOffsets = wallets.offsets
    out.push({ key: 'wallets', ...wallets.report })
  }
  if (has.vendor_settlements && (await tableColumns(db, 'vendor_settlements')).has('amount_usdt_micros')) {
    const row = await vendorOverpaid(db)
    out.push({
      name: '供应商结算单已付 ≤ 应付',
      key: 'vendor_overpaid',
      rows: num(row.n),
      micros: { overpaid: num(row.over_micros) },
      real: { overpaid: num(row.over_real) },
    })
  }
  if (has.billing_charges && has.usage_logs) {
    const { charges, settled } = await chargeUsagePairing(db, after)
    out.push({
      name: '结算扣费 ↔ 使用记录（明细完整的小时）',
      key: 'charge_usage',
      charges: { rows: num(charges.rows), micros: num(charges.micros), without_usage: num(charges.without_usage) },
      settled_usage: {
        rows: num(settled.rows),
        micros: num(settled.micros),
        without_charge: num(settled.without_charge),
      },
    })
  }
  if (has.vendor_usage_facts && has.vendor_resources && has.usage_logs) {
    const settledBefore = new Date(now - RECONCILE_DEFAULTS.factGraceMs).toISOString()
    const { facts, eligible } = await vendorFactPairing(db, after, settledBefore)
    out.push({
      name: '使用记录 ↔ 供应商用量事实（明细完整的小时，当前计入口径）',
      key: 'vendor_facts',
      facts: {
        rows: num(facts.rows),
        micros: num(facts.micros),
        without_request: num(facts.without_request),
        without_usage: num(facts.without_usage),
        amount_mismatch: num(facts.amount_mismatch),
      },
      eligible_usage: {
        rows: num(eligible.rows),
        micros: num(eligible.micros),
        missing_fact: num(eligible.missing_fact),
      },
    })
  }
  if (has.usage_logs) {
    const since = new Date(now - RECONCILE_DEFAULTS.windowMs).toISOString()
    const until = new Date(now).toISOString()
    const row = await unmeteredShare(db, since, until)
    const micros = num(row.micros)
    out.push({
      name: 'unmetered 金额占比（近 24 小时客户 Key 成功请求，官方价）',
      key: 'unmetered',
      since,
      until,
      rows: num(row.rows),
      micros,
      unmetered_rows: num(row.unmetered_rows),
      unmetered_micros: num(row.unmetered_micros),
      unmetered_unpriced: num(row.unmetered_unpriced),
      ratio: micros > 0 ? num(row.unmetered_micros) / micros : 0,
      threshold: unmeteredRatio,
    })
    const pending = await staleSettlementPending(db, new Date(now - RECONCILE_DEFAULTS.pendingStaleMs).toISOString())
    out.push({
      name: 'settlement_pending 超过 1 小时',
      key: 'settlement_pending',
      count: num(pending.n),
      oldest: pending.oldest || null,
    })
  }
  return { aggregates: out, walletOffsets }
}

/** 由检查结果得出发现项：`{ code, severity: 'error' | 'warn', count, ... }`。 */
export function findingsOf(rows, aggregates) {
  const out = []
  const add = (code, severity, count, detail = {}) => {
    if (count > 0) out.push({ code, severity, count, ...detail })
  }
  const badRows = rows.filter((r) => r.status !== 'ok')
  add('money_rows', 'error', badRows.length, { columns: badRows.map((r) => `${r.table}.${r.column}`).slice(0, 20) })
  const rollups = aggregates.filter((a) => a.micros?.equal === false || a.mismatched_hours > 0)
  add('usage_rollup', 'error', rollups.length, { checks: rollups.map((a) => a.name) })
  const by = Object.fromEntries(aggregates.filter((a) => a.key).map((a) => [a.key, a]))
  add('charge_amount', 'error', num(by.charge_amount?.micros.mismatched))
  add('wallet_offset', 'error', num(by.wallets?.micros.offset_changed))
  add('wallet_offset_known', 'warn', num(by.wallets?.micros.offset_known))
  add('vendor_overpaid', 'error', num(by.vendor_overpaid?.micros.overpaid))
  add('charge_without_usage', 'error', num(by.charge_usage?.charges.without_usage))
  add('settled_without_charge', 'error', num(by.charge_usage?.settled_usage.without_charge))
  add('vendor_fact_without_usage', 'error', num(by.vendor_facts?.facts.without_usage))
  add('usage_missing_vendor_fact', 'error', num(by.vendor_facts?.eligible_usage.missing_fact))
  add('vendor_fact_amount', 'warn', num(by.vendor_facts?.facts.amount_mismatch))
  const unmetered = by.unmetered
  if (unmetered && unmetered.threshold > 0 && unmetered.ratio > unmetered.threshold)
    add('unmetered_ratio', 'error', unmetered.unmetered_rows || 1, {
      ratio: unmetered.ratio,
      threshold: unmetered.threshold,
      unmetered_micros: unmetered.unmetered_micros,
    })
  add('settlement_pending_stale', 'error', num(by.settlement_pending?.count), {
    oldest: by.settlement_pending?.oldest ?? null,
  })
  return out
}

/**
 * 全部检查。opts：samples、now、unmeteredRatio、walletBaseline（见 auditAggregates）。
 * 返回 `{ ok, rows, aggregates, findings, wallet_offsets }`。
 */
export async function runReconcile(db, opts = {}) {
  const rows = await auditRows(db, opts)
  const { aggregates, walletOffsets } = await auditAggregates(db, opts)
  const findings = findingsOf(rows, aggregates)
  return {
    ok: !findings.some((f) => f.severity === 'error'),
    rows,
    aggregates,
    findings,
    wallet_offsets: walletOffsets,
  }
}
