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
    // 没有创建者（主密钥或迁移 064 之前创建）按管理员管控
    keys: [{ id: 'k1', user_id: 'user-1', status: 'active', managed_by_admin: true }],
  })
})

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ApiKeyStore } from '../../src/lib/admin/api-keys.mjs'
import { GroupsRepo } from '../../src/lib/db/repos/groups-repo.mjs'
import { validateBulkKeyEdit } from '../../src/lib/admin/api-key-bulk-edit.mjs'

async function bulkFixture(t) {
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
  // a 是 owner-a 自己创建的 Key；b 由管理员替 owner-b 创建（created_by_user_id 不是 owner-b）
  const a = await store.create({ name: 'a', user_id: 'owner-a', quota: 20, rpm: 10, created_by_user_id: 'owner-a' })
  const b = await store.create({ name: 'b', user_id: 'owner-b', quota: 30, rpm: 20, created_by_user_id: 'admin-x' })
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
  const { store, a, b, call } = await bulkFixture(t)
  await store.repo.recordUsage(a.id, { cost_micros: 3_000_000 })
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
    const record = await store.getById(key.id)
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
    assert.equal((await store.reveal(key.id)).key, key.key)
  }
  assert.equal((await store.getById(a.id)).quota_used, 3)
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM operation_audit WHERE action='key.bulk_update'").get().n, 2)
  await call({ ids: [a.id], patch: { quota_usd: 0, expires_at: null, ip_whitelist: [] } })
  assert.equal((await store.getById(a.id)).quota, 0)
  assert.equal((await store.getById(a.id)).rpm, 30)
  assert.equal((await store.getById(a.id)).expires_at, null)
  assert.equal((await store.getById(a.id)).ip_whitelist, '[]')
})

