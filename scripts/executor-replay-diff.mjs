#!/usr/bin/env node
/**
 * 执行事件、回执与账本的比对（docs/control-plane/DEVELOPMENT_PLAN.md P1.9，终审 A1）。只读打开控制面数据库，三个方向：
 *   1. 事件 → 回执：executor_event_inbox 中的 request.finalized 与 gateway_worker_receipts 按（实例, dispatch）逐字段比较，
 *      并比较请求尝试条数与 Worker 尝试列表；
 *   2. 回执 → 事件：已开始消费事件的实例（窗口内有收件记录），其后到达的回执必须有对应的 request.finalized
 *      （Worker 事件日志写入失败、关闭到开启切换窗口内自行确认、数据目录回滚都会造成这类缺失）；最近 5 分钟内的回执记为待到达；
 *   3. 回执 → 账本：有对应 usage_logs 的分发，用量可信度、token 与成本必须与回执一致（按入账同一口径换算）；
 *      对账进入死信、或回执到达 1 小时后仍待结算，算结算差异。
 * 回执 → 事件只检查各实例事件消费窗口（第一条收件到控制面最后一次成功拉取）内的回执；不是客户端请求（没有使用记录）
 * 或已回退到 VM 的请求不比较尝试条数。
 * 已知盲区：有回执、用量完整，但控制面没有对应使用记录的分发（例如控制面在交付途中重启）按现有设计不计费，
 * 本工具既不比较账本也不比较尝试条数，看不到它；这类请求需要从回执表单独核查。
 * 消费窗口要求比对时间窗内至少有一条收件：Worker 事件日志连续故障超过比对时间窗时，该实例整体不在检查范围内，
 * 请调大 --since-hours，或查看「Gateway Worker」页的事件水位（心跳报告 healthy=false，控制面也会告警）。
 * 收件箱中 invalid / failed / missing / diff 状态同样算问题。有任何差异或问题时退出码为 1。
 * 两边字段都源自 Worker 同一份回执，第 1 项只能证明入库完整；能否发现丢失与计费差异取决于第 2、3 项。
 * Worker 响应头不落库，不在比对范围内；响应头与回执的一致性由 e2e 覆盖。
 *
 * 用法：node scripts/executor-replay-diff.mjs --db <kin.db> [--since-hours 24] [--json]
 */
import { DatabaseSync } from 'node:sqlite'
// 本脚本直接开库（不经 db-client 的绑定改写），时间参数自行转成 UTC+8 存储形式
import { dbTime } from '../src/shared/system-time.mjs'
import { canonicalJson } from '../src/lib/gateway-worker/gateway-auth.mjs'
import { normalizeUsage } from '../src/lib/admin/pricing.mjs'
import { disjointOpenaiUsage } from '../src/lib/protocol/openai-usage.mjs'

export const BILLING_FIELDS = Object.freeze([
  'terminal_state',
  'send_state',
  'upstream_status',
  'upstream_model',
  'runtime_account_id',
  'usage_confidence',
  'usage',
])

// 控制面交付时不写请求尝试的 Worker 操作（回执 operation 字段）：只在 primary 下由 request.finalized 补齐
export const NO_REALTIME_ATTEMPTS = Object.freeze(new Set(['live', 'search']))

const RECEIPT_COLUMNS = {
  terminal_state: (row) => row.terminal_state ?? null,
  send_state: (row) => row.send_state ?? null,
  upstream_status: (row) => (row.upstream_status == null ? null : Number(row.upstream_status)),
  upstream_model: (row) => row.upstream_model ?? null,
  runtime_account_id: (row) => row.runtime_account_id ?? null,
  usage_confidence: (row) => row.usage_confidence ?? null,
  usage: (row) => (row.usage_json ? JSON.parse(row.usage_json) : null),
}

const stable = (value) => canonicalJson(value)

// 收件箱中表示问题的状态（计入退出码）
export const PROBLEM_STATUSES = Object.freeze(new Set(['invalid', 'failed', 'missing', 'diff']))
// 回执到达后、事件被拉取前的正常延迟
export const EVENT_LAG_MS = 5 * 60_000
// 回执到达后仍待结算的宽限期
export const SETTLEMENT_GRACE_MS = 60 * 60_000

/** 回执与 usage_logs 行比较（与 GatewayWorkerRepo.applyReceiptToUsage 同一口径），返回不一致的字段。 */
export function compareLedger(receipt, row) {
  if (!row) return []
  const diffs = []
  const raw = receipt.usage_json ? JSON.parse(receipt.usage_json) : null
  const usage = normalizeUsage(disjointOpenaiUsage(raw || {}) || {})
  const input = Number(usage.input_tokens ?? 0)
  const output = Number(usage.output_tokens ?? 0)
  if (receipt.usage_confidence === 'complete' && row.usage_confidence !== 'complete')
    diffs.push({ field: 'ledger.usage_confidence', receipt: receipt.usage_confidence, ledger: row.usage_confidence })
  if (input > 0 && Number(row.input_tokens || 0) !== input)
    diffs.push({ field: 'ledger.input_tokens', receipt: input, ledger: Number(row.input_tokens || 0) })
  if (output > 0 && Number(row.output_tokens || 0) !== output)
    diffs.push({ field: 'ledger.output_tokens', receipt: output, ledger: Number(row.output_tokens || 0) })
  if (receipt.usage_confidence === 'complete' && (input > 0 || output > 0) && row.total_cost == null)
    diffs.push({ field: 'ledger.total_cost', receipt: 'priced', ledger: null })
  return diffs
}

