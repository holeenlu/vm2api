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
import { calculateCost } from '../../src/lib/admin/pricing.mjs'
import { keyScopeFromRecord, keyAllowsVm } from '../../src/lib/admin/key-scope.mjs'
import { ownerPred } from '../../src/lib/db/repos/usage-log-preds.mjs'

function setup(t) {
  closeDatabase()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-test-'))
  const db = openDatabase({ dataDir: dir })
  t.after(() => {
    closeDatabase()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const users = new PanelUserStore({ db })
  const user = users.create({ username: 'customer', password: 'customer-pass' })
  const groups = new GroupsRepo(db)
  const group = groups.create({ name: 'service', platform: 'anthropic' })
  groups.setGrants(user.id, [group.id])
  const keys = new ApiKeyStore({ db })
  const key = keys.create({ user_id: user.id, group_id: group.id })
  const billing = new RelayBilling(db)
  return { db, users, user, groups, group, keys, key, billing }
}
function credit(billing, user, amount = 1, key = 'test-credit-1') {
  return billing.adjust(user.id, { amount, reason: 'test credit', idempotency_key: key }, 'test-admin')
}
const model = 'claude-sonnet-5'
const body = { model, max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] }

test('empty VM supports multiple groups, version conflicts do not partially change membership', (t) => {
  const { groups, group } = setup(t)
  const other = groups.create({ name: 'premium', platform: 'anthropic' })
  const first = groups.assignResource('vm', 'empty-slot', [group.id, other.id], 0, 'admin')
  assert.equal(first.groups.length, 2)
  assert.equal(first.groups_version, 1)
  assert.throws(() => groups.assignResource('vm', 'empty-slot', [], 0), /刷新/)
  assert.equal(groups.forResource('vm', 'empty-slot').length, 2)
  groups.assignResource('vm', 'empty-slot', [other.id], 1)
  assert.equal(groups.resources(group.id).length, 0)
  assert.equal(groups.resources(other.id).length, 1)
})
test('commercial authorization reads grants and memberships live and has no global fallback', (t) => {
  const { db, user, groups, group, key } = setup(t)
  assert.equal(keyAllowsVm(keyScopeFromRecord(key, db), { id: 'vm-1' }), false)
  groups.assignResource('vm', 'vm-1', [group.id], 0)
  assert.equal(keyAllowsVm(keyScopeFromRecord(key, db), { id: 'vm-1' }), true)
  groups.setGrants(user.id, [])
  assert.equal(keyScopeFromRecord(key, db).error, 'group_forbidden')
  assert.equal(keyScopeFromRecord({ ...key, group_id: null }, db).error, 'group_required')
})
test('zero user concurrency and RPM allow concurrent keys while key concurrency still applies', (t) => {
  const { users, user, keys, key, group } = setup(t)
  users.update(user.id, { concurrency: 0, rpm_limit: 0 })
  const capped = keys.create({ user_id: user.id, group_id: group.id, max_concurrency: 1 })
  for (let i = 0; i < 8; i++) assert.equal(keys.acquire(key).ok, true)
  assert.equal(keys.acquire(capped).ok, true)
  assert.equal(keys.acquire(capped).code, 'api_key_concurrency_limit')
  assert.equal(keys.acquire(key).ok, true)
  keys.release(capped)
  assert.equal(keys.acquire(capped).ok, true)
})
test('wallet adjustments are idempotent and generic user updates never overwrite money', (t) => {
  const { billing, user, users } = setup(t)
  const stale = users.getById(user.id)
  credit(billing, user, 2)
  credit(billing, user, 2)
  assert.equal(billing.balance(user.id).balance, 2)
  assert.throws(() => credit(billing, user, 3), /幂等/)
  users.repo.update({ ...stale, username: 'customer' })
  assert.equal(billing.balance(user.id).balance, 2)
  assert.equal(billing.ledger(user.id).length, 1)
})
test('administrator transfers available balance to a customer atomically and retries idempotently', (t) => {
  const { billing, user, users, groups, group, keys } = setup(t)
  const admin = users.create({ username: 'manager', password: 'manager-pass', role: 'admin' })
  credit(billing, admin, 5, 'admin-seed-1')
  groups.setGrants(admin.id, [group.id])
  const adminKey = keys.create({ user_id: admin.id, group_id: group.id })
  const first = billing.transfer(
    admin.id,
    user.id,
    { amount: 2, reason: 'customer top-up', idempotency_key: 'customer-transfer-1' },
    admin.username,
  )
  assert.equal(first.balance, 2)
  assert.equal(first.source.balance, 3)
  const duplicate = billing.transfer(
    admin.id,
    user.id,
    { amount: 2, reason: 'customer top-up', idempotency_key: 'customer-transfer-1' },
    admin.username,
  )
  assert.equal(duplicate.duplicate, true)
  assert.equal(billing.balance(admin.id).balance, 3)
  assert.equal(billing.balance(user.id).balance, 2)
  assert.equal(billing.ledger(null).filter((row) => row.kind === 'transfer').length, 2)
  assert.throws(
    () =>
      billing.transfer(
        admin.id,
        user.id,
        { amount: 4, reason: 'too much', idempotency_key: 'customer-transfer-2' },
        admin.username,
      ),
    /余额不足/,
  )
  const adminContext = billing.authorize(adminKey, 'admin-owned-request', model, body)
  billing.settle(adminContext, { input_tokens: 1, output_tokens: 1 }, model)
  assert.ok(billing.balance(admin.id).balance < 3)
})
test('concurrent keys do not freeze funds; actual charges are idempotent and gate later requests', (t) => {
  const { billing, db, user, keys, key } = setup(t)
  credit(billing, user, 0.000001)
  const second = keys.create({ user_id: user.id, group_id: key.group_id })
  const firstContext = billing.authorize(key, 'request-a', model, body)
  billing.authorize(second, 'request-b', model, body)
  assert.equal(billing.balance(user.id).available, 0.000001)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM billing_charges').get().n, 0)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM billing_reservations').get().n, 0)
  const usage = { input_tokens: 100, output_tokens: 100 }
  let writes = 0
  const first = billing.settle(firstContext, usage, model, () => writes++)
  billing.settle(firstContext, usage, model, () => writes++)
  assert.equal(writes, 1)
  assert.equal(first.status, 'settled')
  assert.ok(billing.balance(user.id).balance < 0)
  assert.throws(() => billing.authorize(second, 'later', model, body), { code: 'insufficient_balance' })
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM billing_charges WHERE request_id='request-a'").get().n, 1)
  assert.equal(billing.ledger(user.id).filter((r) => r.kind === 'usage').length, 0)
})

