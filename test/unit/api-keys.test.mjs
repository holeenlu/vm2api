import { GroupsRepo } from '../../src/lib/db/repos/groups-repo.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ApiKeyStore, generateApiKey, maskApiKey } from '../../src/lib/admin/api-keys.mjs'

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-keys-'))
  return new ApiKeyStore({ dataDir: dir })
}

test('generateApiKey uses sk-vm- prefix and is long enough', () => {
  const k = generateApiKey()
  assert.match(k, /^sk-vm-[a-f0-9]{64}$/)
  assert.notEqual(k, generateApiKey())
})

test('maskApiKey hides middle', () => {
  const k = 'sk-vm-' + 'a'.repeat(64)
  const m = maskApiKey(k)
  assert.ok(m.includes('…'))
  assert.ok(!m.includes('a'.repeat(20)))
})

test('create + authenticate + list mask', async () => {
  const store = tmpStore()
  const rec = await store.create({ name: 'demo', max_concurrency: 3, quota_requests: 10, rpm: 60 })
  assert.equal(rec.name, 'demo')
  assert.equal(rec.max_concurrency, 3)
  assert.equal(rec.quota_requests, 10)
  const auth = await store.authenticate(rec.key)
  assert.equal(auth.ok, true)
  assert.equal(auth.record.id, rec.id)
  const stored = await store.getById(rec.id)
  assert.notEqual(stored.key, rec.key)
  assert.match(stored.key, /^hmac:/)
  assert.ok(stored.key_hash)
  const listed = await store.list()
  assert.equal(listed.length, 1)
  assert.ok(listed[0].key.includes('…'))
  assert.notEqual(listed[0].key, rec.key)
})

test('reveal returns the plaintext for copy; rotate swaps it in place', async () => {
  const store = tmpStore()
  const rec = await store.create({ name: 'copyable', max_concurrency: 4 })
  const listed = (await store.list())[0]
  assert.equal(listed.revealable, true)
  assert.ok(listed.key.includes('…'), 'list stays masked')

  const shown = await store.reveal(rec.id)
  assert.equal(shown.ok, true)
  assert.equal(shown.key, rec.key)

  const rotated = await store.rotate(rec.id)
  assert.notEqual(rotated.key, rec.key)
  assert.equal((await store.authenticate(rec.key)).ok, false, 'old value dies')
  assert.equal((await store.authenticate(rotated.key)).ok, true)
  assert.equal((await store.reveal(rec.id)).key, rotated.key)
  const kept = await store.getById(rec.id)
  assert.equal(kept.name, 'copyable')
  assert.equal(kept.max_concurrency, 4)
})

test('reveal reports hash-only rows as unrecoverable', async () => {
  const store = tmpStore()
  const rec = await store.create({ name: 'legacy' })
  const row = await store.getById(rec.id)
  row.key_secret = null
  await store.repo.update(row)

  const out = await store.reveal(rec.id)
  assert.equal(out.ok, false)
  assert.equal(out.code, 'key_not_recoverable')
  assert.equal((await store.list())[0].revealable, false)
  assert.equal(await store.reveal('key_missing'), null)
  assert.equal((await store.authenticate(rec.key)).ok, true, 'auth still works off the hash')
})

test('key_secret is encrypted at rest when KIN_DB_SECRET is set', async () => {
  const prev = process.env.KIN_DB_SECRET
  process.env.KIN_DB_SECRET = 'unit-test-secret'
  try {
    const store = tmpStore()
    const rec = await store.create({ name: 'enc' })
    const row = await store.getById(rec.id)
    assert.match(row.key_secret, /^enc:v1:/)
    assert.ok(!row.key_secret.includes(rec.key))
    assert.equal((await store.reveal(rec.id)).key, rec.key)
  } finally {
    if (prev === undefined) delete process.env.KIN_DB_SECRET
    else process.env.KIN_DB_SECRET = prev
  }
})