test('bulk rejects missing/foreign keys without writing an earlier key', async (t) => {
  const { store, a, b, call } = await bulkFixture(t)
  for (const ids of [
    [a.id, b.id],
    [a.id, 'missing'],
  ]) {
    const r = await call({ ids, patch: { rpm: 99 } }, { panelRole: 'user', panelUserId: 'owner-a' })
    assert.equal(r.status, 404)
    assert.equal((await store.getById(a.id)).rpm, 10)
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
  const { store, a, b, call } = await bulkFixture(t)
  const groups = new GroupsRepo(store.db)
  const group = await groups.create({ name: 'exclusive', platform: 'openai', is_exclusive: true, models: [] })
  store.db
    .prepare('INSERT INTO user_groups(user_id,group_id,created_at) VALUES(?,?,?)')
    .run('owner-a', group.id, new Date().toISOString())
  const before = await store.getById(a.id)
  const result = await call({ ids: [a.id, b.id], patch: { group_id: group.id, rpm: 88 } })
  assert.equal(result.status, 403)
  assert.deepEqual(await store.getById(a.id), before)
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM operation_audit WHERE action='key.bulk_update'").get().n, 0)
  assert.equal((await call({ ids: [a.id], patch: { group_id: null } })).status, 400)
  assert.equal((await call({ ids: [a.id], patch: { group_id: group.id } })).status, 200)
  assert.equal((await store.getById(a.id)).group_id, group.id)
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

test('only super admins may set CPR peer sharing when creating or editing a key', async (t) => {
  const { store, a } = await bulkFixture(t)
  const call = async (method, path, body, identity) => {
    const response = {}
    const handle = createPanelApiKeyRoutes({
      apiKeyStore: store,
      ctx: {},
      requestLog: null,
      readBody: async () => body,
      normalizeInput: (input) => ({ ...input }),
      json: (_res, status, data) => Object.assign(response, { status, data }),
    })
    await handle({ method, ...identity }, {}, path, new URL('http://localhost'))
    return response
  }
  const sharing = { enabled: true, share_pool: true, share_plans: false, share_quota: false }
  const keyCount = () => store.db.prepare('SELECT COUNT(*) AS n FROM api_keys').get().n
  await store.users.insert({ id: 'admin-1', username: 'admin-1', password_hash: 'test', role: 'admin' })
  const adminKey = await store.create({ name: 'admin', user_id: 'admin-1' })
  const before = keyCount()
  for (const [identity, key] of [
    [{ panelRole: 'user', panelUserId: 'owner-a' }, a],
    [{ panelRole: 'admin', panelUserId: 'admin-1' }, adminKey],
  ]) {
    const original = (await store.getById(key.id)).peer_sharing
    const created = await call('POST', '/api/panel/api-keys', { name: 'x', peer_sharing: sharing }, identity)
    assert.equal(created.status, 403)
    assert.equal(created.data.error.code, 'forbidden')
    const edited = await call('PATCH', `/api/panel/api-keys/${key.id}`, { peer_sharing: sharing }, identity)
    assert.equal(edited.status, 403)
    assert.equal((await store.getById(key.id)).peer_sharing, original)
  }
  assert.equal(keyCount(), before)
  assert.equal(
    (await call('PATCH', `/api/panel/api-keys/${a.id}`, { rpm: 12 }, { panelRole: 'user', panelUserId: 'owner-a' }))
      .status,
    200,
  )
  const edited = await call(
    'PATCH',
    `/api/panel/api-keys/${a.id}`,
    { peer_sharing: sharing },
    { panelRole: 'super_admin', panelUser: 'test' },
  )
  assert.equal(edited.status, 200)
  assert.deepEqual(edited.data.item.peer_sharing, sharing)
  const profile = { client: 'cli', platform: 'macos', versionMode: 'fixed', codexVersion: '0.150.0' }
  const superCreated = await call(
    'POST',
    '/api/panel/api-keys',
    { name: 'super', codex_client_profile: profile },
    { panelRole: 'super_admin', panelUser: 'test' },
  )
  assert.equal(superCreated.status, 201)
  assert.equal(superCreated.data.item.codex_client_profile.codexVersion, '0.150.0')
  const defaults = await call(
    'POST',
    '/api/panel/api-keys',
    { name: 'defaults' },
    { panelRole: 'super_admin', panelUser: 'test' },
  )
  assert.equal(defaults.data.item.codex_client_profile, null)
})

test('a user may only rename or change IP lists on keys an administrator created for them', async (t) => {
  const { store, a, b, call: bulk } = await bulkFixture(t)
  const legacy = await store.create({ name: 'legacy', user_id: 'owner-b', quota: 5 })
  const call = async (method, path, body, identity = { panelRole: 'user', panelUserId: 'owner-b' }) => {
    const response = {}
    const handle = createPanelApiKeyRoutes({
      apiKeyStore: store,
      ctx: {},
      requestLog: null,
      readBody: async () => body,
      normalizeInput: (input) => ({ ...input }),
      json: (_res, status, data) => Object.assign(response, { status, data }),
    })
    await handle({ method, ...identity }, {}, path, new URL(`http://localhost${path}`))
    return response
  }
  await store.repo.recordUsage(b.id, { cost_micros: 2_000_000 })
  const before = await store.getById(b.id)

  // 受管字段（额度、限速、状态、分组、有效期、重置额度）一律 403，Key 不变
  for (const body of [
    { quota: 999 },
    { rpm: 0 },
    { status: 'disabled' },
    { expires_at: null },
    { group_id: null },
    { reset_quota: true },
    { name: 'renamed', max_concurrency: 1 },
  ]) {
    const denied = await call('PATCH', `/api/panel/api-keys/${b.id}`, body)
    assert.equal(denied.status, 403, JSON.stringify(body))
    assert.equal(denied.data.error.code, 'key_managed_by_admin')
  }
  const reset = await call('POST', `/api/panel/api-keys/${b.id}/reset-quota`)
  assert.equal(reset.status, 403)
  assert.equal(reset.data.error.code, 'key_managed_by_admin')
  assert.deepEqual(await store.getById(b.id), before)
  // 迁移 064 之前或主密钥创建的 Key 没有创建者，同样受管
  assert.equal((await call('PATCH', `/api/panel/api-keys/${legacy.id}`, { quota: 50 })).status, 403)

  // 名称与 IP 名单照常可改
  const renamed = await call('PATCH', `/api/panel/api-keys/${b.id}`, {
    name: 'mine now',
    ip_whitelist: ['10.0.0.0/8'],
    ip_blacklist: ['10.0.0.9'],
  })
  assert.equal(renamed.status, 200, JSON.stringify(renamed.data))
  const after = await store.getById(b.id)
  assert.equal(after.name, 'mine now')
  assert.deepEqual(JSON.parse(after.ip_whitelist), ['10.0.0.0/8'])
  assert.equal(after.quota, before.quota)
  assert.equal(after.quota_used, before.quota_used)

  // 批量：含受管 Key 时只接受 IP 名单，拒绝时不写任何 Key
  const bulkDenied = await bulk({ ids: [b.id], patch: { rpm: 1 } }, { panelRole: 'user', panelUserId: 'owner-b' })
  assert.equal(bulkDenied.status, 403)
  assert.equal(bulkDenied.data.error.code, 'key_managed_by_admin')
  assert.equal((await store.getById(b.id)).rpm, 20)
  assert.equal(
    (await bulk({ ids: [b.id], patch: { ip_blacklist: [] } }, { panelRole: 'user', panelUserId: 'owner-b' })).status,
    200,
  )

  // 列表标出受管 Key，供面板置灰
  const list = await call('GET', '/api/panel/api-keys')
  assert.deepEqual(Object.fromEntries(list.data.keys.map((key) => [key.id, key.managed_by_admin])), {
    [b.id]: true,
    [legacy.id]: true,
  })

  // 用户自己创建的 Key 不受限制；管理员与超管照常管理用户的 Key
  const owner = { panelRole: 'user', panelUserId: 'owner-a' }
  assert.equal(
    (await call('PATCH', `/api/panel/api-keys/${a.id}`, { quota: 7, status: 'disabled' }, owner)).status,
    200,
  )
  assert.equal((await call('POST', `/api/panel/api-keys/${a.id}/reset-quota`, undefined, owner)).status, 200)
  assert.equal((await store.getById(a.id)).quota, 7)
  const root = { panelRole: 'super_admin', panelUser: 'test' }
  assert.equal((await call('PATCH', `/api/panel/api-keys/${b.id}`, { rpm: 3 }, root)).status, 200)
  assert.equal((await call('POST', `/api/panel/api-keys/${b.id}/reset-quota`, undefined, root)).status, 200)
  assert.equal((await store.getById(b.id)).rpm, 3)
})