test('billing transaction rolls back Key failures without leaving a hold or receipt', (t) => {
  const { billing, db, user, key } = setup(t)
  credit(billing, user)
  const context = billing.authorize(key, 'request-failure', model, body)
  assert.throws(
    () =>
      billing.settle(context, { input_tokens: 20, output_tokens: 20 }, model, () => {
        throw new Error('meter failed')
      }),
    /meter failed/,
  )
  assert.equal(billing.balance(user.id).available, 1)
  assert.equal(billing.ledger(user.id).length, 1)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM billing_charges').get().n, 0)
  billing.settle(context, { input_tokens: 20, output_tokens: 20 }, model)
  assert.ok(billing.balance(user.id).balance < 1)
})

test('request pricing snapshot survives edits without estimating cost or modifying output limits', (t) => {
  const { billing, db, user, key, groups, group } = setup(t)
  credit(billing, user)
  const input = { model, input: 'hello' }
  const context = billing.authorize(key, 'snapshot', model, input)
  assert.deepEqual(input, { model, input: 'hello' })
  billing.authorize(key, 'large-output', model, { ...input, max_output_tokens: 1000000 })
  groups.update(group.id, { rate_multiplier: 10 })
  const usage = { input_tokens: 100, output_tokens: 100 }
  const result = billing.settle(context, usage, model)
  assert.equal(result.actual_micros, Math.round(calculateCost(usage, model).total_cost * 1e6))
  assert.equal(db.prepare('SELECT COUNT(*) n FROM billing_charges').get().n, 1)
})

