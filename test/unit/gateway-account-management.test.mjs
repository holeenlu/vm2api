import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createDatabase, openDatabase, closeDatabase, applyMigrations } from '../../src/lib/db/database.mjs'
import { GatewayWorkerRepo } from '../../src/lib/gateway-worker/gateway-repo.mjs'
import { GatewayAccountManagement } from '../../src/lib/gateway-worker/account-management.mjs'
import { GatewayWorkerService } from '../../src/lib/gateway-worker/gateway-execution.mjs'
import { createGatewayWorkerRoutes } from '../../src/lib/gateway-worker/gateway-routes.mjs'

const sha = (value) => crypto.createHash('sha256').update(value).digest('hex')
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-admin-'))
  const db = createDatabase({ dataDir: dir })
  t.after(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  db.prepare(
    "INSERT INTO groups(name,platform,status,models_json,created_at,updated_at) VALUES('Codex A','openai','active','[]',datetime('now'),datetime('now')),('Codex B','openai','active','[]',datetime('now'),datetime('now'))",
  ).run()
  const groups = db
    .prepare("SELECT id FROM groups WHERE platform='openai'")
    .all()
    .map((g) => g.id)
  const repo = new GatewayWorkerRepo(db)
  repo.upsertInstance({
    id: 'gw-one',
    base_url: 'http://127.0.0.1:8790',
    health_state: 'healthy',
    drain_state: 'accepting',
    boot_id: 'boot-one',
    protocol_version: 1,
  })
  const calls = []
  const runtime = new Map()
  const service = {
    async oauthStart(body, instanceId) {
      calls.push(['start', instanceId, body])
      return {
        ok: true,
        data: {
          session_id: crypto.randomUUID(),
          auth_url: 'https://auth.example.test/authorize?state=correct-state',
          state_hash: sha('correct-state'),
          expires_at: new Date(Date.now() + 600000).toISOString(),
        },
      }
    },
    async oauthComplete(body, instanceId) {
      calls.push(['complete', instanceId, body])
      const start = calls.filter((c) => c[0] === 'start').at(-1)[2]
      const account = {
        id: start.runtime_account_id,
        email: 'test@example.test',
        chatgpt_account_id: 'chatgpt-one',
        credential_revision: body.expected_credential_revision + 1,
      }
      runtime.set(account.id, account)
      return { ok: true, data: { account, credential_revision: account.credential_revision } }
    },
    async projectAccountToAll(body, source) {
      calls.push(['fanout', source, body])
      return { ok: true }
    },
    client: {
      async patchAccount(instance, id, patch) {
        calls.push(['patch', instance, id, patch])
        Object.assign(runtime.get(id) || {}, patch)
        return { ok: true, data: { account: runtime.get(id) } }
      },
    },
  }
  const manager = new GatewayAccountManagement({ repo, service })
  const input = {
    name: 'Platform Codex',
    notes: 'Note',
    group_ids: groups,
    proxy_endpoint: 'http://user:secret@proxy.example.test:8080',
    max_concurrency: 6,
    max_rpm: 50,
    idempotency_key: crypto.randomUUID(),
  }
  async function authorize(draft, actor = 'operator') {
    const session = await manager.start(actor, draft.id)
    const result = await manager.complete(actor, draft.id, {
      session_id: session.session_id,
      code: 'http://localhost:1455/auth/callback?code=code-one&state=correct-state',
    })
    return { session, result }
  }
  return { db, repo, manager, input, groups, calls, runtime, service, authorize }
}

test('super admin can authorize platform account without supplier or VM; source Worker is pinned', async (t) => {
  const f = fixture(t)
  const draft = f.manager.createDraft('operator', f.input)
  assert.equal(f.manager.createDraft('operator', f.input).id, draft.id)
  assert.throws(() => f.manager.createDraft('operator', { ...f.input, name: 'Changed' }), {
    code: 'idempotency_conflict',
  })
  f.repo.upsertInstance({
    id: 'gw-two',
    base_url: 'http://127.0.0.1:8791',
    health_state: 'healthy',
    drain_state: 'accepting',
    protocol_version: 1,
  })
  const { session, result } = await f.authorize(draft)
  const account = result.account
  assert.equal(account.vendor_id, null)
  assert.equal(f.db.prepare('SELECT count(*) n FROM vendors').get().n, 0)
  assert.equal(f.db.prepare("SELECT count(*) n FROM vendor_resources WHERE resource_type='vm'").get().n, 0)
  assert.deepEqual(
    f.manager.groups
      .forResource('gateway_worker_account', account.id)
      .map((g) => g.id)
      .sort(),
    f.groups.sort(),
  )
  assert.equal(account.projection_status, 'synced')
  assert.equal(account.credential_revision, 1)
  assert.ok(account.runtime_account_id)
  assert.equal(f.calls.find((c) => c[0] === 'start')[1], 'gw-one')
  assert.equal(f.calls.find((c) => c[0] === 'complete')[1], 'gw-one')
  assert.equal(JSON.stringify(account).includes('secret'), false)
  assert.equal(JSON.stringify(account).includes('access_token'), false)
  assert.equal(
    f.db
      .prepare('SELECT secret_json FROM vendor_resources WHERE id=?')
      .get(account.id)
      .secret_json.includes('access_token'),
    false,
  )
  assert.deepEqual(await f.manager.complete('operator', draft.id, { session_id: session.session_id }), result)
  assert.equal(f.db.prepare("SELECT count(*) n FROM vendor_resources WHERE resource_type='account'").get().n, 1)
})

