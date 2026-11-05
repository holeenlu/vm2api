import test from 'node:test'
import assert from 'node:assert/strict'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { UsersRepo } from '../../src/lib/db/repos/users-repo.mjs'
import { UsageLogsRepo } from '../../src/lib/db/repos/usage-logs-repo.mjs'
import { UsageLogsView } from '../../src/lib/db/repos/usage-logs-view.mjs'
import { StatisticsRepo } from '../../src/lib/db/repos/statistics-repo.mjs'
import { createRelayHandler } from '../../src/lib/admin/relay-routes.mjs'

function fixture(t) {
  const db = createDatabase({ dbPath: ':memory:' })
  t.after(() => db.close())
  const users = new UsersRepo(db)
  const logs = new UsageLogsRepo(db)
  const now = new Date().toISOString()
  for (const [id, role, parent] of [
    ['sa', 'super_admin', null],
    ['a', 'admin', 'sa'],
    ['a1', 'admin', 'a'],
    ['a2', 'admin', 'a1'],
    ['au', 'user', 'a2'],
    ['b', 'admin', 'sa'],
    ['bu', 'user', 'b'],
  ]) {
    users.insert({ id, role, parent_user_id: parent, username: id, password_hash: 'unused', balance: 1 })
    db.prepare('INSERT INTO api_keys(id,name,key,user_id,created_by_user_id) VALUES(?,?,?,?,?)').run(
      `k-${id}`,
      id,
      `sk-${id}`,
      id,
      id,
    )
    logs.insertSummary({
      id: `log-${id}`,
      request_id: `req-${id}`,
      created_at: now,
      user_id: id,
      api_key_id: `k-${id}`,
      status: 200,
      model: 'test-model',
      path: '/v1/responses',
    })
    db.prepare(`INSERT INTO wallet_ledger(id,user_id,kind,amount_micros,balance_after_micros,idempotency_key,reason,created_at)
      VALUES(?,?,'adjustment',1000000,1000000,?,'fixture',?)`).run(id, id, id, now)
    db.prepare(`INSERT INTO user_subscriptions(id,user_id,group_id,starts_at,created_at,updated_at)
      VALUES(?,?,1,?,?,?)`).run(id, id, now, now, now)
  }
  db.exec(
    "UPDATE wallet_ledger SET wallet_domain_id=(SELECT admin_domain_id FROM users WHERE users.id=wallet_ledger.user_id AND role='admin')",
  )
  return { db, users, logs, view: new UsageLogsView(db) }
}

test('admin usage queries execute for the whole root domain, selected user and own keys', (t) => {
  const { db, users, logs, view } = fixture(t)
  for (const actor of ['a', 'a1', 'a2']) {
    const owner = { type: 'panel_admin_scope', adminId: actor, scopeRootId: users.scopeRootId(actor) }
    assert.deepEqual(
      view
        .listBatch({ owner_user_id: owner })
        .logs.map((r) => r.id)
        .sort(),
      ['log-a', 'log-a1', 'log-a2', 'log-au'],
    )
    assert.equal(view.summary({ owner_user_id: owner }).totalRequests, 4)
    assert.equal(logs.hasSuccessfulRequest({ owner_user_id: owner }), true)
    assert.doesNotThrow(() => new StatisticsRepo(db).statistics({ owner_user_id: owner }))
    assert.deepEqual(
      view
        .filterOptions({ owner_user_id: owner })
        .users.map((u) => u.id)
        .sort(),
      ['a', 'a1', 'a2', 'au'],
    )
  }
  const selected = { type: 'panel_users', scopeRootId: 'a', userId: 'a1' }
  assert.deepEqual(
    view.listBatch({ owner_user_id: selected }).logs.map((r) => r.id),
    ['log-a1'],
  )
  assert.equal(view.summary({ owner_user_id: { ...selected, userId: 'b' } }).totalRequests, 0)
  assert.equal(view.summary({ owner_user_id: { type: 'panel_users' } }).totalRequests, 0)
  assert.deepEqual(view.filterOptions({ owner_user_id: { ...selected, userId: 'b' } }).users, [])
  const mine = { type: 'panel_key_creator', creatorId: 'a1' }
  assert.deepEqual(
    view.listBatch({ owner_user_id: mine }).logs.map((r) => r.id),
    ['log-a1'],
  )
  assert.deepEqual(
    view.filterOptions({ owner_user_id: mine }).keys.map((k) => k.id),
    ['k-a1'],
  )
})

test('billing route queries user-owned ledger and subscriptions without usage-only columns', async (t) => {
  const { db } = fixture(t)
  async function billing(actor, query = '') {
    let out
    const handle = createRelayHandler({
      apiKeyStore: { db },
      json: (_res, status, body) => {
        out = { status, body }
      },
    })
    await handle(
      { method: 'GET', panelUser: actor, panelUserId: actor, panelRole: 'admin' },
      {},
      new URL(`http://localhost/api/panel/billing${query}`),
    )
    return out
  }
  for (const actor of ['a', 'a1', 'a2']) {
    const result = await billing(actor)
    assert.equal(result.status, 200, JSON.stringify(result.body))
    assert.equal(result.body.data.balance, 3)
    assert.deepEqual(result.body.data.items.map((r) => r.user_id).sort(), ['a', 'a1', 'a2', 'au'])
    assert.deepEqual(result.body.data.subscriptions.map((r) => r.user_id).sort(), ['a', 'a1', 'a2', 'au'])
  }
  const selected = await billing('a2', '?user_id=a1')
  assert.equal(selected.status, 200)
  assert.equal(selected.body.data.balance, 3)
  assert.deepEqual(selected.body.data.items.map((r) => r.user_id).sort(), ['a', 'a1', 'a2'])
  assert.deepEqual(
    selected.body.data.subscriptions.map((r) => r.user_id),
    ['a1'],
  )
  assert.equal((await billing('a', '?user_id=b')).status, 403)
  assert.deepEqual((await billing('b')).body.data.items.map((r) => r.user_id).sort(), ['b', 'bu'])
})