test('subscription blocks overlaps, charges windows instead of wallet and immediately revokes', (t) => {
  const { billing, user, key, groups, group, db } = setup(t)
  groups.update(group.id, { subscription_type: 'subscription', daily_limit_usd: 1 })
  assert.throws(() => billing.authorize(key, 'no-sub', model, body), /套餐/)
  const sub = billing.createSubscription({ user_id: user.id, group_id: group.id }, 'admin')
  assert.throws(() => billing.createSubscription({ user_id: user.id, group_id: group.id }, 'admin'), /重叠/)
  const subContext = billing.authorize(key, 'sub-req', model, body)
  billing.settle(subContext, { input_tokens: 100, output_tokens: 10 }, model)
  assert.equal(billing.balance(user.id).balance, 0)
  assert.ok(billing.subscriptions(user.id)[0].windows[0].used > 0)
  billing.updateSubscription(sub.id, 'revoked', 'admin')
  assert.throws(() => billing.authorize(key, 'revoked', model, body), /套餐/)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM wallet_ledger').get().n, 0)
})
test('customer history excludes VM ownership and current key reassignments', (t) => {
  const { db, user } = setup(t)
  const p = ownerPred(user.id)
  db.prepare('INSERT INTO usage_logs(id,request_id,created_at,user_id,vm_owner_user_id) VALUES(?,?,?,?,?)').run(
    'a',
    'a',
    new Date().toISOString(),
    'another',
    user.id,
  )
  assert.equal(db.prepare('SELECT COUNT(*) n FROM usage_logs WHERE ' + p.sql).get(...p.params).n, 0)
})

test('abandoned requests leave no persistent state; unknown pricing does not require reconciliation', (t) => {
  const { billing, db, user, key, groups, group } = setup(t)
  credit(billing, user, 3)
  billing.authorize(key, 'abandoned', model, body)
  const restarted = new RelayBilling(db)
  assert.equal(restarted.balance(user.id).available, 3)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM billing_charges').get().n, 0)
  const unknown = billing.authorize(key, 'unknown', 'unpriced-test-model', {})
  const result = billing.settle(unknown, { input_tokens: 10 }, 'unpriced-test-model')
  assert.equal(result.status, 'unmetered')
  assert.equal(result.actual_micros, null)
  assert.equal(billing.balance(user.id).available, 3)
  groups.update(group.id, { rate_multiplier: 0 })
  const free = billing.authorize(key, 'free', model, body)
  assert.equal(billing.settle(free, { input_tokens: 10, output_tokens: 3 }, model).actual_micros, 0)
})

test('customer deletion, rotation and key quota reset never restore wallet funds', (t) => {
  const { billing, user, key, keys } = setup(t)
  credit(billing, user, 1)
  const usageContext = billing.authorize(key, 'usage', model, body)
  billing.settle(usageContext, { input_tokens: 1000, output_tokens: 100 }, model, (rate) =>
    keys.recordUsage(key, { input_tokens: 1000, output_tokens: 100 }, { model, rateMultiplier: rate }),
  )
  const after = billing.balance(user.id).balance
  keys.update(key.id, { reset_quota: true })
  keys.rotate(key.id)
  assert.equal(billing.balance(user.id).balance, after)
})