/** 比较一个事件载荷与对应回执行，返回不一致的字段。 */
export function compareFinalized(payload, receipt) {
  if (!receipt) return [{ field: '*', reason: 'receipt_missing' }]
  const diffs = []
  for (const field of BILLING_FIELDS) {
    const expected = payload[field] === undefined ? null : payload[field]
    const actual = RECEIPT_COLUMNS[field](receipt)
    const normalizedExpected = field === 'upstream_status' && expected != null ? Number(expected) : expected
    if (stable(normalizedExpected) !== stable(actual)) diffs.push({ field, event: normalizedExpected, receipt: actual })
  }
  return diffs
}

export function diffDatabase(db, { sinceHours = 24, now = Date.now() } = {}) {
  const since = dbTime(now - sinceHours * 3600_000)
  const rows = db
    .prepare(
      "SELECT event_id,instance_id,payload_json,mode,attempts_state FROM executor_event_inbox WHERE type='request.finalized' AND received_at>=? ORDER BY received_at",
    )
    .all(since)
  const receiptOf = db.prepare('SELECT * FROM gateway_worker_receipts WHERE gateway_instance_id=? AND dispatch_id=?')
  const attemptsOf = db.prepare('SELECT COUNT(*) AS n FROM request_attempts WHERE request_id=?')
  const clientLog = db.prepare('SELECT 1 FROM usage_logs WHERE request_id=? LIMIT 1')
  const vmAttempts = db.prepare(
    "SELECT 1 FROM request_attempts WHERE request_id=? AND COALESCE(selection_reason,'') NOT LIKE 'gateway_worker%' LIMIT 1",
  )
  // 不是客户端请求（账号测试对话等没有使用记录）或请求回退到 VM：补写按设计跳过，不比较尝试条数（终审复核 N1）
  const notClient = (row, requestId) =>
    row.attempts_state === 'not_client' || !clientLog.get(requestId) || !!vmAttempts.get(requestId)
  const report = {
    since,
    checked: 0,
    matched: 0,
    attempts_pending: 0,
    attempts_not_client: 0,
    receipts_checked: 0,
    events_pending: 0,
    differing: [],
  }
  const seen = new Set()
  for (const row of rows) {
    let parsed = null
    try {
      parsed = JSON.parse(row.payload_json)
    } catch {}
    // 收件箱 invalid 行存的是整个信封（终审 A2）
    const payload = parsed && typeof parsed.dispatch_id === 'string' ? parsed : parsed?.payload || {}
    report.checked++
    if (typeof payload.dispatch_id !== 'string' || !payload.dispatch_id) {
      report.differing.push({
        event_id: row.event_id,
        dispatch_id: null,
        diffs: [{ field: '*', reason: 'invalid_event' }],
      })
      continue
    }
    seen.add(`${row.instance_id}|${payload.dispatch_id}`)
    const diffs = compareFinalized(payload, receiptOf.get(row.instance_id, payload.dispatch_id))
    // 请求尝试条数与 Worker 的尝试列表一致（R2 审查 P2-7）
    const expected = Array.isArray(payload.attempts) ? payload.attempts.length : 0
    if (payload.request_id && expected && notClient(row, String(payload.request_id))) report.attempts_not_client++
    else if (payload.request_id && expected) {
      const actual = Number(attemptsOf.get(String(payload.request_id))?.n || 0)
      // 没有实时行时只在两种情况下不算差异、单独计数（R2 第二轮复审 N6）：
      //   - primary 下尚未补齐（入库不到 60 秒，attempts_state 为空）；补齐失败或重试中仍算差异；
      //   - 其他模式下，交付时本就不写请求尝试的通道（语音通话 live、搜索 search，见 NO_REALTIME_ATTEMPTS）
      const pending =
        !actual &&
        (row.mode === 'primary'
          ? row.attempts_state == null
          : NO_REALTIME_ATTEMPTS.has(String(payload.operation || '')))
      if (pending) report.attempts_pending++
      else if (actual !== expected) diffs.push({ field: 'attempts', event: expected, receipt: actual })
    }
    if (diffs.length) report.differing.push({ event_id: row.event_id, dispatch_id: payload.dispatch_id, diffs })
    else report.matched++
  }
  // 回执 → 事件、回执 → 账本
  // 各实例的事件消费窗口：窗口内第一条与最后一条收件之间（切回 off 之后的回执不要求有事件，终审复核）
  const consuming = new Map(
    db
      .prepare(
        `SELECT i.instance_id,MIN(i.received_at) AS first,MAX(i.received_at) AS last,
                (SELECT MAX(c.updated_at) FROM executor_event_cursors c WHERE c.instance_id=i.instance_id) AS pulled
           FROM executor_event_inbox i WHERE i.received_at>=? GROUP BY 1`,
      )
      .all(since)
      .map((row) => [row.instance_id, row]),
  )
  // 窗口开始前一小时内到达的事件也算（回执在窗口内、事件稍早入库）
  const earlier = dbTime(Date.parse(since) - 3600_000)
  for (const row of db
    .prepare(
      "SELECT instance_id,payload_json FROM executor_event_inbox WHERE type='request.finalized' AND received_at>=? AND received_at<?",
    )
    .all(earlier, since)) {
    try {
      const payload = JSON.parse(row.payload_json)
      const dispatch = typeof payload.dispatch_id === 'string' ? payload.dispatch_id : payload.payload?.dispatch_id
      if (dispatch) seen.add(`${row.instance_id}|${dispatch}`)
    } catch {}
  }
  const jobOf = db.prepare(
    'SELECT status FROM gateway_worker_reconciliation_jobs WHERE gateway_instance_id=? AND dispatch_id=? LIMIT 1',
  )
  const ledgerOf = db.prepare(
    "SELECT * FROM usage_logs WHERE execution_kind='gateway_worker' AND dispatch_id=? LIMIT 1",
  )
  const lagSince = dbTime(now - EVENT_LAG_MS)
  for (const receipt of db
    .prepare('SELECT * FROM gateway_worker_receipts WHERE received_at>=? ORDER BY received_at')
    .all(since)) {
    report.receipts_checked++
    const diffs = []
    const window = consuming.get(receipt.gateway_instance_id)
    // 窗口终点取控制面最后一次成功拉取该实例的时刻（每次拉取都刷新游标，即使没有新事件）：仍在消费但事件
    // 写不进 Worker 日志时，后来的回执仍在窗口内、会报缺事件；切回 off 后不再拉取，之后的回执不在窗口内（终审复核 A-N2）
    const windowLast = window ? [window.last, window.pulled].filter(Boolean).sort().at(-1) : null
    const windowEnd = window ? dbTime(Date.parse(windowLast) + EVENT_LAG_MS) : null
    const inWindow = window && receipt.received_at >= window.first && receipt.received_at <= windowEnd
    if (inWindow && !seen.has(`${receipt.gateway_instance_id}|${receipt.dispatch_id}`)) {
      if (receipt.received_at >= lagSince) report.events_pending++
      else diffs.push({ field: '*', reason: 'event_missing' })
    }
    const ledger = ledgerOf.get(receipt.dispatch_id)
    diffs.push(...compareLedger(receipt, ledger))
    // 结算：对账进入死信，或回执到达 1 小时后仍待结算（终审复核）
    if (jobOf.get(receipt.gateway_instance_id, receipt.dispatch_id)?.status === 'dead_letter')
      diffs.push({ field: 'ledger.settlement', receipt: 'settled', ledger: 'dead_letter' })
    else if (ledger?.billing_status === 'settlement_pending' && receipt.received_at < dbTime(now - SETTLEMENT_GRACE_MS))
      diffs.push({ field: 'ledger.settlement', receipt: 'settled', ledger: 'settlement_pending' })
    if (diffs.length) report.differing.push({ event_id: null, dispatch_id: receipt.dispatch_id, diffs })
  }
  report.statuses = db
    .prepare('SELECT type,mode,status,COUNT(*) AS n FROM executor_event_inbox WHERE received_at>=? GROUP BY 1,2,3')
    .all(since)
    .map((row) => ({ ...row }))
  report.problems = report.statuses
    .filter((row) => PROBLEM_STATUSES.has(row.status))
    .reduce((sum, row) => sum + Number(row.n || 0), 0)
  return report
}

