// 数据访问分层 R6 B7a：推理热路径准入与计费异步化后的竞态修复（R4–R8、R21）与已删除的临时同步出口
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { closeDatabase, createDatabase, openDatabase } from '../../src/lib/db/database.mjs'
import { PanelUserStore } from '../../src/lib/admin/panel-users.mjs'
import { ApiKeyStore } from '../../src/lib/admin/api-keys.mjs'
import { RelayBilling } from '../../src/lib/admin/relay-billing.mjs'
import { GroupsRepo } from '../../src/lib/db/repos/groups-repo.mjs'
import { UsersRepo } from '../../src/lib/db/repos/users-repo.mjs'
import { SettingsRepo } from '../../src/lib/db/repos/settings-repo.mjs'
import { RefusalGuardsRepo } from '../../src/lib/db/repos/refusal-guards-repo.mjs'
import { ApiEndpointStore } from '../../src/lib/admin/api-endpoints.mjs'
import { ApiEndpointsRepo } from '../../src/lib/db/repos/api-endpoints-repo.mjs'
import { GatewayWorkerRepo } from '../../src/lib/gateway-worker/gateway-repo.mjs'
import * as billingRepo from '../../src/lib/admin/repos/relay-billing-repo.mjs'
import * as resources from '../../src/lib/vendor/repos/resources-repo.mjs'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'
import { loadModelPolicy, warmModelPolicy } from '../../src/lib/protocol/model-policy.mjs'
import { loadGptModelPolicy, warmGptModelPolicy } from '../../src/lib/protocol/gpt-model-policy.mjs'

const MODEL = 'claude-sonnet-5'
const BODY = { model: MODEL, max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] }
const USAGE = { input_tokens: 100, output_tokens: 100 }

async function setup(t) {
  const db = createDatabase({ dbPath: ':memory:' })
  t.after(() => db.close())
  const users = new PanelUserStore({ db })
  const user = await users.create({ username: 'customer', password: 'customer-pass' })
  const groups = new GroupsRepo(db)
  const group = await groups.create({ name: 'service', platform: 'anthropic' })
  await groups.setGrants(user.id, [group.id])
  const keys = new ApiKeyStore({ db, hashSecret: 'b7a-test' })
  const key = await keys.create({ user_id: user.id, group_id: group.id })
  const billing = new RelayBilling(db)
  const credit = (amount, idempotency_key = 'credit-b7a') =>
    billing.adjust(user.id, { amount, reason: 'test credit', idempotency_key }, 'test-admin')
  const micros = () => db.prepare('SELECT balance_micros FROM users WHERE id=?').get(user.id).balance_micros
  const charges = (requestId) =>
    db.prepare('SELECT COUNT(*) n FROM billing_charges WHERE request_id=?').get(requestId).n
  return { db, users, user, groups, group, keys, key, billing, credit, micros, charges }
}

// ---- R4 结算幂等 ----

test('R4: concurrent settlements of one request_id charge the wallet and record key usage once', async (t) => {
  const { billing, key, credit, micros, charges } = await setup(t)
  await credit(5)
  const context = await billing.authorize(key, 'req-r4', MODEL, BODY)
  const before = micros()
  let writes = 0
  const settle = () => billing.settle(context, USAGE, MODEL, async () => writes++)
  const [a, b, c] = await Promise.all([settle(), settle(), settle()])
  assert.equal(charges('req-r4'), 1)
  assert.equal(writes, 1)
  assert.equal(a.status, 'settled')
  assert.deepEqual([b.actual_micros, c.actual_micros], [a.actual_micros, a.actual_micros])
  assert.equal(before - micros(), a.actual_micros)
})