test('draft owner, full callback state, expiry and group validation are enforced before token exchange', async (t) => {
  const f = fixture(t)
  assert.throws(() => f.manager.createDraft('operator', { ...f.input, group_ids: [1] }), {
    code: 'group_scope_forbidden',
  })
  assert.throws(() => f.manager.createDraft('operator', { ...f.input, proxy_endpoint: '' }), { code: 'proxy_required' })
  assert.throws(() => f.manager.createDraft('operator', { ...f.input, worker_id: 'gw-two' }), {
    code: 'invalid_resource_patch',
  })
  const draft = f.manager.createDraft('operator', f.input)
  await assert.rejects(f.manager.start('different-operator', draft.id), { code: 'draft_not_found' })
  const session = await f.manager.start('operator', draft.id)
  await assert.rejects(f.manager.complete('operator', draft.id, { session_id: 'other', code: 'abc' }), {
    code: 'oauth_session_mismatch',
  })
  await assert.rejects(f.manager.complete('operator', draft.id, { session_id: session.session_id, code: 'abc' }), {
    code: 'oauth_callback_required',
  })
  await assert.rejects(
    f.manager.complete('operator', draft.id, {
      session_id: session.session_id,
      code: 'http://localhost/callback?code=a&state=wrong',
    }),
    { code: 'oauth_state_mismatch' },
  )
  f.db.prepare("UPDATE gateway_worker_oauth_sessions SET expires_at='2000-01-01T00:00:00Z'").run()
  await assert.rejects(
    f.manager.complete('operator', draft.id, {
      session_id: session.session_id,
      code: 'http://localhost/callback?code=a&state=correct-state',
    }),
    { code: 'oauth_session_expired' },
  )
  assert.equal(
    f.calls.some((c) => c[0] === 'complete'),
    false,
  )
})

test('editing groups, proxy and capacity changes the runtime; pause and archive remove scheduling', async (t) => {
  const f = fixture(t)
  const { result } = await f.authorize(f.manager.createDraft('operator', f.input))
  const id = result.account.id
  const changed = await f.manager.update('operator', id, {
    name: 'Changed',
    notes: 'new note',
    group_ids: [f.groups[1]],
    max_concurrency: 8,
    max_rpm: 20,
    proxy_endpoint: 'socks5://user:new-password@proxy2.example.test:1080',
  })
  assert.equal(changed.account.name, 'Changed')
  assert.deepEqual(changed.account.config.group_ids, [f.groups[1]])
  assert.equal(
    f.calls.filter((c) => c[0] === 'patch').at(-1)[3].proxy_url,
    'socks5://user:new-password@proxy2.example.test:1080',
  )
  assert.equal(changed.account.config.proxy_endpoint, 'socks5://proxy2.example.test:1080')
  const paused = await f.manager.update('operator', id, { status: 'paused', proxy_endpoint: '' })
  assert.equal(paused.account.status, 'paused')
  assert.equal(f.runtime.get(result.account.runtime_account_id).enabled, false)
  assert.deepEqual(f.runtime.get(result.account.runtime_account_id).groups, [])
  await f.manager.update('operator', id, { status: 'active' })
  assert.equal(f.runtime.get(result.account.runtime_account_id).enabled, true)
  await f.manager.update('operator', id, { status: 'archived' })
  assert.deepEqual(f.manager.groups.forResource('gateway_worker_account', id), [])
  assert.equal(f.runtime.get(result.account.runtime_account_id).enabled, false)
  await assert.rejects(f.manager.update('operator', id, { status: 'active' }), { code: 'resource_archived' })
})

test('reauthorization preserves metadata and paused state, increments revision; failed projection is visible', async (t) => {
  const f = fixture(t)
  const { result } = await f.authorize(f.manager.createDraft('operator', f.input))
  const id = result.account.id
  const draft = f.manager.createDraft('operator', { idempotency_key: crypto.randomUUID() }, id)
  await f.manager.update('operator', id, { name: 'Changed while authorizing', status: 'paused' })
  const changed = await f.authorize(draft)
  assert.equal(changed.result.account.name, 'Changed while authorizing')
  assert.equal(changed.result.account.status, 'paused')
  assert.equal(changed.result.account.credential_revision, 2)
  f.service.client.patchAccount = async () => {
    throw new Error('offline')
  }
  const pending = await f.manager.update('operator', id, { notes: 'save offline' })
  assert.equal(pending.projection_pending, true)
  assert.equal(pending.account.projection_status, 'drifted')
  assert.equal(pending.account.vendor_id, null)
})