test('refund adds one opposite ledger entry with a durable original reference', (t) => {
  const { billing, user, db } = setup(t)
  const creditResult = credit(billing, user, 2)
  const original = creditResult.transaction.id
  billing.reverse(original, { reason: 'wrong manual credit' }, 'admin')
  billing.reverse(original, { reason: 'retry' }, 'admin')
  assert.equal(billing.balance(user.id).balance, 0)
  const rows = db.prepare('SELECT * FROM wallet_ledger ORDER BY created_at').all()
  assert.equal(rows.length, 2)
  assert.equal(JSON.parse(rows[1].metadata_json).reverses, original)
})
test('live commercial sessions isolate customer, key and group even with forged identical client IDs', async (t) => {
  const { db, key } = setup(t)
  const { StickyRouter } = await import('../../src/lib/pool/sticky-router.mjs')
  const router = new StickyRouter({ db, config: { sticky: { enabled: true } } })
  const req = { apiKeyKind: 'managed', apiKeyRecord: key }
  const key1 = router.sessionPoolKeys(req, {}, { sessionId: 'identical', deviceId: 'identical' }).stickyKey
  const key2 = router.sessionPoolKeys(
    { ...req, apiKeyRecord: { ...key, id: 'other' } },
    {},
    { sessionId: 'identical', deviceId: 'identical' },
  ).stickyKey
  const key3 = router.sessionPoolKeys(
    { ...req, apiKeyRecord: { ...key, group_id: 99 } },
    {},
    { sessionId: 'identical', deviceId: 'identical' },
  ).stickyKey
  assert.equal(new Set([key1, key2, key3]).size, 3)
  assert.notEqual(
    router.canonicalDeviceKey('same', req),
    router.canonicalDeviceKey('same', { ...req, apiKeyRecord: { ...key, user_id: 'other' } }),
  )
})
test('legacy migration preserves private pool scopes and never rewrites historical usage ownership', async (t) => {
  const { db, user, keys } = setup(t)
  const { migrateRelayScopes } = await import('../../src/lib/admin/relay-migration.mjs')
  const old = keys.create({ user_id: user.id })
  db.prepare("UPDATE api_keys SET group_type='anthropic',allowed_vms=? WHERE id=?").run(
    JSON.stringify(['private', 'public']),
    old.id,
  )
  const report = migrateRelayScopes(
    db,
    [
      { id: 'private', owner_user_id: user.id },
      { id: 'public', owner_user_id: null },
      { id: 'other-private', owner_user_id: 'someone' },
    ],
    [],
  )
  const migrated = report.keys.find((k) => k.key_id === old.id)
  assert.deepEqual(migrated.resource_ids, ['private'])
  assert.equal(report.private_resources.length, 2)
  assert.deepEqual(migrateRelayScopes(db, [], []), report)
})
test('deleted in-flight Key still occupies the user concurrency and cannot create extra capacity', (t) => {
  const { keys, key, user } = setup(t)
  keys.users.update({ ...keys.users.getById(user.id), concurrency: 1 })
  assert.equal(keys.acquire(key).ok, true)
  keys.remove(key.id)
  const another = keys.create({ user_id: user.id, group_id: key.group_id })
  assert.equal(keys.acquire(another).code, 'user_concurrency_limit')
  keys.release(key.id)
  assert.equal(keys.acquire(another).ok, true)
  keys.release(another.id)
})

test('ledger keyset cursor does not skip same-millisecond transactions', (t) => {
  const { billing, db, user } = setup(t)
  for (let i = 0; i < 3; i++) credit(billing, user, 1, 'cursor-credit-' + i)
  db.prepare('UPDATE wallet_ledger SET created_at=?').run('2026-10-20T00:00:00.000Z')
  const first = billing.ledger(user.id, { limit: 2 }),
    last = first.at(-1)
  const second = billing.ledger(user.id, { limit: 2, before: last.created_at, before_id: last.id })
  assert.equal(first.length, 2)
  assert.equal(second.length, 1)
  assert.equal(new Set([...first, ...second].map((r) => r.id)).size, 3)
})

