import test from 'node:test'
import assert from 'node:assert/strict'
import { sealCredentialBundle } from '../../src/lib/executor/custody.mjs'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createDatabase, openDatabase, closeDatabase, applyMigrations } from '../../src/lib/db/database.mjs'
import { GatewayWorkerRepo } from '../../src/lib/gateway-worker/gateway-repo.mjs'
import { GatewayAccountManagement, gatewayAccountPatch } from '../../src/lib/gateway-worker/account-management.mjs'
import { GatewayWorkerService } from '../../src/lib/gateway-worker/gateway-execution.mjs'
import { createGatewayWorkerRoutes } from '../../src/lib/gateway-worker/gateway-routes.mjs'
import { attachListForecasts } from '../../src/lib/gateway-worker/quota-forecast.mjs'
import { maybeDecrypt, maybeEncrypt } from '../../src/lib/db/secure.mjs'
import { saveCodexSettings } from '../../src/lib/executor/settings-store.mjs'
import { ProxyPool } from '../../src/lib/vm/proxy-pool.mjs'

const sha = (value) => crypto.createHash('sha256').update(value).digest('hex')
async function fixture(t) {
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
  await repo.upsertInstance({
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
          // 新版 Worker 沿用控制面生成的会话并补上安装身份交回（P3.7）
          session_id: body.session?.session_id || crypto.randomUUID(),
          auth_url: 'https://auth.example.test/authorize?state=correct-state',
          state_hash: sha('correct-state'),
          expires_at: new Date(Date.now() + 600000).toISOString(),
          ...(body.session ? { session: { ...body.session, installation_id: 'inst-1' } } : {}),
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
    proxy_endpoint: 'socks5h://user:secret@proxy.example.test:1080',
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

test('new accounts are numbered gw-01, gw-02 like VM slots; allocated numbers are never reused', async (t) => {
  const f = await fixture(t)
  const draft = (name) => f.manager.createDraft('operator', { ...f.input, name, idempotency_key: crypto.randomUUID() })
  const first = await f.authorize(await draft('one'))
  assert.equal(first.result.account.id, 'gw-01')
  assert.equal(first.result.account.runtime_account_id, 'gwacct_gw-01')
  // 建草稿即占号：并发建号不撞号；放弃的草稿（过期、或 Worker 已保存凭据但收尾失败）留下空号，不复用
  // 两个草稿并发创建（R6 B5：读高水位与登记在同一事务里）
  const [pendingA, pendingB] = await Promise.all([draft('pending-a'), draft('pending-b')])
  assert.deepEqual([pendingA, pendingB].map((d) => f.manager.drafts.get(d.id).resourceId).sort(), ['gw-02', 'gw-03'])
  for (const d of [pendingA, pendingB]) f.manager.drafts.get(d.id).expires = 0
  const failing = await draft('failing')
  assert.equal(f.manager.drafts.get(failing.id).resourceId, 'gw-04')
  const complete = f.service.oauthComplete
  f.service.oauthComplete = async () => ({ ok: false, status: 502, data: {} })
  await assert.rejects(f.authorize(failing))
  f.service.oauthComplete = complete
  f.manager.drafts.get(failing.id).expires = 0
  const next = await f.authorize(await draft('next'))
  assert.equal(next.result.account.id, 'gw-05')
  // 重新授权沿用原编号
  const again = await f.authorize(
    await f.manager.createDraft('operator', { idempotency_key: crypto.randomUUID() }, 'gw-01'),
  )
  assert.equal(again.result.account.id, 'gw-01')
})

test('super admin can authorize platform account without supplier or VM; source Worker is pinned', async (t) => {
  const f = await fixture(t)
  const draft = await f.manager.createDraft('operator', f.input)
  assert.equal((await f.manager.createDraft('operator', f.input)).id, draft.id)
  await assert.rejects(() => f.manager.createDraft('operator', { ...f.input, name: 'Changed' }), {
    code: 'idempotency_conflict',
  })
  await f.repo.upsertInstance({
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
    (await f.manager.groups.forResource('gateway_worker_account', account.id)).map((g) => g.id).sort(),
    f.groups.sort(),
  )
  assert.equal(account.projection_status, 'synced')
  assert.equal(account.credential_revision, 1)
  assert.ok(account.runtime_account_id)
  assert.equal(f.calls.find((c) => c[0] === 'start')[1], 'gw-one')
  assert.equal(f.calls.find((c) => c[0] === 'complete')[1], 'gw-one')
  // 授权会话由控制面生成（P3.7）：完成时把补上安装身份的会话原样交回 Worker，完成后不再保留 verifier
  const startBody = f.calls.find((c) => c[0] === 'start')[2]
  const completeBody = f.calls.find((c) => c[0] === 'complete')[2]
  assert.equal(startBody.session.code_verifier.length, 43)
  assert.deepEqual(completeBody.session, { ...startBody.session, installation_id: 'inst-1' })
  assert.equal(
    f.db.prepare('SELECT session_json FROM gateway_worker_oauth_sessions WHERE session_id=?').get(session.session_id)
      ?.session_json,
    null,
  )
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
  const f = await fixture(t)
  await assert.rejects(() => f.manager.createDraft('operator', { ...f.input, group_ids: [1] }), {
    code: 'group_scope_forbidden',
  })
  await assert.rejects(() => f.manager.createDraft('operator', { ...f.input, proxy_endpoint: '' }), {
    code: 'proxy_required',
  })
  await assert.rejects(() => f.manager.createDraft('operator', { ...f.input, worker_id: 'gw-two' }), {
    code: 'invalid_resource_patch',
  })
  const draft = await f.manager.createDraft('operator', f.input)
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
  const f = await fixture(t)
  const { result } = await f.authorize(await f.manager.createDraft('operator', f.input))
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
    'socks5h://user:new-password@proxy2.example.test:1080',
  )
  assert.equal(changed.account.config.proxy_endpoint, 'socks5h://proxy2.example.test:1080')
  const paused = await f.manager.update('operator', id, { status: 'paused', proxy_endpoint: '' })
  assert.equal(paused.account.status, 'paused')
  assert.equal(f.runtime.get(result.account.runtime_account_id).enabled, false)
  assert.deepEqual(f.runtime.get(result.account.runtime_account_id).groups, [])
  await f.manager.update('operator', id, { status: 'active' })
  assert.equal(f.runtime.get(result.account.runtime_account_id).enabled, true)
  await f.manager.update('operator', id, { status: 'archived' })
  assert.deepEqual(await f.manager.groups.forResource('gateway_worker_account', id), [])
  assert.equal(f.runtime.get(result.account.runtime_account_id).enabled, false)
  await assert.rejects(f.manager.update('operator', id, { status: 'active' }), { code: 'resource_archived' })
})

test('reauthorization preserves metadata and paused state, increments revision; failed projection is visible', async (t) => {
  const f = await fixture(t)
  const { result } = await f.authorize(await f.manager.createDraft('operator', f.input))
  const id = result.account.id
  const draft = await f.manager.createDraft('operator', { idempotency_key: crypto.randomUUID() }, id)
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

// R3 复审 N2、M2：重新授权把代次下限交给 Worker，下限在完成授权时现算（草稿创建之后其他实例刷新出的代次也计入）
test('reauthorization passes a revision floor computed when the authorization completes', async (t) => {
  const f = await fixture(t)
  const { result } = await f.authorize(await f.manager.createDraft('operator', f.input))
  const id = result.account.id
  const draft = await f.manager.createDraft('operator', { idempotency_key: crypto.randomUUID() }, id)
  f.db
    .prepare(
      "INSERT INTO credential_refresh_leases(account_resource_id,grant_kind,holder_instance_id,runtime_account_id,lease_token,credential_revision,state,expires_at,acquired_at,updated_at) VALUES(?,'native','gw-two','rt','tok',7,'released',datetime('now'),datetime('now'),datetime('now'))",
    )
    .run(id)
  await f.authorize(draft)
  const complete = f.calls.filter((c) => c[0] === 'complete').at(-1)[2]
  assert.equal(complete.min_credential_revision, 7)
  assert.deepEqual(await f.manager.revisionFloors(id), { minRevision: 7, minBpsGeneration: 0 })
})

test('subscription expiry is kept on the account, refreshed with backoff, and dropped for another ChatGPT account', async (t) => {
  const f = await fixture(t)
  const { result } = await f.authorize(await f.manager.createDraft('operator', f.input))
  const id = result.account.id
  const row = async () => (await f.repo.listCodexAccounts()).find((item) => item.id === id)
  const before = (await row()).updated_at
  const service = new GatewayWorkerService({ repo: f.repo })
  const asked = []
  let reply = { expires_at: '2026-12-01T00:00:00Z', will_renew: true, billing_period: 'monthly' }
  service.client.accountInsight = async (instance, runtimeId, kind) => {
    asked.push([instance, runtimeId, kind])
    return { ok: true, status: 200, data: { ok: true, subscription: reply } }
  }
  await service.accountInsight(id, 'subscription')
  assert.deepEqual(asked, [['gw-one', result.account.runtime_account_id, 'subscription']])
  const saved = (await row()).config.subscription
  assert.equal(saved.expires_at, '2026-12-01T00:00:00.000Z')
  assert.equal(saved.will_renew, true)
  assert.equal(saved.billing_period, 'monthly')
  assert.equal((await row()).updated_at, before, 'the list order does not change')
  assert.equal(JSON.stringify(await gatewayAccountPatch(f.db, await row())).includes('2026-12-01'), false)

  // Fresh values are not re-checked; stale ones are, and a failure backs off before retrying.
  const now = Date.parse(saved.checked_at)
  assert.equal(await service.refreshAccountSubscriptions({ at: now + 60_000 }), 0)
  assert.equal(asked.length, 1)
  reply = null
  const day = 24 * 60 * 60_000
  assert.equal(await service.refreshAccountSubscriptions({ at: now + day }), 0)
  assert.equal(await service.refreshAccountSubscriptions({ at: now + day + 60 * 60_000 }), 0)
  assert.equal(asked.length, 2)
  assert.equal(
    (await row()).config.subscription.expires_at,
    '2026-12-01T00:00:00.000Z',
    'a failed check keeps the last value',
  )
  reply = { expires_at: '2027-01-01T00:00:00Z' }
  assert.equal(await service.refreshAccountSubscriptions({ at: now + day + 7 * 60 * 60_000 }), 1)
  assert.equal((await row()).config.subscription.expires_at, '2027-01-01T00:00:00.000Z')

  // Reauthorizing the same ChatGPT account keeps it; another account must not inherit it.
  const again = await f.authorize(await f.manager.createDraft('operator', { idempotency_key: crypto.randomUUID() }, id))
  assert.equal(again.result.account.config.subscription.expires_at, '2027-01-01T00:00:00.000Z')
  f.db
    .prepare(
      "UPDATE vendor_resources SET config_json=json_set(config_json,'$.chatgpt_account_id','chatgpt-old') WHERE id=?",
    )
    .run(id)
  const other = await f.authorize(await f.manager.createDraft('operator', { idempotency_key: crypto.randomUUID() }, id))
  assert.equal(other.result.account.config.subscription, undefined)
})

test('single Worker heartbeat reconciles its own account and does not mark it source-missing', async (t) => {
  const f = await fixture(t)
  const { result } = await f.authorize(await f.manager.createDraft('operator', f.input))
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
  assert.equal((await f.manager.account(result.account.id)).projection_status, 'synced')
  assert.equal(f.calls.filter((c) => c[0] === 'patch').at(-1)[3].proxy_url, f.input.proxy_endpoint)
})

// 最终审计 F1：唯一的 Worker 数据目录丢失（导出 404）时，control 托管用凭据库令牌与控制面账号资料直接重建投影
test('a single Worker that lost its data is re-projected from the vault under control custody', async (t) => {
  const f = await fixture(t)
  const { result } = await f.authorize(await f.manager.createDraft('operator', f.input))
  const runtimeId = result.account.runtime_account_id
  const accountId = result.account.id
  const { createCredentialVault, loadKeyring } = await import('../../src/lib/executor/vault.mjs')
  const { createCredentialCustody } = await import('../../src/lib/executor/credential-custody.mjs')
  const { openCredentialBundle, openCustodyBundle } = await import('../../src/lib/executor/custody.mjs')
  const fixtureKeys = JSON.parse(
    fs.readFileSync(new URL('../fixtures/executor-contract/custody.json', import.meta.url), 'utf8'),
  )
  const keyFile = path.join(os.tmpdir(), `vault-projection-${crypto.randomUUID()}.json`)
  t.after(() => fs.rmSync(keyFile, { force: true }))
  const vault = createCredentialVault({ db: f.db, keyring: loadKeyring({ file: keyFile }) })
  const KEY = 'projection-bundle-key'
  const build = (mode = 'control') => {
    const service = new GatewayWorkerService({ repo: f.repo })
    service._custody = createCredentialCustody({
      db: f.db,
      env: { KIN_CREDENTIAL_CUSTODY: mode, KIN_CODEX_GATEWAY_CREDENTIAL_BUNDLE_KEY: KEY },
      vault,
      log: { warn() {} },
    })
    const calls = []
    service.client.exportAccount = async () => ({
      ok: false,
      status: 404,
      data: { error: { code: 'account_not_found' } },
    })
    service.client.importAccount = async (instance, id, body) => {
      calls.push(['import', instance, id, body])
      return { ok: true, data: { account: { id, credential_revision: body.credential_revision } } }
    }
    service.client.patchAccount = async (instance, id, body) => {
      calls.push(['patch', instance, id, body])
      return { ok: true, data: { account: { id, credential_revision: 1 } } }
    }
    return { service, calls }
  }
  const status = async () => (await f.manager.account(accountId)).projection_status

  // worker 托管（默认）：没有来源时维持原有行为，不碰凭据库
  let run = build('worker')
  await run.service.projectAllAccountsTo('gw-one')
  assert.equal(run.calls.filter((c) => c[0] === 'import').length, 0)
  assert.equal(await status(), 'drifted')

  // control 托管但凭据库还没有该账号：不导入
  run = build()
  await run.service.projectAllAccountsTo('gw-one')
  assert.equal(run.calls.filter((c) => c[0] === 'import').length, 0)
  assert.equal(await status(), 'drifted')

  // 凭据库有令牌：按共享凭据包导入（实例没有托管公钥），代理在凭据包里，先停用再由 PATCH 启用
  await vault.put({
    accountResourceId: accountId,
    grant: 'native',
    revision: 1,
    secrets: { access_token: 'vault-access', refresh_token: 'vault-refresh' },
    expiresAt: '2026-12-01T00:00:00.000Z',
    source: 'test',
  })
  run = build()
  assert.equal((await run.service.projectAllAccountsTo('gw-one')).ok, true)
  const [imported] = run.calls.filter((c) => c[0] === 'import')
  assert.equal(imported[2], runtimeId)
  assert.equal(imported[3].credential_revision, 1)
  assert.equal(imported[3].enabled, false)
  assert.equal(imported[3].paused, true)
  assert.equal(imported[3].email, 'test@example.test')
  assert.equal(imported[3].chatgpt_account_id, 'chatgpt-one')
  assert.equal(imported[3].custody_bundle, undefined)
  const shared = openCredentialBundle(KEY, runtimeId, imported[3].credential_bundle)
  assert.equal(shared.access_token, 'vault-access')
  assert.equal(shared.proxy_url, f.input.proxy_endpoint)
  const patch = run.calls.find((c) => c[0] === 'patch')
  assert.equal(run.calls.indexOf(patch) > run.calls.indexOf(imported), true)
  assert.equal(patch[3].enabled, true)
  assert.equal(patch[3].proxy_url, f.input.proxy_endpoint)
  assert.equal(await status(), 'synced')

  // 实例托管公钥已确认：按公钥封装，导入元数据的代次与封装绑定
  f.db
    .prepare(
      "UPDATE gateway_worker_instances SET custody_public_key=?, capabilities_json=json_set(COALESCE(capabilities_json,'{}'),'$.custody',json('true')) WHERE id='gw-one'",
    )
    .run(fixtureKeys.public_key)
  f.db.prepare("UPDATE gateway_worker_account_bindings SET projection_status='drifted'").run()
  run = build()
  await run.service.projectAllAccountsTo('gw-one')
  const sealed = run.calls.find((c) => c[0] === 'import')[3]
  assert.equal(sealed.credential_bundle, undefined)
  assert.equal(
    openCustodyBundle(fixtureKeys.private_key, 'gw-one', runtimeId, sealed.custody_bundle, {
      credentialRevision: 1,
      bpsGeneration: 0,
    }).refresh_token,
    'vault-refresh',
  )

  // 凭据库落后于控制面已知的代次（轮换报告丢失）：不下发旧令牌
  f.db.prepare('UPDATE gateway_worker_account_bindings SET credential_revision=3').run()
  run = build()
  await run.service.projectAllAccountsTo('gw-one')
  assert.equal(run.calls.filter((c) => c[0] === 'import').length, 0)
  assert.equal(await status(), 'drifted')

  // 导出失败但不是 404、心跳也回报了该账号：本实例可能仍有账号，不用凭据库覆盖
  f.db.prepare('UPDATE gateway_worker_account_bindings SET credential_revision=1').run()
  run = build()
  run.service.client.exportAccount = async () => ({ ok: false, status: 502, data: {} })
  await run.service.projectAllAccountsTo('gw-one', {
    revisions: [{ account_id: runtimeId, credential_revision: 1, projection_revision: 1, config_fingerprint: 'x' }],
  })
  assert.equal(run.calls.filter((c) => c[0] === 'import').length, 0)

  // 复核 G3：另一个实例在线、只是导出失败（可能持有更新的令牌）时不重建；它离线时才重建
  await f.repo.upsertInstance({
    id: 'gw-two',
    base_url: 'http://127.0.0.1:8791',
    health_state: 'healthy',
    drain_state: 'accepting',
  })
  f.db
    .prepare(
      "INSERT INTO gateway_worker_account_bindings(account_resource_id,gateway_instance_id,runtime_account_id,credential_revision,projection_status,created_at,updated_at) VALUES(?,'gw-two',?,1,'synced','x','x')",
    )
    .run(accountId, runtimeId)
  f.db
    .prepare(
      "UPDATE gateway_worker_account_bindings SET projection_status='drifted' WHERE gateway_instance_id='gw-one'",
    )
    .run()
  run = build()
  run.service.client.exportAccount = async (instance) =>
    instance === 'gw-one'
      ? { ok: false, status: 404, data: { error: { code: 'account_not_found' } } }
      : { ok: false, status: 502, data: {} }
  await run.service.projectAllAccountsTo('gw-one')
  assert.equal(
    run.calls.filter((c) => c[0] === 'import').length,
    0,
    'an online source that fails to export blocks the rebuild',
  )
  // 复核 H1：状态仍是 healthy、但 45 秒没有心跳（多 Worker 空闲时没人把它标成 offline）也算不在线
  f.db
    .prepare("UPDATE gateway_worker_instances SET last_heartbeat_at=? WHERE id='gw-two'")
    .run(new Date(Date.now() - 60_000).toISOString())
  assert.equal((await f.repo.getInstance('gw-two')).health_state, 'healthy')
  run = build()
  run.service.client.exportAccount = async (instance) =>
    instance === 'gw-one'
      ? { ok: false, status: 404, data: { error: { code: 'account_not_found' } } }
      : { ok: false, status: 502, data: {} }
  await run.service.projectAllAccountsTo('gw-one')
  assert.equal(run.calls.filter((c) => c[0] === 'import').length, 1)

  // 复核 G4：不带 account_not_found 的 404（反代、路由）不算账号缺失
  f.db.prepare('DELETE FROM gateway_worker_account_bindings WHERE gateway_instance_id=?').run('gw-two')
  f.db.prepare("UPDATE gateway_worker_account_bindings SET projection_status='drifted'").run()
  run = build()
  run.service.client.exportAccount = async () => ({ ok: false, status: 404, data: {} })
  await run.service.projectAllAccountsTo('gw-one')
  assert.equal(run.calls.filter((c) => c[0] === 'import').length, 0)

  // 复核 G1、G2、G5：BPS 一并重建（代次与托管封装一致，过期时间缺失时取 JWT exp），套餐带上；
  // 刷新租约记录的代次高于凭据库时：原生落后不重建，BPS 落后只重建原生
  const exp = Math.floor(Date.parse('2026-12-24T00:00:00Z') / 1000)
  const jwt = `x.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.y`
  await vault.put({
    accountResourceId: accountId,
    grant: 'bps',
    revision: 3,
    secrets: { access_token: jwt, refresh_token: 'bps-refresh' },
    source: 'test',
  })
  f.db
    .prepare(
      "UPDATE vendor_resources SET config_json=json_set(config_json,'$.bps_grant',json('{\"revision\":2}'),'$.plan','pro') WHERE id=?",
    )
    .run(accountId)
  run = build()
  await run.service.projectAllAccountsTo('gw-one')
  const withBps = run.calls.find((c) => c[0] === 'import')[3]
  assert.deepEqual(withBps.bps, { revision: 2, token_generation: 2, expires_at: '2026-12-24T00:00:00.000Z' })
  assert.equal(withBps.plan, 'pro')
  assert.equal(
    openCustodyBundle(fixtureKeys.private_key, 'gw-one', runtimeId, withBps.custody_bundle, {
      credentialRevision: 1,
      bpsGeneration: 2,
    }).bps_refresh_token,
    'bps-refresh',
  )
  const lease = (grant, revision) =>
    f.db
      .prepare(
        "INSERT OR REPLACE INTO credential_refresh_leases(account_resource_id,grant_kind,holder_instance_id,runtime_account_id,lease_token,credential_revision,state,expires_at,acquired_at,updated_at) VALUES(?,?,'gw-one',?,'t',?,'released','x','x','x')",
      )
      .run(accountId, grant, runtimeId, revision)
  lease('bps', 5)
  f.db.prepare("UPDATE gateway_worker_account_bindings SET projection_status='drifted'").run()
  run = build()
  await run.service.projectAllAccountsTo('gw-one')
  assert.equal(run.calls.find((c) => c[0] === 'import')[3].bps, undefined, 'a stale BPS copy is not rebuilt')
  lease('native', 2)
  f.db.prepare("UPDATE gateway_worker_account_bindings SET projection_status='drifted'").run()
  run = build()
  await run.service.projectAllAccountsTo('gw-one')
  assert.equal(run.calls.filter((c) => c[0] === 'import').length, 0, 'a native copy behind the lease is not rebuilt')
})

test('heartbeat projection only re-projects accounts whose reported revisions or fingerprint differ', async (t) => {
  const f = await fixture(t)
  const { result } = await f.authorize(await f.manager.createDraft('operator', f.input))
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
  const f = await fixture(t)
  const { result } = await f.authorize(await f.manager.createDraft('operator', f.input))
  f.db.prepare("UPDATE groups SET status='inactive',deleted_at=datetime('now') WHERE platform='openai'").run()
  f.service.client.patchAccount = async () => ({ ok: false, status: 503 })
  const paused = await f.manager.update('operator', result.account.id, { status: 'paused' })
  assert.equal(paused.account.status, 'paused')
  assert.equal(paused.projection_pending, true)
  // 实例照常接单，只把未同步的账号排除在选号之外
  assert.equal((await f.repo.pickInstance())?.id, 'gw-one')
  assert.deepEqual(await f.repo.unsyncedRuntimeAccounts('gw-one'), [result.account.runtime_account_id])
  await assert.rejects(f.manager.update('operator', result.account.id, { status: 'active' }), {
    code: 'group_scope_forbidden',
  })
  const archived = await f.manager.update('operator', result.account.id, { status: 'archived' })
  assert.equal(archived.account.status, 'archived')
})

test('heartbeat projection skips accounts that never reached a Worker instead of blocking the instance', async (t) => {
  const f = await fixture(t)
  const { result } = await f.authorize(await f.manager.createDraft('operator', f.input))
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
  assert.equal((await f.repo.listAccountBindings('account_orphan')).length, 0)
  assert.equal((await f.manager.account(result.account.id)).projection_status, 'synced')
  assert.equal((await f.repo.pickInstance())?.id, 'gw-one')
  assert.deepEqual(await f.repo.unsyncedRuntimeAccounts('gw-one'), [])
})

test('archived accounts are retired on their own instance only; failures exclude the account there', async (t) => {
  const f = await fixture(t)
  const { result } = await f.authorize(await f.manager.createDraft('operator', f.input))
  await f.manager.update('operator', result.account.id, { status: 'archived' })
  await f.repo.upsertInstance({
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
  assert.equal(await f.repo.getAccountBinding(result.account.id, 'gw-two'), null)
  assert.equal((await service.projectAllAccountsTo('gw-one')).ok, true)
  assert.deepEqual(
    touched.map((c) => c[0]),
    ['patch'],
  )
  assert.deepEqual(touched[0][2].groups, [])
  assert.equal(touched[0][2].enabled, false)
  assert.equal((await f.repo.getAccountBinding(result.account.id, 'gw-one')).projection_status, 'archived')
  assert.ok(await f.repo.pickInstance())
  assert.deepEqual(await f.repo.unsyncedRuntimeAccounts('gw-one'), [])
  // 心跳回报已停用（版本不旧于归档版本）或已不在实例上时，不再重复停用
  touched.length = 0
  const runtimeId = result.account.runtime_account_id
  const archivedRevision = (await f.repo.getAccountBinding(result.account.id, 'gw-one')).projection_revision
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
  assert.equal((await f.repo.getAccountBinding(result.account.id, 'gw-one')).projection_status, 'drifted')
  assert.deepEqual(await f.repo.unsyncedRuntimeAccounts('gw-one'), [result.account.runtime_account_id])
  assert.equal((await f.repo.pickInstance())?.id, 'gw-one')
})

test('a Worker that lost an active account recovers it from another instance binding', async (t) => {
  const f = await fixture(t)
  const { result } = await f.authorize(await f.manager.createDraft('operator', f.input))
  await f.repo.upsertInstance({
    id: 'gw-two',
    base_url: 'http://127.0.0.1:8791',
    health_state: 'healthy',
    drain_state: 'accepting',
    boot_id: 'boot-two',
    protocol_version: 1,
  })
  const runtimeId = result.account.runtime_account_id
  await f.repo.recordProjection({
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
  assert.equal((await f.repo.getAccountBinding(result.account.id, 'gw-one')).projection_status, 'synced')
})

// R3 复审 M1：轮换报告丢失后，持有更高凭据代次的实例拒绝旧投影（409 带本地代次）；
// 控制面按 MAX 记下该代次，下一次投影以它为来源，其他实例从它恢复，不再长期把它排除在调度外
test('a stale-projection rejection makes the newer instance the projection source', async (t) => {
  const f = await fixture(t)
  const { result } = await f.authorize(await f.manager.createDraft('operator', f.input))
  await f.repo.upsertInstance({
    id: 'gw-two',
    base_url: 'http://127.0.0.1:8791',
    health_state: 'healthy',
    drain_state: 'accepting',
    boot_id: 'boot-two',
    protocol_version: 1,
  })
  const runtimeId = result.account.runtime_account_id
  const accountId = result.account.id
  await f.repo.recordProjection({
    accountResourceId: accountId,
    instanceId: 'gw-one',
    runtimeAccountId: runtimeId,
    credentialRevision: 2,
    status: 'synced',
  })
  await f.repo.recordProjection({
    accountResourceId: accountId,
    instanceId: 'gw-two',
    runtimeAccountId: runtimeId,
    credentialRevision: 1,
    status: 'synced',
  })
  const local = { 'gw-one': 2, 'gw-two': 3 }
  const service = new GatewayWorkerService({ repo: f.repo })
  const calls = []
  service.client.exportAccount = async (instance, id) => {
    calls.push(['export', instance])
    return {
      ok: true,
      data: { account: { id, credential_revision: local[instance] }, credential_bundle: `b-${instance}` },
    }
  }
  service.client.importAccount = async (instance, id, body) => {
    calls.push(['import', instance, body.credential_bundle])
    if (local[instance] > Number(body.credential_revision))
      return {
        ok: false,
        status: 409,
        data: { error: { code: 'credential_revision_stale' }, account: { id, credential_revision: local[instance] } },
      }
    local[instance] = Number(body.credential_revision)
    return { ok: true, data: { account: { id, credential_revision: local[instance] } } }
  }
  service.client.patchAccount = async (instance, id) => ({
    ok: true,
    data: { account: { id, credential_revision: local[instance] } },
  })
  // 第一次：gw-two 拒绝 gw-one 的旧凭据，绑定代次推进到 3
  await service.projectAllAccountsTo('gw-two')
  const rejected = await f.repo.getAccountBinding(accountId, 'gw-two')
  assert.equal(rejected.projection_status, 'drifted')
  assert.equal(rejected.credential_revision, 3)
  // 下一次：gw-two 以自身为来源恢复同步；gw-one 从 gw-two 取新凭据
  calls.length = 0
  await service.projectAllAccountsTo('gw-two')
  assert.deepEqual(calls[0], ['export', 'gw-two'])
  assert.equal((await f.repo.getAccountBinding(accountId, 'gw-two')).projection_status, 'synced')
  calls.length = 0
  await service.projectAllAccountsTo('gw-one')
  assert.deepEqual(calls.slice(0, 2), [
    ['export', 'gw-two'],
    ['import', 'gw-one', 'b-gw-two'],
  ])
  assert.equal(local['gw-one'], 3)
})

test('platform-owned receipts retain usage without creating supplier settlement facts', async (t) => {
  const f = await fixture(t)
  const { result } = await f.authorize(await f.manager.createDraft('operator', f.input))
  f.db
    .prepare(
      "INSERT INTO usage_logs(request_id,created_at,model,status,execution_kind,dispatch_id,total_cost) VALUES('platform-request',?,'gpt-5-codex',200,'gateway_worker','platform-dispatch',0.02)",
    )
    .run(new Date().toISOString())
  const updated = await f.repo.applyReceiptToUsage(
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
    // 执行策略只有一个精确路径：子路径由本处理器回 404，不交回外层路由
    reply = null
    const handled = await handler(
      { method: 'GET', panelRole: 'super_admin' },
      {},
      { pathname: '/api/panel/gateway-execution-policies/v1' },
    )
    assert.notEqual(handled, false)
    assert.deepEqual([reply?.status, reply?.body?.error?.code], [404, 'not_found'])
  } finally {
    await closeDatabase()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('migration 081 preserves existing supplier accounts and FK dependants and reopens idempotently', async (t) => {
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
  await repo.upsertInstance({ id: 'gw-old', base_url: 'http://127.0.0.1:8790' })
  await repo.recordProjection({
    accountResourceId: 'old-account',
    instanceId: 'gw-old',
    runtimeAccountId: 'runtime-old',
  })
  const before = db.prepare("SELECT * FROM vendor_resources WHERE id='old-account'").get()
  applyMigrations(db)
  // 迁移 118 只新增墓碑列 deleted_at（历史行为 NULL），其余字段原样保留
  const { deleted_at: deletedAt, ...after } = db.prepare("SELECT * FROM vendor_resources WHERE id='old-account'").get()
  assert.equal(deletedAt, null)
  assert.deepEqual(after, { ...before })
  assert.equal((await repo.getAccountBinding('old-account')).runtime_account_id, 'runtime-old')
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
  const f = await fixture(t)
  const { result } = await f.authorize(await f.manager.createDraft('operator', f.input))
  const id = result.account.id
  const now = Date.now()
  const insert = f.db.prepare(
    "INSERT INTO usage_logs(request_id,created_at,model,status,execution_kind,account_resource_id,total_cost,input_tokens,output_tokens) VALUES(?,?,'gpt-5-codex',?,'gateway_worker',?,?,10,5)",
  )
  insert.run('u-now', new Date(now - 60_000).toISOString(), 200, id, 0.5)
  insert.run('u-err', new Date(now - 120_000).toISOString(), 500, id, 0)
  insert.run('u-old', new Date(now - 3 * 86400_000).toISOString(), 200, id, 2)
  insert.run('u-other', new Date(now - 60_000).toISOString(), 200, 'someone-else', 9)
  const usage = (await f.repo.listCodexAccounts()).find((row) => row.id === id).usage
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

test('account 5H/7D cost windows align to quota resets like VM rows, including an elapsed reset', async (t) => {
  const f = await fixture(t)
  const { result } = await f.authorize(await f.manager.createDraft('operator', f.input))
  const id = result.account.id
  const now = Date.parse('2026-11-04T12:00:00.000Z')
  const ago = (minutes) => new Date(now - minutes * 60_000).toISOString()
  const insert = f.db.prepare(
    "INSERT INTO usage_logs(request_id,created_at,model,status,execution_kind,account_resource_id,total_cost,input_tokens,output_tokens) VALUES(?,?,'gpt-5-codex',200,'gateway_worker',?,?,10,5)",
  )
  insert.run('before-reset', ago(90), id, 4)
  insert.run('after-reset', ago(30), id, 1)
  insert.run('last-week', ago(8 * 24 * 60), id, 16)
  const usageWith = async (quota) => (await f.repo.codexAccountUsage([{ id, quota }], now)).get(id)

  // 5h 窗口 1 小时前已重置：新窗口从重置时刻起算，不再回退成滚动 5 小时
  const elapsed = await usageWith({
    primary_window: { window_minutes: 300, used_percent: 40, reset_at: ago(60) },
    secondary_window: { window_minutes: 10080, used_percent: 10, reset_at: new Date(now + 86400_000).toISOString() },
  })
  assert.equal(elapsed.window_5h_cost, 1)
  assert.equal(elapsed.window_7d_cost, 5)

  // 未来重置：窗口为 [reset − window_minutes, now]
  const future = await usageWith({
    primary_window: { window_minutes: 300, reset_at: new Date(now + 4 * 3600_000).toISOString() },
  })
  assert.equal(future.window_5h_cost, 1)

  // 没有重置时间：回退滚动窗口
  const rolling = await usageWith(null)
  assert.equal(rolling.window_5h_cost, 5)
  assert.equal(rolling.window_7d_cost, 5)
  assert.equal(rolling.total_cost, 21)
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
    await closeDatabase()
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
    await new GatewayWorkerRepo(db).upsertInstance({
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
    await closeDatabase()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('bulk edit applies the single-account rules to every target and validates all first', async (t) => {
  const f = await fixture(t)
  const one = (await f.authorize(await f.manager.createDraft('operator', f.input))).result.account
  const two = (
    await f.authorize(
      await f.manager.createDraft('operator', {
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
  assert.deepEqual((await f.manager.account(two.id)).config.group_ids, [f.groups[0], f.groups[1]])
  await f.manager.bulkUpdate('operator', {
    ids: [one.id, two.id],
    patch: { groups: { operation: 'remove', ids: [f.groups[0]] } },
  })
  const after = (id) => f.manager.account(id)
  assert.equal((await after(one.id)).status, 'paused')
  assert.equal((await after(one.id)).config.max_concurrency, 9)
  assert.deepEqual((await after(one.id)).config.group_ids, [f.groups[1]])
  assert.equal(f.runtime.get(one.runtime_account_id).max_rpm, 30)
  // Removing the last group fails validation; nothing is written for either account.
  await assert.rejects(
    f.manager.bulkUpdate('operator', {
      ids: [one.id, two.id],
      patch: { max_concurrency: 3, groups: { operation: 'remove', ids: [f.groups[1]] } },
    }),
    { code: 'group_required' },
  )
  assert.equal((await after(one.id)).config.max_concurrency, 9)
  await assert.rejects(f.manager.bulkUpdate('operator', { ids: [one.id], patch: { name: 'x' } }), {
    code: 'invalid_patch',
  })
  await assert.rejects(f.manager.bulkUpdate('operator', { ids: [one.id], patch: { max_concurrency: 0 } }), {
    code: 'invalid_capacity',
  })
})

test('CPR account settings: blank name uses OAuth email; weight, model access and scheduling reach the Worker', async (t) => {
  const f = await fixture(t)
  const draft = await f.manager.createDraft('operator', {
    ...f.input,
    name: '',
    weight: 7,
    status: 'paused',
    model_access: { mode: 'denylist', models: ['gpt-5.5-mini'] },
    idempotency_key: crypto.randomUUID(),
  })
  const { result } = await f.authorize(draft)
  const account = await f.manager.account(result.account.id)
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

test('Codex requests use the Worker only for groups bound to Gateway accounts', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-scope-'))
  const db = openDatabase({ dataDir: dir })
  t.after(async () => {
    await closeDatabase()
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
  assert.equal(await service.shouldUse(req(901), {}), false)
  assert.equal(await service.shouldUse(req(902), {}), true)
  await saveCodexSettings(db, { gateway_worker: { preference: 'vm' } }, 'test')
  assert.equal(await service.shouldUse(req(902), {}), false)
  assert.equal(await service.shouldUse({}, {}), false)
})

test('heartbeat load records the instance peak and per-account in-flight shown on the account list', async (t) => {
  const f = await fixture(t)
  const { result } = await f.authorize(await f.manager.createDraft('operator', f.input))
  const id = result.account.id
  const runtime = result.account.runtime_account_id
  const instance = (await f.repo.getAccountBinding(id)).gateway_instance_id
  await f.repo.recordRuntimeLoad(instance, {
    peak_concurrency: 4,
    account_inflight: [
      { account_id: runtime, in_flight: 2 },
      { account_id: 'gwacct_unknown', in_flight: 9 },
    ],
  })
  assert.equal((await f.repo.listCodexAccounts()).find((row) => row.id === id).inflight, 2)
  assert.equal((await f.repo.getInstance(instance)).peak_concurrency, 4)
  // 下一次心跳未列出该账号：在途归零
  await f.repo.recordRuntimeLoad(instance, { peak_concurrency: 1, account_inflight: [] })
  assert.equal((await f.repo.listCodexAccounts()).find((row) => row.id === id).inflight, 0)
  assert.equal((await f.repo.getInstance(instance)).peak_concurrency, 1)
  // 离线实例的在途不计
  await f.repo.recordRuntimeLoad(instance, { account_inflight: [{ account_id: runtime, in_flight: 3 }] })
  f.db.prepare("UPDATE gateway_worker_instances SET health_state='offline' WHERE id=?").run(instance)
  assert.equal((await f.repo.listCodexAccounts()).find((row) => row.id === id).inflight, 0)
})

test('heartbeat credential states mark idle accounts and clear once the Worker stops reporting them', async (t) => {
  const f = await fixture(t)
  const { result } = await f.authorize(await f.manager.createDraft('operator', f.input))
  const id = result.account.id
  const runtime = result.account.runtime_account_id
  const instance = (await f.repo.getAccountBinding(id)).gateway_instance_id
  const row = async () => (await f.repo.listCodexAccounts()).find((item) => item.id === id)
  assert.equal((await row()).credential_state, null)
  await f.repo.recordRuntimeCredentials(instance, [
    { account_id: runtime, credential_state: 'expired', last_error: 'credential_refresh_failed' },
    { account_id: 'gwacct_unknown', credential_state: 'banned' },
  ])
  assert.equal((await row()).credential_state, 'expired')
  assert.equal((await row()).credential_error, 'credential_refresh_failed')
  // 旧版 Worker 不上报该字段：保持原值
  await f.repo.recordRuntimeCredentials(instance, undefined)
  assert.equal((await row()).credential_state, 'expired')
  // 刷新成功或重新授权后 Worker 不再列出：恢复可用
  await f.repo.recordRuntimeCredentials(instance, [])
  assert.equal((await row()).credential_state, null)
  assert.equal((await row()).credential_error, null)
})

test('reauthorization clears the expired credential state at once instead of waiting for the next heartbeat', async (t) => {
  const f = await fixture(t)
  const { result } = await f.authorize(await f.manager.createDraft('operator', f.input))
  const id = result.account.id
  const runtime = result.account.runtime_account_id
  const instance = (await f.repo.getAccountBinding(id)).gateway_instance_id
  const row = async () => (await f.repo.listCodexAccounts()).find((item) => item.id === id)
  await f.repo.recordRuntimeCredentials(instance, [
    { account_id: runtime, credential_state: 'expired', last_error: 'credential_expired', bps_state: 'expired' },
  ])
  assert.equal((await row()).credential_state, 'expired')
  await f.authorize(await f.manager.createDraft('operator', { idempotency_key: crypto.randomUUID() }, id))
  assert.equal((await row()).credential_state, null)
  assert.equal((await row()).credential_error, null)
  // BPS 附加授权独立，原生凭据重新授权不改它
  assert.equal((await row()).bps_state, 'expired')
})

test('account list rows carry the weekly capacity forecast next to the 7D spend, reused between polls', async (t) => {
  const f = await fixture(t)
  const { result } = await f.authorize(await f.manager.createDraft('operator', f.input))
  const id = result.account.id
  const now = Date.parse('2026-11-04T12:00:00.000Z')
  const reset = now + 3 * 86400_000
  const start = reset - 7 * 86400_000
  f.db.prepare('UPDATE vendor_resources SET created_at=? WHERE id=?').run(new Date(start - 86400_000).toISOString(), id)
  const setQuota = (percent) =>
    f.db.prepare('UPDATE gateway_worker_account_bindings SET quota_json=? WHERE account_resource_id=?').run(
      JSON.stringify({
        secondary_window: { used_percent: percent, window_minutes: 10080, reset_at: new Date(reset).toISOString() },
        updated_at: new Date(now - 60_000).toISOString(),
      }),
      id,
    )
  setQuota(40)
  const insert = f.db.prepare(
    "INSERT INTO usage_logs(request_id,created_at,model,status,execution_kind,account_resource_id,total_cost,input_tokens,output_tokens) VALUES(?,?,'gpt-5-codex',200,'gateway_worker',?,?,1000,0)",
  )
  insert.run('w1', new Date(start + 3600_000).toISOString(), id, 1)
  insert.run('w2', new Date(start + 7200_000).toISOString(), id, 3)
  const estimate = async (at) =>
    (await attachListForecasts(f.db, await f.repo.listCodexAccounts(), at)).find((row) => row.id === id).usage
      .estimate_7d
  const first = await estimate(now)
  assert.equal(first.status, 'ok')
  assert.ok(Math.abs(first.total_usd - 10) < 1e-9)
  assert.equal(first.total_tokens, 5000)
  assert.equal(first.used_ratio, 0.4)
  // Same weekly reading inside 5 minutes: the cached forecast is reused even if usage grew.
  insert.run('w3', new Date(start + 10800_000).toISOString(), id, 4)
  assert.ok(Math.abs((await estimate(now + 60_000)).total_usd - 10) < 1e-9)
  // A new weekly reading recomputes: $8 logged at 50% → $16.
  setQuota(50)
  assert.ok(Math.abs((await estimate(now + 120_000)).total_usd - 16) < 1e-9)
})

test('BPS is an additional authorization on an OAuth account with its own settings, import, revoke and 403 move', async (t) => {
  const f = await fixture(t)
  // 新建账号不能直接走 BPS（先 OAuth）
  await assert.rejects(() => f.manager.createDraft('operator', { ...f.input, authorization_kind: 'bps_oauth' }), {
    code: 'bps_requires_account',
  })
  const { result } = await f.authorize(await f.manager.createDraft('operator', f.input))
  const id = result.account.id
  assert.equal(result.account.config.auth_method, 'oauth')
  assert.equal(result.account.config.bps, undefined)
  // 未授权 BPS 时不能编辑 BPS 设置
  await assert.rejects(() => f.manager.update('operator', id, { bps: { models: ['gpt-5.5'] } }), {
    code: 'bps_not_authorized',
  })
  f.service.oauthComplete = async (body) => {
    f.calls.push(['complete', 'gw-one', body])
    return {
      ok: true,
      data: { bps_revision: 1, account: f.runtime.get(f.calls.find((c) => c[0] === 'start')[2].runtime_account_id) },
    }
  }
  const draft = await f.manager.createDraft(
    'operator',
    { idempotency_key: crypto.randomUUID(), authorization_kind: 'bps_oauth' },
    id,
  )
  const authorized = await f.authorize(draft)
  const start = f.calls.filter((c) => c[0] === 'start').at(-1)[2]
  assert.equal(start.grant, 'bps')
  assert.equal(f.calls.filter((c) => c[0] === 'complete').at(-1)[2].expected_bps_revision, 0)
  const account = await f.manager.account(id)
  assert.equal(account.config.bps_grant.revision, 1)
  assert.deepEqual(account.config.bps, {
    enabled: true,
    models: [],
    omit_unsupported_tools: false,
    ignore_encrypted_content: false,
    auto_disable_on_403: true,
    auto_recover_on_403: true,
    recovery_interval_minutes: 1,
    rate_limit_cooldown_seconds: 5,
    auto_move_on_403: false,
    target_group_id: null,
    cache_creation_as_input: true,
  })
  assert.equal(authorized.result.account.id, id)
  // BPS 设置校验与投影
  await assert.rejects(() => f.manager.update('operator', id, { bps: { recovery_interval_minutes: 0 } }), {
    code: 'invalid_bps_recovery_interval',
  })
  await assert.rejects(
    () => f.manager.update('operator', id, { bps: { auto_recover_on_403: true, auto_disable_on_403: false } }),
    {
      code: 'invalid_bps_recovery',
    },
  )
  await assert.rejects(() => f.manager.update('operator', id, { bps: { auto_move_on_403: true } }), {
    code: 'invalid_bps_target_group',
  })
  await assert.rejects(() => f.manager.update('operator', id, { bps: { models: ['a', 'a'] } }), {
    code: 'invalid_bps_models',
  })
  await f.manager.update('operator', id, {
    bps: { models: ['gpt-5.5'], omit_unsupported_tools: true, auto_move_on_403: true, target_group_id: 0 },
  })
  const patch = f.calls.filter((c) => c[0] === 'patch').at(-1)[3]
  assert.deepEqual(patch.bps_settings, {
    enabled: true,
    models: ['gpt-5.5'],
    omit_unsupported_tools: true,
    ignore_encrypted_content: false,
    auto_disable_on_403: true,
    auto_recover_on_403: true,
    recovery_interval_minutes: 1,
    rate_limit_cooldown_seconds: 5,
    cache_creation_as_input: true,
  })
  // 批量 BPS 设置：模型名单按操作合并，开关直接覆盖；未授权账号单独报错
  await assert.rejects(() => f.manager.bulkUpdate('operator', { ids: [id], patch: { bps: { target_group_id: 1 } } }), {
    code: 'invalid_bps_settings',
  })
  let bulk = await f.manager.bulkUpdate('operator', {
    ids: [id],
    patch: { bps: { models: { operation: 'add', ids: ['gpt-5.4', 'gpt-5.5'] }, ignore_encrypted_content: true } },
  })
  assert.equal(bulk.updated, 1)
  assert.deepEqual((await f.manager.account(id)).config.bps.models, ['gpt-5.5', 'gpt-5.4'])
  assert.equal((await f.manager.account(id)).config.bps.ignore_encrypted_content, true)
  bulk = await f.manager.bulkUpdate('operator', {
    ids: [id],
    patch: { bps: { models: { operation: 'remove', ids: ['gpt-5.4'] } } },
  })
  assert.deepEqual((await f.manager.account(id)).config.bps.models, ['gpt-5.5'])
  // 403 停用后按设置退出所有分组，同一次停用只处理一次
  f.db
    .prepare(
      "UPDATE gateway_worker_account_bindings SET bps_state='blocked',bps_blocked_at='2026-11-04T10:00:00Z' WHERE account_resource_id=?",
    )
    .run(id)
  assert.deepEqual(await f.manager.reconcileBpsBlocks(), [id])
  assert.deepEqual((await f.manager.account(id)).config.group_ids, [])
  assert.deepEqual(await f.manager.reconcileBpsBlocks(), [])
  // 心跳上报恢复状态与冷却；手动解除与停止本次恢复经 Worker 执行
  const binding = await f.repo.getAccountBinding(id)
  await f.repo.recordRuntimeCredentials(binding.gateway_instance_id, [
    {
      account_id: binding.runtime_account_id,
      bps_state: 'blocked',
      bps_error: 'banned',
      bps_blocked_at: '2026-11-04T10:00:00Z',
      bps_recovery: 'auto',
      bps_next_probe_at: '2026-11-04T11:00:00Z',
      bps_cooldown_until: '2026-11-04T10:05:00Z',
    },
  ])
  const listed = await f.manager.account(id)
  assert.equal(listed.bps_recovery, 'auto')
  assert.equal(listed.bps_next_probe_at, '2026-11-04T11:00:00Z')
  assert.equal(listed.bps_cooldown_until, '2026-11-04T10:05:00Z')
  const recoveryCalls = []
  const previousInternal = f.service.client.internal
  f.service.client.internal = async (instance, path, options) => {
    recoveryCalls.push([path, options.method])
    return { ok: true, data: { ok: true } }
  }
  await f.manager.bpsRecoveryAction('operator', id, 'stop')
  assert.equal((await f.manager.account(id)).bps_recovery, 'stopped')
  assert.equal((await f.manager.account(id)).bps_next_probe_at, null)
  await f.manager.bpsRecoveryAction('operator', id, 'unblock')
  assert.equal((await f.manager.account(id)).bps_state, null)
  assert.deepEqual(
    recoveryCalls.map(([path, method]) => [path.split('/bps/')[1], method]),
    [
      ['recovery/stop', 'POST'],
      ['unblock', 'POST'],
    ],
  )
  f.service.client.internal = previousInternal
  // 冷却中的可用授权也会上报（无终态）
  await f.repo.recordRuntimeCredentials(binding.gateway_instance_id, [
    {
      account_id: binding.runtime_account_id,
      bps_state: '',
      bps_error: 'rate_limited',
      bps_cooldown_until: '2026-11-04T10:09:00Z',
    },
  ])
  assert.equal((await f.manager.account(id)).bps_state, null)
  assert.equal((await f.manager.account(id)).bps_error, 'rate_limited')
  assert.equal((await f.manager.account(id)).bps_cooldown_until, '2026-11-04T10:09:00Z')
  // 导入与撤销经 Worker 内部接口
  const internal = []
  f.service.client.internal = async (instance, path, options) => {
    internal.push([instance, path, options])
    return { ok: true, data: { bps_revision: 2 } }
  }
  await assert.rejects(() => f.manager.importBps('operator', id, { access_token: 'x' }), {
    code: 'invalid_bps_credential',
  })
  // 旧授权已失效：写入新授权后状态行立即恢复，不等下一次心跳
  await f.repo.recordRuntimeCredentials(binding.gateway_instance_id, [
    { account_id: binding.runtime_account_id, bps_state: 'invalid', bps_error: 'refresh_token_reused' },
  ])
  assert.equal((await f.manager.account(id)).bps_state, 'invalid')
  await f.manager.importBps('operator', id, { tokens: { access_token: 'at', refresh_token: 'rt', id_token: 'it' } })
  assert.equal((await f.manager.account(id)).bps_state, null)
  assert.equal((await f.manager.account(id)).bps_error, null)
  assert.match(internal[0][1], /\/bps\/import$/)
  assert.equal(internal[0][2].body.expected_bps_revision, 1)
  assert.equal((await f.manager.account(id)).config.bps_grant.revision, 2)
  // BPS 模型目录经 Worker 查询并保存，非法强度与字段被丢弃
  f.service.client.internal = async (instance, path, options) => {
    internal.push([instance, path, options])
    return {
      ok: true,
      data: {
        allowed: true,
        models: [{ id: 'gpt-5.5', display_name: 'GPT-5.5', reasoning_efforts: ['low', 'ultra', 'high'], extra: 1 }],
        restricted_models: ['gpt-secret'],
        fetched_at: '2026-11-04T12:00:00Z',
      },
    }
  }
  const catalog = await f.manager.bpsModels(id, { refresh: true })
  assert.match(internal.at(-1)[1], /\/bps\/models\?refresh=1$/)
  assert.equal(internal.at(-1)[2].method, 'GET')
  assert.deepEqual(catalog.models, [{ id: 'gpt-5.5', display_name: 'GPT-5.5', reasoning_efforts: ['low', 'high'] }])
  assert.deepEqual((await f.manager.account(id)).config.bps_catalog.restricted_models, ['gpt-secret'])
  await f.manager.recordBpsVerification(id, {
    ok: true,
    model: 'gpt-5.5',
    probe: { mode: 'bps', response_model: 'gpt-5.5' },
  })
  assert.equal((await f.manager.account(id)).config.bps_verification.ok, true)
  assert.equal((await f.manager.account(id)).config.bps_verification.mode, 'bps')
  f.service.client.internal = async (instance, path, options) => {
    internal.push([instance, path, options])
    return { ok: true, data: { bps_revision: 2 } }
  }
  // 撤销时删除 BPS 租约行，原生租约行保留（R3 复审 N3）
  const leaseRow = f.db.prepare(
    "INSERT INTO credential_refresh_leases(account_resource_id,grant_kind,holder_instance_id,runtime_account_id,lease_token,credential_revision,state,expires_at,acquired_at,updated_at) VALUES(?,?,'gw-one','rt','tok',4,'released',datetime('now'),datetime('now'),datetime('now'))",
  )
  leaseRow.run(id, 'bps')
  leaseRow.run(id, 'native')
  // 配置写入失败时整体回滚：BPS 租约与授权都还在（删除与配置、审计在同一事务）
  f.db.exec(
    `CREATE TRIGGER fail_revoke BEFORE UPDATE ON vendor_resources WHEN NEW.id='${id}' BEGIN SELECT RAISE(ABORT,'config write failed'); END`,
  )
  await assert.rejects(() => f.manager.revokeBps('operator', id), /config write failed/)
  f.db.exec('DROP TRIGGER fail_revoke')
  assert.equal(
    f.db
      .prepare("SELECT COUNT(*) AS n FROM credential_refresh_leases WHERE account_resource_id=? AND grant_kind='bps'")
      .get(id).n,
    1,
  )
  assert.notEqual((await f.manager.account(id)).config.bps_grant, undefined)
  await f.manager.revokeBps('operator', id)
  assert.equal(internal.at(-1)[2].method, 'DELETE')
  assert.deepEqual(
    f.db
      .prepare('SELECT grant_kind FROM credential_refresh_leases WHERE account_resource_id=?')
      .all(id)
      .map((r) => r.grant_kind),
    ['native'],
  )
  assert.equal((await f.manager.account(id)).config.bps_grant, undefined)
  assert.equal((await f.manager.account(id)).config.bps.models[0], 'gpt-5.5')
  const skipped = await f.manager.bulkUpdate('operator', { ids: [id], patch: { bps: { enabled: false } } })
  assert.equal(skipped.updated, 0)
  assert.equal(skipped.items[0].error.code, 'bps_not_authorized')
})

test('BPS recovery probes reported by heartbeats are kept per account without usage records', async (t) => {
  const f = await fixture(t)
  const { result } = await f.authorize(await f.manager.createDraft('operator', f.input))
  const id = result.account.id
  const runtimeId = (await f.repo.getAccountBinding(id)).runtime_account_id
  const probe = {
    account_id: runtimeId,
    probed_at: '2099-01-01T00:00:00Z',
    model: 'gpt-5.5',
    ok: true,
    status: 200,
    input_tokens: 12,
    output_tokens: 3,
    total_tokens: 15,
    duration_ms: 800,
  }
  await f.repo.recordBpsProbes('gw-one', [probe, probe, { ...probe, account_id: 'unknown' }])
  await f.repo.recordBpsProbes('gw-one', [
    {
      ...probe,
      probed_at: '2099-01-01T00:01:00Z',
      ok: false,
      status: 403,
      error_code: 'account_deactivated',
      total_tokens: 0,
    },
  ])
  const probes = await f.repo.listBpsProbes(id)
  assert.equal(probes.length, 2)
  assert.deepEqual(
    probes.map((p) => [p.ok, p.status, p.error_code, p.total_tokens]),
    [
      [false, 403, 'account_deactivated', 0],
      [true, 200, null, 15],
    ],
  )
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM usage_logs').get().n, 0)
})

test('accounts export with native and BPS credentials and import into new accounts', async (t) => {
  const f = await fixture(t)
  const { result } = await f.authorize(await f.manager.createDraft('operator', f.input))
  const id = result.account.id
  // 令牌来自 Worker 导出的凭据包（实例间共享密钥加密），不再经明文接口（P3.9）
  const previousKey = process.env.KIN_CODEX_GATEWAY_CREDENTIAL_BUNDLE_KEY
  process.env.KIN_CODEX_GATEWAY_CREDENTIAL_BUNDLE_KEY = 'export-test-key'
  t.after(() => {
    if (previousKey === undefined) delete process.env.KIN_CODEX_GATEWAY_CREDENTIAL_BUNDLE_KEY
    else process.env.KIN_CODEX_GATEWAY_CREDENTIAL_BUNDLE_KEY = previousKey
  })
  f.service.client.exportAccount = async (_instance, runtimeId) => ({
    ok: true,
    data: {
      account: {
        id: runtimeId,
        chatgpt_account_id: 'chatgpt-one',
        email: 'one@example.test',
        expires_at: '0001-01-01T00:00:00Z',
      },
      credential_bundle: sealCredentialBundle('export-test-key', runtimeId, {
        access_token: 'at-1',
        refresh_token: 'rt-1',
        id_token: 'it-1',
        bps_access_token: 'bps-at',
        bps_refresh_token: 'bps-rt',
        bps_id_token: 'bps-it',
      }),
    },
  })
  f.manager.saveBpsGrant = async () => ({})
  const exported = await f.manager.exportAccounts('operator', [id])
  assert.equal(exported.failed.length, 0, JSON.stringify(exported.failed))
  assert.equal(exported.file.type, 'kin-gateway-accounts')
  const [entry] = exported.file.accounts
  assert.equal(entry.name, 'Platform Codex')
  assert.equal(entry.credentials.refresh_token, 'rt-1')
  assert.equal(entry.credentials.chatgpt_account_id, 'chatgpt-one')
  assert.equal(entry.credentials.expires_at, undefined, 'zero expiry is omitted')
  assert.equal(entry.bps_credentials.refresh_token, 'bps-rt')
  assert.equal(entry.bps_credentials.chatgpt_account_id, 'chatgpt-one')
  assert.match(entry.proxy_url, /proxy\.example\.test/)
  assert.ok(f.db.prepare("SELECT 1 FROM operation_audit WHERE action='gateway.account.exported'").get())
  // 导入：先建账号导入原生授权，再导入 BPS 授权
  const upserts = []
  f.service.upsertAccount = async (payload, instanceId) => {
    upserts.push([instanceId, payload])
    const account = { ...payload, email: 'imported@example.test', credential_revision: payload.credential_revision }
    f.runtime.set(payload.id, account)
    return { ok: true, data: { account } }
  }
  const bpsImports = []
  f.manager.importBps = async (actor, accountId, body) => {
    bpsImports.push([accountId, body])
    return {}
  }
  await assert.rejects(() => f.manager.importAccounts('operator', { file: { type: 'other' } }), {
    code: 'invalid_import_file',
  })
  const imported = await f.manager.importAccounts('operator', {
    file: { ...exported.file, accounts: [{ ...entry, name: 'Imported Codex', bps: undefined }] },
    group_ids: [f.groups[0]],
    idempotency_key: 'import-1',
  })
  assert.equal(imported.imported, 1, JSON.stringify(imported.items))
  assert.equal(upserts[0][1].refresh_token, 'rt-1')
  assert.equal(imported.items[0].bps, 'authorized')
  assert.equal(bpsImports[0][1].tokens.refresh_token, 'bps-rt')
  assert.notEqual(imported.items[0].id, id)
  assert.equal((await f.manager.account(imported.items[0].id)).name, 'Imported Codex')
})

test('first BPS authorization applies the editable BPS defaults template', async (t) => {
  const f = await fixture(t)
  // BPS 默认设置模板来自 Codex 本地设置（控制面设置存储）
  assert.deepEqual(f.manager.bpsDefaults().models, [])
  await saveCodexSettings(f.db, { bps_defaults: { models: ['gpt-5.5'], ignore_encrypted_content: true } }, 'test')
  const defaults = f.manager.bpsDefaults()
  assert.deepEqual(defaults.models, ['gpt-5.5'])
  assert.equal(defaults.ignore_encrypted_content, true)
  assert.equal(defaults.auto_move_on_403, false)
})

test('a pasted proxy joins the platform proxy pool and binds the account by id; legacy inline proxies can be pooled', async (t) => {
  const f = await fixture(t)
  // Legacy account: created before pasted proxies reached the pool, so it only has the inline address.
  const legacy = (
    await f.authorize(
      await f.manager.createDraft('operator', {
        ...f.input,
        name: 'Legacy',
        proxy_endpoint: 'old.example.test:1080:user:secret',
        idempotency_key: crypto.randomUUID(),
      }),
    )
  ).result.account
  assert.equal(legacy.config.proxy_id, '')
  const pool = new ProxyPool({ db: f.db })
  t.after(() => pool.stopScheduler())
  f.manager.proxyPool = pool

  // A rejected draft leaves no pool row behind.
  await assert.rejects(
    () =>
      f.manager.createDraft('operator', {
        ...f.input,
        group_ids: [],
        idempotency_key: crypto.randomUUID(),
      }),
    { code: 'group_required' },
  )
  assert.equal(pool.state.proxies.length, 0)

  const { result } = await f.authorize(await f.manager.createDraft('operator', f.input))
  assert.equal(pool.state.proxies.length, 1)
  const row = pool.state.proxies[0]
  assert.deepEqual([row.host, row.port, row.username, row.platforms], ['proxy.example.test', 1080, 'user', ['openai']])
  assert.equal(result.account.config.proxy_id, row.id)
  assert.equal(result.account.config.proxy_endpoint, 'socks5h://proxy.example.test:1080')
  const secret = (id) =>
    JSON.parse(maybeDecrypt(f.db.prepare('SELECT secret_json FROM vendor_resources WHERE id=?').get(id).secret_json))
  assert.equal(secret(result.account.id).proxy_url, 'socks5h://user:secret@proxy.example.test:1080')
  assert.equal(f.db.prepare('SELECT count(*) n FROM proxies WHERE id=? AND vendor_id IS NULL').get(row.id).n, 1)

  // The same address pasted on another account reuses the row.
  const again = await f.manager.update('operator', legacy.id, { proxy_endpoint: f.input.proxy_endpoint })
  assert.equal(again.account.config.proxy_id, row.id)
  assert.equal(pool.state.proxies.length, 1)

  // A disabled pool row is refused rather than silently bypassed.
  pool.setEnabled(row.id, false)
  await assert.rejects(f.manager.update('operator', result.account.id, { proxy_endpoint: f.input.proxy_endpoint }), {
    code: 'proxy_unavailable',
  })
  pool.setEnabled(row.id, true)

  // Moving a legacy inline proxy into the pool keeps the exact credentials.
  f.manager.proxyPool = undefined
  await f.manager.update('operator', legacy.id, { proxy_endpoint: 'old.example.test:1080:user:secret' })
  assert.equal((await f.manager.account(legacy.id)).config.proxy_id, '')
  f.manager.proxyPool = pool
  const pooled = await f.manager.poolInlineProxy('operator', legacy.id)
  const legacyRow = pool.state.proxies.find((p) => p.host === 'old.example.test')
  assert.equal(pooled.account.config.proxy_id, legacyRow.id)
  assert.equal(legacyRow.password, 'secret')
  assert.equal(secret(legacy.id).proxy_url, 'socks5h://user:secret@old.example.test:1080')
  // Idempotent once bound.
  assert.equal((await f.manager.poolInlineProxy('operator', legacy.id)).account.config.proxy_id, legacyRow.id)
})

test('an old Worker that keeps its own OAuth session still completes (transition)', async (t) => {
  const f = await fixture(t)
  const original = f.service.oauthStart
  f.service.oauthStart = async (body, instanceId) => {
    const result = await original(body, instanceId)
    delete result.data.session
    return result
  }
  const { session, result } = await f.authorize(await f.manager.createDraft('operator', f.input))
  assert.ok(result.account.id)
  assert.equal(f.calls.find((c) => c[0] === 'complete')[2].session, undefined)
  assert.equal(
    f.db.prepare('SELECT session_json FROM gateway_worker_oauth_sessions WHERE session_id=?').get(session.session_id)
      ?.session_json,
    null,
  )
})

test('a supplier Gateway account is created through the same draft path: owner row, secret and binding written once', async (t) => {
  const f = await fixture(t)
  f.db.exec(
    `INSERT INTO vendors(id,name,external_code,email,tier,root_id,groups_json,created_by,created_at,updated_at) VALUES('vendor-a','Supplier','code-a','a@example.test',1,'vendor-a','${JSON.stringify(f.groups.map(String))}','test','now','now')`,
  )
  f.db
    .prepare(
      "INSERT INTO vendor_resources(id,vendor_id,resource_type,name,status,config_json,secret_json,created_by,created_at,updated_at) VALUES('proxy-a','vendor-a','proxy','Exit','active','{}',?,'test','now','now')",
    )
    .run(maybeEncrypt(JSON.stringify({ endpoint: 'socks5://px:pxsecret@127.0.0.1:1080' })))
  const secretWrites = []
  const prepare = f.db.prepare.bind(f.db)
  f.db.prepare = (sql) => {
    if (/secret_json=\?/.test(sql)) secretWrites.push(sql)
    return prepare(sql)
  }
  const created = []
  // 供应商层建号（开户策略、额度与供应商审计在那里执行），编号沿用草稿占用的 gw-NN
  const owner = {
    vendorId: 'vendor-a',
    externalId: 'account:supplier-key',
    createResource(resourceId) {
      created.push(resourceId)
      const config = {
        platform: 'openai',
        auth_method: 'oauth',
        authorization_mode: 'codex_oauth',
        execution_kind: 'gateway_worker',
        name_from_authorization: true,
        group_ids: [f.groups[0]],
        proxy_id: 'proxy-a',
      }
      prepare(
        "INSERT INTO vendor_resources(id,vendor_id,resource_type,name,external_id,status,config_json,created_by,created_at,updated_at) VALUES(?,'vendor-a','account','pending','account:supplier-key','active',?,'vendor-user','now','now')",
      ).run(resourceId, JSON.stringify(config))
      return { id: resourceId, config }
    },
  }
  const body = { idempotency_key: 'supplier-key', name: '', group_ids: [f.groups[0]], proxy_id: 'proxy-a' }
  // 平台草稿不能使用供应商的代理
  await assert.rejects(() => f.manager.createDraft('operator', body), { code: 'proxy_scope_forbidden' })
  const actor = 'vendor:vendor-a:u1'
  const draft = await f.manager.createDraft(actor, body, null, { owner })
  const resourceId = f.manager.drafts.get(draft.id).resourceId
  // 授权成功前不建账号行
  assert.equal(prepare('SELECT count(*) n FROM vendor_resources WHERE id=?').get(resourceId).n, 0)
  const { result } = await f.authorize(draft, actor)
  assert.equal(f.calls.find((c) => c[0] === 'start')[2].proxy_url, 'socks5h://px:pxsecret@127.0.0.1:1080')
  assert.deepEqual(created, [resourceId])
  assert.equal(result.account.id, resourceId)
  const row = prepare('SELECT * FROM vendor_resources WHERE id=?').get(resourceId)
  assert.equal(row.vendor_id, 'vendor-a')
  assert.equal(row.name, 'test@example.test')
  const config = JSON.parse(row.config_json)
  assert.equal(config.proxy_id, 'proxy-a')
  assert.equal(config.authorization_mode, 'codex_oauth')
  assert.equal(config.runtime_account_id, `gwacct_${resourceId}`)
  assert.equal(config.name_from_authorization, undefined)
  assert.equal(JSON.parse(maybeDecrypt(row.secret_json)).proxy_url, 'socks5h://px:pxsecret@127.0.0.1:1080')
  assert.equal(secretWrites.length, 1)
  const bindings = await f.repo.listAccountBindings(resourceId)
  assert.equal(bindings.length, 1)
  assert.equal(bindings[0].runtime_account_id, `gwacct_${resourceId}`)
  assert.equal(bindings[0].projection_status, 'synced')
  assert.equal(
    prepare("SELECT count(*) n FROM operation_audit WHERE action='gateway.account.created' AND target=?").get(
      resourceId,
    ).n,
    1,
  )
  // 供应商备注与运营备注分开保存
  await f.manager.update(actor, resourceId, { vendor_notes: ' supplier note ' })
  assert.equal((await f.manager.account(resourceId)).config.vendor_notes, 'supplier note')
  // 订阅档位手动覆盖：统一小写保存，空串清除恢复自动识别，非法值拒绝
  await f.manager.update(actor, resourceId, { plan_override: 'ProLite' })
  assert.equal((await f.manager.account(resourceId)).config.plan_override, 'prolite')
  await f.manager.update(actor, resourceId, { plan_override: '' })
  assert.equal((await f.manager.account(resourceId)).config.plan_override, undefined)
  await assert.rejects(f.manager.update(actor, resourceId, { plan_override: 'pro 200!' }), {
    code: 'invalid_plan_override',
  })
  await assert.rejects(
    f.manager.update(
      'operator',
      (await f.authorize(await f.manager.createDraft('operator', f.input))).result.account.id,
      {
        vendor_notes: 'x',
      },
    ),
    { code: 'invalid_resource_patch' },
  )
  // 同一幂等键再建草稿：已建账号直接作为结果
  const again = await f.manager.createDraft('vendor:vendor-a:u2', body, null, { owner })
  assert.equal(f.manager.drafts.get(again.id).result.account.id, resourceId)
})

test('accepting a custody key and its audit commit together', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-custody-accept-'))
  const db = openDatabase({ dataDir: dir })
  try {
    const repo = new GatewayWorkerRepo(db)
    await repo.upsertInstance({ id: 'gw-a', base_url: 'http://127.0.0.1:1', health_state: 'healthy' })
    db.prepare(
      "UPDATE gateway_worker_instances SET custody_public_key='old-key',custody_key_pending='new-key' WHERE id='gw-a'",
    ).run()
    let reply
    const handler = createGatewayWorkerRoutes({
      json: (_res, status, body) => {
        reply = { status, body }
      },
      readBody: async () => ({ public_key: 'new-key' }),
    })
    const accept = () =>
      handler(
        { method: 'POST', panelRole: 'super_admin', panelUserId: 'u_root' },
        {},
        { pathname: '/api/panel/gateway-workers/gw-a/custody-key/accept' },
      )
    db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON operation_audit BEGIN SELECT RAISE(ABORT,'audit failed'); END")
    await assert.rejects(accept, /audit failed/)
    db.exec('DROP TRIGGER fail_audit')
    const kept = db
      .prepare("SELECT custody_public_key,custody_key_pending FROM gateway_worker_instances WHERE id='gw-a'")
      .get()
    assert.deepEqual({ ...kept }, { custody_public_key: 'old-key', custody_key_pending: 'new-key' })
    await accept()
    assert.equal(reply.status, 200)
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM operation_audit WHERE action='gateway.instance.custody_key_accepted'").get()
        .n,
      1,
    )
  } finally {
    await closeDatabase()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
