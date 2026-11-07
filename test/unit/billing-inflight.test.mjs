import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'
import { PanelUserStore } from '../../src/lib/admin/panel-users.mjs'
import { ApiKeyStore } from '../../src/lib/admin/api-keys.mjs'
import { GroupsRepo } from '../../src/lib/db/repos/groups-repo.mjs'
import { RelayBilling } from '../../src/lib/admin/relay-billing.mjs'
import { UsageLogsRepo } from '../../src/lib/db/repos/usage-logs-repo.mjs'
import {
  BOOT_ID,
  normalizeRelayBillingPolicy,
  releaseInflight,
  sweepInflight,
} from '../../src/lib/admin/billing-inflight.mjs'

const model = 'claude-sonnet-5'
const body = { model, max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] }

async function setup(t) {
  await closeDatabase()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-inflight-'))
  const db = openDatabase({ dataDir: dir })
  t.after(async () => {
    await closeDatabase()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const users = new PanelUserStore({ db })
  const user = await users.create({ username: 'customer', password: 'customer-pass' })
  const groups = new GroupsRepo(db)
  const group = await groups.create({ name: 'service', platform: 'anthropic' })
  await groups.setGrants(user.id, [group.id])
  const keys = new ApiKeyStore({ db })
  const key = await keys.create({ user_id: user.id, group_id: group.id })
  const billing = new RelayBilling(db)
  const credit = (amount, id) =>
    billing.adjust(user.id, { amount, reason: 'test credit', idempotency_key: `test-credit-${id}` }, 'test-admin')
  return { dir, db, user, groups, group, key, billing, credit }
}

const inflightCount = (db) => db.prepare('SELECT COUNT(*) AS n FROM billing_inflight').get().n

test('relay billing policy normalizes thresholds and keeps safe defaults', () => {
  assert.deepEqual(normalizeRelayBillingPolicy(), { low_balance_micros: 1_000_000, low_balance_max_inflight: 1 })
  assert.deepEqual(normalizeRelayBillingPolicy({ low_balance_micros: 0, low_balance_max_inflight: 3 }), {
    low_balance_micros: 0,
    low_balance_max_inflight: 3,
  })
  assert.deepEqual(normalizeRelayBillingPolicy({ low_balance_micros: -1, low_balance_max_inflight: 0 }), {
    low_balance_micros: 1_000_000,
    low_balance_max_inflight: 1,
  })
})

test('admission records an in-flight row and limits concurrency on a low balance (audit P1-B1)', async (t) => {
  const { db, key, billing, credit } = await setup(t)
  await credit(0.5, 'low')
  const first = await billing.authorize(key, 'r1', model, body)
  assert.equal(first.request_id, 'r1')
  assert.equal(inflightCount(db), 1)
  await assert.rejects(billing.authorize(key, 'r2', model, body), { code: 'insufficient_balance', status: 402 })
  // 收口释放后同一钱包可以再发
  assert.equal(await releaseInflight(db, 'r1'), true)
  assert.ok(await billing.authorize(key, 'r3', model, body))
  // 阈值 0 关闭保护；余额充足时不受限
  assert.ok(await billing.authorize(key, 'r4', model, body, { policy: { low_balance_micros: 0 } }))
  await credit(10, 'top-up')
  assert.ok(await billing.authorize(key, 'r5', model, body))
  assert.ok(await billing.authorize(key, 'r6', model, body))
})

test('the sweeper settles orphans left by a previous process (audit P1-B3, P2-5)', async (t) => {
  const { db, dir, key, billing, credit } = await setup(t)
  await credit(10, 'funds')
  const context = await billing.authorize(key, 'charged', model, body)
  await billing.settle(context, { input_tokens: 10, output_tokens: 2 }, model)
  await billing.authorize(key, 'lost', model, body)
  await billing.authorize(key, 'gateway', model, body)
  await billing.authorize(key, 'queued', model, body)
  db.prepare('UPDATE billing_inflight SET boot_id = ?').run('previous-boot')
  db.prepare(
    "UPDATE billing_inflight SET gateway_instance_id='gw-1', dispatch_id='d-1' WHERE request_id='gateway'",
  ).run()
  const pendingFile = path.join(dir, 'pending-commits.jsonl')
  fs.writeFileSync(pendingFile, `${JSON.stringify({ entry: { version: 1, request_id: 'queued' } })}\n`)
  const usageLogs = new UsageLogsRepo(db, { billingMaintenance: false })
  const report = await sweepInflight(db, { usageLogs, pendingFile, log: null })
  assert.deepEqual(report, { settled: 1, reconciled: 1, interrupted: 1, deferred: 1 })
  const status = (id) => db.prepare('SELECT billing_status, final_state FROM usage_logs WHERE request_id = ?').get(id)
  assert.equal(status('lost').billing_status, 'interrupted')
  assert.equal(status('gateway').billing_status, 'settlement_pending')
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM gateway_worker_reconciliation_jobs WHERE request_id='gateway'").get().n,
    1,
  )
  // 已结算的不重复记账；待补写的留给 replay
  assert.equal(status('charged'), undefined)
  assert.deepEqual(
    db
      .prepare('SELECT request_id FROM billing_inflight')
      .all()
      .map((row) => row.request_id),
    ['queued'],
  )
  // 本进程刚开始的在途请求不被扫描
  await billing.authorize(key, 'live', model, body)
  await sweepInflight(db, { usageLogs, pendingFile, log: null })
  assert.ok(db.prepare("SELECT 1 FROM billing_inflight WHERE request_id='live' AND boot_id=?").get(BOOT_ID))
})

test('a free group with a paid independent image rate still requires a balance for images (audit P2-9)', async (t) => {
  const { key, billing, groups, group } = await setup(t)
  await groups.update(group.id, { rate_multiplier: 0, image_rate_independent: true, image_rate_multiplier: 1 })
  assert.ok(await billing.authorize(key, 'text', model, body))
  const imageBody = { ...body, tools: [{ type: 'image_generation', model: 'gpt-image-2' }] }
  await assert.rejects(billing.authorize(key, 'image', model, imageBody), { code: 'insufficient_balance' })
})