test('R4: a competing settlement committed between the charge lookup and the claim is not charged again', async (t) => {
  const { db, billing, key, user, group, credit, micros, charges } = await setup(t)
  await credit(5)
  const context = await billing.authorize(key, 'req-r4-race', MODEL, BODY)
  const before = micros()
  // 本次读完 billing_charges（没有记录）之后、写入抢占之前，另一条结算路径（回执对账）已提交同一请求
  const original = billing.charge.bind(billing)
  let lookups = 0
  billing.charge = async (requestId) => {
    const row = await original(requestId)
    if (++lookups === 1) {
      db.prepare(
        "INSERT INTO billing_charges(request_id,user_id,api_key_id,group_id,subscription_id,rate_multiplier,actual_micros,model,usage_json,quote_json,created_at,wallet_domain_id,balance_exempt) VALUES(?,?,?,?,NULL,1,777,?,'{}',NULL,?,NULL,0)",
      ).run(requestId, user.id, key.id, group.id, MODEL, new Date().toISOString())
      db.prepare('UPDATE users SET balance_micros=balance_micros-777 WHERE id=?').run(user.id)
    }
    return row
  }
  let writes = 0
  const out = await billing.settle(context, USAGE, MODEL, () => writes++)
  assert.equal(out.actual_micros, 777, '按已有记录返回')
  assert.equal(out.status, 'settled')
  assert.equal(writes, 0, '不再记 Key 用量')
  assert.equal(charges('req-r4-race'), 1)
  assert.equal(before - micros(), 777, '钱包只扣了竞争方那一次')
})

test('R4: settlement still debits past zero (unconditional debit, original semantics)', async (t) => {
  const { billing, key, credit, micros } = await setup(t)
  await credit(0.000001)
  const context = await billing.authorize(key, 'req-negative', MODEL, BODY)
  await billing.settle(context, { input_tokens: 100_000, output_tokens: 100_000 }, MODEL)
  assert.ok(micros() < 0)
})

// ---- R5 商业日志提交 ----

function commercialHarness(finish) {
  let captured = null
  const { handleSearch } = createHandleProtocol({
    cfg: { limits: { max_body_bytes: 1 << 20 }, paths: {} },
    requireAuth(req) {
      captured = req
      req.apiKeyKind = 'managed'
      req.apiKeyRecord = { id: 'commercial-key', user_id: 'customer', group_id: 2 }
      return true
    },
    readBody() {
      assert.fail('rejected search must not read the request body')
    },
    json(res, status, body) {
      res.statusCode = status
      res.body = body
      res.emit('finish')
    },
    requestLog: { start: () => ({ request_id: 'req-r5', mode: 'normal', t0: Date.now() }), finish },
    groupsRepo: { rateMultiplier: async () => 1 },
    stats: { errors: 0, requests: 0, by_route: {} },
    routingConfig: {},
  })
  return {
    async run() {
      const res = new EventEmitter()
      await handleSearch({ headers: {}, method: 'POST' }, res, '/v1/alpha/search')
      return { req: captured, res }
    },
  }
}

test('R5: commitRelayLog sets the committed flag before any await, so re-entry joins the running commit', async () => {
  let calls = 0
  let release
  const gate = new Promise((resolve) => (release = resolve))
  const { req, res } = await commercialHarness(async () => {
    calls++
    await gate
  }).run()
  // res finish 监听器已开始提交，正停在 requestLog.finish 里
  assert.equal(req.relayLogCommitted, true)
  assert.equal(calls, 1)
  const joined = [req.commitRelayLog(), req.commitRelayLog()]
  res.emit('finish')
  release()
  await Promise.all(joined)
  assert.equal(calls, 1, '只提交一次')
  await req.commitRelayLog()
  assert.equal(calls, 1)
})

test('R5: a failed commit clears the flag (original semantics) and the listener rejection is contained', async () => {
  const unhandled = []
  const onUnhandled = (error) => unhandled.push(error)
  process.on('unhandledRejection', onUnhandled)
  const logged = []
  const error = console.error
  console.error = (...args) => logged.push(args.join(' '))
  try {
    let calls = 0
    let fail
    const failing = new Promise((_, reject) => (fail = reject))
    const { req } = await commercialHarness(async () => {
      if (++calls === 1) await failing
    }).run()
    // 首次提交（finish 监听器发起）进行中时到达的调用，等它失败后按原语义自己重试一次
    const waiter = req.commitRelayLog()
    fail(new Error('disk full'))
    await waiter
    assert.equal(calls, 2)
    assert.equal(req.relayLogCommitted, true)
    await new Promise((resolve) => setImmediate(resolve))
    assert.ok(logged.some((line) => line.includes('[billing] usage write failed') && line.includes('disk full')))
    assert.deepEqual(unhandled, [])
  } finally {
    console.error = error
    process.off('unhandledRejection', onUnhandled)
  }
})

