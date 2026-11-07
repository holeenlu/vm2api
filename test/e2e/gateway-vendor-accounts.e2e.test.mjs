import test from 'node:test'
import assert from 'node:assert/strict'
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
  // 供应商 Gateway 账号与运营端共用 gw-NN 编号
  assert.match(accountId, /^gw-\d{2,}$/)
  assert.equal(runtimeId, `gwacct_${accountId}`)
  assert.equal(f.facts(accountId).proxy_url, 'socks5h://pxuser:pxsecret@127.0.0.1:1080')
  assert.equal(f.facts(accountId).native_revision, 1)

  const edited = await vendor('PATCH', `/api/vendor/accounts/${accountId}`, {
    proxy_endpoint: '127.0.0.1:4555:test:example',
  })
  assert.equal(edited.status, 200, JSON.stringify(edited.raw))
  assert.equal(JSON.stringify(edited.raw).includes('example@'), false)
  assert.equal(f.facts(accountId).proxy_url, 'socks5h://test:example@127.0.0.1:4555')

  // 供应商备注、暂停与归档走运营端同一更新路径：备注单独保存，归档停用并清空分组
  const noted = await vendor('PATCH', `/api/vendor/accounts/${accountId}`, { notes: 'supplier note', status: 'paused' })
  assert.equal(noted.status, 200, JSON.stringify(noted.raw))
  assert.equal(noted.data.status, 'paused')
  assert.equal(noted.data.config.vendor_notes, 'supplier note')
  assert.equal(f.facts(accountId).status, 'paused')
  // 供应商的恢复与暂停动作同样只改账号状态（Worker 直读生效），不调用 Worker
  const resumed = await vendor('POST', `/api/vendor/accounts/${accountId}/resume`)
  assert.equal(resumed.status, 200, JSON.stringify(resumed.raw))
  assert.equal(resumed.data.account.status, 'active')
  assert.equal(f.facts(accountId).status, 'active')
  const paused = await vendor('POST', `/api/vendor/accounts/${accountId}/pause`)
  assert.equal(paused.status, 200, JSON.stringify(paused.raw))
  assert.equal(f.facts(accountId).status, 'paused')
  assert.equal(
    f.calls.some((c) => /\/(pause|resume)$/.test(c.path)),
    false,
  )
  const archived = await vendor('DELETE', `/api/vendor/accounts/${accountId}`)
  assert.equal(archived.status, 200, JSON.stringify(archived.raw))
  assert.equal(archived.data.status, 'archived')
  assert.deepEqual([f.facts(accountId).status, f.facts(accountId).groups], ['archived', []])
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

  // 运营端与供应商的账号池都列出该账号，名称与邮箱为授权邮箱；Worker 心跳确认读到事实后凭据状态为有效
  await f.beat()
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

  // 供应商用账号文件重新授权：凭据写进凭据库（代次前进），结果不含 Worker 运行视图
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
  assert.equal(f.facts(accountId).native_revision, 2)
  assert.equal(f.facts(accountId).runtime_account_id, runtimeId)

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
