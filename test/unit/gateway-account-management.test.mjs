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
import { attachListForecasts } from '../../src/lib/gateway-worker/quota-forecast.mjs'
import { maybeDecrypt, maybeEncrypt } from '../../src/lib/db/secure.mjs'
import { saveCodexSettings } from '../../src/lib/executor/settings-store.mjs'
import { ProxyPool } from '../../src/lib/vm/proxy-pool.mjs'
import { createCredentialCustody } from '../../src/lib/executor/credential-custody.mjs'
import { deriveCodexSurfaceStableId } from '../../src/lib/oauth/codex-oauth.mjs'
import { dbTime } from '../../src/shared/system-time.mjs'

const sha = (value) => crypto.createHash('sha256').update(value).digest('hex')
/** 授权链接里的 state（原生在 Desktop 外层链接的 authorize_url 里）拼成回调链接。 */
function stateOf(authUrl) {
  const url = new URL(authUrl)
  return url.searchParams.get('state') || new URL(url.searchParams.get('authorize_url')).searchParams.get('state')
}
const callbackFor = (authUrl, code = 'code-one') =>
  `http://localhost:1455/auth/callback?code=${code}&state=${stateOf(authUrl)}`
const jwt = (payload) =>
  `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`
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
  // 授权在控制面完成（S1）：假的 OpenAI 令牌服务，签发带身份声明的 JWT；identity 可按测试改
  const identity = { email: 'test@example.test', chatgpt_account_id: 'chatgpt-one', plan: 'plus', user: 'user-1' }
  let issued = 0
  const tokenFetch = async (url, init) => {
    const form = Object.fromEntries(new URLSearchParams(String(init.body)))
    calls.push(['token', form.grant_type, form])
    if (identity.reject) return { status: 400, json: async () => ({ error: 'invalid_grant' }) }
    issued += 1
    const auth = {
      chatgpt_account_id: identity.chatgpt_account_id,
      chatgpt_plan_type: identity.plan,
      chatgpt_user_id: identity.user,
    }
    const exp = Math.floor(Date.now() / 1000) + 3600
    return {
      status: 200,
      json: async () => ({
        access_token: jwt({ exp, client_id: form.client_id, 'https://api.openai.com/auth': auth }),
        refresh_token: `rt-${issued}`,
        id_token: jwt({ email: identity.email, aud: [form.client_id], 'https://api.openai.com/auth': auth }),
        expires_in: 3600,
      }),
    }
  }
  // 与 GatewayWorkerService.internal 相同：发往当前接单的实例（迁移 130 起绑定不记实例）
  const service = {
    client: {},
    async internal(target, options) {
      const instance = await repo.pickInstance()
      return service.client.internal(instance?.id, target, options)
    },
  }
  const manager = new GatewayAccountManagement({ repo, service, tokenFetch })
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
      code: callbackFor(session.auth_url),
    })
    return { session, result }
  }
  return { db, repo, manager, input, groups, calls, runtime, service, authorize, identity }
}

/** Worker 直读的事实（gateway_account_facts_v1 一行 + 分组 + 解开的代理地址）。 */
function facts(db, id) {
  const row = db.prepare('SELECT * FROM gateway_account_facts_v1 WHERE account_resource_id=?').get(id)
  const groups = db
    .prepare('SELECT group_id FROM gateway_account_groups_v1 WHERE account_resource_id=? ORDER BY group_id')
    .all(id)
    .map((g) => g.group_id)
  const secret = row.secret_json ? JSON.parse(maybeDecrypt(row.secret_json)) : {}
  return { ...row, groups, proxy_url: secret.proxy_url || '' }
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
  f.identity.reject = true
  await assert.rejects(f.authorize(failing), { code: 'oauth_code_rejected' })
  f.identity.reject = false
  f.manager.drafts.get(failing.id).expires = 0
  const next = await f.authorize(await draft('next'))
  assert.equal(next.result.account.id, 'gw-05')
  // 重新授权沿用原编号
  const again = await f.authorize(
    await f.manager.createDraft('operator', { idempotency_key: crypto.randomUUID() }, 'gw-01'),
  )
  assert.equal(again.result.account.id, 'gw-01')
})

