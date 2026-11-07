// 每日计费对账（审计阶段 2 W9）：三方核对、钱包差额基线、unmetered 占比、settlement_pending 超时、
// 留痕与告警、Worker 线程与调度时刻。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDatabase, closeDatabase, getDbPath } from '../../src/lib/db/database.mjs'
import { PanelUserStore } from '../../src/lib/admin/panel-users.mjs'
import { ApiKeyStore } from '../../src/lib/admin/api-keys.mjs'
import { GroupsRepo } from '../../src/lib/db/repos/groups-repo.mjs'
import { RelayBilling } from '../../src/lib/admin/relay-billing.mjs'
import { UsageLogsRepo } from '../../src/lib/db/repos/usage-logs-repo.mjs'
import { runReconcile } from '../../src/lib/admin/billing-reconcile.mjs'
import {
  formatBillingReconcileMessage,
  RECONCILE_AUDIT_ACTION,
  reconcileDue,
  reconcileInWorker,
  runDailyReconcile,
} from '../../src/lib/admin/billing-reconcile-schedule.mjs'
import { mergeNotifyConfig, normalizeNotifyConfig } from '../../src/lib/admin/notify.mjs'
import { dbTime } from '../../src/shared/system-time.mjs'

const ROOT = path.resolve(import.meta.dirname, '../..')
const model = 'claude-sonnet-5'
const body = { model, max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] }
const ago = (ms) => dbTime(Date.now() - ms)
const HOUR = 3600_000
const log = { warn() {} }
const errors = (result) =>
  result.findings
    .filter((f) => f.severity === 'error')
    .map((f) => f.code)
    .sort()

