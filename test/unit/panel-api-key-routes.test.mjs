import test from 'node:test'
import assert from 'node:assert/strict'
import { createPanelApiKeyRoutes } from '../../src/lib/admin/panel-api-key-routes.mjs'

test('panel API key route factory handles role-scoped list responses', async () => {
  const response = {}
  const handle = createPanelApiKeyRoutes({
    apiKeyStore: {
      snapshot: () => ({ keys: [{ id: 'k1', user_id: 'user-1', status: 'active' }] }),
      users: { scopeIds: () => [] },
    },
    requestLog: null,
    json(_res, status, body) {
      response.status = status
      response.body = body
    },
    readBody: async () => ({}),
    ctx: {},
    normalizeInput: (body) => body,
  })

  const handled = await handle(
    { method: 'GET', panelUserId: 'user-1', panelRole: 'user' },
    {},
    '/api/panel/api-keys',
    new URL('http://localhost/api/panel/api-keys'),
  )
  assert.equal(handled, true)
  assert.equal(response.status, 200)
  assert.deepEqual(response.body, {
    ok: true,
    total: 1,
    active: 1,
    keys: [{ id: 'k1', user_id: 'user-1', status: 'active' }],
  })
})

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ApiKeyStore } from '../../src/lib/admin/api-keys.mjs'
import { GroupsRepo } from '../../src/lib/db/repos/groups-repo.mjs'
import { validateBulkKeyEdit } from '../../src/lib/admin/api-key-bulk-edit.mjs'

function bulkFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'key-bulk-'))
  const store = new ApiKeyStore({ dataDir: dir })
  t.after(() => {
    store.db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  for (const id of ['owner-a', 'owner-b'])
    store.db
      .prepare(
        "INSERT INTO users(id,username,email,password_hash,role,status,created_at,updated_at) VALUES(?,?,?,?,'user','active',?,?)",
      )
      .run(id, id, id + '@test.local', 'test', new Date().toISOString(), new Date().toISOString())
  const a = store.create({ name: 'a', user_id: 'owner-a', quota: 20, rpm: 10 })
  const b = store.create({ name: 'b', user_id: 'owner-b', quota: 30, rpm: 20 })
  const call = async (body, identity = { panelRole: 'super_admin', panelUser: 'test' }) => {
    const response = {}
    const handle = createPanelApiKeyRoutes({
      apiKeyStore: store,
      ctx: {},
      requestLog: null,
      readBody: async () => body,
      normalizeInput: (patch) => {
        const input = { ...patch }
        if (Object.hasOwn(input, 'quota_usd')) {
          input.quota = input.quota_usd
          delete input.quota_usd
        }
        return input
      },
      json: (_res, status, data) => Object.assign(response, { status, data }),
    })
    await handle({ method: 'PATCH', ...identity }, {}, '/api/panel/api-keys/bulk', new URL('http://localhost'))
    return response
  }
  return { store, a, b, call }
}

test('bulk updates all limits without resetting spend, changing secrets or returning plaintext', async (t) => {
  const { store, a, b, call } = bulkFixture(t)
  store.repo.recordUsage(a.id, { cost: 3 })
  const patch = {
    status: 'disabled',
    max_concurrency: 4,
    quota_usd: 50,
    quota_requests: 100,
    rpm: 30,
    rate_limit_5h: 2.5,
    rate_limit_1d: 5,
    rate_limit_7d: 15,
    expires_at: '2027-01-01T00:00:00+08:00',
    ip_whitelist: ['10.0.0.0/8'],
    ip_blacklist: ['10.0.0.1'],
  }
  const result = await call({ ids: [a.id, b.id, a.id], patch })
  assert.deepEqual(result, { status: 200, data: { ok: true, updated: 2 } })
  for (const key of [a, b]) {
    const record = store.getById(key.id)
    for (const field of [
      'status',
      'max_concurrency',
      'quota_requests',
      'rpm',
      'rate_limit_5h',
      'rate_limit_1d',
      'rate_limit_7d',
    ])
      assert.equal(record[field], patch[field])
    assert.equal(record.quota, 50)
    assert.equal(record.expires_at, '2026-12-31T16:00:00.000Z')
    assert.deepEqual(JSON.parse(record.ip_whitelist), patch.ip_whitelist)
    assert.equal(record.name, key.name)
    assert.equal(store.reveal(key.id).key, key.key)
  }
  assert.equal(store.getById(a.id).quota_used, 3)
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM operation_audit WHERE action='key.bulk_update'").get().n, 2)
  await call({ ids: [a.id], patch: { quota_usd: 0, expires_at: null, ip_whitelist: [] } })
  assert.equal(store.getById(a.id).quota, 0)
  assert.equal(store.getById(a.id).rpm, 30)
  assert.equal(store.getById(a.id).expires_at, null)
  assert.equal(store.getById(a.id).ip_whitelist, '[]')
})

test('bulk rejects missing/foreign keys without writing an earlier key', async (t) => {
  const { store, a, b, call } = bulkFixture(t)
  for (const ids of [
    [a.id, b.id],
    [a.id, 'missing'],
  ]) {
    const r = await call({ ids, patch: { rpm: 99 } }, { panelRole: 'user', panelUserId: 'owner-a' })
    assert.equal(r.status, 404)
    assert.equal(store.getById(a.id).rpm, 10)
  }
  assert.equal(
    (await call({ ids: [a.id], patch: { rpm: 50 } }, { panelRole: 'user', panelUserId: 'owner-a' })).status,
    200,
  )
  assert.equal(
    (await call({ ids: [b.id], patch: { rpm: 50 } }, { panelRole: 'admin', panelUserId: 'owner-a' })).status,
    404,
  )
})

test('bulk group failure rolls back prior key and audit writes', async (t) => {
  const { store, a, b, call } = bulkFixture(t)
  const groups = new GroupsRepo(store.db)
  const group = groups.create({ name: 'exclusive', platform: 'openai', is_exclusive: true, models: [] })
  store.db
    .prepare('INSERT INTO user_groups(user_id,group_id,created_at) VALUES(?,?,?)')
    .run('owner-a', group.id, new Date().toISOString())
  const before = store.getById(a.id)
  const result = await call({ ids: [a.id, b.id], patch: { group_id: group.id, rpm: 88 } })
  assert.equal(result.status, 403)
  assert.deepEqual(store.getById(a.id), before)
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM operation_audit WHERE action='key.bulk_update'").get().n, 0)
  assert.equal((await call({ ids: [a.id], patch: { group_id: null } })).status, 400)
  assert.equal((await call({ ids: [a.id], patch: { group_id: group.id } })).status, 200)
  assert.equal(store.getById(a.id).group_id, group.id)
})

test('bulk validation rejects silent coercions, unsupported fields and oversized selections', () => {
  for (const patch of [
    {},
    { quota_usd: '' },
    { quota_usd: null },
    { quota_usd: Infinity },
    { rpm: -1 },
    { rpm: 1.5 },
    { max_concurrency: 129 },
    { quota_requests: 1e9 + 1 },
    { reset_quota: true },
    { user_id: 'owner-b' },
    { name: 'rename' },
    { key: 'secret' },
    { group_id: '' },
    { group_id: 0 },
    { status: 'revoked' },
    { expires_at: '2027-01-01T12:00' },
    { ip_whitelist: ['not-an-ip'] },
  ])
    assert.throws(() => validateBulkKeyEdit({ ids: ['key'], patch }), JSON.stringify(patch))
  for (const ids of [[], [''], Array(501).fill('key')])
    assert.throws(() => validateBulkKeyEdit({ ids, patch: { rpm: 0 } }))
})