test('slow resource update rechecks current version inside its write transaction', async (t) => {
  const { createRelayHandler } = await import('../../src/lib/admin/relay-routes.mjs')
  const { db, keys, groups, group } = setup(t)
  let releaseBody, entered
  const reading = new Promise((resolve) => {
    entered = resolve
  })
  const delayed = new Promise((resolve) => {
    releaseBody = resolve
  })
  const response = {}
  const handle = createRelayHandler({
    apiKeyStore: keys,
    cfg: { paths: { project: os.tmpdir() } },
    readBody: async () => {
      entered()
      return delayed
    },
    json(_res, status, body) {
      Object.assign(response, { status, body })
    },
  })
  const work = handle(
    { method: 'PUT', panelRole: 'super_admin' },
    {},
    new URL('http://localhost/api/panel/groups/' + group.id + '/resources'),
  )
  await reading
  // A second completed edit changes the same group while the first reads its body.
  groups.assignResource('api_endpoint', 'other-endpoint', [group.id], 0)
  const before = groups.getById(group.id)
  const audits = db.prepare('SELECT COUNT(*) n FROM operation_audit').get().n
  releaseBody({ expected_version: group.version, resources: [] })
  await work
  assert.equal(response.status, 409)
  assert.deepEqual(groups.getById(group.id), before)
  assert.equal(groups.resources(group.id)[0].resource_id, 'other-endpoint')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM operation_audit').get().n, audits)
})
test('stale key admission observes revocation, rotation, changed scope, spend and IP policy', (t) => {
  const { keys, key, groups } = setup(t)
  keys.update(key.id, { status: 'disabled' })
  assert.equal(keys.acquire(key).ok, false)
  keys.update(key.id, { status: 'active', ip_whitelist: ['192.0.2.1'] })
  assert.equal(keys.acquire(key, Date.now(), '127.0.0.1').code, 'ip_not_allowed')
  keys.update(key.id, { ip_whitelist: [], quota: 0.001 })
  keys.recordUsage(key, { input_tokens: 1, output_tokens: 1 }, { actualCost: 0.002 })
  assert.equal(keys.acquire(key).ok, false)
  keys.update(key.id, { reset_quota: true, quota: 0 })
  const group = groups.create({ name: 'changed-group' })
  keys.update(key.id, { group_id: group.id })
  assert.equal(keys.acquire(key).code, 'api_key_scope_changed')
  keys.update(key.id, { group_id: key.group_id })
  keys.rotate(key.id)
  assert.equal(keys.acquire(key).code, 'invalid_api_key')
  const rotated = keys.getById(key.id)
  keys.remove(key.id)
  assert.equal(keys.acquire(rotated).code, 'invalid_api_key')
  assert.equal(keys.inflight.size, 0)
})
test('subscription windows count only completed actual charges through the bounded index', (t) => {
  const { db, billing, groups, group, user, key } = setup(t)
  groups.update(group.id, { subscription_type: 'subscription', daily_limit_usd: 10 })
  const sub = billing.createSubscription({ user_id: user.id, group_id: group.id }, 'admin')
  const context = billing.authorize(key, 'window-settled', model, body)
  const settled = billing.settle(context, { input_tokens: 100, output_tokens: 10 }, model)
  billing.authorize(key, 'window-unfinished', model, body)
  for (const window of billing.subscriptionWindows(sub.id, groups.getById(group.id)))
    assert.equal(window.used, settled.actual_micros / 1e6)
  const plan = db
    .prepare(
      'EXPLAIN QUERY PLAN SELECT COALESCE(SUM(actual_micros),0) FROM billing_charges WHERE subscription_id=? AND created_at>?',
    )
    .all(sub.id, '2026-01-01')
  assert.match(plan.map((row) => row.detail).join(' '), /SEARCH.*idx_billing_charges_subscription_created/)
})

test('queued platform and grouped requests cannot revive a revoked or rotated key', async (t) => {
  const { keyScopeFromRequest, refreshKeyScope } = await import('../../src/lib/admin/key-scope.mjs')
  const { keys, key } = setup(t)
  const platform = keys.create({ category: 'oauth' })
  for (const record of [key, platform]) {
    const scope = keyScopeFromRequest({
      apiKeyKind: 'managed',
      apiKeyRecord: record,
      socket: { remoteAddress: '127.0.0.1' },
    })
    keys.update(record.id, { status: 'disabled' })
    assert.ok(refreshKeyScope(scope).error)
    assert.equal(keyAllowsVm(refreshKeyScope(scope), { id: 'vm-1' }), false)
    keys.update(record.id, { status: 'active' })
    keys.rotate(record.id)
    assert.ok(refreshKeyScope(scope).error)
    assert.ok(keyScopeFromRequest({ apiKeyKind: 'managed', apiKeyRecord: record }).error)
  }
})

