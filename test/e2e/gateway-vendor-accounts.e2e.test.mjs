import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { startGatewayAccountFixture } from '../helpers/gateway-account-fixture.mjs'

async function vendorSession(f, username = 'gateway-supplier') {
  const created = await f.request('POST', 'users', {
    username,
    password: 'supplier-test-123',
    role: 'vendor',
    groups: [{ group_id: f.groups[0] }],
  })
  assert.equal(created.status, 201, JSON.stringify(created.raw))
  const login = await fetch(f.baseUrl + '/api/panel/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'supplier-test-123' }),
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
  vendor.vendorId = me.data.vendor.id
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

test('supplier Gateway accounts appear in both account pools like VM rows and can be reauthorized', async (t) => {
  const f = await startGatewayAccountFixture()
  t.after(() => f.stop())
  const vendor = await vendorSession(f)
  const proxy = await vendor('POST', '/api/vendor/proxies', {
    name: 'Supplier exit',
    config: { endpoint: 'socks5://pxuser:pxsecret@127.0.0.1:1080' },
  })
  // 名称留空：授权后使用授权邮箱
  const draft = await vendor('POST', '/api/vendor/account-drafts', {
    platform: 'openai',
    authorization_kind: 'codex_account_file',
    execution_kind: 'gateway_worker',
    group_ids: [f.groups[0]],
    proxy_id: proxy.data.id,
  })
  assert.equal(draft.status, 201, JSON.stringify(draft.raw))
  const credential = {
    type: 'codex',
    mode: 'json',
    auth_json: JSON.stringify({
      access_token: 'at-test',
      refresh_token: 'rt-test',
      email: 'pool-codex@example.test',
      chatgpt_account_id: 'acct-pool',
    }),
  }
  const imported = await vendor('POST', `/api/vendor/account-drafts/${draft.data.draft.id}/import`, credential)
  assert.equal(imported.status, 200, JSON.stringify(imported.raw))
  const accountId = imported.data.account.id
  const runtimeId = imported.data.gateway_worker.runtime_account_id
  const admin = async (method, pathname, body) => {
    const res = await fetch(f.baseUrl + pathname, {
      method,
      headers: { cookie: f.cookie, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    const json = await res.json()
    return { status: res.status, data: json.data || json, raw: json }
  }

  // 运营端与供应商的账号池都列出该账号，名称与邮箱为授权邮箱，Gateway 运行事实已投影
  const adminPool = await admin('GET', '/api/admin/vendors/accounts?archived=all&vendor_id=all')
  const vendorPool = await vendor('GET', '/api/vendor/accounts')
  for (const pool of [adminPool, vendorPool]) {
    assert.equal(pool.status, 200, JSON.stringify(pool.raw))
    const row = pool.data.find((item) => item.id === accountId)
    assert.ok(row, 'Gateway account missing from the account pool')
    assert.equal(row.name, 'pool-codex@example.test')
    assert.equal(row.telemetry.email, 'pool-codex@example.test')
    assert.equal(row.telemetry.execution_kind, 'gateway_worker')
    assert.equal(row.telemetry.vm_id, null)
    assert.equal(row.telemetry.credential_state, 'valid')
    assert.equal(JSON.stringify(row).includes('pxsecret'), false)
  }

  // 详情与虚拟机账号同形状，分组编辑按 Gateway 资源版本校验
  const detail = await vendor('GET', `/api/vendor/accounts/${accountId}`)
  assert.equal(detail.status, 200, JSON.stringify(detail.raw))
  assert.equal(typeof detail.data.owner.name, 'string')
  assert.deepEqual(detail.data.cooldowns, [])
  assert.equal(detail.data.model_limits, null)
  const regrouped = await vendor('PATCH', `/api/vendor/accounts/${accountId}`, {
    group_ids: [f.groups[0]],
    expected_group_version: detail.data.group_version,
  })
  assert.equal(regrouped.status, 200, JSON.stringify(regrouped.raw))
  const autoProxy = await vendor('PATCH', `/api/vendor/accounts/${accountId}`, { proxy_source: 'auto' })
  assert.equal(autoProxy.status, 400, JSON.stringify(autoProxy.raw))
  assert.equal(autoProxy.raw.error.code, 'proxy_source_unsupported')

  // 供应商用账号文件重新授权：凭据推到原运行账号，结果不含 Worker 运行视图
  const reDraft = await vendor('POST', `/api/vendor/accounts/${accountId}/gateway-drafts`, {
    idempotency_key: 'reauth-1',
    authorization_kind: 'codex_account_file',
  })
  assert.equal(reDraft.status, 201, JSON.stringify(reDraft.raw))
  const reauthorized = await vendor(
    'POST',
    `/api/vendor/accounts/${accountId}/gateway-drafts/${reDraft.data.draft.id}/import`,
    credential,
  )
  assert.equal(reauthorized.status, 200, JSON.stringify(reauthorized.raw))
  assert.equal(reauthorized.data.account.id, accountId)
  assert.equal(JSON.stringify(reauthorized.raw).includes('runtime_account_id'), false)
  assert.ok(f.calls.some((c) => c.method === 'POST' && c.path === `/internal/v1/accounts/${runtimeId}/reauthorize`))

  // 其他供应商不能为该账号创建草稿，也不能使用别人的草稿
  const other = await vendorSession(f, 'gateway-supplier-b')
  const foreign = await other('POST', `/api/vendor/accounts/${accountId}/gateway-drafts`, { idempotency_key: 'x' })
  assert.ok([403, 404].includes(foreign.status), JSON.stringify(foreign.raw))
  const stolen = await other(
    'POST',
    `/api/vendor/accounts/${accountId}/gateway-drafts/${reDraft.data.draft.id}/import`,
    credential,
  )
  assert.equal(stolen.status, 404, JSON.stringify(stolen.raw))

  // 运营端账号池以超管身份使用同一流程
  const adminDraft = await admin('POST', `/api/admin/vendors/accounts/${accountId}/gateway-drafts`, {
    idempotency_key: 'reauth-admin',
  })
  assert.equal(adminDraft.status, 201, JSON.stringify(adminDraft.raw))

  // 关闭运行控制策略后供应商不能重新授权
  const closed = await f.request('PUT', `gateway-execution-policies?vendor_id=${vendor.vendorId}`, {
    platform: 'openai',
    execution_kind: 'gateway_worker',
    allow_create: true,
    allow_runtime: false,
  })
  assert.equal(closed.status, 200, JSON.stringify(closed.raw))
  const denied = await vendor('POST', `/api/vendor/accounts/${accountId}/gateway-drafts`, {
    idempotency_key: 'reauth-2',
  })
  assert.equal(denied.status, 403, JSON.stringify(denied.raw))
})