test('canAccept rejects disabled / expired / quota / concurrency', async () => {
  const store = tmpStore()
  const rec = await store.create({ name: 'lim', max_concurrency: 1, quota_requests: 2, rpm: 0 })
  assert.equal((await store.canAccept(rec)).ok, true)

  await store.update(rec.id, { status: 'disabled' })
  assert.equal((await store.canAccept(await store.getById(rec.id))).code, 'api_key_disabled')
  await store.update(rec.id, { status: 'active' })

  await store.update(rec.id, { expires_at: new Date(Date.now() - 1000).toISOString() })
  assert.equal((await store.canAccept(await store.getById(rec.id))).code, 'api_key_expired')
  await store.update(rec.id, { expires_at: null })

  const a = await store.acquire(await store.getById(rec.id))
  assert.equal(a.ok, true)
  const blocked = await store.canAccept(await store.getById(rec.id))
  assert.equal(blocked.code, 'api_key_concurrency_limit')
  store.release(rec.id)

  await store.recordUsage(rec.id)
  await store.recordUsage(rec.id)
  assert.equal((await store.canAccept(await store.getById(rec.id))).code, 'api_key_quota_exhausted')
})

test('rpm window blocks then recovers', async () => {
  const store = tmpStore()
  const rec = await store.create({ name: 'rpm', max_concurrency: 0, quota_requests: 0, rpm: 2 })
  assert.equal((await store.acquire(rec)).ok, true)
  store.release(rec)
  assert.equal((await store.acquire(rec)).ok, true)
  store.release(rec)
  const gate = await store.canAccept(await store.getById(rec.id))
  assert.equal(gate.code, 'api_key_rate_limit')
})

test('user concurrency caps regular users but never the admin operator', async () => {
  const store = tmpStore()
  const now = new Date().toISOString()
  for (const [id, role] of [
    ['u-admin', 'super_admin'],
    ['u-user', 'user'],
  ]) {
    await store.users.insert({
      id,
      username: id,
      password_hash: 'x',
      role,
      concurrency: 1,
      created_at: now,
      updated_at: now,
    })
  }
  const admin = await store.create({ name: 'admin-key', max_concurrency: 0, user_id: 'u-admin' })
  await new GroupsRepo(store.db).setGrants('u-user', [1])
  const user = await store.create({ name: 'user-key', group_id: 1, max_concurrency: 0, user_id: 'u-user' })

  for (let i = 0; i < 3; i++) assert.equal((await store.acquire(admin)).ok, true)

  assert.equal((await store.acquire(user)).ok, true)
  const blocked = await store.canAccept(user)
  assert.equal(blocked.code, 'user_concurrency_limit')
  assert.deepEqual(blocked.detail, { inflight: 1, max: 1 })
})

test('update reset_quota and remove', async () => {
  const store = tmpStore()
  const rec = await store.create({ name: 'x', quota_requests: 5 })
  await store.recordUsage(rec.id)
  await store.recordUsage(rec.id)
  assert.equal((await store.getById(rec.id)).quota_requests_used, 2)
  await store.update(rec.id, { reset_quota: true })
  assert.equal((await store.getById(rec.id)).quota_requests_used, 0)
  assert.equal(await store.remove(rec.id), true)
  assert.equal(await store.getById(rec.id), null)
  assert.equal((await store.authenticate(rec.key)).ok, false)
})

test('recordUsage accumulates cache token columns', async () => {
  const store = tmpStore()
  const rec = await store.create({ name: 'cache' })
  await store.recordUsage(rec.id, {
    input_tokens: 10,
    output_tokens: 5,
    cache_read_input_tokens: 3,
    cache_creation_input_tokens: 7,
  })
  await store.recordUsage(rec.id, { input_tokens: 1, output_tokens: 1, cache_read_tokens: 2 })
  const saved = await store.getById(rec.id)
  assert.equal(saved.tokens_in, 11)
  assert.equal(saved.tokens_out, 6)
  assert.equal(saved.cache_read_tokens, 5)
  assert.equal(saved.cache_creation_tokens, 7)
})

