import test from 'node:test'
import assert from 'node:assert/strict'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { PanelUserStore } from '../../src/lib/admin/panel-users.mjs'
import { GroupsRepo } from '../../src/lib/db/repos/groups-repo.mjs'
import { keyScopeFromRecord } from '../../src/lib/admin/key-scope.mjs'

function setup(t) {
  const db = createDatabase({ dbPath: ':memory:' })
  t.after(() => db.close())
  const users = new PanelUserStore({ db })
  const groups = new GroupsRepo(db)
  const add = (username, role, parent) =>
    users.create({ username, password: 'testing-pass', role, actorId: parent?.id })
  const sa = add('super', 'super_admin')
  const a = add('admin-a', 'admin', sa)
  const peer = add('admin-peer', 'admin', a)
  const child = add('admin-child', 'admin', peer)
  const user = add('customer-a', 'user', child)
  const b = add('admin-b', 'admin', sa)
  const foreign = add('customer-b', 'user', b)
  const standalone = add('standalone', 'user', sa)
  return { db, users, groups, add, sa, a, peer, child, user, b, foreign, standalone }
}

test('saving any domain admin synchronizes peers and customers while retaining customer-specific prices', (t) => {
  const { users, groups, a, peer, child, user, b, foreign, standalone } = setup(t)
  groups.setGrants(b.id, [2])
  groups.setGrants(standalone.id, [2])
  groups.setGrants(user.id, [{ group_id: 1, rate_multiplier: 0, rpm_override: 7 }])
  const shared = [
    { group_id: 1, rate_multiplier: 1.25, rpm_override: 20 },
    { group_id: 2, rate_multiplier: 2, rpm_override: null },
  ]
  users.update(peer.id, { groups: shared })
  for (const admin of [a, peer, child]) assert.deepEqual(structuredClone(groups.grants(admin.id)), shared)
  assert.deepEqual(structuredClone(groups.grants(user.id)), [
    { group_id: 1, rate_multiplier: 0, rpm_override: 7 },
    { group_id: 2, rate_multiplier: null, rpm_override: null },
  ])
  const rows = users.list()
  for (const admin of [a, peer, child])
    assert.deepEqual(structuredClone(rows.find((u) => u.id === admin.id).groups), shared)
  for (const other of [b, foreign, standalone])
    assert.deepEqual(
      groups.grants(other.id).map((g) => g.group_id),
      [2],
    )
  groups.setOverride(child.id, 1, { rpm_limit: 30 })
  for (const admin of [a, peer, child])
    assert.deepEqual({ ...groups.override(admin.id, 1) }, { rate_multiplier: 1.25, rpm_limit: 30 })
  assert.deepEqual({ ...groups.override(user.id, 1) }, { rate_multiplier: 0, rpm_limit: 7 })
})

test('new members inherit the stable domain after root deletion and promotion cannot retain unrelated grants', (t) => {
  const { users, groups, add, a, peer, user } = setup(t)
  groups.setGrants(a.id, [{ group_id: 1, rate_multiplier: 0.5, rpm_override: 8 }])
  users.remove(a.id, { actorId: peer.id })
  const admin = add('new-admin', 'admin', peer)
  const customer = add('new-customer', 'user', admin)
  assert.deepEqual(groups.grants(admin.id), groups.grants(peer.id))
  assert.deepEqual(structuredClone(groups.grants(customer.id)), [
    { group_id: 1, rate_multiplier: null, rpm_override: null },
  ])
  groups.setGrants(user.id, [2])
  users.update(user.id, { role: 'admin' })
  assert.deepEqual(groups.grants(user.id), groups.grants(peer.id))
  groups.setGrants(admin.id, [2])
  assert.deepEqual(
    groups.grants(peer.id).map((g) => g.group_id),
    [2],
  )
  assert.deepEqual(
    groups.grants(customer.id).map((g) => g.group_id),
    [2],
  )
})

test('revocation immediately denies existing admin and user Keys without changing super-admin platform access', (t) => {
  const { db, groups, sa, a, peer, user, b } = setup(t)
  groups.setGrants(a.id, [1])
  groups.setGrants(b.id, [1])
  const scope = (u, group_id = 1) => keyScopeFromRecord({ id: u.id + '-key', user_id: u.id, group_id }, db)
  for (const member of [a, peer, user, b]) assert.equal(scope(member).error, undefined)
  groups.setGrants(peer.id, [])
  for (const member of [a, peer, user]) {
    assert.equal(scope(member).error, 'group_forbidden')
    assert.deepEqual(groups.grants(member.id), [])
    assert.equal(scope(member, null).error, 'group_required')
  }
  assert.equal(scope(b).error, undefined)
  assert.equal(scope(sa).error, undefined)
  assert.equal(scope(sa, null).platform, true)
})

test('invalid or interrupted domain changes roll back all memberships, overrides and the edited user', (t) => {
  const { db, users, groups, a, peer, user } = setup(t)
  groups.setGrants(a.id, [1])
  const before = users.list()
  assert.throws(() => users.update(peer.id, { enabled: false, groups: [1, 999999] }), { code: 'group_not_found' })
  assert.deepEqual(users.list(), before)
  db.exec(
    `CREATE TRIGGER reject_domain_group BEFORE INSERT ON user_groups WHEN NEW.group_id=2 AND NEW.user_id='${user.id}' BEGIN SELECT RAISE(ABORT,'forced write failure'); END`,
  )
  assert.throws(() => users.update(peer.id, { enabled: false, groups: [2] }), /forced write failure/)
  assert.deepEqual(users.list(), before)
  for (const member of [a, peer, user])
    assert.deepEqual(
      groups.grants(member.id).map((g) => g.group_id),
      [1],
    )
})
