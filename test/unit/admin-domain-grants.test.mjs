import test from 'node:test'
import assert from 'node:assert/strict'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { PanelUserStore } from '../../src/lib/admin/panel-users.mjs'
import { GroupsRepo } from '../../src/lib/db/repos/groups-repo.mjs'
import { keyScopeFromRecord } from '../../src/lib/admin/key-scope.mjs'

async function setup(t) {
  const db = createDatabase({ dbPath: ':memory:' })
  t.after(() => db.close())
  const users = new PanelUserStore({ db })
  const groups = new GroupsRepo(db)
  const add = async (username, role, parent) =>
    users.create({ username, password: 'testing-pass', role, actorId: parent?.id })
  const sa = await add('super', 'super_admin')
  const a = await add('admin-a', 'admin', sa)
  const peer = await add('admin-peer', 'admin', a)
  const child = await add('admin-child', 'admin', peer)
  const user = await add('customer-a', 'user', child)
  const b = await add('admin-b', 'admin', sa)
  const foreign = await add('customer-b', 'user', b)
  const standalone = await add('standalone', 'user', sa)
  return { db, users, groups, add, sa, a, peer, child, user, b, foreign, standalone }
}

test('saving any domain admin synchronizes peers and customers while retaining customer-specific prices', async (t) => {
  const { users, groups, a, peer, child, user, b, foreign, standalone } = await setup(t)
  await groups.setGrants(b.id, [2])
  await groups.setGrants(standalone.id, [2])
  await groups.setGrants(user.id, [{ group_id: 1, rate_multiplier: 0, rpm_override: 7 }])
  const shared = [
    { group_id: 1, rate_multiplier: 1.25, rpm_override: 20 },
    { group_id: 2, rate_multiplier: 2, rpm_override: null },
  ]
  await users.update(peer.id, { groups: shared })
  for (const admin of [a, peer, child]) assert.deepEqual(structuredClone(await groups.grants(admin.id)), shared)
  assert.deepEqual(structuredClone(await groups.grants(user.id)), [
    { group_id: 1, rate_multiplier: 0, rpm_override: 7 },
    { group_id: 2, rate_multiplier: null, rpm_override: null },
  ])
  const rows = await users.list()
  for (const admin of [a, peer, child])
    assert.deepEqual(structuredClone(rows.find((u) => u.id === admin.id).groups), shared)
  for (const other of [b, foreign, standalone])
    assert.deepEqual(
      (await groups.grants(other.id)).map((g) => g.group_id),
      [2],
    )
  await groups.setOverride(child.id, 1, { rpm_limit: 30 })
  for (const admin of [a, peer, child])
    assert.deepEqual({ ...(await groups.override(admin.id, 1)) }, { rate_multiplier: 1.25, rpm_limit: 30 })
  assert.deepEqual({ ...(await groups.override(user.id, 1)) }, { rate_multiplier: 0, rpm_limit: 7 })
})

test('new members inherit the stable domain after root deletion and promotion cannot retain unrelated grants', async (t) => {
  const { users, groups, add, a, peer, user } = await setup(t)
  await groups.setGrants(a.id, [{ group_id: 1, rate_multiplier: 0.5, rpm_override: 8 }])
  await users.remove(a.id, { actorId: peer.id })
  const admin = await add('new-admin', 'admin', peer)
  const customer = await add('new-customer', 'user', admin)
  assert.deepEqual(await groups.grants(admin.id), await groups.grants(peer.id))
  assert.deepEqual(structuredClone(await groups.grants(customer.id)), [
    { group_id: 1, rate_multiplier: null, rpm_override: null },
  ])
  await groups.setGrants(user.id, [2])
  await users.update(user.id, { role: 'admin' })
  assert.deepEqual(await groups.grants(user.id), await groups.grants(peer.id))
  await groups.setGrants(admin.id, [2])
  assert.deepEqual(
    (await groups.grants(peer.id)).map((g) => g.group_id),
    [2],
  )
  assert.deepEqual(
    (await groups.grants(customer.id)).map((g) => g.group_id),
    [2],
  )
})

test('revocation immediately denies existing admin and user Keys without changing super-admin platform access', async (t) => {
  const { db, groups, sa, a, peer, user, b } = await setup(t)
  await groups.setGrants(a.id, [1])
  await groups.setGrants(b.id, [1])
  const scope = (u, group_id = 1) => keyScopeFromRecord({ id: u.id + '-key', user_id: u.id, group_id }, db)
  for (const member of [a, peer, user, b]) assert.equal(scope(member).error, undefined)
  await groups.setGrants(peer.id, [])
  for (const member of [a, peer, user]) {
    assert.equal(scope(member).error, 'group_forbidden')
    assert.deepEqual(await groups.grants(member.id), [])
    assert.equal(scope(member, null).error, 'group_required')
  }
  assert.equal(scope(b).error, undefined)
  assert.equal(scope(sa).error, undefined)
  assert.equal(scope(sa, null).platform, true)
})

test('invalid or interrupted domain changes roll back all memberships, overrides and the edited user', async (t) => {
  const { db, users, groups, a, peer, user } = await setup(t)
  await groups.setGrants(a.id, [1])
  const before = await users.list()
  await assert.rejects(() => users.update(peer.id, { enabled: false, groups: [1, 999999] }), {
    code: 'group_not_found',
  })
  assert.deepEqual(await users.list(), before)
  db.exec(
    `CREATE TRIGGER reject_domain_group BEFORE INSERT ON user_groups WHEN NEW.group_id=2 AND NEW.user_id='${user.id}' BEGIN SELECT RAISE(ABORT,'forced write failure'); END`,
  )
  await assert.rejects(() => users.update(peer.id, { enabled: false, groups: [2] }), /forced write failure/)
  assert.deepEqual(await users.list(), before)
  for (const member of [a, peer, user])
    assert.deepEqual(
      (await groups.grants(member.id)).map((g) => g.group_id),
      [1],
    )
})