// ---- R6 余额准入 ----

test('R6: admission is read-only and lets concurrent requests overspend; settlement goes negative', async (t) => {
  const { db, billing, keys, key, credit, micros } = await setup(t)
  await credit(0.000001)
  const second = await keys.create({ user_id: key.user_id, group_id: key.group_id })
  // 并发准入都只读余额：都通过，不预占
  const [a, b] = await Promise.all([
    billing.authorize(key, 'req-r6-a', MODEL, BODY),
    billing.authorize(second, 'req-r6-b', MODEL, BODY),
  ])
  assert.ok(a && b)
  assert.equal(micros(), 1)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM billing_charges').get().n, 0)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM billing_reservations').get().n, 0)
  await Promise.all([billing.settle(a, USAGE, MODEL), billing.settle(b, USAGE, MODEL)])
  assert.ok(micros() < 0, '两次结算都扣款，余额为负')
  await assert.rejects(billing.authorize(key, 'req-r6-later', MODEL, BODY), { code: 'insufficient_balance' })
})

// ---- R7 Key 并发 / RPM ----

/** 在准入读完库内数据之后、内存检查之前挡住，等 n 个请求都读完再一起放行。 */
function holdAfterStoredRead(keys, n) {
  const original = keys._limitFacts.bind(keys)
  let arrived = 0
  let open
  const all = new Promise((resolve) => (open = resolve))
  keys._limitFacts = async (rec) => {
    const facts = await original(rec)
    if (++arrived === n) open()
    await all
    return facts
  }
}

test('R7: concurrent acquires on one key never exceed max_concurrency', async (t) => {
  const { keys, user, group, users } = await setup(t)
  await users.update(user.id, { concurrency: 0, rpm_limit: 0 })
  const key = await keys.create({ user_id: user.id, group_id: group.id, max_concurrency: 2 })
  holdAfterStoredRead(keys, 10)
  const results = await Promise.all(Array.from({ length: 10 }, () => keys.acquire(key)))
  assert.equal(results.filter((r) => r.ok).length, 2)
  assert.ok(results.filter((r) => !r.ok).every((r) => r.code === 'api_key_concurrency_limit'))
  assert.equal(keys.inflight.get(key.id), 2)
})

test('R7: concurrent acquires respect the user concurrency cap across keys and the RPM window', async (t) => {
  const { keys, user, group, users } = await setup(t)
  await users.update(user.id, { concurrency: 3, rpm_limit: 0 })
  const owned = []
  for (let i = 0; i < 4; i++)
    owned.push(await keys.create({ user_id: user.id, group_id: group.id, max_concurrency: 0 }))
  holdAfterStoredRead(keys, 8)
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => keys.acquire(owned[i % 4])))
  assert.equal(results.filter((r) => r.ok).length, 3)
  assert.ok(results.filter((r) => !r.ok).every((r) => r.code === 'user_concurrency_limit'))
  assert.equal(keys.userInflight.get(user.id), 3)

  const limited = await keys.create({ name: 'rpm', max_concurrency: 0, rpm: 4 })
  const fresh = new ApiKeyStore({ db: keys.db, hashSecret: 'b7a-test' })
  holdAfterStoredRead(fresh, 10)
  const rpm = await Promise.all(Array.from({ length: 10 }, () => fresh.acquire(limited)))
  assert.equal(rpm.filter((r) => r.ok).length, 4)
  assert.ok(rpm.filter((r) => !r.ok).every((r) => r.code === 'api_key_rate_limit'))
})

// ---- R8 Key 额度 ----

test('R8: the quota flip is a conditional update that keeps concurrent edits', async (t) => {
  const { db, keys } = await setup(t)
  const key = await keys.create({ name: 'quota', quota: 1 })
  // 用量写入之后、状态翻转之前，管理面并发改了名称
  const original = keys.repo.recordUsage.bind(keys.repo)
  keys.repo.recordUsage = async (...args) => {
    const rec = await original(...args)
    db.prepare("UPDATE api_keys SET name='renamed' WHERE id=?").run(key.id)
    return rec
  }
  await keys.recordUsage(key.id, {}, { actualCost: 2 })
  const after = await keys.getById(key.id)
  assert.equal(after.status, 'quota_exhausted')
  assert.equal(after.name, 'renamed', '翻转不整行写回')
})

