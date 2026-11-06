import test from 'node:test'
import assert from 'node:assert/strict'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { ApiKeyStore } from '../../src/lib/admin/api-keys.mjs'
import { GroupsRepo } from '../../src/lib/db/repos/groups-repo.mjs'

async function fixture(t, { user = 0, group = 0, key = 0 } = {}) {
  const db = createDatabase({ dbPath: ':memory:' })
  t.after(() => db.close())
  const keys = new ApiKeyStore({ db })
  const groups = new GroupsRepo(db)
  const a = await groups.create({ name: 'A', rpm_limit: group })
  const b = await groups.create({ name: 'B', rpm_limit: group })
  for (const id of ['user-one', 'user-two']) {
    await keys.users.insert({
      id,
      username: id,
      role: 'user',
      password_hash: 'test',
      concurrency: 0,
      rpm_limit: user,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    await groups.setGrants(id, [a.id, b.id])
  }
  const make = (groupId = a.id, userId = 'user-one', rpm = key) =>
    keys.create({ user_id: userId, group_id: groupId, max_concurrency: 0, rpm })
  const one = await make(),
    two = await make()
  const now = Date.now()
  const hit = async (rec = one, at = now) => {
    const out = await keys.acquire(rec, at)
    if (out.ok) keys.release(rec)
    return out
  }
  return { db, keys, groups, a, b, one, two, make, hit, now }
}
test('Key RPM can tighten but does not multiply group allowance', async (t) => {
  const { hit, one, two } = await fixture(t, { user: 4, group: 3, key: 2 })
  assert.ok((await hit(one)).ok)
  assert.ok((await hit(one)).ok)
  assert.equal((await hit(one)).code, 'api_key_rate_limit')
  assert.ok((await hit(two)).ok)
  assert.equal((await hit(two)).code, 'group_rate_limit')
})
test('three keys in group A share 60 while user shares 100 across groups', async (t) => {
  const { hit, one, two, make, b } = await fixture(t, { user: 100, group: 60 })
  const third = await make(),
    otherGroup = await make(b.id)
  for (let i = 0; i < 60; i++) assert.ok((await hit([one, two, third][i % 3])).ok)
  assert.equal((await hit(third)).code, 'group_rate_limit')
  for (let i = 0; i < 40; i++) assert.ok((await hit(otherGroup)).ok)
  assert.equal((await hit(otherGroup)).code, 'user_rate_limit')
})
test('different users do not share one group counter', async (t) => {
  const { hit, one, make, a } = await fixture(t, { group: 1 })
  assert.ok((await hit(one)).ok)
  assert.equal((await hit(one)).code, 'group_rate_limit')
  assert.ok((await hit(await make(a.id, 'user-two'))).ok)
})
test('zero group RPM does not remove the user global cap', async (t) => {
  const { hit, one, two } = await fixture(t, { user: 1 })
  assert.ok((await hit(one)).ok)
  assert.equal((await hit(two)).code, 'user_rate_limit')
})
test('zero user RPM still enforces group RPM', async (t) => {
  const { hit, one, two } = await fixture(t, { group: 1 })
  assert.ok((await hit(one)).ok)
  assert.equal((await hit(two)).code, 'group_rate_limit')
})
test('a higher dedicated group RPM cannot bypass global user RPM', async (t) => {
  const { hit, one, two, groups, a } = await fixture(t, { user: 2, group: 1 })
  await groups.setOverride(one.user_id, a.id, { rpm_limit: 10 })
  assert.ok((await hit(one)).ok)
  assert.ok((await hit(two)).ok)
  assert.equal((await hit(two)).code, 'user_rate_limit')
})
test('dedicated zero exempts only group RPM and still enforces user cap', async (t) => {
  const { hit, one, two, groups, a } = await fixture(t, { user: 2, group: 1 })
  await groups.setOverride(one.user_id, a.id, { rpm_limit: 0 })
  assert.ok((await hit(one)).ok)
  assert.ok((await hit(two)).ok)
  assert.equal((await hit(two)).code, 'user_rate_limit')
})
test('dedicated zero does not exempt a positive Key RPM', async (t) => {
  const { hit, one, groups, a } = await fixture(t, { key: 1, group: 1 })
  await groups.setOverride(one.user_id, a.id, { rpm_limit: 0 })
  assert.ok((await hit(one)).ok)
  assert.equal((await hit(one)).code, 'api_key_rate_limit')
})
test('null restores group default and preserves dedicated price', async (t) => {
  const { hit, one, groups, a } = await fixture(t, { group: 1 })
  await groups.setOverride(one.user_id, a.id, { rpm_limit: 0, rate_multiplier: 0.5 })
  assert.ok((await hit(one)).ok)
  await groups.setOverride(one.user_id, a.id, { rpm_limit: null })
  assert.equal((await hit(one)).code, 'group_rate_limit')
  assert.equal((await groups.override(one.user_id, a.id)).rate_multiplier, 0.5)
})
test('all zero RPM allows frequency while concurrency remains separate', async (t) => {
  const { hit, keys, one } = await fixture(t)
  for (let i = 0; i < 100; i++) assert.ok((await hit(one)).ok)
  await keys.users.update({ ...(await keys.users.getById(one.user_id)), concurrency: 1 })
  assert.ok((await keys.acquire(one)).ok)
  assert.equal((await keys.acquire(one)).code, 'user_concurrency_limit')
})
test('60-second window and live edits preserve counters across key rotation', async (t) => {
  const { hit, keys, groups, one, a, now } = await fixture(t, { user: 1 })
  assert.ok((await hit(one)).ok)
  await keys.rotate(one.id)
  assert.equal((await hit(one, now + 59999)).code, 'invalid_api_key')
  assert.equal((await hit(await keys.getById(one.id), now + 59999)).code, 'user_rate_limit')
  assert.ok((await hit(await keys.getById(one.id), now + 60000)).ok)
  await groups.update(a.id, { rpm_limit: 1 })
  assert.equal((await hit(await keys.getById(one.id), now + 60000)).code, 'user_rate_limit')
  await keys.users.update({ ...(await keys.users.getById(one.user_id)), rpm_limit: 0 })
  assert.equal((await hit(await keys.getById(one.id), now + 60000)).code, 'group_rate_limit')
})