test('custom key rejected when duplicate', async () => {
  const store = tmpStore()
  await store.create({ name: 'a', key: 'sk-kin-customkey0001' })
  await assert.rejects(() => store.create({ name: 'b', key: 'sk-kin-customkey0001' }), /exists/)
})

test('keys persist in sqlite across store re-open (same dataDir)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-keys-'))
  const store = new ApiKeyStore({ dataDir: dir })
  const rec = await store.create({ name: 'persist', quota_requests: 9 })
  await store.recordUsage(rec.id, { input_tokens: 11, output_tokens: 22 })

  const store2 = new ApiKeyStore({ dataDir: dir })
  const again = await store2.getById(rec.id)
  assert.ok(again, 'record should survive re-open')
  assert.equal(again.name, 'persist')
  assert.equal(again.quota_requests_used, 1)
  assert.equal(again.tokens_in, 11)
  assert.equal(again.tokens_out, 22)
  assert.equal((await store2.authenticate(rec.key)).ok, true)
  assert.ok(fs.existsSync(path.join(dir, 'kin.db')), 'kin.db file exists')
})

test('new key writes no legacy VM pool selection fields', async () => {
  const store = tmpStore()
  const key = await store.create({ name: 'modern', group_id: 1, allowed_vms: ['vm-1'], vm_pool_id: 'old' })
  assert.equal(key.group_id, 1)
  assert.equal(key.vm_pool_id, undefined)
  assert.equal(key.allowed_vms, undefined)
})

// 审计阶段 1 W5：残留明文 Key 在启动 / 备份恢复时一次性哈希化；鉴权只按 key_hash 查索引，
// 哈希未命中不再全表逐行比较（任意错误 Key 都触发一次全表扫描的未鉴权放大）
test('legacy plaintext keys are hashed once and a wrong key never scans the table', async () => {
  const store = tmpStore()
  const token = 'sk-vm-legacy-plaintext-0001'
  store.db
    .prepare("INSERT INTO api_keys (id, name, key, status) VALUES ('key_legacy', 'legacy', ?, 'active')")
    .run(token)
  store.db
    .prepare(
      "INSERT INTO api_keys (id, name, key, status, deleted_at) VALUES ('key_gone', 'gone', 'sk-vm-deleted-plain-0001', 'disabled', '2026-01-01T00:00:00Z')",
    )
    .run()

  let listed = 0
  const list = store.repo.list.bind(store.repo)
  store.repo.list = async (...args) => {
    listed += 1
    return list(...args)
  }
  // 哈希化之前明文行鉴权不到，也不会为此读全表
  assert.deepEqual(await store.authenticate(token), { ok: false, reason: 'invalid' })
  assert.deepEqual(await store.authenticate('sk-vm-' + 'f'.repeat(64)), { ok: false, reason: 'invalid' })
  assert.equal(listed, 0)

  assert.equal(await store.hashLegacyPlaintextKeys(), 2)
  assert.equal(await store.hashLegacyPlaintextKeys(), 0)
  const rows = store.db.prepare('SELECT id, key, key_hash, key_prefix, key_suffix FROM api_keys ORDER BY id').all()
  for (const row of rows) {
    assert.match(row.key, /^hmac:/, row.id)
    assert.ok(row.key_hash, row.id)
  }
  assert.equal(rows.find((r) => r.id === 'key_legacy').key_prefix, token.slice(0, 10))
  const auth = await store.authenticate(token)
  assert.equal(auth.ok, true)
  assert.equal(auth.record.id, 'key_legacy')
  assert.equal((await store.reveal('key_legacy')).key, token)
  assert.equal(listed, 0)
})

test('restoring a backup hashes the plaintext keys it brings back', async () => {
  const store = tmpStore()
  const other = tmpStore()
  other.db.prepare("INSERT INTO api_keys (id, name, key) VALUES ('key_old', 'old', 'sk-vm-restored-plain-01')").run()
  await store.rebind(other.db)
  assert.match(other.db.prepare("SELECT key FROM api_keys WHERE id = 'key_old'").get().key, /^hmac:/)
  assert.equal((await store.authenticate('sk-vm-restored-plain-01')).ok, true)
})