test('Images settlement uses the image price snapshot once; incomplete pricing leaves no funds frozen', (t) => {
  const { db, billing, user, key } = setup(t)
  credit(billing, user, 10)
  const imageModel = 'gpt-image-2.5-flare'
  const input = { model: imageModel, prompt: 'fixture image' }
  const ticket = billing.authorize(key, 'image-once', imageModel, input, { protocol: 'openai.images' })
  assert.deepEqual(input, { model: imageModel, prompt: 'fixture image' })
  const usage = {
    image_generation: {
      model: imageModel,
      only: true,
      usage: {
        input_tokens: 300,
        input_tokens_details: { text_tokens: 100, image_tokens: 200 },
        output_tokens: 1000,
        total_tokens: 1300,
      },
    },
  }
  const expected = calculateCost(usage, imageModel, { resolvedPrice: JSON.parse(ticket.quote_json) })
  assert.equal(expected.known, true)
  assert.ok(expected.total_cost > 0)
  let calls = 0
  const first = billing.settle(ticket, usage, imageModel, () => calls++)
  billing.settle(ticket, usage, imageModel, () => calls++)
  assert.equal(first.status, 'settled')
  assert.equal(first.actual_micros, Math.round(expected.total_cost * 1e6))
  assert.equal(calls, 1)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM billing_charges WHERE request_id='image-once'").get().n, 1)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM wallet_ledger WHERE request_id='image-once'").get().n, 0)
  const incompleteContext = billing.authorize(
    key,
    'image-missing-split',
    imageModel,
    { ...input },
    { protocol: 'openai.images' },
  )
  const incomplete = {
    image_generation: { model: imageModel, only: true, usage: { input_tokens: 300, output_tokens: 1000 } },
  }
  assert.equal(billing.settle(incompleteContext, incomplete, imageModel).status, 'unmetered')
})

test('Responses image-tool cost is included with text usage and frozen in request pricing snapshot', (t) => {
  const { billing, user, key } = setup(t)
  credit(billing, user, 10)
  const textModel = 'gpt-6-luna',
    imageModel = 'gpt-image-2.5-flare'
  const ticket = billing.authorize(
    key,
    'tool-image',
    textModel,
    {
      model: textModel,
      input: 'fixture',
      tools: [{ type: 'image_generation', model: imageModel }],
    },
    { protocol: 'openai.responses' },
  )
  const quote = JSON.parse(ticket.quote_json)
  assert.ok(quote.image_price.price.image)
  const plain = { input_tokens: 100, output_tokens: 50 }
  const usage = {
    ...plain,
    image_generation: {
      model: imageModel,
      only: false,
      usage: {
        input_tokens: 50,
        input_tokens_details: { text_tokens: 50, image_tokens: 0 },
        output_tokens: 100,
      },
    },
  }
  const cost = calculateCost(usage, textModel, { resolvedPrice: quote })
  assert.ok(cost.total_cost > calculateCost(plain, textModel, { resolvedPrice: quote }).total_cost)
  const result = billing.settle(ticket, usage, textModel)
  assert.equal(result.actual_micros, Math.round(cost.total_cost * 1e6))
})

test('a settled charge is returned without the JSON blobs its caller never reads', (t) => {
  const { billing, db, user, key } = setup(t)
  credit(billing, user, 1, 'blob-credit')
  const context = billing.authorize(key, 'blob-request', model, body)
  const usage = { input_tokens: 100, output_tokens: 100, attribution: { items: { amsg_1: { input_tokens: 1 } } } }
  const first = billing.settle(context, usage, model)
  // What handle-protocol reads off the result.
  assert.equal(first.status, 'settled')
  assert.equal(typeof first.actual_micros, 'number')
  assert.equal(first.group_id, key.group_id)
  assert.equal(first.subscription_id, null)
  assert.equal(first.rate_multiplier, context.rate_multiplier)
  assert.equal(first.request_id, 'blob-request')
  // The row still holds its blobs; the read path simply stops carrying them.
  for (const key_ of ['usage_json', 'quote_json']) assert.equal(key_ in first, false)
  assert.ok(db.prepare('SELECT usage_json FROM billing_charges WHERE request_id=?').get('blob-request').usage_json)
  // The idempotent re-settle takes the other read path and must match.
  const again = billing.settle(context, usage, model)
  assert.deepEqual(again, first)
})