test('single Worker heartbeat reconciles its own account and does not mark it source-missing', async (t) => {
  const f = fixture(t)
  const { result } = await f.authorize(f.manager.createDraft('operator', f.input))
  const service = new GatewayWorkerService({ repo: f.repo })
  service.client.exportAccount = async () => ({
    ok: true,
    data: { account: { id: result.account.runtime_account_id, credential_revision: 1 }, credential_bundle: 'opaque' },
  })
  service.client.patchAccount = f.service.client.patchAccount
  service.client.importAccount = async () => {
    throw new Error('must not import its own credentials')
  }
  assert.equal((await service.projectAllAccountsTo('gw-one')).ok, true)
  assert.equal(f.manager.account(result.account.id).projection_status, 'synced')
  assert.equal(f.calls.filter((c) => c[0] === 'patch').at(-1)[3].proxy_url, f.input.proxy_endpoint)
})

test('heartbeat projection only re-projects accounts whose reported revisions or fingerprint differ', async (t) => {
  const f = fixture(t)
  const { result } = await f.authorize(f.manager.createDraft('operator', f.input))
  const runtimeId = result.account.runtime_account_id
  const service = new GatewayWorkerService({ repo: f.repo })
  const calls = []
  service.client.exportAccount = async (instance, id) => {
    calls.push(['export', id])
    return { ok: true, data: { account: { id, credential_revision: 1 } } }
  }
  let patched = null
  service.client.patchAccount = async (instance, id, body) => {
    calls.push(['patch', id])
    patched = body
    return { ok: true, data: { account: { id, credential_revision: 1 } } }
  }
  // 首次（没有回报）全量投影，PATCH 带上配置指纹
  assert.equal((await service.projectAllAccountsTo('gw-one')).ok, true)
  assert.match(patched.config_fingerprint, /^[0-9a-f]{64}$/)
  // 自动使用重置卡默认关闭，且关闭时也显式下发（Worker 的 PATCH 只覆盖出现的字段）
  assert.equal(patched.reset_credit_auto, false)
  const report = (extra = {}) => [
    {
      account_id: runtimeId,
      credential_revision: 1,
      projection_revision: patched.projection_revision,
      config_fingerprint: patched.config_fingerprint,
      ...extra,
    },
  ]
  calls.length = 0
  const current = await service.projectAllAccountsTo('gw-one', { revisions: report() })
  assert.equal(current.results.find((r) => r.account_id === result.account.id).skipped, 'projection_current')
  assert.deepEqual(calls, [])
  // 配置指纹不一致（例如代理或出口位置变化）、实例上缺少账号时重新投影
  await service.projectAllAccountsTo('gw-one', { revisions: report({ config_fingerprint: 'stale' }) })
  assert.deepEqual(calls.splice(0), [
    ['export', runtimeId],
    ['patch', runtimeId],
  ])
  await service.projectAllAccountsTo('gw-one', { revisions: [] })
  assert.equal(calls.filter(([kind]) => kind === 'patch').length, 1)
  // 同一实例的投影不并发（心跳与手动注册路由各有服务实例，也不能并发）
  calls.length = 0
  const other = new GatewayWorkerService({ repo: f.repo })
  other.client = service.client
  const [first, second] = await Promise.all([
    service.projectAllAccountsTo('gw-one'),
    other.projectAllAccountsTo('gw-one'),
  ])
  assert.equal(first.ok && second.ok, true)
  assert.equal(second.skipped, 'projection_in_progress')
  assert.equal(calls.filter(([kind]) => kind === 'patch').length, 1)
  // 投影不读取账号列表页的用量聚合
  const listCodexAccounts = f.repo.listCodexAccounts
  f.repo.listCodexAccounts = () => {
    throw new Error('projection must not aggregate account usage')
  }
  try {
    assert.equal((await service.projectAllAccountsTo('gw-one')).ok, true)
  } finally {
    f.repo.listCodexAccounts = listCodexAccounts
  }
  // 运营编辑同步下发的指纹与心跳期望一致：编辑后的下一次心跳不再重复投影
  f.service.client.patchAccount = async (instance, id, body) => {
    patched = body
    return { ok: true, data: { account: { id, credential_revision: 1 } } }
  }
  await f.manager.update('operator', result.account.id, { max_concurrency: 7 })
  assert.equal(patched.max_concurrency, 7)
  calls.length = 0
  const afterEdit = await service.projectAllAccountsTo('gw-one', { revisions: report() })
  assert.equal(afterEdit.results.find((r) => r.account_id === result.account.id).skipped, 'projection_current')
  assert.deepEqual(calls, [])
})

