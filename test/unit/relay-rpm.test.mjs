import test from 'node:test'
import assert from 'node:assert/strict'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { ApiKeyStore } from '../../src/lib/admin/api-keys.mjs'
import { GroupsRepo } from '../../src/lib/db/repos/groups-repo.mjs'

function fixture(t, { user = 0, group = 0, key = 0 } = {}) {
  const db = createDatabase({ dbPath: ':memory:' })
  t.after(() => db.close())
  const keys = new ApiKeyStore({ db })
  const groups = new GroupsRepo(db)
  const a = groups.create({ name: 'A', rpm_limit: group })
  const b = groups.create({ name: 'B', rpm_limit: group })
  for (const id of ['user-one', 'user-two']) {
    keys.users.insert({
      id,
      username: id,
      role: 'user',
      password_hash: 'test',
      concurrency: 0,
      rpm_limit: user,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    groups.setGrants(id, [a.id, b.id])
  }
  const make = (groupId = a.id, userId = 'user-one', rpm = key) =>
    keys.create({ user_id: userId, group_id: groupId, max_concurrency: 0, rpm })
  const one = make(),
    two = make()
  const now = Date.now()
  const hit = (rec = one, at = now) => {
    const out = keys.acquire(rec, at)
    if (out.ok) keys.release(rec)
    return out
  }
  return { db, keys, groups, a, b, one, two, make, hit, now }
}
test('Key RPM can tighten but does not multiply group allowance', (t) => {
  const { hit, one, two } = fixture(t, { user: 4, group: 3, key: 2 })
  assert.ok(hit(one).ok)
  assert.ok(hit(one).ok)
  assert.equal(hit(one).code, 'api_key_rate_limit')
  assert.ok(hit(two).ok)
  assert.equal(hit(two).code, 'group_rate_limit')
})
test('three keys in group A share 60 while user shares 100 across groups', (t) => {
  const { hit, one, two, make, b } = fixture(t, { user: 100, group: 60 })
  const third = make(),
    otherGroup = make(b.id)
  for (let i = 0; i < 60; i++) assert.ok(hit([one, two, third][i % 3]).ok)
  assert.equal(hit(third).code, 'group_rate_limit')
  for (let i = 0; i < 40; i++) assert.ok(hit(otherGroup).ok)
  assert.equal(hit(otherGroup).code, 'user_rate_limit')
})
test('different users do not share one group counter', (t) => {
  const { hit, one, make, a } = fixture(t, { group: 1 })
  assert.ok(hit(one).ok)
  assert.equal(hit(one).code, 'group_rate_limit')
  assert.ok(hit(make(a.id, 'user-two')).ok)
})
test('zero group RPM does not remove the user global cap', (t) => {
  const { hit, one, two } = fixture(t, { user: 1 })
  assert.ok(hit(one).ok)
  assert.equal(hit(two).code, 'user_rate_limit')
})
test('zero user RPM still enforces group RPM', (t) => {
  const { hit, one, two } = fixture(t, { group: 1 })
  assert.ok(hit(one).ok)
  assert.equal(hit(two).code, 'group_rate_limit')
})
test('a higher dedicated group RPM cannot bypass global user RPM', (t) => {
  const { hit, one, two, groups, a } = fixture(t, { user: 2, group: 1 })
  groups.setOverride(one.user_id, a.id, { rpm_limit: 10 })
  assert.ok(hit(one).ok)
  assert.ok(hit(two).ok)
  assert.equal(hit(two).code, 'user_rate_limit')
})
test('dedicated zero exempts only group RPM and still enforces user cap', (t) => {
  const { hit, one, two, groups, a } = fixture(t, { user: 2, group: 1 })
  groups.setOverride(one.user_id, a.id, { rpm_limit: 0 })
  assert.ok(hit(one).ok)
  assert.ok(hit(two).ok)
  assert.equal(hit(two).code, 'user_rate_limit')
})
test('dedicated zero does not exempt a positive Key RPM', (t) => {
  const { hit, one, groups, a } = fixture(t, { key: 1, group: 1 })
  groups.setOverride(one.user_id, a.id, { rpm_limit: 0 })
  assert.ok(hit(one).ok)
  assert.equal(hit(one).code, 'api_key_rate_limit')
})
test('null restores group default and preserves dedicated price', (t) => {
  const { hit, one, groups, a } = fixture(t, { group: 1 })
  groups.setOverride(one.user_id, a.id, { rpm_limit: 0, rate_multiplier: 0.5 })
  assert.ok(hit(one).ok)
  groups.setOverride(one.user_id, a.id, { rpm_limit: null })
  assert.equal(hit(one).code, 'group_rate_limit')
  assert.equal(groups.override(one.user_id, a.id).rate_multiplier, 0.5)
})
test('all zero RPM allows frequency while concurrency remains separate', (t) => {
  const { hit, keys, one } = fixture(t)
  for (let i = 0; i < 100; i++) assert.ok(hit(one).ok)
  keys.users.update({ ...keys.users.getById(one.user_id), concurrency: 1 })
  assert.ok(keys.acquire(one).ok)
  assert.equal(keys.acquire(one).code, 'user_concurrency_limit')
})
test('60-second window and live edits preserve counters across key rotation', (t) => {
  const { hit, keys, groups, one, a, now } = fixture(t, { user: 1 })
  assert.ok(hit(one).ok)
  keys.rotate(one.id)
  assert.equal(hit(one, now + 59999).code, 'invalid_api_key')
  assert.equal(hit(keys.getById(one.id), now + 59999).code, 'user_rate_limit')
  assert.ok(hit(keys.getById(one.id), now + 60000).ok)
  groups.update(a.id, { rpm_limit: 1 })
  assert.equal(hit(keys.getById(one.id), now + 60000).code, 'user_rate_limit')
  keys.users.update({ ...keys.users.getById(one.user_id), rpm_limit: 0 })
  assert.equal(hit(keys.getById(one.id), now + 60000).code, 'group_rate_limit')
})
