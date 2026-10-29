import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { startGateway } from '../harness.mjs'
async function request(gw, method, path, cookie = '', body) {
  const res = await fetch(gw.baseUrl + path, {
    method,
    headers: { cookie, 'content-type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body),
  })
  return { status: res.status, json: await res.json(), cookie: res.headers.get('set-cookie') || '' }
}
const login = (gw, username, password) => request(gw, 'POST', '/api/panel/login', '', { username, password })
test('super-admin supplier platform creates linked login and shares resources, policy and statements with portal', async () => {
  const gw = await startGateway()
  try {
    const sa = await login(gw, 'admin', 'testpass')
    const created = await request(gw, 'POST', '/api/admin/vendors', sa.cookie, {
      name: 'Business supplier',
      username: 'supplier-admin-test',
      password: 'test-password',
      email: 'business@test',
      external_code: 'business',
      platforms: ['anthropic'],
      contact_name: 'Finance',
    })
    assert.equal(created.status, 201, JSON.stringify(created.json))
    const id = created.json.data.id
    const vendor = await login(gw, 'supplier-admin-test', 'test-password')
    assert.equal(vendor.status, 200)
    const me = await request(gw, 'GET', '/api/vendor/me', vendor.cookie)
    assert.equal(me.json.data.vendor.id, id)
    const list = await request(gw, 'GET', '/api/admin/vendors', sa.cookie)
    assert.equal(list.json.data[0].members[0].username, 'supplier-admin-test')
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
    assert.equal(
      (
        await request(gw, 'PATCH', `/api/admin/vendors/${id}`, sa.cookie, {
          contact_name: 'Updated finance',
          default_price_cny_per_usd: 2,
        })
      ).status,
      200,
    )
    assert.equal(
      (await request(gw, 'GET', '/api/vendor/billing', vendor.cookie)).json.data.profile.contact_name,
      'Updated finance',
    )
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
