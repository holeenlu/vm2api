import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { startGateway } from '../harness.mjs'

async function login(gw, username, password) {
  const res = await fetch(`${gw.baseUrl}/api/panel/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  return { status: res.status, json: await res.json(), cookie: res.headers.get('set-cookie') || '' }
}

async function request(gw, method, path, cookie, body) {
  const res = await fetch(gw.baseUrl + path, {
    method,
    headers: { cookie, 'content-type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body),
  })
  return { status: res.status, json: await res.json() }
}

test('supplier portal creates account and VM together, and capability hides child menu', async () => {
  const gw = await startGateway()
  try {
    const sa = await login(gw, 'admin', 'testpass')
    assert.equal(sa.status, 200)
    const emptyProviders = await request(gw, 'GET', '/api/panel/providers', sa.cookie)
    assert.equal(emptyProviders.status, 200)
    assert.deepEqual(emptyProviders.json.data.items, [], 'platform VM must not be listed')
    assert.equal(emptyProviders.json.data.totals.total_cost, 0)
    const group = await request(gw, 'POST', '/api/panel/groups', sa.cookie, {
      name: 'supplier-coding',
      platform: 'anthropic',
    })
    assert.equal(group.status, 201, JSON.stringify(group.json))
    const groupId = group.json.data.item.id
    const user = await request(gw, 'POST', '/api/panel/users', sa.cookie, {
      username: 'vendor-one',
      password: 'vendor-pass',
      role: 'user',
    })
    assert.equal(user.status, 201)
    const vendor = await request(gw, 'POST', '/api/admin/vendors', sa.cookie, {
      name: '供应商一',
      email: 'vendor-one@local',
      external_code: 'vendor-one',
      groups: [String(groupId)],
      platforms: ['anthropic'],
      account_limit: 4,
      proxy_limit: 2,
      child_limit: 0,
      user_id: user.json.data.item.id,
    })
    assert.equal(vendor.status, 201, JSON.stringify(vendor.json))
    const vendorLogin = await login(gw, 'vendor-one', 'vendor-pass')
    assert.equal(vendorLogin.status, 200)
    assert.equal((await request(gw, 'GET', '/api/panel/providers', vendorLogin.cookie)).status, 403)
    const me = await request(gw, 'GET', '/api/vendor/me', vendorLogin.cookie)
    assert.equal(me.status, 200, JSON.stringify(me.json))
    assert.equal(me.json.data.vendor.views.includes('vendors'), false)
    const directVm = await request(gw, 'POST', '/api/vendor/vms', vendorLogin.cookie, { name: 'illegal direct vm' })
    assert.equal(directVm.status, 409)
    assert.equal(directVm.json.error.code, 'account_creation_required')
    const proxy = await request(gw, 'POST', '/api/vendor/proxies', vendorLogin.cookie, {
      name: '供应商出口 01',
      config: { endpoint: 'socks5://127.0.0.1:1080' },
    })
    assert.equal(proxy.status, 201, JSON.stringify(proxy.json))
    assert.ok(proxy.json.data.config.pool_proxy_id)
    const account = await request(gw, 'POST', '/api/vendor/accounts', vendorLogin.cookie, {
      name: '账号 01',
      platform: 'anthropic',
      auth_method: 'oauth',
      authorization_kind: 'claude_oauth',
      proxy_id: proxy.json.data.id,
      group_ids: [groupId],
      idempotency_key: 'account-1',
    })
    assert.equal(account.status, 201, JSON.stringify(account.json))
    assert.equal(account.json.data.account.resource_type, 'account')
    assert.equal(account.json.data.vm.resource_type, 'vm')
    assert.equal(account.json.data.vm.config.account_resource_id, account.json.data.account.id)
    const runtimeVmId = account.json.data.vm.config.runtime_vm_id
    assert.ok(runtimeVmId)
    const providers = await request(gw, 'GET', '/api/panel/providers', sa.cookie)
    assert.equal(providers.status, 200, JSON.stringify(providers.json))
    assert.equal(providers.json.data.items.length, 1)
    assert.equal(providers.json.data.items[0].id, account.json.data.account.id)
    assert.equal(providers.json.data.items[0].vm_id, runtimeVmId)
    assert.equal(providers.json.data.items[0].vendor_name, 'vendor-one', 'show login name, not vendor entity name')
    assert.equal(providers.json.data.items[0].name, account.json.data.account.name)
    assert.equal(providers.json.data.vendors[0].name, 'vendor-one')
    const runtimeVm = JSON.parse(fs.readFileSync(path.join(gw.project, 'vms', `${runtimeVmId}.json`), 'utf8'))
    assert.equal(runtimeVm.vendor_account_resource_id, account.json.data.account.id)
    assert.equal(account.json.data.runtime_boot.ok, false)
    assert.equal(account.json.data.runtime_boot.code, 'runtime_start_failed')
    assert.equal(runtimeVm.status, 'stopped')
    assert.equal(runtimeVm.proxy.id, proxy.json.data.config.pool_proxy_id)
    const assigned = await request(gw, 'GET', `/api/panel/groups/${groupId}`, sa.cookie)
    assert.equal(assigned.status, 200, JSON.stringify(assigned.json))
    assert.ok(assigned.json.data.item.resources.some((item) => item.resource_id === runtimeVmId))
    const pool = await request(gw, 'GET', '/api/panel/proxies', sa.cookie)
    assert.equal(pool.status, 200, JSON.stringify(pool.json))
    const poolProxy = pool.json.data.proxies.find((item) => item.id === proxy.json.data.config.pool_proxy_id)
    assert.equal(poolProxy.vendor_id, vendor.json.data.id)
    assert.ok(poolProxy.bound_vm_ids.includes(runtimeVmId))
    const vendorPool = await request(gw, 'GET', `/api/panel/proxies?vendor_id=${vendor.json.data.id}`, sa.cookie)
    assert.equal(vendorPool.status, 200, JSON.stringify(vendorPool.json))
    assert.equal(vendorPool.json.data.proxies.length, 1)
    const platformPool = await request(gw, 'GET', '/api/panel/proxies?platform=anthropic', sa.cookie)
    assert.equal(platformPool.status, 200, JSON.stringify(platformPool.json))
    assert.ok(platformPool.json.data.proxies.some((item) => item.id === poolProxy.id))
    const retry = await request(gw, 'POST', '/api/vendor/accounts', vendorLogin.cookie, {
      name: 'changed',
      platform: 'anthropic',
      auth_method: 'oauth',
      idempotency_key: 'account-1',
    })
    assert.equal(retry.status, 201)
    assert.equal(retry.json.data.account.id, account.json.data.account.id)
  } finally {
    await gw.stop()
  }
})

test('supplier UI endpoints enforce zero limit, read scope, method and schedule isolation', async () => {
  const gw = await startGateway()
  try {
    const sa = await login(gw, 'admin', 'testpass')
    const create = await request(gw, 'POST', '/api/panel/users', sa.cookie, {
      username: 'portal-parent',
      password: 'supplier-test-123',
      role: 'vendor',
      vendor_create_child: true,
      vendor_child_limit: 0,
      vendor_contact_name: '供应商联系人',
      vendor_settlement_email: 'settlement@example.test',
      vendor_binance_id: 'binance-test',
      vendor_default_price_cny_per_usd: 1.8,
      vendor_fx_cny_per_usdt: 6.7,
    })
    assert.equal(create.status, 201, JSON.stringify(create.json))
    assert.equal(create.json.data.item.vendor.child_limit, 0)
    assert.equal(create.json.data.item.vendor.settlement_email, 'settlement@example.test')
    const parent = await login(gw, 'portal-parent', 'supplier-test-123')
    const childIds = []
    for (let n = 1; n <= 2; n++) {
      const child = await request(gw, 'POST', '/api/vendor/vendors', parent.cookie, {
        name: 'Child ' + n,
        email: `child${n}@local`,
        external_code: 'child' + n,
        username: 'portal-child' + n,
        password: 'supplier-test-123',
      })
      assert.equal(child.status, 201, JSON.stringify(child.json))
      childIds.push(child.json.data.id)
    }
    const billing = await request(gw, 'GET', '/api/vendor/billing', parent.cookie)
    assert.equal(billing.status, 200, JSON.stringify(billing.json))
    assert.equal(billing.json.data.profile.default_price_cny_per_usd, 1.8)
    const settlement = await request(gw, 'POST', '/api/vendor/settlements', parent.cookie, {
      vendor_id: childIds[0],
      start_date: '2026-10-01',
      end_date: '2026-10-08',
    })
    assert.equal(settlement.status, 201, JSON.stringify(settlement.json))
    const child = await login(gw, 'portal-child1', 'supplier-test-123')
    const pair = await request(gw, 'POST', '/api/vendor/accounts', child.cookie, {
      name: 'Test account',
      platform: 'anthropic',
    })
    assert.equal(pair.status, 201, JSON.stringify(pair.json))
    const accountId = pair.json.data.account.id
    const vmId = pair.json.data.vm.config.runtime_vm_id
    const list = await request(gw, 'GET', '/api/vendor/accounts?vendor_id=all', parent.cookie)
    assert.equal(list.status, 200, JSON.stringify(list.json))
    assert.equal(list.json.data.length, 1)
    assert.equal(list.json.data[0].telemetry.state, 'unauthorized')
    assert.equal((await request(gw, 'GET', '/api/vendor/accounts?vendor_id=all', child.cookie)).status, 403)
    assert.equal((await request(gw, 'GET', '/api/vendor/vendors', child.cookie)).status, 403)
    assert.equal(
      (await request(gw, 'PATCH', '/api/vendor/accounts/' + accountId, parent.cookie, { status: 'paused' })).status,
      403,
    )
    assert.equal((await request(gw, 'GET', `/api/vendor/accounts/${accountId}/pause`, child.cookie)).status, 405)
    assert.equal(
      (await request(gw, 'PATCH', '/api/vendor/accounts/' + accountId, child.cookie, { status: 'paused' })).status,
      200,
    )
    let vm = JSON.parse(fs.readFileSync(path.join(gw.project, 'vms', vmId + '.json'), 'utf8'))
    assert.equal(vm.schedule_off, true)
    assert.equal(
      (await request(gw, 'PATCH', '/api/vendor/accounts/' + accountId, child.cookie, { status: 'active' })).status,
      200,
    )
    vm = JSON.parse(fs.readFileSync(path.join(gw.project, 'vms', vmId + '.json'), 'utf8'))
    assert.equal(vm.unschedulable.reason, 'no_credential')
    assert.equal(vm.schedulable, false)
    const detail = await request(gw, 'GET', '/api/vendor/accounts/' + accountId, child.cookie)
    assert.equal('secret_json' in detail.json.data, false)
  } finally {
    await gw.stop()
  }
})
