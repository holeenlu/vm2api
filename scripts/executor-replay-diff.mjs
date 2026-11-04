#!/usr/bin/env node
/**
 * 执行事件与回执的计费字段比对（docs/control-plane/DEVELOPMENT_PLAN.md P1.9）。只读打开控制面数据库，
 * 把 executor_event_inbox 中的 request.finalized 与 gateway_worker_receipts 按（实例, dispatch）逐字段比较。
 * 用于影子期核对与切换前验收（primary 下回执本身由事件写入，比对只用于核查入库是否完整）；有差异或缺失时退出码为 1。
 * 同时比较请求尝试条数与 Worker 尝试列表。Worker 响应头不落库，不在比对范围内；响应头与回执的一致性由 e2e 覆盖。
 *
 * 用法：node scripts/executor-replay-diff.mjs --db <kin.db> [--since-hours 24] [--json]
 */
import { DatabaseSync } from 'node:sqlite'
import { canonicalJson } from '../src/lib/gateway-worker/gateway-auth.mjs'

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
  const since = new Date(now - sinceHours * 3600_000).toISOString()
  const rows = db
    .prepare(
      "SELECT event_id,instance_id,payload_json,mode,attempts_state FROM executor_event_inbox WHERE type='request.finalized' AND received_at>=? ORDER BY received_at",
    )
    .all(since)
  const receiptOf = db.prepare('SELECT * FROM gateway_worker_receipts WHERE gateway_instance_id=? AND dispatch_id=?')
  const attemptsOf = db.prepare('SELECT COUNT(*) AS n FROM request_attempts WHERE request_id=?')
  const report = { since, checked: 0, matched: 0, attempts_pending: 0, differing: [] }
  for (const row of rows) {
    const payload = JSON.parse(row.payload_json)
    const diffs = compareFinalized(payload, receiptOf.get(row.instance_id, payload.dispatch_id))
    // 请求尝试条数与 Worker 的尝试列表一致（R2 审查 P2-7）
    const expected = Array.isArray(payload.attempts) ? payload.attempts.length : 0
    if (payload.request_id && expected) {
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
    report.checked++
    if (diffs.length) report.differing.push({ event_id: row.event_id, dispatch_id: payload.dispatch_id, diffs })
    else report.matched++
  }
  report.statuses = db
    .prepare('SELECT type,mode,status,COUNT(*) AS n FROM executor_event_inbox WHERE received_at>=? GROUP BY 1,2,3')
    .all(since)
    .map((row) => ({ ...row }))
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
        `since ${report.since}: checked ${report.checked}, matched ${report.matched}, differing ${report.differing.length}, attempts pending ${report.attempts_pending}`,
      )
      for (const row of report.statuses) console.log(`  ${row.type}\t${row.mode}\t${row.status}\t${row.n}`)
      for (const item of report.differing.slice(0, 50))
        console.log(
          `  DIFF ${item.dispatch_id}: ${item.diffs.map((diff) => diff.field + (diff.reason ? `(${diff.reason})` : '')).join(', ')}`,
        )
    }
    process.exitCode = report.differing.length ? 1 : 0
  } finally {
    db.close()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2))