test('R8: a quota reset that lands before the flip keeps the key active', async (t) => {
  const { db, keys } = await setup(t)
  const key = await keys.create({ name: 'quota', quota: 1 })
  const original = keys.repo.recordUsage.bind(keys.repo)
  keys.repo.recordUsage = async (...args) => {
    const rec = await original(...args)
    db.prepare("UPDATE api_keys SET quota_used=0, name='reset' WHERE id=?").run(key.id)
    return rec
  }
  const rec = await keys.recordUsage(key.id, {}, { actualCost: 2 })
  assert.equal(rec.quota_used, 2, '返回写入时读到的记录（原语义）')
  const after = await keys.getById(key.id)
  assert.equal(after.status, 'active')
  assert.equal(after.quota_used, 0)
  assert.equal(after.name, 'reset')
})

// ---- R21 模型策略初始化 ----

test('R21: runtime policy loads never write; the boot warm-up seeds once even when called concurrently', async (t) => {
  closeDatabase()
  openDatabase({ dbPath: ':memory:' })
  const writes = []
  const set = SettingsRepo.prototype.set
  SettingsRepo.prototype.set = function (key, value) {
    writes.push(key)
    return set.call(this, key, value)
  }
  t.after(() => {
    SettingsRepo.prototype.set = set
    closeDatabase()
  })
  const settings = new SettingsRepo()
  loadModelPolicy({ force: true })
  loadGptModelPolicy({ force: true })
  assert.equal(settings.has('model_policy'), false, '运行期加载只读内存')
  assert.equal(settings.has('gpt_model_policy'), false)
  assert.deepEqual(writes, [])

  await Promise.all([warmModelPolicy(), warmModelPolicy(), warmGptModelPolicy(), warmGptModelPolicy()])
  assert.deepEqual(writes.sort(), ['gpt_model_policy', 'model_policy'])
  assert.equal(settings.get('model_policy').source, 'seed')
  assert.equal(settings.get('gpt_model_policy').source, 'seed')

  // 已有策略时再预热不重复写
  await Promise.all([warmModelPolicy(), warmGptModelPolicy()])
  assert.equal(writes.length, 2)
})

// ---- 已删除的临时同步出口 ----

test('B7a removed the admission and billing sync exits', async (t) => {
  const db = createDatabase({ dbPath: ':memory:' })
  t.after(() => db.close())
  const users = new UsersRepo(db)
  assert.equal(users.getByUsernameSync, undefined)
  assert.equal(PanelUserStore.prototype.getByUsernameSync, undefined)
  for (const name of ['walletSync', 'walletAmountSync', 'changeWalletSync', 'subscriptionWindowsSync'])
    assert.equal(RelayBilling.prototype[name], undefined, name)
  for (const name of [
    'domainWalletBalanceSync',
    'userWalletBalanceSync',
    'addDomainWalletBalanceSync',
    'addUserWalletBalanceSync',
    'subscriptionUsedSinceSync',
  ])
    assert.equal(billingRepo[name], undefined, name)
  assert.equal(GatewayWorkerRepo.prototype.enqueueReconciliationSync, undefined)
  assert.equal(resources.findSupplierRuntimeVmSync, undefined)
  assert.equal(ApiEndpointStore.prototype.listRawSync, undefined)
  assert.equal(ApiEndpointStore.prototype.setKeyCooldownSync, undefined)
  for (const name of ['listHydratedSync', 'hydrateSync', 'setKeyCooldownSync'])
    assert.equal(ApiEndpointsRepo.prototype[name], undefined, name)
  assert.equal(RefusalGuardsRepo.prototype.removeSync, undefined)
  // 结算与准入的仓储函数、分组倍率都是 async
  assert.equal(billingRepo.chargeByRequestId.constructor.name, 'AsyncFunction')
  assert.equal(billingRepo.insertBillingCharge.constructor.name, 'AsyncFunction')
  assert.equal(GroupsRepo.prototype.rateMultiplier.constructor.name, 'AsyncFunction')
  assert.equal(await new GroupsRepo(db).rateMultiplier(1), 1)
})