test('revoked groups do not prevent pause or archive; a drifting projection excludes only that account', async (t) => {
  const f = fixture(t)
  const { result } = await f.authorize(f.manager.createDraft('operator', f.input))
  f.db.prepare("UPDATE groups SET status='inactive',deleted_at=datetime('now') WHERE platform='openai'").run()
  f.service.client.patchAccount = async () => ({ ok: false, status: 503 })
  const paused = await f.manager.update('operator', result.account.id, { status: 'paused' })
  assert.equal(paused.account.status, 'paused')
  assert.equal(paused.projection_pending, true)
  // 实例照常接单，只把未同步的账号排除在选号之外
  assert.equal(f.repo.pickInstance()?.id, 'gw-one')
  assert.deepEqual(f.repo.unsyncedRuntimeAccounts('gw-one'), [result.account.runtime_account_id])
  await assert.rejects(f.manager.update('operator', result.account.id, { status: 'active' }), {
    code: 'group_scope_forbidden',
  })
  const archived = await f.manager.update('operator', result.account.id, { status: 'archived' })
  assert.equal(archived.account.status, 'archived')
})

test('heartbeat projection skips accounts that never reached a Worker instead of blocking the instance', async (t) => {
  const f = fixture(t)
  const { result } = await f.authorize(f.manager.createDraft('operator', f.input))
  // Supplier onboarding that failed before any Worker held the credential: no binding anywhere.
  f.db
    .prepare(
      "INSERT INTO vendor_resources(id,vendor_id,resource_type,name,status,config_json,created_by,created_at,updated_at) VALUES('account_orphan',NULL,'account','Orphan','provisioning',?,'test',datetime('now'),datetime('now'))",
    )
    .run(JSON.stringify({ platform: 'openai', execution_kind: 'gateway_worker', group_ids: f.groups }))
  const service = new GatewayWorkerService({ repo: f.repo })
  service.client.exportAccount = async (instance, id) => ({
    ok: true,
    data: { account: { id, credential_revision: 1 } },
  })
  service.client.patchAccount = f.service.client.patchAccount
  const projected = await service.projectAllAccountsTo('gw-one')
  assert.equal(projected.ok, true)
  assert.equal(projected.results.find((r) => r.account_id === 'account_orphan').skipped, 'no_projection_source')
  assert.equal(f.repo.listAccountBindings('account_orphan').length, 0)
  assert.equal(f.manager.account(result.account.id).projection_status, 'synced')
  assert.equal(f.repo.pickInstance()?.id, 'gw-one')
  assert.deepEqual(f.repo.unsyncedRuntimeAccounts('gw-one'), [])
})

test('archived accounts are retired on their own instance only; failures exclude the account there', async (t) => {
  const f = fixture(t)
  const { result } = await f.authorize(f.manager.createDraft('operator', f.input))
  await f.manager.update('operator', result.account.id, { status: 'archived' })
  f.repo.upsertInstance({
    id: 'gw-two',
    base_url: 'http://127.0.0.1:8791',
    health_state: 'healthy',
    drain_state: 'accepting',
    boot_id: 'boot-two',
    protocol_version: 1,
  })
  const service = new GatewayWorkerService({ repo: f.repo })
  const touched = []
  service.client.exportAccount = async (instance) => {
    touched.push(['export', instance])
    return { ok: true, data: { account: {} } }
  }
  service.client.importAccount = async (instance) => {
    touched.push(['import', instance])
    return { ok: true, data: { account: {} } }
  }
  // The Worker lost the archived account (data dir rebuilt): absent counts as retired.
  service.client.patchAccount = async (instance, id, patch) => {
    touched.push(['patch', instance, patch])
    return { ok: false, status: 404, data: { error: { code: 'account_not_found' } } }
  }
  assert.equal((await service.projectAllAccountsTo('gw-two')).ok, true)
  assert.deepEqual(touched, [])
  assert.equal(f.repo.getAccountBinding(result.account.id, 'gw-two'), null)
  assert.equal((await service.projectAllAccountsTo('gw-one')).ok, true)
  assert.deepEqual(
    touched.map((c) => c[0]),
    ['patch'],
  )
  assert.deepEqual(touched[0][2].groups, [])
  assert.equal(touched[0][2].enabled, false)
  assert.equal(f.repo.getAccountBinding(result.account.id, 'gw-one').projection_status, 'archived')
  assert.ok(f.repo.pickInstance())
  assert.deepEqual(f.repo.unsyncedRuntimeAccounts('gw-one'), [])
  // 心跳回报已停用（版本不旧于归档版本）或已不在实例上时，不再重复停用
  touched.length = 0
  const runtimeId = result.account.runtime_account_id
  const archivedRevision = f.repo.getAccountBinding(result.account.id, 'gw-one').projection_revision
  await service.projectAllAccountsTo('gw-one', {
    revisions: [{ account_id: runtimeId, projection_revision: archivedRevision }],
  })
  await service.projectAllAccountsTo('gw-one', { revisions: [] })
  assert.deepEqual(touched, [])
  // 实例回到旧版本（如从旧备份恢复）时重新停用
  await service.projectAllAccountsTo('gw-one', {
    revisions: [{ account_id: runtimeId, projection_revision: archivedRevision - 1 }],
  })
  assert.deepEqual(
    touched.map((c) => c[0]),
    ['patch'],
  )
  service.client.patchAccount = async () => ({ ok: false, status: 503 })
  f.db.prepare('UPDATE gateway_worker_instances SET active_concurrency=? WHERE id=?').run(9, 'gw-two')
  assert.equal((await service.projectAllAccountsTo('gw-one')).ok, false)
  assert.equal(f.repo.getAccountBinding(result.account.id, 'gw-one').projection_status, 'drifted')
  assert.deepEqual(f.repo.unsyncedRuntimeAccounts('gw-one'), [result.account.runtime_account_id])
  assert.equal(f.repo.pickInstance()?.id, 'gw-one')
})

