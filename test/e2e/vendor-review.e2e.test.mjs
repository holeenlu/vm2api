import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { startGateway } from '../harness.mjs'
import { requestVendorAccount } from './vendor-account-test-helper.mjs'
async function rawRequest(gw, method, path, cookie = '', body) {
  const r = await fetch(gw.baseUrl + path, {
    method,
    headers: { cookie, 'content-type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body),
  })
  return { status: r.status, json: await r.json(), cookie: r.headers.get('set-cookie') || '' }
}
async function request(gw, method, path, cookie = '', body) {
  if (method === 'POST' && path === '/api/vendor/accounts')
    return requestVendorAccount(gw, cookie, body || {}, rawRequest)
  return rawRequest(gw, method, path, cookie, body)
}
const login = (gw, username, password) => request(gw, 'POST', '/api/panel/login', '', { username, password })
async function fixture() {
  const gw = await startGateway()
  const sa = await login(gw, 'admin', 'testpass')
  const root = await request(gw, 'POST', '/api/admin/vendors', sa.cookie, {
    name: 'Parent',
    username: 'review-parent',
    password: 'test-password',
    email: 'parent@test',
    external_code: 'parent',
    create_child: true,
    child_limit: 1,
    platforms: ['anthropic'],
    groups: ['1'],
  })
  assert.equal(root.status, 201, JSON.stringify(root.json))
  const vendor = await login(gw, 'review-parent', 'test-password')
  return {
    gw,
    sa,
    root: root.json.data,
    vendor,
    stop: async () => {
      await gw.stop()
      fs.rmSync(gw.project, { recursive: true, force: true })
    },
  }
}
test('S11 HTTP child identity isolation, concurrent idempotency and downstream payment permission', async () => {
  const { gw, sa, root, vendor, stop } = await fixture()
  try {
    const target = await request(gw, 'POST', '/api/panel/users', sa.cookie, {
      username: 'unrelated-user',
      password: 'test-password',
      role: 'user',
    })
    const body = {
      name: 'Child',
      email: 'child@test',
      external_code: 'child',
      username: 'review-child',
      password: 'test-password',
      idempotency_key: 'child-once',
      groups: [],
      platforms: [],
    }
    const stolen = await request(gw, 'POST', '/api/vendor/vendors', vendor.cookie, {
      ...body,
      user_id: target.json.data.item.id,
    })
    assert.equal(stolen.status, 403, JSON.stringify(stolen.json))
    const [a, b] = await Promise.all([
      request(gw, 'POST', '/api/vendor/vendors', vendor.cookie, body),
      request(gw, 'POST', '/api/vendor/vendors', vendor.cookie, body),
    ])
    assert.equal(a.status, 201, JSON.stringify(a.json))
    assert.equal(b.status, 201, JSON.stringify(b.json))
    assert.equal(a.json.data.id, b.json.data.id)
    const childId = a.json.data.id
    assert.deepEqual(a.json.data.platforms, ['anthropic'])
    const child = await login(gw, 'review-child', 'test-password')
    const bad = await request(gw, 'POST', '/api/vendor/accounts', child.cookie, { name: 'wrong', platform: 'openai' })
    assert.equal(bad.status, 409)
    const childAccount = await request(gw, 'POST', '/api/vendor/accounts', child.cookie, {
      name: 'fact-account',
      platform: 'anthropic',
      idempotency_key: 'fact-account-once',
    })
    assert.equal(childAccount.status, 201, JSON.stringify(childAccount.json))
    const db = createDatabase({ dataDir: `${gw.project}/data` })
    db.prepare(
      'INSERT INTO vendor_usage_facts (id,vendor_id,resource_id,model,input_tokens,output_tokens,cost_usd,occurred_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    ).run(
      'paid-fact',
      childId,
      childAccount.json.data.account.id,
      'model',
      100,
      20,
      10,
      '2026-10-01T00:00:00.000Z',
      new Date().toISOString(),
    )
    db.close()
    const period = {
      vendor_ids: [childId],
      start_date: '2026-10-01',
      end_date: '2026-10-02',
    }
    const pricing = await request(gw, 'POST', '/api/admin/vendors/pricing', sa.cookie, {
      idempotency_key: 'review-global-pricing',
      effective_date: '2026-10-01',
      openai_price: 2,
      claude_price: 2,
      exchange_rate: 5,
    })
    assert.equal(pricing.status, 201, JSON.stringify(pricing.json))
    const preview = await request(gw, 'POST', '/api/vendor/settlements/preview', vendor.cookie, period)
    assert.equal(preview.status, 200, JSON.stringify(preview.json))
    const statement = await request(gw, 'POST', '/api/vendor/settlements', vendor.cookie, {
      idempotency_key: 'new-bill-once',
      preview_token: preview.json.data.items[0].preview_token,
    })
    assert.equal(statement.status, 201, JSON.stringify(statement.json))
    const sid = statement.json.data.id
    assert.equal((await request(gw, 'POST', `/api/vendor/settlements/${sid}/confirm`, vendor.cookie, {})).status, 403)
    assert.equal(
      (await request(gw, 'PATCH', `/api/admin/vendors/${root.id}`, sa.cookie, { settlement_pay: true })).status,
      200,
    )
    assert.equal((await request(gw, 'POST', `/api/vendor/settlements/${sid}/confirm`, vendor.cookie, {})).status, 200)
    assert.equal((await request(gw, 'POST', `/api/vendor/settlements/${sid}/confirm`, child.cookie, {})).status, 403)
    const payment = {
      amount_usdt: statement.json.data.amount_usdt,
      reason: 'test-receipt',
      idempotency_key: 'pay-once',
    }
    const [p1, p2] = await Promise.all([
      request(gw, 'POST', `/api/vendor/settlements/${sid}/payments`, vendor.cookie, payment),
      request(gw, 'POST', `/api/vendor/settlements/${sid}/payments`, vendor.cookie, payment),
    ])
    assert.equal(p1.status, 200, JSON.stringify(p1.json))
    assert.equal(p2.status, 200, JSON.stringify(p2.json))
    const billing = await request(gw, 'GET', '/api/vendor/billing', child.cookie)
    assert.equal(billing.json.data.upstream[0].status, 'paid')
    assert.equal(billing.json.data.upstream[0].payments.length, 1)
  } finally {
    await stop()
  }
})
test('S12 HTTP retries cannot rebind accounts, invalid patches do not change pool and archived VM access is denied', async () => {
  const { gw, sa, vendor, stop } = await fixture()
  try {
    const p1 = await request(gw, 'POST', '/api/vendor/proxies', vendor.cookie, {
      name: 'one',
      config: { endpoint: 'socks5://127.0.0.1:19101' },
    })
    const p2 = await request(gw, 'POST', '/api/vendor/proxies', vendor.cookie, {
      name: 'two',
      config: { endpoint: 'socks5://127.0.0.1:19102' },
    })
    const body = { name: 'account', platform: 'anthropic', proxy_id: p1.json.data.id, idempotency_key: 'account-once' }
    const pair = await request(gw, 'POST', '/api/vendor/accounts', vendor.cookie, body)
    assert.equal(pair.status, 201, JSON.stringify(pair.json))
    const account = pair.json.data.account
    const vmId = pair.json.data.vm.config.runtime_vm_id
    const retry = await request(gw, 'POST', '/api/vendor/accounts', vendor.cookie, {
      ...body,
      proxy_id: p2.json.data.id,
    })
    assert.equal(retry.status, 200)
    assert.equal(retry.json.data.reused, true)
    let vm = JSON.parse(fs.readFileSync(`${gw.project}/vms/${vmId}.json`, 'utf8'))
    assert.equal(vm.proxy.id, p1.json.data.config.pool_proxy_id)
    const invalid = await request(gw, 'PATCH', `/api/vendor/proxies/${p1.json.data.id}`, vendor.cookie, {
      status: 'invalid',
    })
    assert.equal(invalid.status, 400)
    const pool = await request(gw, 'GET', '/api/panel/proxies', sa.cookie)
    assert.equal(pool.json.data.proxies.find((p) => p.id === p1.json.data.config.pool_proxy_id).enabled, true)
    assert.equal(
      (await request(gw, 'POST', `/api/panel/vms/${vmId}/shell-ticket`, vendor.cookie, { login: false })).status,
      403,
    )
    vm.schedule_off = true
    vm.schedule_off_reason = 'operator'
    fs.writeFileSync(`${gw.project}/vms/${vmId}.json`, JSON.stringify(vm))
    assert.equal(
      (await request(gw, 'PATCH', `/api/vendor/accounts/${account.id}`, vendor.cookie, { status: 'paused' })).status,
      200,
    )
    assert.equal(
      (await request(gw, 'PATCH', `/api/vendor/accounts/${account.id}`, vendor.cookie, { status: 'active' })).status,
      200,
    )
    vm = JSON.parse(fs.readFileSync(`${gw.project}/vms/${vmId}.json`, 'utf8'))
    assert.equal(vm.schedule_off_reason, 'operator')
    assert.equal(vm.schedulable, false)
    assert.equal((await request(gw, 'DELETE', `/api/vendor/accounts/${account.id}`, vendor.cookie)).status, 200)
    assert.equal((await request(gw, 'GET', '/api/vendor/vms', vendor.cookie)).json.data.length, 0)
    assert.equal((await request(gw, 'POST', `/api/panel/vms/${vmId}/start`, vendor.cookie, {})).status, 403)
    assert.equal(
      (await request(gw, 'POST', `/api/panel/vms/${vmId}/shell-ticket`, vendor.cookie, { login: true })).status,
      403,
    )
    assert.equal((await request(gw, 'POST', '/api/vendor/accounts', vendor.cookie, body)).status, 409)
  } finally {
    await stop()
  }
})
