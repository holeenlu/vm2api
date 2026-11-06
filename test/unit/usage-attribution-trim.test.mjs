import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase, openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'
import { RelayBilling } from '../../src/lib/admin/relay-billing.mjs'
import { PanelUserStore } from '../../src/lib/admin/panel-users.mjs'
import { ApiKeyStore } from '../../src/lib/admin/api-keys.mjs'
import { GroupsRepo } from '../../src/lib/db/repos/groups-repo.mjs'
import { usageForStorage } from '../../src/lib/core/usage-persist.mjs'
import { RequestAttemptsRepo } from '../../src/lib/db/repos/request-attempts-repo.mjs'
import { GatewayWorkerRepo } from '../../src/lib/gateway-worker/gateway-repo.mjs'

/** Upstream shape: one attribution entry per assistant message, unbounded. */
function upstreamUsage(messages = 400) {
  const items = {}
  for (let i = 0; i < messages; i++) {
    items[`amsg_01a18a89-0386-7a00-95b9-${String(i).padStart(12, '0')}`] = {
      input_tokens: i,
      cached_tokens: i * 2,
      cache_write_tokens: 0,
      output_tokens: i + 1,
    }
  }
  return {
    input_tokens: 1200,
    output_tokens: 34,
    cache_read_input_tokens: 204800,
    output_tokens_details: { reasoning_tokens: 12 },
    total_tokens: 1234,
    attribution: { items },
  }
}

test('usageForStorage drops attribution and keeps every counter', () => {
  const usage = upstreamUsage(5)
  const stored = usageForStorage(usage)
  assert.equal('attribution' in stored, false)
  assert.equal(stored.input_tokens, 1200)
  assert.equal(stored.output_tokens, 34)
  assert.equal(stored.cache_read_input_tokens, 204800)
  assert.equal(stored.total_tokens, 1234)
  assert.deepEqual(stored.output_tokens_details, { reasoning_tokens: 12 })
  // The caller's object is left alone: billing and key accounting read it after
  // the row is written.
  assert.ok(usage.attribution)
})

test('usageForStorage passes through values it has nothing to trim', () => {
  const plain = { input_tokens: 1, output_tokens: 2 }
  // Same reference, not a copy — this runs per request.
  assert.equal(usageForStorage(plain), plain)
  assert.equal(usageForStorage(null), null)
  assert.equal(usageForStorage(undefined), undefined)
  assert.equal(usageForStorage(0), 0)
  assert.equal(usageForStorage('usage'), 'usage')
  const list = [{ attribution: 1 }]
  assert.equal(usageForStorage(list), list)
})

test('billing_charges stores usage without attribution', async (t) => {
  closeDatabase()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-trim-billing-'))
  const db = openDatabase({ dataDir: dir })
  t.after(() => {
    closeDatabase()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const users = new PanelUserStore({ db })
  const user = await users.create({ username: 'customer', password: 'customer-pass' })
  const groups = new GroupsRepo(db)
  const group = await groups.create({ name: 'service', platform: 'anthropic' })
  await groups.setGrants(user.id, [group.id])
  const keys = new ApiKeyStore({ db })
  const key = keys.create({ user_id: user.id, group_id: group.id })
  const billing = new RelayBilling(db)
  await billing.adjust(user.id, { amount: 1, reason: 'test credit', idempotency_key: 'credit-1' }, 'test-admin')

  const model = 'claude-sonnet-5'
  const body = { model, max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] }
  const context = billing.authorize(key, 'request-attribution', model, body)
  const usage = upstreamUsage()
  const item = billing.settle(context, usage, model)
  assert.equal(item.status, 'settled')

  const row = db.prepare('SELECT usage_json FROM billing_charges WHERE request_id=?').get('request-attribution')
  const stored = JSON.parse(row.usage_json)
  assert.equal('attribution' in stored, false)
  assert.equal(stored.input_tokens, 1200)
  assert.equal(stored.cache_read_input_tokens, 204800)
  // 400 attribution entries are ~30 KB of JSON; the counters are a few hundred bytes.
  assert.ok(row.usage_json.length < 1000, `usage_json stayed large: ${row.usage_json.length} bytes`)
  // Cost still comes from the counters, so the charge is unchanged.
  assert.ok(item.actual_micros > 0)
})

function assertTrimmed(json, label) {
  const stored = JSON.parse(json)
  assert.equal('attribution' in stored, false, `${label} kept attribution`)
  assert.equal(stored.input_tokens, 1200, label)
  assert.equal(stored.cache_read_input_tokens, 204800, label)
  assert.ok(json.length < 1000, `${label} usage_json stayed large: ${json.length} bytes`)
}

test('request_attempts stores usage without attribution', (t) => {
  closeDatabase()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-trim-attempts-'))
  const db = createDatabase({ dataDir: dir })
  t.after(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const attempts = new RequestAttemptsRepo(db)
  const usage = upstreamUsage()
  attempts.record({ requestId: 'req-record', attemptNo: 1, model: 'gpt-test', immediate: true, usage })
  attempts.begin({ requestId: 'req-complete', attemptNo: 1, model: 'gpt-test' })
  attempts.complete('req-complete', 1, { terminalState: 'completed', usage })
  for (const id of ['req-record', 'req-complete']) {
    const row = db.prepare('SELECT usage_json FROM request_attempts WHERE request_id=?').get(id)
    assertTrimmed(row.usage_json, id)
  }
  assert.ok(usage.attribution, 'caller usage must not be mutated')
})

test('gateway worker receipts and reconciliation jobs store usage without attribution', async (t) => {
  closeDatabase()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-trim-gateway-'))
  const db = createDatabase({ dataDir: dir })
  t.after(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const repo = new GatewayWorkerRepo(db)
  await repo.upsertInstance({ id: 'gw_test', name: 'test', base_url: 'http://127.0.0.1:8790', health_state: 'healthy' })
  const dispatch = await repo.createDispatch({
    requestId: 'req_1',
    instanceId: 'gw_test',
    protocol: 'openai.responses',
    model: 'gpt-test',
    scope: { group_ids: [1] },
    nonce: 'nonce_1',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  })
  const receipt = {
    receipt_id: 'receipt_1',
    dispatch_id: dispatch,
    request_id: 'req_1',
    gateway_instance_id: 'gw_test',
    terminal_state: 'completed',
    usage_confidence: 'complete',
    usage: upstreamUsage(),
  }
  assert.equal((await repo.ingestReceipt(receipt)).duplicate, false)
  const row = db.prepare('SELECT usage_json FROM gateway_worker_receipts WHERE receipt_id=?').get('receipt_1')
  assertTrimmed(row.usage_json, 'receipt')

  await repo.enqueueReconciliation({
    gatewayInstanceId: 'gw_test',
    dispatchId: dispatch,
    requestId: 'req_1',
    usage: upstreamUsage(),
  })
  await repo.attachReceiptToReconciliation({
    gatewayInstanceId: 'gw_test',
    dispatchId: dispatch,
    receiptId: 'receipt_1',
    usage: upstreamUsage(),
  })
  const job = db.prepare('SELECT usage_json FROM gateway_worker_reconciliation_jobs WHERE dispatch_id=?').get(dispatch)
  assertTrimmed(job.usage_json, 'reconciliation job')
})
