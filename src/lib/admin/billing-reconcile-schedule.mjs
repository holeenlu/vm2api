/**
 * 每日计费对账的调度、留痕与告警（审计阶段 2 W9）。
 *
 * - 时刻：routing.json `relay_billing.reconcile_at`（UTC+8 `HH:MM`，默认 03:30，空串关闭）。每 5 分钟检查一次，
 *   当天到点后 3 小时内补跑（停机错过时）；同一天只跑一次，重启后按操作审计里当天已有的对账行判定。
 * - 执行：检查在 Worker 线程（billing-reconcile-thread.mjs）的只读连接、一个读事务里跑，全表求和不占主线程；
 *   主线程只读上一次对账的审计行（钱包差额基线）并写入本次结果。
 * - 留痕：每次写一条 operation_audit（actor `system`、action `billing.reconcile`、target 为 UTC+8 对账日），
 *   after_json 为结论、发现项、汇总口径、指标与钱包差额（下次的基线）；对账失败也写一条（沿用上次基线）。
 * - 告警：有 error 级发现项或对账失败时，经 notify.mjs 推送 `billing_reconcile` 事件（面板通知设置可关），
 *   受通知总开关与通道配置约束；推送结果写日志，不重试（次日照常对账）。
 */
import { Worker } from 'node:worker_threads'
import { systemDate, systemDateTime } from '../../shared/system-time.mjs'
import { normalizeRelayBillingPolicy } from './billing-inflight.mjs'
import { DEFAULT_NOTIFY, dispatchNotify, normalizeNotifyConfig, notifyChannelsReady } from './notify.mjs'
import { audit } from './relay-common.mjs'
import { lastReconcileAudit } from './repos/billing-reconcile-repo.mjs'

export const RECONCILE_AUDIT_ACTION = 'billing.reconcile'
const TICK_MS = 5 * 60_000
const CATCH_UP_MINUTES = 180
const RUN_TIMEOUT_MS = 20 * 60_000

/** UTC+8 当天是否该跑：到点后 CATCH_UP_MINUTES 内、且当天还没跑过。`at` 为空表示关闭。 */
export function reconcileDue({ now = Date.now(), at, lastRunDay = null } = {}) {
  if (!at) return false
  const local = systemDateTime(now)
  if (lastRunDay === local.slice(0, 10)) return false
  const [h, m] = at.split(':').map(Number)
  const minute = Number(local.slice(11, 13)) * 60 + Number(local.slice(14, 16))
  return minute >= h * 60 + m && minute < h * 60 + m + CATCH_UP_MINUTES
}

/** 在 Worker 线程里跑一次全部检查；超时或线程出错时拒绝。 */
export function reconcileInWorker(dbPath, options = {}, { timeoutMs = RUN_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./billing-reconcile-thread.mjs', import.meta.url), {
      workerData: { dbPath, options },
      execArgv: process.execArgv.filter((arg) => !arg.startsWith('--input-type')),
    })
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn(value)
      void worker.terminate()
    }
    const timer = setTimeout(
      () => finish(reject, Object.assign(new Error('billing reconcile timed out'), { code: 'reconcile_timeout' })),
      timeoutMs,
    )
    worker.on('message', ({ value, error }) =>
      error ? finish(reject, Object.assign(new Error(error.message), { code: error.code })) : finish(resolve, value),
    )
    worker.on('error', (error) => finish(reject, error))
    worker.on('exit', (code) => finish(reject, new Error(`billing reconcile worker exited (${code})`)))
  })
}

const RECONCILE_TITLE = '计费对账异常'
const percent = (value) => `${(Number(value) * 100).toFixed(2)}%`
const shanghaiClock = (iso) => new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })

// 发现项文案（billing-reconcile.mjs findingsOf）
const RECONCILE_FINDING_LABELS = {
  reconcile_failed: '对账未完成',
  money_rows: '金额整数列与 REAL 列不一致的列',
  usage_rollup: '用量小时汇总与明细不一致的检查项',
  charge_amount: '结算扣费与使用记录实际价不一致',
  wallet_offset: '钱包余额 ≠ Σ流水 − Σ扣费（新出现或变化）',
  vendor_overpaid: '供应商结算单已付超过应付',
  charge_without_usage: '有扣费没有使用记录',
  settled_without_charge: '使用记录已结算但没有扣费',
  vendor_fact_without_usage: '供应商用量事实找不到使用记录',
  usage_missing_vendor_fact: '使用记录缺供应商用量事实',
  unmetered_ratio: '未计费（unmetered）金额占比超过阈值',
  settlement_pending_stale: 'settlement_pending 超过 1 小时',
}

/**
 * 每日计费对账异常的推送文案（notify.mjs 的 `billing_reconcile` 事件，经同一 dispatchNotify 通道发送）：
 * 只列 error 级发现项，附 unmetered 占比与负余额钱包。
 */
export function formatBillingReconcileMessage(report = {}, cfg = DEFAULT_NOTIFY, baseUrl = '') {
  const title = RECONCILE_TITLE
  const lines = [`【KIN】${title}`, '']
  if (report.day) lines.push(`对账日 ${report.day}（UTC+8）`)
  for (const f of (report.findings || []).filter((row) => row.severity === 'error')) {
    let line = `· ${RECONCILE_FINDING_LABELS[f.code] || f.code}：${f.count}`
    if (f.code === 'unmetered_ratio')
      line = `· ${RECONCILE_FINDING_LABELS[f.code]}：${percent(f.ratio)}（阈值 ${percent(f.threshold)}）`
    if (f.code === 'reconcile_failed') line = `· ${RECONCILE_FINDING_LABELS[f.code]}：${f.error || 'unknown'}`
    if (f.code === 'settlement_pending_stale' && f.oldest) line += `，最早 ${shanghaiClock(f.oldest)}`
    lines.push(line)
  }
  const metrics = report.metrics || {}
  if (metrics.unmetered_ratio != null) lines.push('', `近 24 小时 unmetered 占比 ${percent(metrics.unmetered_ratio)}`)
  if (metrics.negative_wallets)
    lines.push(
      `负余额钱包 ${metrics.negative_wallets} 个，最低 $${(Number(metrics.min_balance_micros) / 1e6).toFixed(2)}`,
    )
  lines.push('', '明细见操作审计 billing.reconcile；复核：node scripts/audit-money-micros.mjs')
  const url = String(cfg.console_url || baseUrl || '').replace(/\/$/, '')
  if (url) lines.push(`${url}/#/billing`)
  return { title, text: lines.join('\n'), subject: `KIN · ${title}` }
}

function previousBaseline(row) {
  try {
    const offsets = JSON.parse(row?.after_json || 'null')?.wallet_offsets
    return offsets && typeof offsets === 'object' ? offsets : null
  } catch {
    return null
  }
}

function metricsOf(result) {
  const by = Object.fromEntries((result.aggregates || []).filter((a) => a.key).map((a) => [a.key, a]))
  return {
    unmetered_ratio: by.unmetered?.ratio ?? null,
    unmetered_micros: by.unmetered?.unmetered_micros ?? null,
    settlement_pending_stale: by.settlement_pending?.count ?? null,
    negative_wallets: by.wallets?.negative.wallets ?? null,
    min_balance_micros: by.wallets?.negative.min_balance_micros ?? null,
    charges_micros: by.charge_usage?.charges.micros ?? null,
    settled_usage_micros: by.charge_usage?.settled_usage.micros ?? null,
    vendor_facts_micros: by.vendor_facts?.facts.micros ?? null,
    vendor_eligible_micros: by.vendor_facts?.eligible_usage.micros ?? null,
  }
}

/**
 * 跑一次对账并留痕、按需告警。deps：db（主连接，写审计）、dbPath（Worker 打开的库文件）、policy（relay_billing）、
 * notifyConfig、baseUrl、send（测试替身；缺省 dispatchNotify）、runner（测试替身；缺省 reconcileInWorker）、now、log。
 * 返回 `{ day, ok, findings, metrics, notified }`。
 */
