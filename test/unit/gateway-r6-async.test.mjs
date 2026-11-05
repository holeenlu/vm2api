// R6 B5：gateway-worker 数据访问异步化的专项回归——竞态 R19（回执入账与结算只发生一次）与临时同步出口。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, openDatabase, withTransaction } from '../../src/lib/db/database.mjs'
import { RelayBilling } from '../../src/lib/admin/relay-billing.mjs'
import { PanelUserStore } from '../../src/lib/admin/panel-users.mjs'
import { ApiKeyStore } from '../../src/lib/admin/api-keys.mjs'
import { GroupsRepo } from '../../src/lib/db/repos/groups-repo.mjs'
import { GatewayWorkerRepo } from '../../src/lib/gateway-worker/gateway-repo.mjs'
import { createGatewayWorkerReconciler } from '../../src/lib/gateway-worker/receipt-reconciler.mjs'
import { bodyHash } from '../../src/lib/gateway-worker/gateway-auth.mjs'

const MODEL = 'gpt-5.5'

async function fixture(t) {
  closeDatabase()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-r6-async-'))
  const db = openDatabase({ dataDir: dir })
  t.after(() => {
    closeDatabase()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const users = new PanelUserStore({ db })
  const user = await users.create({ username: 'customer', password: 'customer-pass' })
  const groups = new GroupsRepo(db)
  const group = await groups.create({ name: 'codex', platform: 'openai' })
  await groups.setGrants(user.id, [group.id])
  const keys = new ApiKeyStore({ db })
  const key = keys.create({ user_id: user.id, group_id: group.id })
  const billing = new RelayBilling(db)
  await billing.adjust(user.id, { amount: 10, reason: 'test credit', idempotency_key: 'credit-1' }, 'test-admin')
  const repo = new GatewayWorkerRepo(db)
  const balance = async () => (await billing.balance(user.id)).balance
  const charges = (requestId) =>
    db.prepare('SELECT COUNT(*) AS n FROM billing_charges WHERE request_id=?').get(requestId).n
  return { db, repo, billing, key, keys, user, balance, charges }
}

// 一个待结算的 Gateway 请求：派发、实时日志（settlement_pending）与带计费上下文的对账任务
async function pendingRequest(f, requestId, { enqueue = true } = {}) {
  await f.repo.upsertInstance({ id: 'gw_r19', name: 'r19', base_url: 'http://127.0.0.1:1', health_state: 'offline' })
  const dispatchId = await f.repo.createDispatch({
    requestId,
    instanceId: 'gw_r19',
    protocol: 'openai.responses',
    model: MODEL,
    scope: {},
    nonce: requestId,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  })
  f.db
    .prepare(
      `INSERT INTO usage_logs(id,request_id,created_at,execution_kind,gateway_instance_id,dispatch_id,final_state,billing_status,status,model)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      `log_${requestId}`,
      requestId,
      new Date().toISOString(),
      'gateway_worker',
      'gw_r19',
      dispatchId,
      'verified',
      'settlement_pending',
      200,
      MODEL,
    )
  const context = f.billing.authorize(f.key, requestId, MODEL, { model: MODEL })
  if (enqueue) await f.repo.enqueueReconciliation({ gatewayInstanceId: 'gw_r19', dispatchId, requestId, context })
  const unsigned = {
    receipt_id: `receipt_${requestId}`,
    dispatch_id: dispatchId,
    request_id: requestId,
    gateway_instance_id: 'gw_r19',
    sequence: 1,
    terminal_state: 'completed',
    upstream_model: MODEL,
    usage_confidence: 'complete',
    usage: { input_tokens: 20000, output_tokens: 4000 },
  }
  return { dispatchId, context, receipt: { ...unsigned, payload_hash: bodyHash(unsigned) } }
}

test('R19: concurrent replays of the same Receipt record it once; the other is a duplicate', async (t) => {
  const f = await fixture(t)
  const { dispatchId, receipt } = await pendingRequest(f, 'req_replay')
  const results = await Promise.all([
    f.repo.ingestReceipt(receipt),
    f.repo.ingestReceipt(receipt),
    f.repo.ingestReceipt({ ...receipt }),
  ])
  assert.deepEqual(results.map((item) => item.duplicate).sort(), [false, true, true])
  assert.ok(results.every((item) => item.receipt_id === 'receipt_req_replay'))
  assert.equal(
    f.db.prepare('SELECT COUNT(*) AS n FROM gateway_worker_receipts WHERE dispatch_id=?').get(dispatchId).n,
    1,
  )
  const dispatch = f.db
    .prepare('SELECT status,receipt_id FROM gateway_worker_dispatches WHERE dispatch_id=?')
    .get(dispatchId)
  assert.deepEqual({ ...dispatch }, { status: 'completed', receipt_id: 'receipt_req_replay' })
  // 不同 receipt_id 的同一 dispatch 回执按重复处理，不新建行
  const other = { ...receipt, receipt_id: 'receipt_other' }
  delete other.payload_hash
  assert.equal((await f.repo.ingestReceipt({ ...other, payload_hash: bodyHash(other) })).duplicate, true)
  assert.equal(
    f.db.prepare('SELECT COUNT(*) AS n FROM gateway_worker_receipts WHERE dispatch_id=?').get(dispatchId).n,
    1,
  )
})

test('R19: two reconcilers settling the same job concurrently charge the wallet once', async (t) => {
  const f = await fixture(t)
  const { receipt } = await pendingRequest(f, 'req_twice')
  await f.repo.ingestReceipt(receipt)
  const before = await f.balance()
  const a = createGatewayWorkerReconciler({ db: f.db, apiKeyStore: f.keys, client: {}, replayIntervalMs: 1e12 })
  const b = createGatewayWorkerReconciler({ db: f.db, apiKeyStore: f.keys, client: {}, replayIntervalMs: 1e12 })
  await Promise.all([a.tick(), b.tick(), a.tick()])
  assert.equal(f.charges('req_twice'), 1)
  const charge = f.db
    .prepare('SELECT actual_micros,gateway_receipt_id FROM billing_charges WHERE request_id=?')
    .get('req_twice')
  assert.ok(charge.actual_micros > 0)
  assert.equal(charge.gateway_receipt_id, 'receipt_req_twice')
  assert.equal(Math.round((before - (await f.balance())) * 1e6), charge.actual_micros)
  const job = f.db
    .prepare("SELECT status,attempts FROM gateway_worker_reconciliation_jobs WHERE request_id='req_twice'")
    .get()
  assert.deepEqual({ ...job }, { status: 'settled', attempts: 1 })
  assert.equal(
    f.db.prepare("SELECT billing_status FROM usage_logs WHERE request_id='req_twice'").get().billing_status,
    'settled',
  )
})

test('R19: inference-path settlement and the reconciler on the same request charge once', async (t) => {
  const f = await fixture(t)
  const { receipt, context } = await pendingRequest(f, 'req_both')
  await f.repo.ingestReceipt(receipt)
  const before = await f.balance()
  const reconciler = createGatewayWorkerReconciler({
    db: f.db,
    apiKeyStore: f.keys,
    client: {},
    replayIntervalMs: 1e12,
  })
  // 推理路径（finalizeCommercial）在请求日志的同步事务里直接结算，与对账器的异步结算并发
  const direct = Promise.resolve().then(() =>
    withTransaction(f.db, () => f.billing.settle(context, receipt.usage, MODEL)),
  )
  const [settled] = await Promise.all([direct, reconciler.tick()])
  assert.equal(settled.status, 'settled')
  assert.equal(f.charges('req_both'), 1)
  const charge = f.db.prepare('SELECT actual_micros FROM billing_charges WHERE request_id=?').get('req_both')
  assert.equal(Math.round((before - (await f.balance())) * 1e6), charge.actual_micros)
  // 再结算一次（重放、再次对账）仍返回原扣费，不再扣款
  const again = f.billing.settle(context, receipt.usage, MODEL)
  assert.equal(again.actual_micros, charge.actual_micros)
  assert.equal(Math.round((before - (await f.balance())) * 1e6), charge.actual_micros)
})

test('R19: a failure after the charge rolls the whole settlement back and the job retries', async (t) => {
  const f = await fixture(t)
  const { receipt } = await pendingRequest(f, 'req_rollback')
  await f.repo.ingestReceipt(receipt)
  const before = await f.balance()
  const reconciler = createGatewayWorkerReconciler({
    db: f.db,
    apiKeyStore: f.keys,
    client: {},
    replayIntervalMs: 1e12,
  })
  // 扣费之后、任务完成之前失败：扣费、使用记录与回执关联一并回滚
  const finish = reconciler.repo.finishReconciliation.bind(reconciler.repo)
  let broken = true
  reconciler.repo.finishReconciliation = async (id, status, extra) => {
    if (broken && status === 'settled') throw new Error('disk hiccup')
    return finish(id, status, extra)
  }
  await reconciler.tick()
  assert.equal(f.charges('req_rollback'), 0)
  assert.equal(await f.balance(), before)
  const job = f.db
    .prepare("SELECT status,last_error FROM gateway_worker_reconciliation_jobs WHERE request_id='req_rollback'")
    .get()
  assert.deepEqual({ ...job }, { status: 'pending', last_error: 'disk hiccup' })
  broken = false
  f.db
    .prepare("UPDATE gateway_worker_reconciliation_jobs SET next_attempt_at=NULL WHERE request_id='req_rollback'")
    .run()
  await reconciler.tick()
  assert.equal(f.charges('req_rollback'), 1)
  assert.ok((await f.balance()) < before)
})

test('enqueueReconciliationSync (R6 temporary exit, B7) writes the same job inside a synchronous transaction', async (t) => {
  const f = await fixture(t)
  const input = (dispatchId) => ({
    gatewayInstanceId: 'gw_r19',
    dispatchId,
    requestId: `req_${dispatchId}`,
    model: MODEL,
    usage: { input_tokens: 1 },
    context: { request_id: `req_${dispatchId}` },
  })
  await f.repo.upsertInstance({ id: 'gw_r19', name: 'r19', base_url: 'http://127.0.0.1:1', health_state: 'offline' })
  const syncId = withTransaction(f.db, () => f.repo.enqueueReconciliationSync(input('d_sync')))
  const asyncId = await f.repo.enqueueReconciliation(input('d_async'))
  assert.match(syncId, /^reconcile_/)
  assert.match(asyncId, /^reconcile_/)
  const row = (dispatchId) => {
    const {
      id: _id,
      dispatch_id: _d,
      request_id: _r,
      context_json,
      created_at: _c,
      updated_at: _u,
      next_attempt_at: _n,
      ...rest
    } = f.db.prepare('SELECT * FROM gateway_worker_reconciliation_jobs WHERE dispatch_id=?').get(dispatchId)
    return { ...rest, context: JSON.parse(context_json).request_id.replace(dispatchId, '') }
  }
  assert.deepEqual(row('d_sync'), row('d_async'))
  // 缺少必填字段时两者都不入队
  assert.equal(f.repo.enqueueReconciliationSync({ gatewayInstanceId: 'gw_r19' }), null)
  assert.equal(await f.repo.enqueueReconciliation({ gatewayInstanceId: 'gw_r19' }), null)
})

test('the reconciler timer skips a tick while the previous one runs and contains its rejection', async (t) => {
  const f = await fixture(t)
  const reconciler = createGatewayWorkerReconciler({
    db: f.db,
    apiKeyStore: f.keys,
    client: {},
    replayIntervalMs: 1e12,
    intervalMs: 5,
  })
  let calls = 0
  let release
  const gate = new Promise((resolve) => (release = resolve))
  reconciler.repo.dueReconciliation = async () => {
    calls++
    await gate
    throw new Error('database unavailable')
  }
  const unhandled = []
  const onUnhandled = (reason) => unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  const warn = console.warn
  const warnings = []
  console.warn = (line) => warnings.push(String(line))
  t.after(() => {
    reconciler.stop()
    console.warn = warn
    process.off('unhandledRejection', onUnhandled)
  })
  reconciler.start()
  await new Promise((resolve) => setTimeout(resolve, 40))
  // 第一轮仍在等待：其后的定时触发都被跳过
  assert.equal(calls, 1)
  release()
  await new Promise((resolve) => setTimeout(resolve, 20))
  reconciler.stop()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(unhandled, [])
  assert.ok(warnings.some((line) => line.includes('gateway reconciler: tick failed: database unavailable')))
})