function main(argv) {
  const value = (flag) => {
    const index = argv.indexOf(flag)
    return index >= 0 ? argv[index + 1] : null
  }
  const dbPath = value('--db')
  if (!dbPath) {
    console.error('usage: node scripts/executor-replay-diff.mjs --db <kin.db> [--since-hours 24] [--json]')
    process.exit(2)
  }
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const report = diffDatabase(db, { sinceHours: Number(value('--since-hours') || 24) })
    if (argv.includes('--json')) console.log(JSON.stringify(report, null, 2))
    else {
      console.log(
        `since ${report.since}: events checked ${report.checked}, matched ${report.matched}, receipts checked ${report.receipts_checked}, differing ${report.differing.length}, inbox problems ${report.problems}, attempts pending ${report.attempts_pending}, attempts not client ${report.attempts_not_client}, events pending ${report.events_pending}`,
      )
      for (const row of report.statuses) console.log(`  ${row.type}\t${row.mode}\t${row.status}\t${row.n}`)
      for (const item of report.differing.slice(0, 50))
        console.log(
          `  DIFF ${item.dispatch_id}: ${item.diffs.map((diff) => diff.field + (diff.reason ? `(${diff.reason})` : '')).join(', ')}`,
        )
    }
    process.exitCode = report.differing.length || report.problems ? 1 : 0
  } finally {
    db.close()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2))
