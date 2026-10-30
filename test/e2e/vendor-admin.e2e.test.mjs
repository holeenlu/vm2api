import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { startGateway } from '../harness.mjs'
import { requestVendorAccount } from './vendor-account-test-helper.mjs'
async function rawRequest(gw, method, path, cookie = '', body) {
  const res = await fetch(gw.baseUrl + path, {
    method,
    headers: { cookie, 'content-type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body),
  })
  return { status: res.status, json: await res.json(), cookie: res.headers.get('set-cookie') || '' }
}
async function request(gw, method, path, cookie = '', body) {
  if (method === 'POST' && path === '/api/vendor/accounts') return requestVendorAccount(gw, cookie, body || {}, rawRequest)
  return rawRequest(gw, method, path, cookie, body)
}
const login = (gw, username, password) => request(gw, 'POST', '/api/panel/login', '', { username, password })
test('super-admin supplier platform creates linked login and shares resources, policy and statements with portal', async () => {
  const gw = await startGateway()
  try {
    const sa = await login(gw, 'admin', 'testpass')
    const created = await request(gw, 'POST', '/api/admin/vendors', sa.cookie, {
      name: 'Business supplier',
      username: '123.supplier+admin@long-example-domain.test',
      password: 'test-password',
      email: 'business@test',
      external_code: 'business',
      platforms: ['anthropic'],
      contact_name: 'Finance',
    })
    assert.equal(created.status, 201, JSON.stringify(created.json))
    const id = created.json.data.id
    const vendor = await login(gw, '123.supplier+admin@long-example-domain.test', 'test-password')
    assert.equal(vendor.status, 200)
    const me = await request(gw, 'GET', '/api/vendor/me', vendor.cookie)
    assert.equal(me.json.data.vendor.id, id)
    const list = await request(gw, 'GET', '/api/admin/vendors', sa.cookie)
    assert.equal(list.json.data[0].members[0].username, '123.supplier+admin@long-example-domain.test')
    const proxy = await request(gw, 'POST', `/api/admin/vendors/proxies?vendor_id=${id}`, sa.cookie, {
      name: 'Shared proxy',
      config: { endpoint: 'socks5://private:secret@127.0.0.1:19080' },
    })
    assert.equal(proxy.status, 201, JSON.stringify(proxy.json))
    assert.ok(!JSON.stringify(proxy.json).includes('secret'))
    const conflicting = await request(gw, 'POST', '/api/admin/vendors', sa.cookie, {
      name: 'Other supplier',
      username: 'other-supplier',
      password: 'test-password',
      email: 'other@test',
      external_code: 'other',
    })
    assert.equal(conflicting.status, 201)
    const rejectedProxy = await request(
      gw,
      'POST',
      `/api/admin/vendors/proxies?vendor_id=${conflicting.json.data.id}`,
      sa.cookie,
      { name: 'Conflicting proxy', config: { endpoint: 'socks5://private:secret@127.0.0.1:19080' } },
    )
    assert.equal(rejectedProxy.status, 409)
    assert.deepEqual(
      (await request(gw, 'GET', `/api/admin/vendors/proxies?vendor_id=${conflicting.json.data.id}`, sa.cookie)).json
        .data,
      [],
    )
    const proxies = await request(gw, 'GET', '/api/vendor/proxies', vendor.cookie)
    assert.equal(proxies.json.data[0].id, proxy.json.data.id)
    const pair = await request(gw, 'POST', '/api/vendor/accounts', vendor.cookie, {
      name: 'Shared account',
      platform: 'anthropic',
    })
    assert.equal(pair.status, 201, JSON.stringify(pair.json))
    const account = pair.json.data.account
    const accounts = await request(gw, 'GET', `/api/admin/vendors/accounts?vendor_id=${id}`, sa.cookie)
    assert.equal(accounts.json.data[0].id, account.id)
    assert.equal(
      (await request(gw, 'PATCH', `/api/admin/vendors/accounts/${account.id}`, sa.cookie, { status: 'paused' })).status,
      200,
    )
    assert.equal((await request(gw, 'GET', '/api/vendor/accounts', vendor.cookie)).json.data[0].status, 'paused')
    const pricing = await request(gw, 'POST', '/api/admin/vendors/pricing', sa.cookie, {
      idempotency_key: 'admin-e2e-pricing',
      effective_date: '2026-10-01',
      openai_price: 2,
      claude_price: 2,
      exchange_rate: 5,
    })
    assert.equal(pricing.status, 201, JSON.stringify(pricing.json))
    assert.equal((await request(gw, 'GET', '/api/vendor/billing', vendor.cookie)).json.data.profile, undefined)
    const period = { vendor_id: id, start_date: '2026-10-01', end_date: '2026-10-02' }
    const preview = await request(gw, 'POST', '/api/admin/vendors/settlements/preview', sa.cookie, period)
    assert.equal(preview.status, 200, JSON.stringify(preview.json))
    const statement = await request(gw, 'POST', '/api/admin/vendors/settlements', sa.cookie, period)
    assert.equal(statement.status, 201, JSON.stringify(statement.json))
    assert.equal(
      (await request(gw, 'GET', '/api/vendor/billing', vendor.cookie)).json.data.upstream[0].id,
      statement.json.data.id,
    )
    const disabled = await request(gw, 'PATCH', `/api/admin/vendors/${id}`, sa.cookie, { status: 'disabled' })
    assert.equal(disabled.status, 200, JSON.stringify(disabled.json))
    const vmId = pair.json.data.vm.config.runtime_vm_id
    const vm = JSON.parse(fs.readFileSync(`${gw.project}/vms/${vmId}.json`, 'utf8'))
    assert.equal(vm.vendor_disabled, true)
    assert.equal(vm.schedulable, false)
    assert.equal((await request(gw, 'PATCH', `/api/admin/vendors/${id}`, sa.cookie, { status: 'active' })).status, 200)
    const restored = JSON.parse(fs.readFileSync(`${gw.project}/vms/${vmId}.json`, 'utf8'))
    assert.equal(restored.vendor_disabled, false)
    assert.equal(restored.schedulable, false, 'resuming vendor must preserve paused/unauthed account gate')
    const admin = await request(gw, 'POST', '/api/panel/users', sa.cookie, {
      username: 'ordinary-admin',
      password: 'test-password',
      role: 'admin',
    })
    assert.equal(admin.status, 201)
    const operator = await login(gw, 'ordinary-admin', 'test-password')
    for (const cookie of [vendor.cookie, operator.cookie])
      for (const endpoint of ['', '/accounts', '/proxies', '/usage', '/settlements']) {
        assert.equal((await request(gw, 'GET', '/api/admin/vendors' + endpoint, cookie)).status, 403)
      }
    const panelMe = await request(gw, 'GET', '/api/panel/me', sa.cookie)
    assert.ok(panelMe.json.data.views.includes('suppliers'))
    assert.ok(!(await request(gw, 'GET', '/api/panel/me', operator.cookie)).json.data.views.includes('suppliers'))
    const bad = await request(gw, 'POST', '/api/admin/vendors', sa.cookie, {
      name: 'Bad',
      username: 'rollback-vendor',
      password: 'test-password',
      email: 'bad@test',
      external_code: 'bad',
      default_multiplier: -1,
    })
    assert.equal(bad.status, 400, JSON.stringify(bad.json))
    assert.notEqual((await login(gw, 'rollback-vendor', 'test-password')).status, 200)
  } finally {
    await gw.stop()
    fs.rmSync(gw.project, { recursive: true, force: true })
  }
})

test('supplier creation needs only login identity and uses the shared pricing settings', async () => {
  const gw = await startGateway()
  try {
    const sa = await login(gw, 'admin', 'testpass')
    const created = await request(gw, 'POST', '/api/admin/vendors', sa.cookie, {
      username: 'minimal-supplier',
      password: 'test-password',
      remark: '仅工作日联系',
      platforms: ['anthropic', 'openai'],
    })
    assert.equal(created.status, 201, JSON.stringify(created.json))
    const vendor = created.json.data
    assert.equal(vendor.name, 'minimal-supplier')
    assert.equal(vendor.external_code, undefined)
    assert.equal(vendor.email, undefined)
    assert.equal(vendor.contact_name, undefined)
    assert.equal(vendor.settlement_email, undefined)
    assert.equal(vendor.remark, '仅工作日联系')
    const detail = await request(gw, 'GET', `/api/admin/vendors/${vendor.id}`, sa.cookie)
    assert.equal(detail.json.data.remark, '仅工作日联系')
    assert.equal(vendor.group_prices, undefined)
    const session = await login(gw, 'minimal-supplier', 'test-password')
    assert.equal(session.status, 200)
    const vendorMe = await request(gw, 'GET', '/api/vendor/me', session.cookie)
    assert.equal(vendorMe.json.data.vendor.remark, undefined)
    const edit = await request(gw, 'PATCH', `/api/admin/vendors/${vendor.id}`, sa.cookie, {
      remark: '周五结算',
    })
    assert.equal(edit.status, 200, JSON.stringify(edit.json))
    assert.equal(edit.json.data.remark, '周五结算')
    const listed = await request(gw, 'GET', '/api/admin/vendors', sa.cookie)
    assert.equal(listed.json.data.find((v) => v.id === vendor.id).remark, '周五结算')
    assert.equal(edit.json.data.name, vendor.name)
    const billing = await request(gw, 'GET', '/api/vendor/billing', session.cookie)
    assert.equal(billing.json.data.profile, undefined)
    const pricing = await request(gw, 'POST', '/api/admin/vendors/pricing', sa.cookie, {
      idempotency_key: 'minimal-global-pricing',
      effective_date: '2026-10-01',
      openai_price: 2.5,
      claude_price: 1.9,
      exchange_rate: 6.7,
    })
    assert.equal(pricing.status, 201, JSON.stringify(pricing.json))
    const rejected = await request(gw, 'POST', '/api/admin/vendors', sa.cookie, {
      username: 'invalid-price-supplier',
      password: 'test-password',
      exchange_rate: 0,
    })
    assert.equal(rejected.status, 400)
    assert.notEqual((await login(gw, 'invalid-price-supplier', 'test-password')).status, 200)
  } finally {
    await gw.stop()
    fs.rmSync(gw.project, { recursive: true, force: true })
  }
})
test('super-admin supplier proxy workbench keeps the vendor resource and shared pool synchronized', async () => {
  const gw = await startGateway()
  try {
    const sa = await login(gw, 'admin', 'testpass')
    const created = await request(gw, 'POST', '/api/admin/vendors', sa.cookie, {
      username: 'proxy-workbench-supplier',
      password: 'test-password',
      platforms: ['anthropic', 'openai'],
    })
    assert.equal(created.status, 201, JSON.stringify(created.json))
    const vendorId = created.json.data.id
    const proxy = await request(gw, 'POST', `/api/admin/vendors/proxies?vendor_id=${vendorId}`, sa.cookie, {
      name: 'Operations exit',
      config: { endpoint: 'socks5://proxy-user:proxy-secret@127.0.0.1:19999' },
    })
    assert.equal(proxy.status, 201, JSON.stringify(proxy.json))
    assert.equal(JSON.stringify(proxy.json).includes('proxy-secret'), false)

    let listed = await request(gw, 'GET', `/api/admin/vendors/proxies?vendor_id=${vendorId}`, sa.cookie)
    let row = listed.json.data[0]
    assert.equal(row.config.protocol, 'socks5')
    assert.equal(row.config.has_auth, true)
    assert.ok(row.config.pool_id)
    assert.equal(row.config.pool_enabled, true)

    const invalid = await request(gw, 'PATCH', `/api/admin/vendors/proxies/${row.id}`, sa.cookie, {
      status: 'invalid',
    })
    assert.equal(invalid.status, 400, JSON.stringify(invalid.json))
    listed = await request(gw, 'GET', `/api/admin/vendors/proxies?vendor_id=${vendorId}`, sa.cookie)
    assert.equal(listed.json.data[0].config.pool_enabled, true)

    const edited = await request(gw, 'PATCH', `/api/admin/vendors/proxies/${row.id}`, sa.cookie, {
      name: 'Operations exit updated',
      endpoint: 'http://new-user:new-secret@127.0.0.1:19998',
    })
    assert.equal(edited.status, 200, JSON.stringify(edited.json))
    assert.equal(JSON.stringify(edited.json).includes('new-secret'), false)
    listed = await request(gw, 'GET', `/api/admin/vendors/proxies?vendor_id=${vendorId}`, sa.cookie)
    row = listed.json.data[0]
    assert.equal(row.name, 'Operations exit updated')
    assert.equal(row.config.protocol, 'http')
    assert.equal(row.config.has_auth, true)

    const supplier = await login(gw, 'proxy-workbench-supplier', 'test-password')
    const pair = await request(gw, 'POST', '/api/vendor/accounts', supplier.cookie, {
      name: 'proxy-bound-account',
      platform: 'anthropic',
      proxy_id: row.id,
      idempotency_key: 'proxy-bound-account-once',
    })
    assert.equal(pair.status, 201, JSON.stringify(pair.json))
    assert.equal((await request(gw, 'POST', `/api/admin/vendors/proxies/${row.id}/archive`, sa.cookie, {})).status, 409)
    assert.equal(
      (await request(gw, 'DELETE', `/api/vendor/accounts/${pair.json.data.account.id}`, supplier.cookie)).status,
      200,
    )

    assert.equal((await request(gw, 'POST', `/api/admin/vendors/proxies/${row.id}/disable`, sa.cookie, {})).status, 200)
    listed = await request(gw, 'GET', `/api/admin/vendors/proxies?vendor_id=${vendorId}`, sa.cookie)
    assert.equal(listed.json.data[0].config.pool_enabled, false)
    assert.equal(listed.json.data[0].status, 'paused')
    assert.equal((await request(gw, 'POST', `/api/admin/vendors/proxies/${row.id}/enable`, sa.cookie, {})).status, 200)
    assert.equal((await request(gw, 'POST', `/api/admin/vendors/proxies/${row.id}/archive`, sa.cookie, {})).status, 200)
    assert.deepEqual(
      (await request(gw, 'GET', `/api/admin/vendors/proxies?vendor_id=${vendorId}`, sa.cookie)).json.data,
      [],
    )
  } finally {
    await gw.stop()
    fs.rmSync(gw.project, { recursive: true, force: true })
  }
})
