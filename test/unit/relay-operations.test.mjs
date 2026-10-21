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
test('concurrent keys share reservations; duplicate settlement cannot double debit', (t) => {
  const { billing, user, keys, key } = setup(t)
  const cost = calculateCost(
    { input_tokens: Buffer.byteLength(JSON.stringify(body)), output_tokens: 64 },
    model,
  ).total_cost
  credit(billing, user, cost)
  const second = keys.create({ user_id: user.id, group_id: key.group_id })
  billing.reserve(key, 'request-a', model, body)
  assert.throws(() => billing.reserve(second, 'request-b', model, body), /余额不足/)
  const usage = { input_tokens: 1, output_tokens: 1 }
  let writes = 0
  const first = billing.settle('request-a', usage, model, null, () => {
    writes++
  })
  billing.settle('request-a', usage, model, null, () => {
    writes++
  })
  assert.equal(writes, 1)
  assert.equal(first.status, 'settled')
  assert.equal(billing.balance(user.id).reserved, 0)
  assert.equal(billing.ledger(user.id).filter((r) => r.kind === 'usage').length, 1)
})
test('billing transaction rolls back if key metering fails', (t) => {
  const { billing, user, key } = setup(t)
  credit(billing, user)
  billing.reserve(key, 'request-failure', model, body)
  assert.throws(
    () =>
      billing.settle('request-failure', { input_tokens: 20, output_tokens: 20 }, model, null, () => {
        throw new Error('meter failed')
      }),
    /meter failed/,
  )
  assert.equal(billing.balance(user.id).balance, 1)
  assert.equal(billing.ledger(user.id).length, 1)
  assert.ok(billing.balance(user.id).reserved > 0)
})
test('request pricing rate snapshot survives later group edits; cancelled admissions release holds', (t) => {
  const { billing, user, key, groups, group } = setup(t)
  credit(billing, user)
  billing.reserve(key, 'snapshot', model, body)
  groups.update(group.id, { rate_multiplier: 10 })
  const usage = { input_tokens: 100, output_tokens: 100 }
  const result = billing.settle('snapshot', usage, model)
  assert.equal(result.actual_micros, Math.round(calculateCost(usage, model).total_cost * 1e6))
  billing.reserve(key, 'rejected', model, body)
  billing.finish('rejected')
  assert.equal(billing.balance(user.id).reserved, 0)
})
test('subscription blocks overlaps, charges windows instead of wallet and immediately revokes', (t) => {
  const { billing, user, key, groups, group, db } = setup(t)
  groups.update(group.id, { subscription_type: 'subscription', daily_limit_usd: 1 })
  assert.throws(() => billing.reserve(key, 'no-sub', model, body), /套餐/)
  const sub = billing.createSubscription({ user_id: user.id, group_id: group.id }, 'admin')
  assert.throws(() => billing.createSubscription({ user_id: user.id, group_id: group.id }, 'admin'), /重叠/)
  billing.reserve(key, 'sub-req', model, body)
  billing.settle('sub-req', { input_tokens: 100, output_tokens: 10 }, model)
  assert.equal(billing.balance(user.id).balance, 0)
  assert.ok(billing.subscriptions(user.id)[0].windows[0].used > 0)
  billing.updateSubscription(sub.id, 'revoked', 'admin')
  assert.throws(() => billing.reserve(key, 'revoked', model, body), /套餐/)
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

test('restart retains unknown holds for auditable recovery; free usage differs from missing usage', (t) => {
  const { billing, db, user, key, groups, group } = setup(t)
  credit(billing, user, 3)
  billing.reserve(key, 'interrupted', model, body)
  assert.equal(billing.recover(), 1)
  assert.equal(billing.balance(user.id).reserved > 0, true)
  billing.resolve('interrupted', { action: 'release', reason: 'verified no upstream execution' }, 'admin')
  assert.equal(billing.balance(user.id).balance, 3)
  assert.equal(billing.balance(user.id).reserved, 0)
  groups.update(group.id, { rate_multiplier: 0 })
  billing.reserve(key, 'free', model, body)
  billing.settle('free', { input_tokens: 10, output_tokens: 3 }, model)
  assert.equal(
    db.prepare("SELECT actual_micros FROM billing_reservations WHERE request_id='free'").get().actual_micros,
    0,
  )
})
test('customer deletion, rotation and key quota reset never restore wallet funds', (t) => {
  const { billing, user, key, keys } = setup(t)
  credit(billing, user, 1)
  billing.reserve(key, 'usage', model, body)
  billing.settle('usage', { input_tokens: 1000, output_tokens: 100 }, model, 0, (rate) =>
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