/** 一笔经真实写入路径的完整交易：充值流水、准入与结算扣费、使用记录（经 VM 绑定写供应商用量事实）。 */
async function seed(t) {
  await closeDatabase()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-reconcile-'))
  const db = openDatabase({ dataDir: dir })
  t.after(async () => {
    await closeDatabase()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const user = await new PanelUserStore({ db }).create({ username: 'customer', password: 'customer-pass' })
  const groups = new GroupsRepo(db)
  const group = await groups.create({ name: 'service', platform: 'anthropic' })
  await groups.setGrants(user.id, [group.id])
  const key = await new ApiKeyStore({ db }).create({ user_id: user.id, group_id: group.id })
  const billing = new RelayBilling(db)
  await billing.adjust(user.id, { amount: 10, reason: 'credit', idempotency_key: 'credit-1' }, 'test-admin')
  const context = await billing.authorize(key, 'req-1', model, body)
  const charge = await billing.settle(context, { input_tokens: 1000, output_tokens: 100 }, model)
  assert.ok(charge.actual_micros > 0)
  const early = ago(48 * HOUR)
  db.prepare(
    "INSERT INTO vendors(id,name,external_code,email,tier,root_id,created_by,created_at,updated_at) VALUES('v1','V','v1','v1@example.test',1,'v1','t',?,?)",
  ).run(early, early)
  const resource = db.prepare(
    'INSERT INTO vendor_resources(id,vendor_id,resource_type,name,status,config_json,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
  )
  resource.run('vm-res', 'v1', 'vm', 'vm', 'active', JSON.stringify({ runtime_vm_id: 'vm-1' }), 't', early, early)
  resource.run(
    'acc-res',
    'v1',
    'account',
    'acc',
    'active',
    JSON.stringify({ vm_resource_id: 'vm-res' }),
    't',
    early,
    early,
  )
  const logs = new UsageLogsRepo(db, { billingMaintenance: false })
  const log = (rec) =>
    logs.insertSummary({
      status: 200,
      user_id: user.id,
      api_key_id: key.id,
      model,
      pricing_model: model,
      ...rec,
      id: rec.request_id,
    })
  await log({
    request_id: 'req-1',
    created_at: ago(2 * HOUR),
    vm_id: 'vm-1',
    total_cost_micros: 2_000_000,
    total_cost: 2,
    actual_cost_micros: charge.actual_micros,
    actual_cost: charge.actual_micros / 1e6,
    billing_status: 'settled',
  })
  // 绕过写入方（不写供应商用量事实）的使用记录
  const raw = (rec) => {
    const row = {
      status: 200,
      user_id: user.id,
      api_key_id: key.id,
      model,
      pricing_model: model,
      ...rec,
      id: rec.request_id,
    }
    const cols = Object.keys(row)
    db.prepare(`INSERT INTO usage_logs (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(
      ...cols.map((c) => row[c]),
    )
  }
  return { db, dir, user, key, charge, log, raw }
}

test('real write paths reconcile cleanly: wallet, charge, usage log and supplier fact agree', async (t) => {
  const { db } = await seed(t)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM vendor_usage_facts').get().n, 1, 'writer recorded the supplier fact')
  const result = await runReconcile(db)
  assert.equal(result.ok, true, JSON.stringify(result.findings))
  assert.deepEqual(result.findings, [])
  const by = Object.fromEntries(result.aggregates.filter((a) => a.key).map((a) => [a.key, a]))
  assert.equal(by.charge_usage.charges.rows, 1)
  assert.equal(by.charge_usage.settled_usage.rows, 1)
  assert.equal(by.charge_usage.charges.micros, by.charge_usage.settled_usage.micros)
  assert.deepEqual(by.vendor_facts.facts, {
    rows: 1,
    micros: 2_000_000,
    without_request: 0,
    without_usage: 0,
    amount_mismatch: 0,
  })
  assert.deepEqual(by.vendor_facts.eligible_usage, { rows: 1, micros: 2_000_000, missing_fact: 0 })
  assert.equal(by.unmetered.ratio, 0)
  assert.equal(by.settlement_pending.count, 0)
  assert.equal(by.wallets.micros.wallets_with_offset, 0)
  assert.deepEqual(result.wallet_offsets, {})
})

test('each kind of discrepancy is flagged as an error', async (t) => {
  const { db, user, key, raw } = await seed(t)
  // 有扣费没有使用记录（也让钱包少了这笔扣费对应的余额变动）
  db.prepare(
    "INSERT INTO billing_charges(request_id,user_id,api_key_id,group_id,rate_multiplier,actual_micros,created_at) VALUES('orphan',?,?,1,1,7,?)",
  ).run(user.id, key.id, dbTime())
  // 使用记录标为 settled 却没有扣费
  raw({
    request_id: 'no-charge',
    created_at: ago(3 * HOUR),
    billing_status: 'settled',
    actual_cost_micros: 5,
    actual_cost: 0.000005,
  })
  // 结算扣费与使用记录实际价不一致
  db.prepare("UPDATE billing_charges SET actual_micros = actual_micros + 1 WHERE request_id = 'req-1'").run()
  // 供应商用量事实找不到使用记录
  db.prepare(
    "INSERT INTO vendor_usage_facts(id,vendor_id,resource_id,cost_usd,cost_usd_micros,occurred_at,source_request_id,created_at) VALUES('f-ghost','v1','acc-res',1,1000000,?,'ghost',?)",
  ).run(ago(HOUR), ago(HOUR))
  // 按当前口径应有事实却没有（1 小时前，客户已扣费）；10 分钟前的不算（Gateway 回执可能未到）。
  // 审计阶段 2 W10 起只有客户已扣费的请求才记供应商事实：unmetered 的两条不算漏记
  const vmRow = { vm_id: 'vm-1', total_cost_micros: 1_000_000, total_cost: 1, billing_status: 'settled' }
  raw({ request_id: 'no-fact', created_at: ago(2 * HOUR), ...vmRow, billing_status: 'unmetered' })
  raw({ request_id: 'fresh', created_at: ago(10 * 60_000), ...vmRow, billing_status: 'unmetered' })
  raw({
    request_id: 'charged-no-fact',
    created_at: ago(2 * HOUR),
    ...vmRow,
    actual_cost_micros: 1_000_000,
    actual_cost: 1,
  })
  // 停在 settlement_pending 超过 1 小时；10 分钟前的不算
  raw({ request_id: 'pending-old', created_at: ago(2 * HOUR), billing_status: 'settlement_pending' })
  raw({ request_id: 'pending-new', created_at: ago(10 * 60_000), billing_status: 'settlement_pending' })

  const result = await runReconcile(db)
  assert.equal(result.ok, false)
  assert.deepEqual(errors(result), [
    'charge_amount',
    'charge_without_usage',
    'settled_without_charge',
    'settlement_pending_stale',
    'unmetered_ratio',
    'usage_missing_vendor_fact',
    'vendor_fact_without_usage',
    'wallet_offset',
  ])
  const find = (code) => result.findings.find((f) => f.code === code)
  assert.equal(find('usage_missing_vendor_fact').count, 1)
  assert.equal(find('settlement_pending_stale').count, 1)
  // unmetered：两条 1 美元的 unmetered / (2 + 1 + 1 + 1 美元) = 40%
  assert.equal(find('unmetered_ratio').ratio, 0.4)
  assert.equal(find('unmetered_ratio').threshold, 0.05)
  // 阈值为 0 时不判 unmetered 占比
  assert.equal(errors(await runReconcile(db, { unmeteredRatio: 0 })).includes('unmetered_ratio'), false)
  // 钱包差额：充值 10 − 扣费（含孤儿扣费 7 与改大的 1）≠ 余额
  assert.equal(Object.values(result.wallet_offsets)[0], 8)
})

test('supplier fact amount drift is reported as a warning, not an error (facts are immutable after repricing)', async (t) => {
  const { db } = await seed(t)
  db.prepare("UPDATE usage_logs SET total_cost_micros = 3000000, total_cost = 3 WHERE request_id = 'req-1'").run()
  const result = await runReconcile(db)
  assert.equal(result.ok, true, JSON.stringify(result.findings))
  assert.deepEqual(
    result.findings.map((f) => [f.code, f.severity, f.count]),
    [['vendor_fact_amount', 'warn', 1]],
  )
})

test('wallet offsets: no baseline is an error; an unchanged offset against the last baseline only warns', async (t) => {
  const { db, user } = await seed(t)
  db.prepare(
    'UPDATE users SET balance_micros = balance_micros + 5, balance = (balance_micros + 5) / 1000000.0 WHERE id = ?',
  ).run(user.id)
  const first = await runReconcile(db)
  assert.deepEqual(errors(first), ['wallet_offset'])
  assert.deepEqual(first.wallet_offsets, { [`user:${user.id}`]: 5 })
  const known = await runReconcile(db, { walletBaseline: first.wallet_offsets })
  assert.equal(known.ok, true)
  assert.deepEqual(
    known.findings.map((f) => [f.code, f.severity]),
    [['wallet_offset_known', 'warn']],
  )
  db.prepare('UPDATE users SET balance_micros = balance_micros + 1 WHERE id = ?').run(user.id)
  db.prepare('UPDATE users SET balance = balance_micros / 1000000.0 WHERE id = ?').run(user.id)
  assert.deepEqual(errors(await runReconcile(db, { walletBaseline: first.wallet_offsets })), ['wallet_offset'])
  // 负余额钱包只报告
  db.prepare('UPDATE users SET balance_micros = -3, balance = -0.000003 WHERE id = ?').run(user.id)
  const negative = (await runReconcile(db)).aggregates.find((a) => a.key === 'wallets').negative
  assert.deepEqual(negative, { wallets: 1, min_balance_micros: -3 })
})

test('daily run audits every result, alerts once on a new mismatch and carries the wallet baseline forward', async (t) => {
  const { db, user } = await seed(t)
  db.prepare(
    'UPDATE users SET balance_micros = balance_micros + 5, balance = (balance_micros + 5) / 1000000.0 WHERE id = ?',
  ).run(user.id)
  const sent = []
  const send = async (message, event) => {
    sent.push({ message, event })
    return { ok: true, results: [] }
  }
  const runner = (_path, options) => runReconcile(db, options)
  const notifyConfig = { enabled: true, events: { billing_reconcile: true } }
  const now = Date.parse('2026-11-07T19:35:00.000Z')
  const first = await runDailyReconcile({
    db,
    dbPath: 'unused',
    log,
    runner,
    send,
    notifyConfig,
    now,
    baseUrl: 'https://panel.test',
  })
  assert.equal(first.day, '2026-11-08')
  assert.equal(first.ok, false)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].event.type, 'billing_reconcile')
  assert.match(sent[0].message.text, /计费对账异常/)
  assert.match(sent[0].message.text, /钱包余额 ≠ Σ流水 − Σ扣费（新出现或变化）：1/)
  assert.match(sent[0].message.text, /https:\/\/panel\.test\/#\/billing/)
  const rows = db.prepare('SELECT * FROM operation_audit WHERE action = ? ORDER BY id').all(RECONCILE_AUDIT_ACTION)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].actor, 'system')
  assert.equal(rows[0].target, '2026-11-08')
  assert.equal(rows[0].reason, 'mismatch')
  const after = JSON.parse(rows[0].after_json)
  assert.deepEqual(after.wallet_offsets, { [`user:${user.id}`]: 5 })
  assert.equal(after.metrics.unmetered_ratio, 0)

  // 次日：差额未变，按上次基线只报告，不再告警
  const second = await runDailyReconcile({
    db,
    dbPath: 'unused',
    log,
    runner,
    send,
    notifyConfig,
    now: now + 86400_000,
  })
  assert.equal(second.ok, true)
  assert.equal(sent.length, 1)

  // 对账失败：记 reconcile_failed 并告警，审计行沿用上次基线
  const failing = async () => {
    throw new Error('disk I/O error')
  }
  const failed = await runDailyReconcile({
    db,
    dbPath: 'unused',
    runner: failing,
    send,
    notifyConfig,
    now: now + 2 * 86400_000,
  })
  assert.deepEqual(errors(failed), ['reconcile_failed'])
  assert.equal(sent.length, 2)
  assert.match(sent[1].message.text, /对账未完成：disk I\/O error/)
  const last = db
    .prepare('SELECT after_json FROM operation_audit WHERE action = ? ORDER BY id DESC LIMIT 1')
    .get(RECONCILE_AUDIT_ACTION)
  assert.deepEqual(JSON.parse(last.after_json).wallet_offsets, { [`user:${user.id}`]: 5 })

  // 面板通知设置关掉该事件、或通知总开关关闭：照常留痕，不推送
  db.prepare('UPDATE users SET balance_micros = balance_micros + 1 WHERE id = ?').run(user.id)
  db.prepare('UPDATE users SET balance = balance_micros / 1000000.0 WHERE id = ?').run(user.id)
  const off = { enabled: true, events: { billing_reconcile: false } }
  assert.equal((await runDailyReconcile({ db, dbPath: 'unused', log, runner, send, notifyConfig: off, now })).ok, false)
  await runDailyReconcile({ db, dbPath: 'unused', log, runner, send, notifyConfig: { enabled: false }, now })
  assert.equal(sent.length, 2)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM operation_audit WHERE action = ?').get(RECONCILE_AUDIT_ACTION).n, 5)
})

test('the worker thread reconciles a read-only snapshot of the database file', async (t) => {
  const { db, user } = await seed(t)
  db.prepare(
    'UPDATE users SET balance_micros = balance_micros + 5, balance = (balance_micros + 5) / 1000000.0 WHERE id = ?',
  ).run(user.id)
  const before = db.prepare('SELECT COUNT(*) n FROM operation_audit').get().n
  const result = await reconcileInWorker(getDbPath(), { now: Date.now() })
  assert.deepEqual(errors(result), ['wallet_offset'])
  assert.ok(result.rows.length > 0)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM operation_audit').get().n, before, 'the worker does not write')
  await assert.rejects(
    () => reconcileInWorker(path.join(os.tmpdir(), 'missing-reconcile.db'), {}),
    /unable to open|no such/i,
  )
})

test('schedule: runs once per UTC+8 day at the configured time, with a three-hour catch-up window', () => {
  const at = '03:30'
  const utc = (iso) => Date.parse(iso)
  assert.equal(reconcileDue({ now: utc('2026-11-07T19:29:00Z'), at }), false, '03:29 UTC+8')
  assert.equal(reconcileDue({ now: utc('2026-11-07T19:30:00Z'), at }), true, '03:30 UTC+8')
  assert.equal(reconcileDue({ now: utc('2026-11-07T22:29:00Z'), at }), true, '06:29 UTC+8 catch-up')
  assert.equal(reconcileDue({ now: utc('2026-11-07T22:30:00Z'), at }), false, 'past the catch-up window')
  assert.equal(reconcileDue({ now: utc('2026-11-07T19:45:00Z'), at, lastRunDay: '2026-11-08' }), false, 'already ran')
  assert.equal(reconcileDue({ now: utc('2026-11-07T19:45:00Z'), at, lastRunDay: '2026-11-07' }), true)
  assert.equal(reconcileDue({ now: utc('2026-11-07T19:45:00Z'), at: '' }), false, 'empty time disables')
})

test('notify: billing_reconcile is on by default, can be switched off, and the message lists only errors', () => {
  assert.equal(normalizeNotifyConfig({}).events.billing_reconcile, true)
  assert.equal(mergeNotifyConfig({}, { events: { billing_reconcile: false } }).events.billing_reconcile, false)
  const message = formatBillingReconcileMessage({
    day: '2026-11-08',
    findings: [
      { code: 'unmetered_ratio', severity: 'error', count: 3, ratio: 0.125, threshold: 0.05 },
      { code: 'settlement_pending_stale', severity: 'error', count: 2, oldest: '2026-11-07T10:00:00.000Z' },
      { code: 'vendor_fact_amount', severity: 'warn', count: 4 },
    ],
    metrics: { unmetered_ratio: 0.125, negative_wallets: 2, min_balance_micros: -1_500_000 },
  })
  assert.equal(message.subject, 'KIN · 计费对账异常')
  assert.match(message.text, /对账日 2026-11-08/)
  assert.match(message.text, /未计费（unmetered）金额占比超过阈值：12\.50%（阈值 5\.00%）/)
  assert.match(message.text, /settlement_pending 超过 1 小时：2，最早/)
  assert.match(message.text, /负余额钱包 2 个，最低 \$-1\.50/)
  assert.doesNotMatch(message.text, /vendor_fact_amount|事实金额/)
})

test('audit script reuses the checks: a wallet offset now fails the run with exit code 1', async (t) => {
  const { db, user } = await seed(t)
  const file = getDbPath()
  const clean = spawnSync(process.execPath, [path.join(ROOT, 'scripts/audit-money-micros.mjs'), file, '--json'], {
    encoding: 'utf8',
  })
  assert.equal(clean.status, 0, clean.stdout + clean.stderr)
  db.prepare(
    'UPDATE users SET balance_micros = balance_micros + 5, balance = (balance_micros + 5) / 1000000.0 WHERE id = ?',
  ).run(user.id)
  const bad = spawnSync(process.execPath, [path.join(ROOT, 'scripts/audit-money-micros.mjs'), file, '--json'], {
    encoding: 'utf8',
  })
  assert.equal(bad.status, 1, bad.stderr)
  const report = JSON.parse(bad.stdout)
  assert.deepEqual(
    report.findings.map((f) => f.code),
    ['wallet_offset'],
  )
})