test('a Worker that lost an active account recovers it from another instance binding', async (t) => {
  const f = fixture(t)
  const { result } = await f.authorize(f.manager.createDraft('operator', f.input))
  f.repo.upsertInstance({
    id: 'gw-two',
    base_url: 'http://127.0.0.1:8791',
    health_state: 'healthy',
    drain_state: 'accepting',
    boot_id: 'boot-two',
    protocol_version: 1,
  })
  const runtimeId = result.account.runtime_account_id
  f.repo.recordProjection({
    accountResourceId: result.account.id,
    instanceId: 'gw-two',
    runtimeAccountId: runtimeId,
    credentialRevision: 1,
    status: 'synced',
  })
  const service = new GatewayWorkerService({ repo: f.repo })
  const imported = []
  service.client.exportAccount = async (instance, id) =>
    instance === 'gw-one'
      ? { ok: false, status: 404, data: { error: { code: 'account_not_found' } } }
      : { ok: true, data: { account: { id, credential_revision: 1 }, credential_bundle: 'opaque' } }
  service.client.importAccount = async (instance, id, body) => {
    imported.push([instance, id, body.credential_bundle])
    return { ok: true, data: { account: { id, credential_revision: 1 } } }
  }
  service.client.patchAccount = f.service.client.patchAccount
  assert.equal((await service.projectAllAccountsTo('gw-one')).ok, true)
  assert.deepEqual(imported, [['gw-one', runtimeId, 'opaque']])
  assert.equal(f.repo.getAccountBinding(result.account.id, 'gw-one').projection_status, 'synced')
})

test('platform-owned receipts retain usage without creating supplier settlement facts', async (t) => {
  const f = fixture(t)
  const { result } = await f.authorize(f.manager.createDraft('operator', f.input))
  f.db
    .prepare(
      "INSERT INTO usage_logs(request_id,created_at,model,status,execution_kind,dispatch_id,total_cost) VALUES('platform-request',?,'gpt-5-codex',200,'gateway_worker','platform-dispatch',0.02)",
    )
    .run(new Date().toISOString())
  const updated = f.repo.applyReceiptToUsage(
    {
      dispatch_id: 'platform-dispatch',
      receipt_id: 'platform-receipt',
      usage_confidence: 'unknown',
      upstream_status: 200,
      usage: { input_tokens: 12, output_tokens: 5 },
    },
    { account_resource_id: result.account.id },
  )
  assert.equal(updated.account_resource_id, result.account.id)
  assert.equal(updated.input_tokens, 12)
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM vendor_usage_facts').get().n, 0)
})