export async function runDailyReconcile({
  db,
  dbPath,
  policy = {},
  notifyConfig = null,
  baseUrl = '',
  send = null,
  runner = reconcileInWorker,
  now = Date.now(),
  log = console,
} = {}) {
  const day = systemDate(now)
  const { reconcile_unmetered_ratio: unmeteredRatio } = normalizeRelayBillingPolicy(policy)
  const baseline = previousBaseline(await lastReconcileAudit(db, RECONCILE_AUDIT_ACTION))
  let result
  try {
    result = await runner(dbPath, { now, unmeteredRatio, walletBaseline: baseline })
  } catch (error) {
    const message = String(error?.message || error).slice(0, 300)
    result = {
      ok: false,
      aggregates: [],
      rows: [],
      findings: [{ code: 'reconcile_failed', severity: 'error', count: 1, error: message }],
      // 对账没跑完：沿用上次的基线，免得下次把历史差额当成新出现
      wallet_offsets: baseline || undefined,
    }
  }
  const report = {
    day,
    ok: result.ok,
    findings: result.findings,
    metrics: metricsOf(result),
    aggregates: result.aggregates,
    rows: (result.rows || []).filter((r) => r.status !== 'ok'),
    wallet_offsets: result.wallet_offsets,
  }
  await audit(db, 'system', RECONCILE_AUDIT_ACTION, day, null, report, result.ok ? 'ok' : 'mismatch')
  let notified = null
  const cfg = normalizeNotifyConfig(notifyConfig || {})
  if (!result.ok && cfg.enabled && cfg.events.billing_reconcile && (send || notifyChannelsReady(cfg).any)) {
    const message = formatBillingReconcileMessage(report, cfg, baseUrl)
    try {
      notified = await (send || ((msg) => dispatchNotify(cfg, msg)))(message, { type: 'billing_reconcile', report })
    } catch (error) {
      notified = { ok: false, error: String(error?.message || error).slice(0, 180) }
    }
    if (notified?.ok === false) log?.warn?.(`[billing-reconcile] alert delivery failed: ${notified.error || 'unknown'}`)
  }
  if (!result.ok)
    log?.warn?.(
      `[billing-reconcile] ${day}: ${result.findings
        .filter((f) => f.severity === 'error')
        .map((f) => `${f.code}=${f.count}`)
        .join(', ')}`,
    )
  return { day, ok: result.ok, findings: result.findings, metrics: report.metrics, notified }
}

let timer = null

/**
 * 注册每日对账（只启动一次；定时器不阻止进程退出）。deps 取值都在每次检查时调用，备份恢复换连接、面板改配置后即生效：
 * getDb、getDbPath、getPolicy（relay_billing）、getNotifyConfig、baseUrl、log。
 */
export function startBillingReconcile({
  getDb,
  getDbPath,
  getPolicy,
  getNotifyConfig,
  baseUrl = '',
  log = console,
  now = () => Date.now(),
} = {}) {
  if (timer) return
  let lastRunDay = null
  let running = false
  const primed = (async () => {
    try {
      const row = await lastReconcileAudit(getDb(), RECONCILE_AUDIT_ACTION)
      lastRunDay = row?.created_at ? systemDate(row.created_at) : null
    } catch {}
  })()
  const tick = async () => {
    await primed
    if (running) return
    const at = normalizeRelayBillingPolicy(getPolicy?.() || {}).reconcile_at
    const current = now()
    if (!reconcileDue({ now: current, at, lastRunDay })) return
    const dbPath = getDbPath?.()
    if (!dbPath) return
    running = true
    lastRunDay = systemDate(current)
    try {
      await runDailyReconcile({
        db: getDb(),
        dbPath,
        policy: getPolicy?.() || {},
        notifyConfig: getNotifyConfig?.() || null,
        baseUrl,
        now: current,
        log,
      })
    } catch (error) {
      log?.warn?.(`[billing-reconcile] run failed: ${error?.message || error}`)
    } finally {
      running = false
    }
  }
  timer = setInterval(() => void tick().catch(() => {}), TICK_MS)
  timer.unref?.()
  setImmediate(() => void tick().catch(() => {}))
}

/** 测试用。 */
export function stopBillingReconcile() {
  if (timer) clearInterval(timer)
  timer = null
}
