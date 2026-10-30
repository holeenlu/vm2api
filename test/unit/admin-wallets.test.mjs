import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase, applyMigrations } from '../../src/lib/db/database.mjs'
import { PanelUserStore } from '../../src/lib/admin/panel-users.mjs'
import { RelayBilling } from '../../src/lib/admin/relay-billing.mjs'
import { ApiKeyStore } from '../../src/lib/admin/api-keys.mjs'
import { GroupsRepo } from '../../src/lib/db/repos/groups-repo.mjs'
import { createRelayHandler } from '../../src/lib/admin/relay-routes.mjs'
const model = 'claude-sonnet-5'
const request = () => ({ model, max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] })
function setup(t) {
  const db = createDatabase({ dbPath: ':memory:' })
  t.after(() => db.close())
  const store = new PanelUserStore({ db })
  const add = (name, role, parent) =>
    store.create({ username: name, password: 'testing-pass', role, actorId: parent?.id })
  const sa = add('super', 'super_admin'),
    otherSa = add('other-super', 'super_admin')
  const a = add('admin-a', 'admin', sa),
    peer = add('admin-a1', 'admin', a),
    b = add('admin-b', 'admin', otherSa)
  const ua = add('customer-a', 'user', a),
    up = add('customer-peer', 'user', peer),
    ub = add('customer-b', 'user', b)
  const own = add('super-customer', 'user', sa)
  const billing = new RelayBilling(db),
    keys = new ApiKeyStore({ db }),
    groups = new GroupsRepo(db)
  const group = groups.create({ name: 'wallet-test', rate_multiplier: 1 })
  for (const u of [a, b, own]) groups.setGrants(u.id, [group.id])
  const call = async (actor, target, amount, idem, reason = 'fund') => {
    let out
    const handler = createRelayHandler({
      apiKeyStore: { db },
      readBody: async () => ({ amount, ...(reason === null ? {} : { reason }), idempotency_key: idem }),
      json: (_res, status, body) => {
        out = { status, body }
      },
    })
    await handler(
      { method: 'POST', panelRole: actor.role, panelUser: actor.username, panelUserId: actor.id },
      {},
      new URL(`http://x/api/panel/users/${target.id}/balance`),
    )
    return out
  }
  return { db, store, add, sa, otherSa, a, peer, b, ua, up, ub, own, billing, keys, group, call }
}

test('root-domain wallet receives admin funding once and transfers exactly 5000 -> 4500 -> 3500', async (t) => {
  const { db, sa, a, peer, b, ua, up, ub, own, billing, call, store } = setup(t)
  assert.equal((await call(sa, peer, 5000, 'fund-domain-1')).status, 200)
  assert.equal((await call(sa, peer, 5000, 'fund-domain-1')).status, 200)
  assert.equal(billing.balance(a.id).balance, 5000)
  assert.equal(billing.balance(peer.id).balance, 5000)
  assert.equal(billing.balance(b.id).balance, 0)
  assert.equal((await call(peer, ua, 500, 'fund-user-500')).status, 200)
  assert.equal((await call(peer, ua, 500, 'fund-user-500')).status, 200)
  assert.equal(billing.balance(peer.id).balance, 4500)
  assert.equal((await call(a, up, 1000, 'fund-user-1000')).status, 200)
  assert.equal(billing.balance(a.id).balance, 3500)
  assert.equal(billing.balance(ua.id).balance, 500)
  assert.equal(billing.balance(up.id).balance, 1000)
  assert.equal(db.prepare("SELECT SUM(balance_micros) n FROM users WHERE role='admin'").get().n, 0)
  assert.deepEqual(billing.ledger(a.id), billing.ledger(peer.id))
  const peers = store.list({ actorId: sa.id, role: 'super_admin' }).filter((u) => [a.id, peer.id].includes(u.id))
  assert.ok(peers.every((u) => u.balance === 3500 && u.shared_balance && u.can_credit))
  assert.equal(store.list({ actorId: peer.id, role: 'admin' }).find((u) => u.id === ua.id).can_credit, true)
  assert.equal(store.repo.canFund(ub.id, { actorId: a.id, role: 'admin' }), false)
  assert.equal(store.repo.canFund(own.id, { actorId: a.id, role: 'admin' }), false)
  assert.equal(store.repo.canFund(ua.id, { role: 'admin' }), false)
  assert.equal((await call(a, ub, 1, 'reject-foreign-user')).status, 404)
  assert.equal((await call(sa, ua, 1, 'reject-granduser')).status, 403)
  assert.equal((await call(sa, b, 1, 'super-fund-other-domain')).status, 200)
  assert.equal(billing.balance(b.id).balance, 1)
  assert.equal((await call(sa, own, 1, 'super-direct-user')).status, 200)
  assert.equal((await call(a, ua, 3501, 'reject-insufficient')).status, 409)
  assert.equal(billing.balance(a.id).balance, 3500)
})