test('admin Gateway endpoints deny vendor, admin and user before creating any draft', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-rbac-'))
  openDatabase({ dataDir: dir })
  try {
    let reply
    let read = false
    const handler = createGatewayWorkerRoutes({
      json: (_res, status, body) => {
        reply = { status, body }
      },
      readBody: async () => {
        read = true
        return {}
      },
    })
    for (const panelRole of ['vendor', 'admin', 'user']) {
      await handler({ method: 'POST', panelRole }, {}, { pathname: '/api/panel/codex-accounts/drafts' })
      assert.equal(reply.status, 403)
      assert.equal(read, false)
    }
    await handler({ method: 'GET', panelRole: 'super_admin' }, {}, { pathname: '/api/panel/codex-accounts/catalog' })
    assert.equal(reply.status, 200)
    assert.equal(reply.body.worker_available, false)
  } finally {
    closeDatabase()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('migration 081 preserves existing supplier accounts and FK dependants and reopens idempotently', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-migration-'))
  const migrations = path.join(dir, 'migrations')
  fs.mkdirSync(migrations)
  for (const file of fs
    .readdirSync('src/lib/db/migrations')
    .filter((file) => file.endsWith('.sql') && Number(file.slice(0, 3)) <= 80))
    fs.copyFileSync(path.join('src/lib/db/migrations', file), path.join(migrations, file))
  const db = createDatabase({ dataDir: dir, migrationsDir: migrations })
  t.after(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  db.exec(
    "INSERT INTO vendors(id,name,external_code,email,tier,root_id,created_by,created_at,updated_at) VALUES('vendor','Supplier','code','supplier@example.test',1,'vendor','test','now','now')",
  )
  db.exec(
    "INSERT INTO vendor_resources(id,vendor_id,resource_type,name,config_json,created_by,created_at,updated_at) VALUES('old-account','vendor','account','Original','{\"platform\":\"openai\",\"execution_kind\":\"gateway_worker\"}','test','now','now')",
  )
  const repo = new GatewayWorkerRepo(db)
  repo.upsertInstance({ id: 'gw-old', base_url: 'http://127.0.0.1:8790' })
  repo.recordProjection({ accountResourceId: 'old-account', instanceId: 'gw-old', runtimeAccountId: 'runtime-old' })
  const before = db.prepare("SELECT * FROM vendor_resources WHERE id='old-account'").get()
  applyMigrations(db)
  assert.deepEqual(db.prepare("SELECT * FROM vendor_resources WHERE id='old-account'").get(), before)
  assert.equal(repo.getAccountBinding('old-account').runtime_account_id, 'runtime-old')
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1)
  assert.deepEqual(applyMigrations(db), [])
  assert.throws(
    () =>
      db.exec(
        "INSERT INTO vendor_resources(id,vendor_id,resource_type,name,created_by,created_at,updated_at) VALUES('bad',NULL,'vm','bad','test','now','now')",
      ),
    /CHECK constraint/,
  )
})

test('account list carries today, 5H/7D and total usage the same way as VM rows', async (t) => {
  const f = fixture(t)
  const { result } = await f.authorize(f.manager.createDraft('operator', f.input))
  const id = result.account.id
  const now = Date.now()
  const insert = f.db.prepare(
    "INSERT INTO usage_logs(request_id,created_at,model,status,execution_kind,account_resource_id,total_cost,input_tokens,output_tokens) VALUES(?,?,'gpt-5-codex',?,'gateway_worker',?,?,10,5)",
  )
  insert.run('u-now', new Date(now - 60_000).toISOString(), 200, id, 0.5)
  insert.run('u-err', new Date(now - 120_000).toISOString(), 500, id, 0)
  insert.run('u-old', new Date(now - 3 * 86400_000).toISOString(), 200, id, 2)
  insert.run('u-other', new Date(now - 60_000).toISOString(), 200, 'someone-else', 9)
  const usage = f.repo.listCodexAccounts().find((row) => row.id === id).usage
  assert.equal(usage.window_5h_requests, 2)
  assert.equal(usage.window_5h_cost, 0.5)
  assert.equal(usage.window_7d_requests, 3)
  assert.equal(usage.window_7d_success, 2)
  assert.equal(usage.window_7d_errors, 1)
  assert.equal(usage.window_7d_cost, 2.5)
  // 计费窗口按输入 / 输出拆分，与 VM 详情页「计费窗口」同口径
  assert.equal(usage.window_5h_input_tokens, 20)
  assert.equal(usage.window_5h_output_tokens, 10)
  assert.equal(usage.window_7d_input_tokens, 30)
  assert.equal(usage.window_7d_cache_read_tokens, 0)
  assert.equal(usage.requests, 3)
  assert.equal(usage.total_cost, 2.5)
  assert.equal(usage.total_tokens, 45)
  assert.ok(usage.today_requests >= 2)
})

test('operator statistics for a Gateway account reuse the supplier usage report', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-usage-'))
  const db = openDatabase({ dataDir: dir })
  try {
    db.prepare(
      "INSERT INTO vendor_resources(id,vendor_id,resource_type,name,config_json,created_by,created_at,updated_at) VALUES('acct-stats',NULL,'account','Stats Codex','{\"platform\":\"openai\",\"execution_kind\":\"gateway_worker\"}','test','now','now')",
    ).run()
    const insert = db.prepare(
      "INSERT INTO usage_logs(request_id,created_at,model,status,execution_kind,account_resource_id,total_cost,input_tokens,output_tokens) VALUES(?,?,'gpt-5-codex',?,'gateway_worker',?,?,10,5)",
    )
    const at = new Date(Date.now() - 60_000).toISOString()
    insert.run('s-ok', at, 200, 'acct-stats', 0.5)
    insert.run('s-err', at, 500, 'acct-stats', 0)
    insert.run('s-other', at, 200, 'someone-else', 9)
    let reply
    const handler = createGatewayWorkerRoutes({
      json: (_res, status, body) => {
        reply = { status, body }
      },
      readBody: async () => ({}),
    })
    const get = (pathname) =>
      handler({ method: 'GET', panelRole: 'super_admin' }, {}, new URL('http://local' + pathname))
    await get('/api/panel/codex-accounts/acct-stats/usage?range=all')
    assert.equal(reply.status, 200, JSON.stringify(reply.body))
    assert.equal(reply.body.data.account_id, 'acct-stats')
    assert.equal(reply.body.data.name, 'Stats Codex')
    assert.equal(reply.body.data.summary.requests, 2)
    assert.equal(reply.body.data.summary.cost_usd, 0.5)
    await get('/api/panel/codex-accounts/missing/usage')
    assert.equal(reply.status, 404)
    await handler(
      { method: 'GET', panelRole: 'vendor' },
      {},
      new URL('http://local/api/panel/codex-accounts/acct-stats/usage'),
    )
    assert.equal(reply.status, 403)
  } finally {
    closeDatabase()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('an upstream 401 relayed by the Worker never reaches the panel as a session 401', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-upstream-401-'))
  const db = openDatabase({ dataDir: dir })
  // Expired account token: the Worker reports the upstream 401 for profile and quota queries.
  const worker = http.createServer((_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: { code: 'profile_unavailable', message: 'profile query failed' } }))
  })
  await new Promise((resolve) => worker.listen(0, '127.0.0.1', resolve))
  try {
    new GatewayWorkerRepo(db).upsertInstance({
      id: 'gw-401',
      base_url: `http://127.0.0.1:${worker.address().port}`,
      health_state: 'healthy',
      drain_state: 'accepting',
    })
    db.prepare(
      "INSERT INTO vendor_resources(id,vendor_id,resource_type,name,config_json,created_by,created_at,updated_at) VALUES('acct-401',NULL,'account','Expired Codex','{\"platform\":\"openai\",\"execution_kind\":\"gateway_worker\"}','test','now','now')",
    ).run()
    db.prepare(
      "INSERT INTO gateway_worker_account_bindings(id,account_resource_id,gateway_instance_id,runtime_account_id,projection_status,created_at,updated_at) VALUES('b-401','acct-401','gw-401','rt-401','synced','now','now')",
    ).run()
    let reply
    const handler = createGatewayWorkerRoutes({
      json: (_res, status, body) => {
        reply = { status, body }
      },
      readBody: async () => ({}),
    })
    const call = (method, pathname) =>
      handler({ method, panelRole: 'super_admin' }, {}, new URL('http://local' + pathname))
    await call('GET', '/api/panel/codex-accounts/acct-401/profile')
    assert.equal(reply.status, 502)
    assert.equal(reply.body.error.code, 'profile_unavailable')
    await call('POST', '/api/panel/codex-accounts/acct-401/quota')
    assert.equal(reply.status, 502)
  } finally {
    worker.close()
    closeDatabase()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('bulk edit applies the single-account rules to every target and validates all first', async (t) => {
  const f = fixture(t)
  const one = (await f.authorize(f.manager.createDraft('operator', f.input))).result.account
  const two = (
    await f.authorize(
      f.manager.createDraft('operator', {
        ...f.input,
        name: 'Second',
        group_ids: [f.groups[0]],
        idempotency_key: crypto.randomUUID(),
      }),
    )
  ).result.account
  const saved = await f.manager.bulkUpdate('operator', {
    ids: [one.id, two.id],
    patch: { status: 'paused', max_concurrency: 9, max_rpm: 30, groups: { operation: 'add', ids: [f.groups[1]] } },
  })
  assert.equal(saved.updated, 2)
  assert.deepEqual(f.manager.account(two.id).config.group_ids, [f.groups[0], f.groups[1]])
  await f.manager.bulkUpdate('operator', {
    ids: [one.id, two.id],
    patch: { groups: { operation: 'remove', ids: [f.groups[0]] } },
  })
  const after = (id) => f.manager.account(id)
  assert.equal(after(one.id).status, 'paused')
  assert.equal(after(one.id).config.max_concurrency, 9)
  assert.deepEqual(after(one.id).config.group_ids, [f.groups[1]])
  assert.equal(f.runtime.get(one.runtime_account_id).max_rpm, 30)
  // Removing the last group fails validation; nothing is written for either account.
  await assert.rejects(
    f.manager.bulkUpdate('operator', {
      ids: [one.id, two.id],
      patch: { max_concurrency: 3, groups: { operation: 'remove', ids: [f.groups[1]] } },
    }),
    { code: 'group_required' },
  )
  assert.equal(after(one.id).config.max_concurrency, 9)
  await assert.rejects(f.manager.bulkUpdate('operator', { ids: [one.id], patch: { name: 'x' } }), {
    code: 'invalid_patch',
  })
  await assert.rejects(f.manager.bulkUpdate('operator', { ids: [one.id], patch: { max_concurrency: 0 } }), {
    code: 'invalid_capacity',
  })
})

test('CPR account settings: blank name uses OAuth email; weight, model access and scheduling reach the Worker', async (t) => {
  const f = fixture(t)
  const draft = f.manager.createDraft('operator', {
    ...f.input,
    name: '',
    weight: 7,
    status: 'paused',
    model_access: { mode: 'denylist', models: ['gpt-5.5-mini'] },
    idempotency_key: crypto.randomUUID(),
  })
  const { result } = await f.authorize(draft)
  const account = f.manager.account(result.account.id)
  assert.equal(account.name, 'test@example.test')
  assert.equal(account.status, 'paused')
  assert.equal(account.config.weight, 7)
  assert.deepEqual(account.config.model_access, { mode: 'denylist', models: ['gpt-5.5-mini'] })
  const patch = f.calls.filter((c) => c[0] === 'patch').at(-1)[3]
  assert.equal(patch.weight, 7)
  assert.deepEqual(patch.denied_models, ['gpt-5.5-mini'])
  assert.deepEqual(patch.models, [])
  assert.equal(patch.enabled, false)
  await f.manager.update('operator', account.id, { model_access: { mode: 'allowlist', models: ['gpt-5.5'] } })
  assert.deepEqual(f.calls.filter((c) => c[0] === 'patch').at(-1)[3].models, ['gpt-5.5'])
  for (const bad of [
    { weight: 0 },
    { weight: 101 },
    { model_access: { mode: 'allowlist', models: [] } },
    { model_access: { mode: 'denylist', models: ['gpt-*'] } },
    { model_access: { mode: 'all', models: ['x'] } },
  ])
    await assert.rejects(f.manager.update('operator', account.id, bad), (e) =>
      /^invalid_(weight|model_access)$/.test(e.code),
    )
  await assert.rejects(f.manager.update('operator', account.id, { name: '' }), { code: 'invalid_resource_name' })
})

test('Codex requests use the Worker only for groups bound to Gateway accounts', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-scope-'))
  const db = openDatabase({ dataDir: dir })
  t.after(() => {
    closeDatabase()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  db.prepare(
    "INSERT INTO groups(id,name,platform,status,models_json,created_at,updated_at) VALUES(901,'VM','openai','active','[]',datetime('now'),datetime('now')),(902,'Gateway','openai','active','[]',datetime('now'),datetime('now'))",
  ).run()
  db.prepare(
    "INSERT INTO group_resources(group_id,resource_kind,resource_id) VALUES(902,'gateway_worker_account','acct-1')",
  ).run()
  const service = new GatewayWorkerService({ repo: new GatewayWorkerRepo(db) })
  const req = (groupId) => ({ apiKeyRecord: { group_id: groupId } })
  assert.equal(service.shouldUse(req(901), {}), false)
  assert.equal(service.shouldUse(req(902), {}), true)
  assert.equal(service.shouldUse(req(902), { codex: { gateway_worker: { preference: 'vm' } } }), false)
  assert.equal(service.shouldUse({}, {}), false)
})

test('heartbeat load records the instance peak and per-account in-flight shown on the account list', async (t) => {
  const f = fixture(t)
  const { result } = await f.authorize(f.manager.createDraft('operator', f.input))
  const id = result.account.id
  const runtime = result.account.runtime_account_id
  const instance = f.repo.getAccountBinding(id).gateway_instance_id
  f.repo.recordRuntimeLoad(instance, {
    peak_concurrency: 4,
    account_inflight: [
      { account_id: runtime, in_flight: 2 },
      { account_id: 'gwacct_unknown', in_flight: 9 },
    ],
  })
  assert.equal(f.repo.listCodexAccounts().find((row) => row.id === id).inflight, 2)
  assert.equal(f.repo.getInstance(instance).peak_concurrency, 4)
  // 下一次心跳未列出该账号：在途归零
  f.repo.recordRuntimeLoad(instance, { peak_concurrency: 1, account_inflight: [] })
  assert.equal(f.repo.listCodexAccounts().find((row) => row.id === id).inflight, 0)
  assert.equal(f.repo.getInstance(instance).peak_concurrency, 1)
  // 离线实例的在途不计
  f.repo.recordRuntimeLoad(instance, { account_inflight: [{ account_id: runtime, in_flight: 3 }] })
  f.db.prepare("UPDATE gateway_worker_instances SET health_state='offline' WHERE id=?").run(instance)
  assert.equal(f.repo.listCodexAccounts().find((row) => row.id === id).inflight, 0)
})

test('heartbeat credential states mark idle accounts and clear once the Worker stops reporting them', async (t) => {
  const f = fixture(t)
  const { result } = await f.authorize(f.manager.createDraft('operator', f.input))
  const id = result.account.id
  const runtime = result.account.runtime_account_id
  const instance = f.repo.getAccountBinding(id).gateway_instance_id
  const row = () => f.repo.listCodexAccounts().find((item) => item.id === id)
  assert.equal(row().credential_state, null)
  f.repo.recordRuntimeCredentials(instance, [
    { account_id: runtime, credential_state: 'expired', last_error: 'credential_refresh_failed' },
    { account_id: 'gwacct_unknown', credential_state: 'banned' },
  ])
  assert.equal(row().credential_state, 'expired')
  assert.equal(row().credential_error, 'credential_refresh_failed')
  // 旧版 Worker 不上报该字段：保持原值
  f.repo.recordRuntimeCredentials(instance, undefined)
  assert.equal(row().credential_state, 'expired')
  // 刷新成功或重新授权后 Worker 不再列出：恢复可用
  f.repo.recordRuntimeCredentials(instance, [])
  assert.equal(row().credential_state, null)
  assert.equal(row().credential_error, null)
})
