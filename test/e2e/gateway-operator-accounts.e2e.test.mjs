import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { startGatewayAccountFixture } from '../helpers/gateway-account-fixture.mjs'

test('operator HTTP workflow: platform account OAuth, editing, pause, reauthorize, archive and import', async (t) => {
  const f = await startGatewayAccountFixture()
  t.after(() => f.stop())
  const input = {
    name: 'Operator Codex',
    group_ids: f.groups,
    proxy_endpoint: 'socks5://user:fixture-secret@proxy.example.test:1080',
    max_concurrency: 6,
    max_rpm: 40,
    idempotency_key: crypto.randomUUID(),
  }
  const draft = await f.request('POST', 'codex-accounts/drafts', input)
  assert.equal(draft.status, 200, JSON.stringify(draft))
  const base = `codex-accounts/drafts/${draft.data.draft.id}`
  const session = await f.request('POST', `${base}/oauth/generate-auth-url`, {})
  assert.equal(session.status, 200)
  assert.equal(typeof session.data.expires_at, 'number')
  const bad = await f.request('POST', `${base}/oauth/exchange-code`, {
    session_id: session.data.session_id,
    code: 'bare-code',
  })
  assert.equal(bad.status, 400)
  const completed = await f.request('POST', `${base}/oauth/exchange-code`, {
    session_id: session.data.session_id,
    code: f.callbackFor(session.data.auth_url),
  })
  assert.equal(completed.status, 200, JSON.stringify(completed))
  const account = completed.data.account
  assert.equal(account.vendor_id, null)
  assert.equal(account.credential_revision, 1)
  // 绑定在 Worker 心跳确认读到事实后才标为已同步；分组由 Worker 从库里直读
  assert.equal(account.projection_status, 'pending')
  assert.ok(account.runtime_account_id)
  assert.deepEqual(f.facts(account.id).groups, f.groups)
  assert.equal(JSON.stringify(completed.raw).includes('fixture-secret'), false)
  const again = await f.request('POST', `${base}/oauth/exchange-code`, {
    session_id: session.data.session_id,
    code: f.callbackFor(session.data.auth_url),
  })
  assert.equal(again.data.account.id, account.id)
  const edited = await f.request('PATCH', `codex-accounts/${account.id}`, {
    name: 'Edited Codex',
    group_ids: [f.groups[1]],
    max_concurrency: 2,
  })
  assert.equal(edited.status, 200)
  assert.equal(f.facts(account.id).max_concurrency, 2)
  assert.deepEqual(f.facts(account.id).groups, [f.groups[1]])
  const paused = await f.request('POST', `codex-accounts/${account.id}/pause`, {})
  assert.equal(paused.status, 200)
  assert.equal(f.facts(account.id).status, 'paused')
  // 配置修改不调用 Worker 的账号接口
  assert.equal(
    f.calls.some((c) => ['PATCH', 'DELETE'].includes(c.method)),
    false,
  )
  const reauth = await f.request('POST', `codex-accounts/${account.id}/drafts`, {
    idempotency_key: crypto.randomUUID(),
  })
  const rbase = `codex-accounts/drafts/${reauth.data.draft.id}`
  const rs = await f.request('POST', `${rbase}/oauth/generate-auth-url`, {})
  const done = await f.request('POST', `${rbase}/oauth/exchange-code`, {
    session_id: rs.data.session_id,
    code: f.callbackFor(rs.data.auth_url),
  })
  assert.equal(done.status, 200, JSON.stringify(done))
  assert.equal(done.data.account.status, 'paused')
  assert.equal(done.data.account.credential_revision, 2)
  const archived = await f.request('PATCH', `codex-accounts/${account.id}`, { status: 'archived' })
  assert.equal(archived.status, 200)
  assert.equal((await f.request('GET', 'codex-accounts')).data.items.length, 0)
  assert.equal((await f.request('GET', 'codex-accounts?archived=all')).data.items.length, 1)
  const tokenDraft = await f.request('POST', 'codex-accounts/drafts', {
    ...input,
    name: 'Import',
    idempotency_key: crypto.randomUUID(),
  })
  const imported = await f.request('POST', `codex-accounts/drafts/${tokenDraft.data.draft.id}/import`, {
    refresh_token: 'fixture-refresh',
  })
  assert.equal(imported.status, 200, JSON.stringify(imported))
  // 只有刷新令牌：控制面先换出访问令牌再一次写库（代次 1），身份以刷新结果为准
  assert.equal(imported.data.account.credential_revision, 1)
  assert.equal(imported.data.account.config.email, 'refreshed@example.test')
  assert.equal(f.tokenRequests.at(-1).grant_type, 'refresh_token')
  assert.equal(JSON.stringify(imported.raw).includes('fixture-refresh'), false)
})
