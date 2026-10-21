import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase, applyMigrations } from '../../src/lib/db/database.mjs'
import { GroupsRepo } from '../../src/lib/db/repos/groups-repo.mjs'
import { ApiKeyStore, publicKeyView } from '../../src/lib/admin/api-keys.mjs'
import { prepareRuntimeSecrets } from '../../src/lib/core/runtime-secrets.mjs'
import { groupUsage, groupCapacity } from '../../src/lib/admin/group-metrics.mjs'

function temp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-refine-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}
test('migration preserves dedicated rates including zero and removes obsolete grant storage', (t) => {
  const root = temp(t),
    migrations = path.join(root, 'migrations')
  fs.mkdirSync(migrations)
  for (const file of fs.readdirSync('src/lib/db/migrations'))
    if (file.endsWith('.sql') && Number(file.slice(0, 3)) <= 42)
      fs.copyFileSync(path.join('src/lib/db/migrations', file), path.join(migrations, file))
  const db = createDatabase({ dbPath: ':memory:', migrationsDir: migrations })
  t.after(() => db.close())
  db.exec(`INSERT INTO users(id,username,email,password_hash,role,created_at,updated_at) VALUES('u','user','user@test.local','x','user','2026-01-01','2026-01-01');
    INSERT INTO user_groups(user_id,group_id,rate_multiplier,created_at) VALUES('u',1,0,'2026-01-01'),('u',2,0.5,'2026-01-01');`)
  applyMigrations(db)
  const groups = new GroupsRepo(db)
  assert.equal(groups.override('u', 1).rate_multiplier, 0)
  assert.equal(groups.override('u', 2).rate_multiplier, 0.5)
  assert.ok(
    !db
      .prepare('PRAGMA table_info(user_groups)')
      .all()
      .some((c) => c.name === 'rate_multiplier'),
  )
  groups.setGrants('u', [{ group_id: 1, rate_multiplier: 0, rpm_override: 2 }])
  assert.equal(groups.override('u', 1).rpm_limit, 2)
  assert.equal(groups.override('u', 2), null)
  assert.throws(() => groups.setGrants('u', [{ group_id: 1, rpm_override: -1 }]))
  assert.equal(groups.override('u', 1).rpm_limit, 2)
})
test('dedicated values never grant access and field updates preserve the other setting', (t) => {
  const db = createDatabase({ dbPath: ':memory:' })
  t.after(() => db.close())
  const keys = new ApiKeyStore({ db }),
    groups = new GroupsRepo(db)
  const user = keys.users.insert({
    id: 'u',
    username: 'user',
    password_hash: 'x',
    role: 'user',
    restrict_public_groups: true,
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
  })
  const g = groups.create({ name: 'exclusive', is_exclusive: true })
  groups.setOverride(user.id, g.id, { rate_multiplier: 0.5, rpm_limit: 20 })
  assert.throws(() => groups.access(user, g.id), { code: 'group_forbidden' })
  groups.setGrants(user.id, [{ group_id: g.id }])
  assert.equal(groups.access(user, g.id).rate, 0.5)
  groups.setOverride(user.id, g.id, { rpm_limit: null })
  assert.equal(groups.override(user.id, g.id).rate_multiplier, 0.5)
  assert.throws(() => groups.setOverride(user.id, g.id, { rate_multiplier: 0.2, rpm_limit: -1 }))
  assert.equal(groups.access(user, g.id).rate, 0.5)
})
test('Docker-generated encryption and API secrets survive restarts without environment values', (t) => {
  const root = temp(t),
    first = {}
  prepareRuntimeSecrets({ root, env: first })
  const second = {}
  prepareRuntimeSecrets({ root, env: second })
  assert.equal(first.TAPMODELS_DB_SECRET, second.TAPMODELS_DB_SECRET)
  assert.equal(first.TAPMODELS_API_KEY, second.TAPMODELS_API_KEY)
  assert.equal(fs.statSync(path.join(root, 'data/runtime-secrets.json')).mode & 0o777, 0o600)
  const explicit = { KIN_DB_SECRET: 'operator-secret' }
  prepareRuntimeSecrets({ root, env: explicit })
  assert.equal(explicit.TAPMODELS_DB_SECRET, 'operator-secret')
})
test('runtime secrets adopt a known existing deployment .env before generating anything', (t) => {
  const root = temp(t)
  fs.writeFileSync(path.join(root, '.env'), 'KIN_DB_SECRET="existing-secret"\nKIN_API_KEY=existing-key\n')
  const env = {}
  prepareRuntimeSecrets({ root, env })
  assert.equal(env.TAPMODELS_DB_SECRET, 'existing-secret')
  assert.equal(env.TAPMODELS_API_KEY, 'existing-key')
})
test('decryption errors differ from hash-only keys and successful original authentication repairs both', (t) => {
  const prev = process.env.TAPMODELS_DB_SECRET
  process.env.TAPMODELS_DB_SECRET = 'first-secret'
  t.after(() => {
    if (prev === undefined) delete process.env.TAPMODELS_DB_SECRET
    else process.env.TAPMODELS_DB_SECRET = prev
  })
  const db = createDatabase({ dbPath: ':memory:' })
  t.after(() => db.close())
  const store = new ApiKeyStore({ db, hashSecret: 'stable-auth-secret' }),
    rec = store.create({ name: 'recoverable' })
  process.env.TAPMODELS_DB_SECRET = 'second-secret'
  assert.equal(store.reveal(rec.id).code, 'key_decryption_failed')
  assert.equal(publicKeyView(store.getById(rec.id)).secret_status, 'decrypt_failed')
  assert.ok(store.authenticate(rec.key).ok)
  assert.equal(store.reveal(rec.id).key, rec.key)
  store.repo.update({ ...store.getById(rec.id), key_secret: null })
  assert.equal(store.reveal(rec.id).code, 'key_not_recoverable')
  assert.ok(store.authenticate(rec.key).ok)
  assert.equal(store.reveal(rec.id).key, rec.key)
})
test('group usage uses settled request group and Shanghai dates, isolates own usage', (t) => {
  const db = createDatabase({ dbPath: ':memory:' })
  t.after(() => db.close())
  for (const [id, at, user, cost, status] of [
    ['a', '2026-10-19T15:59:59Z', 'one', 3, 'settled'],
    ['b', '2026-10-19T16:00:00Z', 'one', 2, 'settled'],
    ['c', '2026-10-20T00:00:00Z', 'two', 4, 'settled'],
    ['d', '2026-10-20T00:00:00Z', 'one', 8, 'pending'],
  ])
    db.prepare(
      'INSERT INTO usage_logs(id,request_id,created_at,user_id,billing_group_id,group_id,actual_cost,billing_status) VALUES(?,?,?,?,?,?,?,?)',
    ).run(id, id, at, user, 1, 2, cost, status)
  const all = groupUsage(db, null, new Date('2026-10-20T10:00:00Z')).get(1)
  assert.equal(all.today_cost, 6)
  assert.equal(all.yesterday_cost, 3)
  assert.equal(all.total_cost, 9)
  assert.equal(groupUsage(db, 'one', new Date('2026-10-20T10:00:00Z')).get(1).total_cost, 5)
  assert.deepEqual(
    groupCapacity(
      [{ resource_kind: 'vm', resource_id: 'vm-1' }],
      [{ id: 'vm-1', schedulable: true, status: 'running', has_token: true, max_concurrency: 5 }],
      { 'vm-1': { inflight: 2 } },
    ),
    { kind: 'vm', used: 2, limit: 5, resources: 1 },
  )
})
