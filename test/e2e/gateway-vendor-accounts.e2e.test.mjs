import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { startGatewayAccountFixture } from '../helpers/gateway-account-fixture.mjs'

async function vendorSession(f) {
  const created = await f.request('POST', 'users', {
    username: 'gateway-supplier',
    password: 'supplier-test-123',
    role: 'vendor',
    groups: [{ group_id: f.groups[0] }],
  })
  assert.equal(created.status, 201, JSON.stringify(created.raw))
  const login = await fetch(f.baseUrl + '/api/panel/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'gateway-supplier', password: 'supplier-test-123' }),
  })
  const cookie = login.headers.get('set-cookie').split(';')[0]
  async function vendor(method, pathname, body) {
    const res = await fetch(f.baseUrl + pathname, {
      method,
      headers: { cookie, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    const json = await res.json()
    return { status: res.status, data: json.data || json, raw: json }
  }
  const me = await vendor('GET', '/api/vendor/me')
  const policy = await f.request('PUT', `gateway-execution-policies?vendor_id=${me.data.vendor.id}`, {
    platform: 'openai',
    execution_kind: 'gateway_worker',
    allow_create: true,
    allow_runtime: true,
  })
  assert.equal(policy.status, 200, JSON.stringify(policy.raw))
  return vendor
}

test('supplier Gateway accounts require a proxy and hand the resolved proxy to the Worker', async (t) => {
  const f = await startGatewayAccountFixture()
  t.after(() => f.stop())
  const vendor = await vendorSession(f)
  const draftBody = {
    platform: 'openai',
    authorization_kind: 'codex_account_file',
    execution_kind: 'gateway_worker',
    group_ids: [f.groups[0]],
  }
  const missing = await vendor('POST', '/api/vendor/account-drafts', draftBody)
  assert.equal(missing.status, 400, JSON.stringify(missing.raw))
  assert.equal(missing.raw.error.code, 'proxy_required')

  const proxy = await vendor('POST', '/api/vendor/proxies', {
    name: 'Supplier exit',
    config: { endpoint: 'socks5://pxuser:pxsecret@127.0.0.1:1080' },
  })
  assert.equal(proxy.status, 201, JSON.stringify(proxy.raw))
  const draft = await vendor('POST', '/api/vendor/account-drafts', { ...draftBody, proxy_id: proxy.data.id })
  assert.equal(draft.status, 201, JSON.stringify(draft.raw))
  const imported = await vendor('POST', `/api/vendor/account-drafts/${draft.data.draft.id}/import`, {
    type: 'codex',
    mode: 'json',
    auth_json: JSON.stringify({
      access_token: 'at-test',
      refresh_token: 'rt-test',
      email: 'supplier-codex@example.test',
      chatgpt_account_id: 'acct-supplier',
    }),
  })
  assert.equal(imported.status, 200, JSON.stringify(imported.raw))
  assert.equal(JSON.stringify(imported.raw).includes('pxsecret'), false)
  const accountId = imported.data.account.id
  const runtimeId = imported.data.gateway_worker.runtime_account_id
  assert.equal(f.accounts.get(runtimeId).proxy_url, 'socks5://pxuser:pxsecret@127.0.0.1:1080')
  assert.equal(imported.data.gateway_worker.instance_id, 'fixture-gw')

  const edited = await vendor('PATCH', `/api/vendor/accounts/${accountId}`, {
    proxy_endpoint: '127.0.0.1:4555:test:example',
  })
  assert.equal(edited.status, 200, JSON.stringify(edited.raw))
  assert.equal(JSON.stringify(edited.raw).includes('example@'), false)
  const patch = f.calls.filter((c) => c.method === 'PATCH' && c.path.endsWith(`/accounts/${runtimeId}`)).at(-1)
  assert.equal(patch.body.proxy_url, 'http://test:example@127.0.0.1:4555')
})

test('supplier Gateway OAuth completes on the Worker that issued the link', async (t) => {
  // 两个接单实例：显式开启多 Worker
  const f = await startGatewayAccountFixture({ env: { KIN_CODEX_GATEWAY_MULTI_WORKER: '1' } })
  t.after(() => f.stop())
  const decoyCalls = []
  const decoy = http.createServer((req, res) => {
    decoyCalls.push(req.url)
    req.resume()
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { code: 'account_not_found' } }))
  })
  await new Promise((resolve) => decoy.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => decoy.close(resolve)))
  const register = (id, baseUrl, load) =>
    f.request('POST', 'gateway-workers/register', {
      id,
      base_url: baseUrl,
      protocol_version: 1,
      health_state: 'healthy',
      drain_state: 'accepting',
      boot_id: `${id}-boot`,
      active_concurrency: load,
    })
  const instances = (await f.request('GET', 'gateway-workers')).raw.items
  const realUrl = instances.find((item) => item.id === 'fixture-gw').base_url
  await register('fixture-gw', realUrl, 0)
  await register('decoy-gw', `http://127.0.0.1:${decoy.address().port}`, 3)

  const vendor = await vendorSession(f)
  const draft = await vendor('POST', '/api/vendor/account-drafts', {
    platform: 'openai',
    authorization_kind: 'codex_oauth',
    execution_kind: 'gateway_worker',
    proxy_endpoint: '127.0.0.1:4555:test:example',
    group_ids: [f.groups[0]],
  })
  assert.equal(draft.status, 201, JSON.stringify(draft.raw))
  const base = `/api/vendor/account-drafts/${draft.data.draft.id}/oauth`
  const link = await vendor('POST', `${base}/generate-auth-url`, {})
  assert.equal(link.status, 200, JSON.stringify(link.raw))
  // The issuing Worker is now the busier one; completion must still go back to it.
  await register('fixture-gw', realUrl, 5)
  await register('decoy-gw', `http://127.0.0.1:${decoy.address().port}`, 0)
  const forged = await vendor('POST', `${base}/exchange-code`, { session_id: 'unknown-session', callback: f.callback })
  assert.equal(forged.status, 409, JSON.stringify(forged.raw))
  assert.equal(forged.raw.error.code, 'oauth_session_mismatch')
  const completed = await vendor('POST', `${base}/exchange-code`, {
    session_id: link.data.session_id,
    callback: f.callback,
  })
  assert.equal(completed.status, 200, JSON.stringify(completed.raw))
  assert.equal(decoyCalls.includes('/internal/v1/oauth/complete'), false)
  assert.ok(f.calls.some((c) => c.path === '/internal/v1/oauth/complete'))
  assert.equal(f.accounts.get(`gwacct_${draft.data.draft.id}`).proxy_url, 'http://test:example@127.0.0.1:4555')
})