test('super admin can authorize platform account without supplier or VM; tokens go straight to the vault', async (t) => {
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
  // 绑定在 Worker 心跳确认读到事实后才标为已同步
  assert.equal(account.projection_status, 'pending')
  assert.equal(account.credential_revision, 1)
  assert.ok(account.runtime_account_id)
  // 授权在控制面完成（S1）：链接带账号安装身份的 stable id，换码带 PKCE verifier，令牌直接写进凭据库
  const installation = (await f.manager.account(account.id)).config.installation_id
  assert.match(installation, /^[0-9a-f-]{36}$/)
  const inner = new URL(new URL(session.auth_url).searchParams.get('authorize_url'))
  assert.equal(inner.searchParams.get('source_surface_stable_id'), deriveCodexSurfaceStableId(installation))
  const [, grantType, form] = f.calls.find((c) => c[0] === 'token')
  assert.deepEqual([grantType, form.code, form.code_verifier.length], ['authorization_code', 'code-one', 43])
  const native = await (await createCredentialCustody({ db: f.db }).vault()).get(account.id, 'native')
  assert.deepEqual([native.revision, native.secrets.refresh_token], [1, 'rt-1'])
  assert.equal((await f.manager.account(account.id)).config.email, 'test@example.test')
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

test('editing groups, proxy and capacity changes the facts the Worker reads; pause and archive remove scheduling', async (t) => {
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
  assert.equal(changed.account.config.proxy_endpoint, 'socks5h://proxy2.example.test:1080')
  const edited = facts(f.db, id)
  assert.deepEqual(edited.groups, [f.groups[1]])
  assert.equal(edited.proxy_url, 'socks5h://user:new-password@proxy2.example.test:1080')
  assert.deepEqual([edited.max_concurrency, edited.max_rpm, edited.status], [8, 20, 'active'])
  const paused = await f.manager.update('operator', id, { status: 'paused', proxy_endpoint: '' })
  assert.equal(paused.account.status, 'paused')
  assert.equal(facts(f.db, id).status, 'paused')
  await f.manager.update('operator', id, { status: 'active' })
  assert.equal(facts(f.db, id).status, 'active')
  await f.manager.update('operator', id, { status: 'archived' })
  assert.deepEqual(await f.manager.groups.forResource('gateway_worker_account', id), [])
  assert.deepEqual([facts(f.db, id).status, facts(f.db, id).groups], ['archived', []])
  await assert.rejects(f.manager.update('operator', id, { status: 'active' }), { code: 'resource_archived' })
  // 配置修改不调用 Worker，也不再换码：只有授权时的一次换码
  assert.deepEqual(
    f.calls.map((c) => c[0]),
    ['token'],
  )
})

test('reauthorization preserves metadata, paused state and installation identity and writes a newer revision', async (t) => {
  const f = await fixture(t)
  const { result } = await f.authorize(await f.manager.createDraft('operator', f.input))
  const id = result.account.id
  const draft = await f.manager.createDraft('operator', { idempotency_key: crypto.randomUUID() }, id)
  await f.manager.update('operator', id, { name: 'Changed while authorizing', status: 'paused' })
  const changed = await f.authorize(draft)
  assert.equal(changed.result.account.name, 'Changed while authorizing')
  assert.equal(changed.result.account.status, 'paused')
  assert.equal(changed.result.account.credential_revision, 2)
  assert.equal(changed.result.account.config.installation_id, result.account.config.installation_id)
  const vault = await createCredentialCustody({ db: f.db }).vault()
  assert.deepEqual(
    [(await vault.get(id, 'native')).revision, (await vault.get(id, 'native')).secrets.refresh_token],
    [2, 'rt-2'],
  )
  assert.equal(changed.result.account.vendor_id, null)
})

// R3 复审 N2、M2：重新授权的代次高于完成授权时已知的最大代次（草稿创建之后刷新出的代次也计入）
test('reauthorization writes above the revision floor computed when the authorization completes', async (t) => {
  const f = await fixture(t)
  const { result } = await f.authorize(await f.manager.createDraft('operator', f.input))
  const id = result.account.id
  const draft = await f.manager.createDraft('operator', { idempotency_key: crypto.randomUUID() }, id)
  // Worker 心跳报告的本地代次（刷新结果尚未写回凭据库）计入下限
  f.db.prepare('UPDATE gateway_worker_account_bindings SET credential_revision=7 WHERE account_resource_id=?').run(id)
  assert.deepEqual(await f.manager.revisionFloors(id), { minRevision: 7 })
  await f.authorize(draft)
  assert.equal((await (await createCredentialCustody({ db: f.db }).vault()).meta(id, 'native')).revision, 8)
})

test('subscription expiry is kept on the account, refreshed with backoff, and dropped for another ChatGPT account', async (t) => {
  const f = await fixture(t)
  const { result } = await f.authorize(await f.manager.createDraft('operator', f.input))
  const id = result.account.id
  const row = async () => (await f.repo.listCodexAccounts()).find((item) => item.id === id)
  const before = (await row()).updated_at
  const service = new GatewayWorkerService({ repo: f.repo })
  const asked = []
  let reply = {
    expires_at: '2026-12-01T00:00:00Z',
    will_renew: true,
    billing_period: 'monthly',
    purchase_origin_platform: 'chatgpt_web',
  }
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
  // 购买平台按 VM 槽位同一映射保存为订阅渠道
  assert.equal(saved.billing_type, 'stripe_subscription')
  assert.equal((await row()).updated_at, before, 'the list order does not change')

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

test('revoked groups do not prevent pause or archive', async (t) => {
  const f = await fixture(t)
  const { result } = await f.authorize(await f.manager.createDraft('operator', f.input))
  f.db.prepare("UPDATE groups SET status='inactive',deleted_at=datetime('now') WHERE platform='openai'").run()
  const paused = await f.manager.update('operator', result.account.id, { status: 'paused' })
  assert.equal(paused.account.status, 'paused')
  // 已删除的分组从账号配置里去掉（重整 P1）；一个分组都不剩时不能恢复接单
  await assert.rejects(f.manager.update('operator', result.account.id, { status: 'active' }), {
    code: 'group_required',
  })
  const archived = await f.manager.update('operator', result.account.id, { status: 'archived' })
  assert.equal(archived.account.status, 'archived')
})

test('platform-owned receipts retain usage without creating supplier settlement facts', async (t) => {
  const f = await fixture(t)
  const { result } = await f.authorize(await f.manager.createDraft('operator', f.input))
  f.db
    .prepare(
      "INSERT INTO usage_logs(request_id,created_at,model,status,execution_kind,dispatch_id,total_cost) VALUES('platform-request',?,'gpt-5-codex',200,'gateway_worker','platform-dispatch',0.02)",
    )
    .run(new Date().toISOString())
  // 回执只改该实例自己派发的使用记录（中期技术债 M2 复审 P2-6）
  f.db
    .prepare(
      "INSERT INTO gateway_worker_dispatches(dispatch_id,request_id,gateway_instance_id,scope_json,nonce_hash,expires_at,status,created_at) VALUES('platform-dispatch','platform-request','gw-one','{}','h-platform','2099-01-01T00:00:00Z','created',?)",
    )
    .run(new Date().toISOString())
  const updated = await f.repo.applyReceiptToUsage(
    {
      gateway_instance_id: 'gw-one',
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
  // 库结构停在 081 之前：直接写当时的绑定行（仓储按迁移 128 之后的结构写）
  db.exec(
    "INSERT INTO gateway_worker_account_bindings(id,account_resource_id,gateway_instance_id,runtime_account_id,created_at,updated_at) VALUES('b-old','old-account','gw-old','runtime-old','now','now')",
  )
  const before = db.prepare("SELECT * FROM vendor_resources WHERE id='old-account'").get()
  applyMigrations(db)
  // 迁移 118 只新增墓碑列 deleted_at（历史行为 NULL）；迁移 124 把绑定里的运行账号 ID 回填到配置；其余字段原样保留
  const { deleted_at: deletedAt, ...after } = db.prepare("SELECT * FROM vendor_resources WHERE id='old-account'").get()
  assert.equal(deletedAt, null)
  assert.deepEqual(
    { ...after, config_json: JSON.parse(after.config_json) },
    { ...before, config_json: { ...JSON.parse(before.config_json), runtime_account_id: 'runtime-old' } },
  )
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
      "INSERT INTO gateway_worker_account_bindings(id,account_resource_id,runtime_account_id,projection_status,created_at,updated_at) VALUES('b-401','acct-401','rt-401','synced','now','now')",
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
  assert.equal(facts(f.db, one.id).max_rpm, 30)
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

test('CPR account settings: blank name uses OAuth email; weight, model access and scheduling reach the Worker facts', async (t) => {
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
  const read = facts(f.db, account.id)
  assert.equal(read.weight, 7)
  assert.deepEqual(JSON.parse(read.model_access_json), { mode: 'denylist', models: ['gpt-5.5-mini'] })
  assert.equal(read.status, 'paused')
  await f.manager.update('operator', account.id, { model_access: { mode: 'allowlist', models: ['gpt-5.5'] } })
  assert.deepEqual(JSON.parse(facts(f.db, account.id).model_access_json), { mode: 'allowlist', models: ['gpt-5.5'] })
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
  const instance = 'gw-one'
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
  const instance = 'gw-one'
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
  const instance = 'gw-one'
  const row = async () => (await f.repo.listCodexAccounts()).find((item) => item.id === id)
  await f.repo.recordRuntimeCredentials(instance, [
    { account_id: runtime, credential_state: 'expired', last_error: 'credential_expired' },
  ])
  assert.equal((await row()).credential_state, 'expired')
  await f.authorize(await f.manager.createDraft('operator', { idempotency_key: crypto.randomUUID() }, id))
  assert.equal((await row()).credential_state, null)
  assert.equal((await row()).credential_error, null)
})

test('account list rows carry the weekly capacity forecast next to the 7D spend, reused between polls', async (t) => {
  const f = await fixture(t)
  const { result } = await f.authorize(await f.manager.createDraft('operator', f.input))
  const id = result.account.id
  const now = Date.parse('2026-11-04T12:00:00.000Z')
  const reset = now + 3 * 86400_000
  const start = reset - 7 * 86400_000
  f.db.prepare('UPDATE vendor_resources SET created_at=? WHERE id=?').run(dbTime(start - 86400_000), id)
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
  insert.run('w1', dbTime(start + 3600_000), id, 1)
  insert.run('w2', dbTime(start + 7200_000), id, 3)
  const estimate = async (at) =>
    (await attachListForecasts(f.db, await f.repo.listCodexAccounts(), at)).find((row) => row.id === id).usage
      .estimate_7d
  const first = await estimate(now)
  assert.equal(first.status, 'ok')
  assert.ok(Math.abs(first.total_usd - 10) < 1e-9)
  assert.equal(first.total_tokens, 5000)
  assert.equal(first.used_ratio, 0.4)
  // Same weekly reading inside 5 minutes: the cached forecast is reused even if usage grew.
  insert.run('w3', dbTime(start + 10800_000), id, 4)
  assert.ok(Math.abs((await estimate(now + 60_000)).total_usd - 10) < 1e-9)
  // A new weekly reading recomputes: $8 logged at 50% → $16.
  setQuota(50)
  assert.ok(Math.abs((await estimate(now + 120_000)).total_usd - 16) < 1e-9)
})

test('accounts export with native credentials and import into new accounts', async (t) => {
  const f = await fixture(t)
  const { result } = await f.authorize(await f.manager.createDraft('operator', f.input))
  const id = result.account.id
  // 令牌只从凭据库导出（S1：授权时控制面已写入）
  const exported = await f.manager.exportAccounts('operator', [id])
  assert.equal(exported.failed.length, 0, JSON.stringify(exported.failed))
  assert.equal(exported.file.type, 'kin-gateway-accounts')
  const [entry] = exported.file.accounts
  assert.equal(entry.name, 'Platform Codex')
  assert.equal(entry.credentials.refresh_token, 'rt-1')
  assert.equal(entry.credentials.chatgpt_account_id, 'chatgpt-one')
  assert.ok(entry.credentials.expires_at > Date.now() / 1000)
  assert.match(entry.proxy_url, /proxy\.example\.test/)
  assert.ok(f.db.prepare("SELECT 1 FROM operation_audit WHERE action='gateway.account.exported'").get())
  // 导入：建账号并写入原生授权
  await assert.rejects(() => f.manager.importAccounts('operator', { file: { type: 'other' } }), {
    code: 'invalid_import_file',
  })
  const imported = await f.manager.importAccounts('operator', {
    file: { ...exported.file, accounts: [{ ...entry, name: 'Imported Codex' }] },
    group_ids: [f.groups[0]],
    idempotency_key: 'import-1',
  })
  assert.equal(imported.imported, 1, JSON.stringify(imported.items))
  const importedNative = await (await createCredentialCustody({ db: f.db }).vault()).get(imported.items[0].id, 'native')
  assert.deepEqual([importedNative.revision, importedNative.secrets.refresh_token], [1, 'rt-1'])
  assert.notEqual(imported.items[0].id, id)
  assert.equal((await f.manager.account(imported.items[0].id)).name, 'Imported Codex')
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

  // 代理改了认证：绑定它的账号的出站地址随之同步（Worker 从账号密文读地址）；停用的代理不改写
  pool.update(row.id, { password: 'rotated' })
  assert.equal(await f.manager.syncProxyAddresses([row.id, legacyRow.id], 'operator'), 1)
  assert.equal(facts(f.db, result.account.id).proxy_url, 'socks5h://user:rotated@proxy.example.test:1080')
  assert.equal(secret(legacy.id).proxy_url, 'socks5h://user:secret@old.example.test:1080')
  assert.ok(f.db.prepare("SELECT 1 FROM operation_audit WHERE action='gateway.account.proxy_synced'").get())
  assert.equal(await f.manager.syncProxyAddresses([row.id]), 0, 'unchanged addresses are not rewritten')
  pool.setEnabled(row.id, false)
  pool.update(row.id, { password: 'again' })
  assert.equal(await f.manager.syncProxyAddresses([row.id]), 0)
  assert.match(secret(result.account.id).proxy_url, /rotated/)
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
  // 换码经供应商代理（控制面按草稿里解析出的出站地址发请求）
  assert.equal(f.manager.drafts.get(draft.id).normalized.proxy, 'socks5h://px:pxsecret@127.0.0.1:1080')
  const { result } = await f.authorize(draft, actor)
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
  const binding = await f.repo.getAccountBinding(resourceId)
  assert.equal(binding.runtime_account_id, `gwacct_${resourceId}`)
  // Worker 心跳确认读到事实后才标为已同步
  assert.equal(binding.projection_status, 'pending')
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

// 分组与资源管理重整 P1：账号已在的分组之后被停用，编辑账号时可以保留（只校验新增分组），不会再也保存不了
test('an account keeps a group that was disabled after it joined; only newly added groups are checked', async (t) => {
  const f = await fixture(t)
  const { result } = await f.authorize(await f.manager.createDraft('operator', f.input))
  const id = result.account.id
  const joined = (await f.manager.account(id)).config.group_ids
  f.db.prepare("UPDATE groups SET status='inactive' WHERE id=?").run(joined[0])
  const renamed = await f.manager.update('operator', id, { name: 'Renamed' })
  assert.equal(renamed.account.name, 'Renamed')
  assert.deepEqual(renamed.account.config.group_ids, joined)
  const other = f.groups.find((g) => !joined.includes(g))
  if (other) {
    f.db.prepare("UPDATE groups SET status='inactive' WHERE id=?").run(other)
    await assert.rejects(f.manager.update('operator', id, { group_ids: [...joined, other] }), {
      code: 'group_scope_forbidden',
    })
  }
})

// 只有刷新令牌的账号文件（S1）：控制面先经账号代理换出访问令牌，再与账号一次写库，身份以刷新结果为准；
// 刷新被拒时不建账号
test('an import with only a refresh token is refreshed in the control plane and stored once', async (t) => {
  const f = await fixture(t)
  const draft = await f.manager.createDraft('operator', { ...f.input, name: '' })
  const result = await f.manager.import('operator', draft.id, { refresh_token: 'rt-only' })
  const [, grantType, form] = f.calls.find((c) => c[0] === 'token')
  assert.deepEqual([grantType, form.refresh_token], ['refresh_token', 'rt-only'])
  const config = (await f.manager.account(result.account.id)).config
  assert.deepEqual([config.email, config.plan, config.chatgpt_account_id], ['test@example.test', 'plus', 'chatgpt-one'])
  const native = await (await createCredentialCustody({ db: f.db }).vault()).get(result.account.id, 'native')
  assert.deepEqual(
    [native.revision, Boolean(native.secrets.access_token), native.secrets.refresh_token],
    [1, true, 'rt-1'],
  )
  f.identity.reject = true
  const second = await f.manager.createDraft('operator', { ...f.input, idempotency_key: crypto.randomUUID() })
  await assert.rejects(f.manager.import('operator', second.id, { refresh_token: 'rt-two' }), {
    code: 'refresh_token_rejected',
  })
  assert.equal(
    f.db.prepare('SELECT 1 FROM vendor_resources WHERE id=?').get(f.manager.drafts.get(second.id).resourceId),
    undefined,
  )
})

// 编辑分组带上读到的分组版本：期间被分组页等入口改过时 409，不拿旧分组覆盖
test('an account edit with a stale group version is refused instead of overwriting newer memberships', async (t) => {
  const f = await fixture(t)
  const { result } = await f.authorize(
    await f.manager.createDraft('operator', { ...f.input, group_ids: [f.groups[0]] }),
  )
  const id = result.account.id
  const version = (await f.repo.listCodexAccounts()).find((a) => a.id === id).group_version
  await f.manager.update('operator', id, { group_ids: [f.groups[0], f.groups[1]], expected_group_version: version })
  await assert.rejects(
    f.manager.update('operator', id, { group_ids: [f.groups[0]], expected_group_version: version }),
    {
      code: 'version_conflict',
    },
  )
  assert.deepEqual(
    facts(f.db, id).groups,
    [...f.groups].sort((a, b) => a - b),
  )
  // 不改分组的编辑不碰分组
  await f.manager.update('operator', id, { max_concurrency: 2 })
  assert.equal(facts(f.db, id).groups.length, 2)
})