test('recharge reasons are optional while ledger actors, audit records and rollback boundaries remain intact', async (t) => {
  const { db, store, sa, a, peer, ua, up, billing, call } = setup(t)
  const funding = await call(sa, a, 50, 'optional-reason-fund', null)
  assert.equal(funding.status, 200)
  const transfer = await call(peer, ua, 10, 'optional-reason-peer', '   ')
  assert.equal(transfer.status, 200)
  assert.equal((await call(peer, ua, 10, 'optional-reason-peer', null)).status, 200)
  assert.equal(billing.balance(a.id).balance, 40)
  assert.equal(billing.balance(ua.id).balance, 10)
  const rows = billing.ledger(null)
  assert.equal(rows.length, 3)
  assert.ok(rows.every((row) => row.reason === ''))
  assert.equal(rows.find((row) => row.kind === 'adjustment').actor, sa.username)
  assert.ok(rows.filter((row) => row.kind === 'transfer').every((row) => row.actor === peer.username))
  const audit = db
    .prepare("SELECT actor,reason FROM operation_audit WHERE action IN ('wallet.add','wallet.transfer')")
    .all()
  assert.deepEqual(
    audit.map((row) => [row.actor, row.reason]),
    [
      [sa.username, ''],
      [peer.username, ''],
    ],
  )
  assert.equal((await call(a, up, 41, 'optional-reason-insufficient', null)).status, 409)
  assert.equal(billing.ledger(null).length, 3)
  assert.equal(billing.balance(a.id).balance, 40)
  assert.equal(billing.balance(up.id).balance, 0)
  assert.throws(
    () => billing.adjust(a.id, { amount: 1, reason: {}, idempotency_key: 'invalid-reason-type' }, sa.username),
    { code: 'invalid_reason' },
  )
  assert.throws(() => billing.reverse(rows.find((row) => row.kind === 'adjustment').id, {}, sa.username), {
    code: 'reason_required',
  })
  // Stable membership permits the remaining peer to fund customers after the root account is deleted.
  store.remove(a.id, { actorId: peer.id })
  assert.equal((await call(peer, ua, 5, 'optional-after-root-delete', null)).status, 200)
  assert.equal(billing.balance(peer.id).balance, 35)
  assert.equal(billing.balance(ua.id).balance, 15)
})

test('administrator completed charges share funds, user keys debit only the user, settlement survives root deletion', (t) => {
  const { db, sa, a, peer, ua, store, billing, keys, group } = setup(t)
  billing.adjust(peer.id, { amount: 1, reason: 'test', idempotency_key: 'fund-for-usage' }, sa.id)
  billing.adjust(ua.id, { amount: 1, reason: 'test', idempotency_key: 'fund-user-usage' }, sa.id)
  const ka = keys.create({ user_id: a.id, group_id: group.id }),
    kp = keys.create({ user_id: peer.id, group_id: group.id }),
    ku = keys.create({ user_id: ua.id, group_id: group.id })
  const ta = billing.authorize(ka, 'request-a', model, request())
  billing.authorize(kp, 'request-peer', model, request())
  assert.equal(billing.balance(peer.id).available, 1)
  store.remove(a.id, { actorId: peer.id })
  assert.equal(store.repo.scopeRootId(peer.id), ta.wallet_domain_id)
  const usage = { input_tokens: 100, output_tokens: 20 }
  const before = billing.balance(peer.id).balance
  const settled = billing.settle(ta, usage, model, (_, cost) => keys.recordUsage(ka, usage, { actualCost: cost }))
  assert.equal(Math.round(billing.balance(peer.id).balance * 1e6), Math.round(before * 1e6) - settled.actual_micros)
  billing.settle(ta, usage, model, () => assert.fail('double metering'))
  const tu = billing.authorize(ku, 'request-user', model, request())
  const domainAfter = billing.balance(peer.id).balance
  billing.settle(tu, usage, model, (_, cost) => keys.recordUsage(ku, usage, { actualCost: cost }))
  assert.equal(billing.balance(peer.id).balance, domainAfter)
  assert.ok(billing.balance(ua.id).balance < 1)
  assert.ok(billing.ledger(peer.id).some((r) => r.request_id === ta.request_id))
})

test('super-admin exemption preserves real Key USD metering and survives a role change', (t) => {
  const { db, sa, billing, keys, group } = setup(t)
  const key = keys.create({ user_id: sa.id, group_id: group.id, quota: 0.000001 })
  const ticket = billing.authorize(key, 'super-request', model, request())
  assert.equal(ticket.balance_exempt, true)
  assert.equal(billing.balance(sa.id).available, 0)
  const usage = { input_tokens: 1000, output_tokens: 100 }
  db.prepare("UPDATE users SET role='user' WHERE id=?").run(sa.id)
  billing.settle(ticket, usage, model, (rate, cost) =>
    keys.recordUsage(key, usage, { actualCost: cost, rateMultiplier: rate }),
  )
  assert.equal(billing.balance(sa.id).balance, 0)
  assert.ok(keys.getById(key.id).quota_used > 0)
  assert.equal(keys.getById(key.id).status, 'quota_exhausted')
  assert.equal(keys.acquire(keys.getById(key.id)).ok, false)
  assert.equal(billing.ledger(sa.id).length, 0)
})

test('super-admin no-group platform Key bypasses wallet billing without mutating upstream body', (t) => {
  const { sa, billing, keys, db } = setup(t)
  const key = keys.create({ user_id: sa.id, quota: 1 })
  const body = { model, messages: [{ role: 'user', content: 'hello' }] }
  const before = structuredClone(body)
  assert.equal(billing.authorize(key, 'platform-request', model, body), null)
  assert.deepEqual(body, before)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM billing_reservations').get().n, 0)
})

test('migration pools existing administrator balances and holds without rewriting historical amounts', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'domain-wallet-upgrade-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const migrations = path.join(root, 'migrations')
  fs.mkdirSync(migrations)
  for (const name of fs.readdirSync('src/lib/db/migrations'))
    if (name.endsWith('.sql') && name < '066')
      fs.copyFileSync(path.join('src/lib/db/migrations', name), path.join(migrations, name))
  const db = createDatabase({ dbPath: ':memory:', migrationsDir: migrations })
  t.after(() => db.close())
  for (const [id, role, parent, money] of [
    ['sa', 'super_admin', null, 0],
    ['a', 'admin', 'sa', 2000000],
    ['p', 'admin', 'a', 3000000],
    ['u', 'user', 'p', 7000000],
    ['b', 'admin', 'sa', 9000000],
  ])
    db.prepare(
      "INSERT INTO users(id,username,email,password_hash,role,parent_user_id,balance_micros,balance) VALUES(?,?,?,'x',?,?,?,?)",
    ).run(id, id, id + '@test', role, parent, money, money / 1e6)
  db.exec(`INSERT INTO billing_reservations(request_id,user_id,api_key_id,group_id,status,reserved_micros,rate_multiplier,group_version,created_at,updated_at) VALUES('pending','p','key',1,'pending_usage',1000000,1,1,'2026-01-01','2026-01-01');
    INSERT INTO wallet_ledger(id,user_id,kind,amount_micros,balance_after_micros,idempotency_key,reason,created_at) VALUES('old','p','adjustment',3000000,3000000,'legacy','test','2026-01-01');`)
  applyMigrations(db)
  const billing = new RelayBilling(db)
  assert.equal(billing.balance('a').balance, 5)
  assert.equal(billing.balance('p').available, 5)
  assert.equal(billing.balance('u').balance, 7)
  assert.equal(billing.balance('b').balance, 9)
  assert.equal(billing.ledger('a')[0].amount_micros, 3000000)
  assert.equal(
    db.prepare("SELECT balance_exempt FROM billing_reservations WHERE request_id='pending'").get().balance_exempt,
    0,
  )
  applyMigrations(db)
  assert.equal(billing.balance('a').balance, 5)
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
})
