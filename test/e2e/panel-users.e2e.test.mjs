import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { startGateway, api } from '../harness.mjs'

async function login(gw, username, password) {
  const res = await fetch(gw.baseUrl + '/api/panel/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  const json = await res.json()
  return { status: res.status, json, cookie: res.headers.get('set-cookie') || '' }
}

async function panel(gw, method, path, { cookie, body } = {}) {
  const res = await fetch(gw.baseUrl + path, {
    method,
    headers: {
      'content-type': 'application/json',
      cookie: cookie || '',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = {}
  try {
    json = JSON.parse(text)
  } catch {}
  return { status: res.status, json, text }
}

for (const prefix of ['TAPMODELS', 'KIN']) {
  test(`${prefix} default admin is listed and can rotate its password across restarts`, async () => {
    const env = {
      TAPMODELS_ADMIN_USER: '',
      TAPMODELS_ADMIN_PASSWORD: '',
      [`${prefix}_ADMIN_USER`]: 'admin',
      [`${prefix}_ADMIN_PASSWORD`]: '123456',
    }
    let gw = await startGateway({ env })
    try {
      const list = await api(gw, 'GET', '/api/panel/users')
      assert.equal(list.status, 200, list.text)
      const self = list.json.data.items.find((user) => user.username === 'admin')
      assert.ok(self, JSON.stringify(list.json))
      assert.equal(self.role, 'super_admin')
      assert.equal(self.password_hash, undefined)
      assert.doesNotMatch(gw.stderr(), /bootstrap failed/)

      const admin = await login(gw, 'admin', '123456')
      const otherSession = await login(gw, 'admin', '123456')
      assert.equal(admin.status, 200)
      assert.equal(otherSession.status, 200)
      const before = await panel(gw, 'GET', '/api/panel/onboarding', { cookie: admin.cookie })
      assert.equal(before.status, 200)
      assert.equal(before.json.data.steps.find((step) => step.id === 'admin_password').done, false)

      const shortCreate = await panel(gw, 'POST', '/api/panel/users', {
        cookie: admin.cookie,
        body: { username: 'reader', password: '123456', role: 'user' },
      })
      assert.equal(shortCreate.status, 400)
      assert.equal(shortCreate.json.error.code, 'invalid_password')
      const shortChange = await panel(gw, 'PATCH', `/api/panel/users/${self.id}`, {
        cookie: admin.cookie,
        body: { password: '123456' },
      })
      assert.equal(shortChange.status, 400)
      assert.equal(shortChange.json.error.code, 'invalid_password')

      const changed = await panel(gw, 'PATCH', `/api/panel/users/${self.id}`, {
        cookie: admin.cookie,
        body: { password: 'changed-admin-pass' },
      })
      assert.equal(changed.status, 200, JSON.stringify(changed.json))
      assert.equal((await panel(gw, 'GET', '/api/panel/me', { cookie: admin.cookie })).status, 200)
      assert.equal((await panel(gw, 'GET', '/api/panel/me', { cookie: otherSession.cookie })).status, 401)
      assert.equal((await login(gw, 'admin', '123456')).status, 401)
      assert.equal((await login(gw, 'admin', 'changed-admin-pass')).status, 200)
      const after = await panel(gw, 'GET', '/api/panel/onboarding', { cookie: admin.cookie })
      assert.equal(after.status, 200)
      assert.equal(after.json.data.steps.find((step) => step.id === 'admin_password').done, true)

      const project = gw.project
      await gw.stop()
      gw = await startGateway({ project, env })
      assert.equal((await login(gw, 'admin', '123456')).status, 401)
      const relogin = await login(gw, 'admin', 'changed-admin-pass')
      assert.equal(relogin.status, 200)
      const restarted = await panel(gw, 'GET', '/api/panel/onboarding', { cookie: relogin.cookie })
      assert.equal(restarted.status, 200)
      assert.equal(restarted.json.data.steps.find((step) => step.id === 'admin_password').done, true)
      const users = await panel(gw, 'GET', '/api/panel/users', { cookie: relogin.cookie })
      assert.equal(users.status, 200)
      assert.equal(users.json.data.items.length, 1)
      assert.equal(users.json.data.items[0].id, self.id)
    } finally {
      await gw.stop()
    }
  })
}

test('admin can create users and change passwords', async () => {
  const gw = await startGateway()
  try {
    const admin = await login(gw, 'admin', 'testpass')
    assert.equal(admin.status, 200, JSON.stringify(admin.json))
    assert.equal(admin.json.role, 'super_admin')

    const created = await panel(gw, 'POST', '/api/panel/users', {
      cookie: admin.cookie,
      body: { username: 'reader+email@long-example-domain.test', password: 'reader-pass', role: 'user' },
    })
    assert.equal(created.status, 201, JSON.stringify(created.json))
    const item = created.json.data?.item || created.json.item
    assert.equal(item.username, 'reader+email@long-example-domain.test')
    assert.equal(item.role, 'user')
    const duplicate = await panel(gw, 'POST', '/api/panel/users', {
      cookie: admin.cookie,
      body: { username: item.username.toUpperCase(), password: 'reader-pass', role: 'user' },
    })
    assert.equal(duplicate.status, 409)
    assert.equal(duplicate.json.error.code, 'username_exists')
    assert.equal(item.password_hash, undefined)

    const readerBefore = await login(gw, 'reader+email@long-example-domain.test', 'reader-pass')
    assert.equal(readerBefore.status, 200)

    const changed = await panel(gw, 'PATCH', `/api/panel/users/${item.id}`, {
      cookie: admin.cookie,
      body: { password: 'reader-next' },
    })
    assert.equal(changed.status, 200, JSON.stringify(changed.json))

    const staleSession = await panel(gw, 'GET', '/api/panel/me', { cookie: readerBefore.cookie })
    assert.equal(staleSession.status, 401)
    const oldLogin = await login(gw, 'reader+email@long-example-domain.test', 'reader-pass')
    assert.equal(oldLogin.status, 401)
    const nextLogin = await login(gw, 'reader+email@long-example-domain.test', 'reader-next')
    assert.equal(nextLogin.status, 200)
    assert.equal(nextLogin.json.role, 'user')

    const short = await panel(gw, 'PATCH', `/api/panel/users/${item.id}`, {
      cookie: admin.cookie,
      body: { password: 'short' },
    })
    assert.equal(short.status, 400)
    assert.equal(short.json.error?.code, 'invalid_password')
  } finally {
    await gw.stop()
  }
})

test('deleting a customer invalidates sessions without altering grouped supply', async () => {
  const gw = await startGateway()
  try {
    const created = await api(gw, 'POST', '/api/panel/users', {
      body: { username: 'tenant', password: 'tenant-pass', role: 'user' },
    })
    const uid = created.json.data.item.id
    const session = await login(gw, 'tenant', 'tenant-pass')
    const group = (await api(gw, 'POST', '/api/panel/groups', { body: { name: 'retained', platform: 'anthropic' } }))
      .json.data.item
    assert.equal(
      (
        await api(gw, 'PUT', '/api/panel/vms/vm-sim-01/groups', {
          body: { group_ids: [group.id], expected_version: 0 },
        })
      ).status,
      200,
    )
    assert.equal((await api(gw, 'DELETE', '/api/panel/users/' + uid)).status, 200)
    const listed = await api(gw, 'GET', '/api/panel/vms')
    assert.equal(listed.json.data.items[0].groups[0].id, group.id)
    assert.equal((await panel(gw, 'GET', '/api/panel/me', { cookie: session.cookie })).status, 401)
  } finally {
    await gw.stop()
  }
})

test('admin changing own password keeps the current session', async () => {
  const gw = await startGateway()
  try {
    const admin = await login(gw, 'admin', 'testpass')
    const list = await panel(gw, 'GET', '/api/panel/users', { cookie: admin.cookie })
    const self = (list.json.data?.items || []).find((u) => u.username === 'admin')
    assert.ok(self, JSON.stringify(list.json))

    const changed = await panel(gw, 'PATCH', `/api/panel/users/${self.id}`, {
      cookie: admin.cookie,
      body: { password: 'admin-next-pass' },
    })
    assert.equal(changed.status, 200, JSON.stringify(changed.json))
    const me = await panel(gw, 'GET', '/api/panel/me', { cookie: admin.cookie })
    assert.equal(me.status, 200)
    const relogin = await login(gw, 'admin', 'admin-next-pass')
    assert.equal(relogin.status, 200)
  } finally {
    await gw.stop()
  }
})

test('tenant user cannot list or modify panel users', async () => {
  const gw = await startGateway()
  try {
    const admin = await login(gw, 'admin', 'testpass')
    const created = await panel(gw, 'POST', '/api/panel/users', {
      cookie: admin.cookie,
      body: { username: 'reader', password: 'reader-pass', role: 'user' },
    })
    const readerId = created.json.data?.item?.id
    const user = await login(gw, 'reader', 'reader-pass')
    assert.equal(user.status, 200)

    const users = await panel(gw, 'GET', '/api/panel/users', { cookie: user.cookie })
    assert.equal(users.status, 403)
    const selfPatch = await panel(gw, 'PATCH', `/api/panel/users/${readerId}`, {
      cookie: user.cookie,
      body: { role: 'super_admin', password: 'escalate-pass' },
    })
    assert.equal(selfPatch.status, 403)
    const database = await panel(gw, 'GET', '/api/panel/database/metrics', { cookie: user.cookie })
    assert.equal(database.status, 403)
    const adminVms = await panel(gw, 'GET', '/admin/vms', { cookie: user.cookie })
    assert.equal(adminVms.status, 403)
  } finally {
    await gw.stop()
  }
})

test('proxy DNS URLs remain admin-only in list and config responses', async () => {
  const gw = await startGateway()
  try {
    const admin = await login(gw, 'admin', 'testpass')
    assert.equal(admin.status, 200)
    const primary = 'https://dns.example.com/private/dns-query?token=private-doh-token'
    const updated = await panel(gw, 'PUT', '/api/panel/proxies/config', {
      cookie: admin.cookie,
      body: { dns_primary: primary, disconnect_on_error: true },
    })
    assert.equal(updated.status, 200, updated.text)
    for (const role of ['user', 'admin']) {
      const created = await panel(gw, 'POST', '/api/panel/users', {
        cookie: admin.cookie,
        body: { username: `dns-${role}`, password: 'reader-pass', role },
      })
      assert.equal(created.status, 201, created.text)
      const reader = await login(gw, `dns-${role}`, 'reader-pass')
      assert.equal(reader.status, 200)
      for (const route of ['/api/panel/proxies', '/api/panel/proxies/config']) {
        const response = await panel(gw, 'GET', route, { cookie: reader.cookie })
        assert.equal(response.status, 403, response.text)
        assert.equal(response.text.includes('private-doh-token'), false)
      }
    }
    for (const route of ['/api/panel/proxies', '/api/panel/proxies/config']) {
      const response = await panel(gw, 'GET', route, { cookie: admin.cookie })
      assert.equal(response.status, 200, response.text)
      const data = response.json.data || response.json
      const config = route.endsWith('/config') ? data : data.config
      assert.equal(config.dns_primary, primary)
      assert.equal(config.disconnect_on_error, true)
    }
  } finally {
    await gw.stop()
  }
})

test('AD manages its domain and funds its own users without infrastructure access', async () => {
  const gw = await startGateway()
  try {
    const sa = await login(gw, 'admin', 'testpass')
    const added = await panel(gw, 'POST', '/api/panel/users', {
      cookie: sa.cookie,
      body: { username: 'manager', password: 'manager-pass', role: 'admin' },
    })
    assert.equal(added.status, 201, added.text)
    const ad = await login(gw, 'manager', 'manager-pass')
    assert.equal(ad.json.role, 'admin')
    const user = await panel(gw, 'POST', '/api/panel/users', {
      cookie: ad.cookie,
      body: { username: 'customer', password: 'customer-pass', role: 'user' },
    })
    assert.equal(user.status, 201, user.text)
    const uid = user.json.data.item.id
    const listed = await panel(gw, 'GET', '/api/panel/users', { cookie: ad.cookie })
    assert.ok(listed.json.data.items.every((u) => u.role === 'user'))
    for (const [method, path, body] of [
      ['POST', '/api/panel/vms/create', {}],
      ['POST', '/api/panel/vms/import', {}],
      ['POST', '/api/panel/vms/vm-sim-01/schedulable', { schedulable: false }],
      ['GET', '/api/panel/vms/vm-sim-01'],
      ['GET', '/api/panel/database/metrics'],
      ['POST', '/api/panel/users', { username: 'escalated', password: 'testing-pass', role: 'super_admin' }],
      ['PATCH', '/api/panel/users/' + uid, { role: 'super_admin' }],
      ['PATCH', '/api/panel/users/' + uid, { groups: [1] }],
      ['PATCH', '/api/panel/users/' + added.json.data.item.id, { enabled: false }],
    ])
      assert.equal((await panel(gw, method, path, { cookie: ad.cookie, body })).status, 403, path)
    const insufficient = await panel(gw, 'POST', '/api/panel/users/' + uid + '/balance', {
      cookie: ad.cookie,
      body: { amount: 1, reason: 'managed user transfer', idempotency_key: 'scope-empty-wallet' },
    })
    assert.equal(insufficient.status, 409, insufficient.text)
    assert.equal(insufficient.json.error.code, 'insufficient_balance')
    const db = new DatabaseSync(path.join(gw.project, 'data', 'kin.db'))
    const saId = db.prepare("SELECT id FROM users WHERE role='super_admin'").get().id
    const now = new Date().toISOString()
    for (const [id, owner, cost] of [
      ['consumer-log', uid, 2],
      ['sa-log', saId, 9],
      ['ad-log', added.json.data.item.id, 7],
    ]) {
      db.prepare(
        'INSERT INTO usage_logs(id,request_id,user_id,created_at,status,actual_cost) VALUES(?,?,?,?,200,?)',
      ).run(id, id, owner, now, cost)
    }
    db.close()
    const visible = await panel(gw, 'GET', '/api/panel/usage-logs', { cookie: ad.cookie })
    assert.deepEqual(visible.json.data.logs.map((r) => r.id).sort(), ['ad-log', 'consumer-log'])
    const forged = await panel(gw, 'GET', '/api/panel/usage-logs?user_id=' + saId, { cookie: ad.cookie })
    assert.deepEqual(forged.json.data.logs, [])
    assert.equal((await panel(gw, 'GET', '/api/panel/request-logs/sa-log', { cookie: ad.cookie })).status, 404)
    const summary = await panel(gw, 'GET', '/api/panel/usage-logs/summary', { cookie: ad.cookie })
    assert.equal(summary.status, 200, summary.text)
    const options = await panel(gw, 'GET', '/api/panel/usage-logs/filter-options', { cookie: ad.cookie })
    assert.deepEqual(options.json.data.users.map((u) => u.id).sort(), [uid, added.json.data.item.id].sort())
    const funding = await panel(gw, 'POST', `/api/panel/users/${added.json.data.item.id}/balance`, {
      cookie: sa.cookie,
      body: { amount: 10, reason: 'fund domain', idempotency_key: 'role-scope-fund-domain' },
    })
    assert.equal(funding.status, 200, funding.text)
    const transfer = await panel(gw, 'POST', `/api/panel/users/${uid}/balance`, {
      cookie: ad.cookie,
      body: { amount: 4, reason: 'fund own user', idempotency_key: 'role-scope-fund-user' },
    })
    assert.equal(transfer.status, 200, transfer.text)
    assert.equal(
      (
        await panel(gw, 'POST', `/api/panel/users/${uid}/balance`, {
          cookie: sa.cookie,
          body: { amount: 4, reason: 'not direct creator', idempotency_key: 'deny-super-granduser' },
        })
      ).status,
      403,
    )
    const bill = await panel(gw, 'GET', '/api/panel/billing', { cookie: ad.cookie })
    assert.equal(bill.status, 200, bill.text)
    assert.equal(bill.json.data.balance, 6, bill.text)
    assert.equal(bill.json.data.reserved, undefined)
    assert.equal(bill.json.data.available, 6)
    assert.ok(bill.json.data.items.every((r) => [uid, added.json.data.item.id].includes(r.user_id)))
    const platformLedger = await panel(gw, 'GET', '/api/panel/billing', { cookie: sa.cookie })
    assert.equal(platformLedger.status, 200, platformLedger.text)
    assert.ok(platformLedger.json.data.items.length > 0)
    for (const field of ['balance', 'reserved', 'available', 'pending'])
      assert.equal(Object.hasOwn(platformLedger.json.data, field), false, field)
    for (const route of [`/api/panel/billing?user_id=${uid}`, `/api/panel/users/${uid}/balance-history`]) {
      const customerWallet = await panel(gw, 'GET', route, { cookie: sa.cookie })
      assert.equal(customerWallet.status, 200, customerWallet.text)
      assert.equal(customerWallet.json.data.balance, 4)
      assert.equal(customerWallet.json.data.reserved, undefined)
      assert.equal(customerWallet.json.data.available, 4)
      assert.ok(customerWallet.json.data.items.length > 0)
    }
    const customerSession = await login(gw, 'customer', 'customer-pass')
    const personalWallet = await panel(gw, 'GET', '/api/panel/billing', { cookie: customerSession.cookie })
    assert.equal(personalWallet.status, 200, personalWallet.text)
    assert.equal(personalWallet.json.data.balance, 4)
    assert.equal(personalWallet.json.data.reserved, undefined)
    assert.equal(personalWallet.json.data.available, 4)
    assert.equal((await panel(gw, 'GET', '/api/panel/billing?user_id=' + saId, { cookie: ad.cookie })).status, 403)
    assert.equal(
      (await panel(gw, 'PATCH', '/api/panel/users/' + uid, { cookie: ad.cookie, body: { enabled: false } })).status,
      200,
    )
    assert.equal((await panel(gw, 'GET', '/api/panel/billing', { cookie: ad.cookie })).status, 200)
    assert.equal((await panel(gw, 'DELETE', '/api/panel/users/' + uid, { cookie: ad.cookie })).status, 200)
  } finally {
    await gw.stop()
  }
})

test('admins can create child admins while each branch remains isolated', async () => {
  const gw = await startGateway()
  try {
    const root = await login(gw, 'admin', 'testpass')
    const first = await panel(gw, 'POST', '/api/panel/users', {
      cookie: root.cookie,
      body: { username: 'branch-a', password: 'branch-a-pass', role: 'admin', groups: [1] },
    })
    const second = await panel(gw, 'POST', '/api/panel/users', {
      cookie: root.cookie,
      body: { username: 'branch-b', password: 'branch-b-pass', role: 'admin', groups: [1] },
    })
    assert.equal(first.status, 201, first.text)
    assert.equal(second.status, 201, second.text)
    const a = await login(gw, 'branch-a', 'branch-a-pass')
    const b = await login(gw, 'branch-b', 'branch-b-pass')
    const child = await panel(gw, 'POST', '/api/panel/users', {
      cookie: a.cookie,
      body: { username: 'branch-a-child', password: 'branch-a-child-pass', role: 'admin' },
    })
    const own = await panel(gw, 'POST', '/api/panel/users', {
      cookie: a.cookie,
      body: { username: 'branch-a-user', password: 'branch-a-user-pass', role: 'user' },
    })
    const foreign = await panel(gw, 'POST', '/api/panel/users', {
      cookie: b.cookie,
      body: { username: 'branch-b-user', password: 'branch-b-user-pass', role: 'user' },
    })
    assert.equal(child.status, 201, child.text)
    assert.equal(own.status, 201, own.text)
    assert.equal(foreign.status, 201, foreign.text)
    const creditPeer = await panel(gw, 'POST', `/api/panel/users/${child.json.data.item.id}/balance`, {
      cookie: root.cookie,
      body: { amount: 5000, reason: 'shared domain', idempotency_key: 'fund-peer-domain' },
    })
    assert.equal(creditPeer.status, 200, creditPeer.text)
    const peerLogin = await login(gw, 'branch-a-child', 'branch-a-child-pass')
    assert.equal((await panel(gw, 'GET', '/api/panel/billing', { cookie: a.cookie })).json.data.balance, 5000)
    assert.equal((await panel(gw, 'GET', '/api/panel/billing', { cookie: peerLogin.cookie })).json.data.balance, 5000)
    const transfer = await panel(gw, 'POST', `/api/panel/users/${own.json.data.item.id}/balance`, {
      cookie: a.cookie,
      body: { amount: 500, reason: 'own customer', idempotency_key: 'fund-own-customer' },
    })
    assert.equal(transfer.status, 200, transfer.text)
    assert.equal((await panel(gw, 'GET', '/api/panel/billing', { cookie: peerLogin.cookie })).json.data.balance, 4500)
    const peerTransfer = await panel(gw, 'POST', `/api/panel/users/${own.json.data.item.id}/balance`, {
      cookie: peerLogin.cookie,
      body: { amount: 1, idempotency_key: 'fund-peer-customer' },
    })
    assert.equal(peerTransfer.status, 200, peerTransfer.text)
    assert.equal(peerTransfer.json.data.balance, 501)
    assert.equal(peerTransfer.json.data.source.balance, 4499)
    assert.equal(peerTransfer.json.data.transaction.actor, 'branch-a-child')
    const repeatedTransfer = await panel(gw, 'POST', `/api/panel/users/${own.json.data.item.id}/balance`, {
      cookie: peerLogin.cookie,
      body: { amount: 1, reason: '   ', idempotency_key: 'fund-peer-customer' },
    })
    assert.equal(repeatedTransfer.status, 200, repeatedTransfer.text)
    assert.equal(repeatedTransfer.json.data.duplicate, true)
    assert.equal(repeatedTransfer.json.data.balance, 501)
    assert.equal(repeatedTransfer.json.data.source.balance, 4499)
    const outsideTransfer = await panel(gw, 'POST', `/api/panel/users/${foreign.json.data.item.id}/balance`, {
      cookie: peerLogin.cookie,
      body: { amount: 1, idempotency_key: 'deny-cross-domain-customer' },
    })
    assert.equal(outsideTransfer.status, 404, outsideTransfer.text)
    assert.equal((await panel(gw, 'GET', '/api/panel/billing', { cookie: a.cookie })).json.data.balance, 4499)
    assert.equal((await panel(gw, 'GET', '/api/panel/billing', { cookie: peerLogin.cookie })).json.data.balance, 4499)
    const foreignBalance = await panel(gw, 'GET', `/api/panel/users/${foreign.json.data.item.id}/balance-history`, {
      cookie: root.cookie,
    })
    assert.equal(foreignBalance.status, 200, foreignBalance.text)
    assert.equal(foreignBalance.json.data.balance, 0)
    const ownerView = await panel(gw, 'GET', '/api/panel/users', { cookie: a.cookie })
    const peerView = await panel(gw, 'GET', '/api/panel/users', { cookie: peerLogin.cookie })
    assert.equal(ownerView.json.data.items.find((u) => u.id === own.json.data.item.id).can_credit, true)
    assert.equal(peerView.json.data.items.find((u) => u.id === own.json.data.item.id).can_credit, true)
    assert.equal(
      (
        await panel(gw, 'PUT', `/api/panel/users/${own.json.data.item.id}/groups`, {
          cookie: a.cookie,
          body: { groups: [1] },
        })
      ).status,
      200,
    )
    assert.equal(
      (
        await panel(gw, 'PUT', `/api/panel/users/${foreign.json.data.item.id}/groups`, {
          cookie: b.cookie,
          body: { groups: [1] },
        })
      ).status,
      200,
    )
    const keyA = await panel(gw, 'POST', '/api/panel/api-keys', {
      cookie: a.cookie,
      body: { name: 'branch-a-key', group_id: 1 },
    })
    assert.equal(keyA.status, 201, keyA.text)
    assert.equal(keyA.json.item.user_id, first.json.data.item.id)
    assert.equal(keyA.json.item.created_by_user_id, first.json.data.item.id)
    const keyB = await panel(gw, 'POST', '/api/panel/api-keys', {
      cookie: b.cookie,
      body: { user_id: second.json.data.item.id, name: 'branch-b-key', group_id: 1 },
    })
    assert.equal(keyB.status, 201, keyB.text)
    assert.equal(keyB.json.item.user_id, second.json.data.item.id)
    assert.equal(keyB.json.item.created_by_user_id, second.json.data.item.id)
    for (const target of [own, child, second, foreign]) {
      const forged = await panel(gw, 'POST', '/api/panel/api-keys', {
        cookie: a.cookie,
        body: { user_id: target.json.data.item.id, name: 'forged-owner', group_id: 1 },
      })
      assert.equal(forged.status, 403, forged.text)
      assert.equal(forged.json.error.code, 'forbidden')
    }
    const keysA = await panel(gw, 'GET', '/api/panel/api-keys', { cookie: a.cookie })
    assert.deepEqual(
      keysA.json.keys.map((item) => item.name),
      ['branch-a-key'],
    )
    const crossKey = await panel(gw, 'GET', `/api/panel/api-keys/${keyB.json.item.id}`, { cookie: a.cookie })
    assert.equal(crossKey.status, 404)
    const listedA = await panel(gw, 'GET', '/api/panel/users', { cookie: a.cookie })
    assert.deepEqual(listedA.json.data.items.map((item) => item.username).sort(), ['branch-a-child', 'branch-a-user'])
    const listedB = await panel(gw, 'GET', '/api/panel/users', { cookie: b.cookie })
    assert.deepEqual(
      listedB.json.data.items.map((item) => item.username),
      ['branch-b-user'],
    )
    const customer = await login(gw, 'branch-a-user', 'branch-a-user-pass')
    const customerKey = await panel(gw, 'POST', '/api/panel/api-keys', {
      cookie: customer.cookie,
      body: { user_id: foreign.json.data.item.id, name: 'customer-key', group_id: 1 },
    })
    assert.equal(customerKey.status, 201, customerKey.text)
    assert.equal(customerKey.json.item.user_id, own.json.data.item.id)
    assert.equal(customerKey.json.item.created_by_user_id, own.json.data.item.id)
    const rootUsers = await panel(gw, 'GET', '/api/panel/users', { cookie: root.cookie })
    const rootId = rootUsers.json.data.items.find((u) => u.username === 'admin').id
    const delegated = await panel(gw, 'POST', '/api/panel/api-keys', {
      cookie: root.cookie,
      body: { user_id: own.json.data.item.id, name: 'super-admin-delegated-key', group_id: 1 },
    })
    assert.equal(delegated.status, 201, delegated.text)
    assert.equal(delegated.json.item.user_id, own.json.data.item.id)
    assert.equal(delegated.json.item.created_by_user_id, rootId)
  } finally {
    await gw.stop()
  }
})

test('domain grants synchronize peers and customers, inherit on creation and revoke existing Keys', async () => {
  const gw = await startGateway()
  try {
    const sa = await login(gw, 'admin', 'testpass')
    const call = (method, route, body, session = sa) =>
      panel(gw, method, '/api/panel' + route, { cookie: session.cookie, body })
    const create = async (username, role, session = sa, extra = {}) => {
      const result = await call('POST', '/users', { username, password: 'domain-test-pass', role, ...extra }, session)
      assert.equal(result.status, 201, result.text)
      return result.json.data.item
    }
    const grants = async (user, session = sa) => {
      const result = await call('GET', `/users/${user.id}/groups`, undefined, session)
      assert.equal(result.status, 200, result.text)
      return result.json.data.items
    }
    const set = async (user, values, session = sa) => {
      const result = await call('PUT', `/users/${user.id}/groups`, { groups: values }, session)
      assert.equal(result.status, 200, result.text)
      return result
    }
    const groupIds = (values) => values.map((g) => g.group_id).sort((a, b) => a - b)
    const firstGrant = [{ group_id: 1, rate_multiplier: 0.5, rpm_override: 30 }]
    const a = await create('grant-a', 'admin', sa, { groups: firstGrant })
    const b = await create('grant-b', 'admin', sa, { groups: [2] })
    const aSession = await login(gw, 'grant-a', 'domain-test-pass')
    const bSession = await login(gw, 'grant-b', 'domain-test-pass')
    const peer = await create('grant-peer', 'admin', aSession)
    const customer = await create('grant-customer', 'user', aSession)
    const foreign = await create('grant-foreign', 'user', bSession)
    assert.deepEqual(await grants(peer), firstGrant)
    assert.deepEqual(await grants(customer), [{ group_id: 1, rate_multiplier: null, rpm_override: null }])
    await set(customer, [{ group_id: 1, rate_multiplier: 0, rpm_override: 7 }], aSession)

    const shared = [
      { group_id: 1, rate_multiplier: 2, rpm_override: 50 },
      { group_id: 2, rate_multiplier: 0.7, rpm_override: 20 },
    ]
    const changed = await call('PATCH', `/users/${peer.id}`, { groups: shared })
    assert.equal(changed.status, 200, changed.text)
    const listed = await call('GET', '/users')
    assert.equal(listed.status, 200, listed.text)
    for (const admin of [a, peer]) {
      assert.deepEqual(await grants(admin), shared)
      assert.deepEqual(listed.json.data.items.find((u) => u.id === admin.id).groups, shared)
    }
    assert.deepEqual(await grants(customer), [
      { group_id: 1, rate_multiplier: 0, rpm_override: 7 },
      { group_id: 2, rate_multiplier: null, rpm_override: null },
    ])
    assert.deepEqual(groupIds(await grants(b)), [2])
    assert.deepEqual(groupIds(await grants(foreign)), [2])

    const peerSession = await login(gw, 'grant-peer', 'domain-test-pass')
    const nextAdmin = await create('grant-next-admin', 'admin', peerSession)
    assert.deepEqual(await grants(nextAdmin), shared)
    const nextSession = await login(gw, 'grant-next-admin', 'domain-test-pass')
    const nextUser = await create('grant-next-user', 'user', nextSession)
    assert.deepEqual(
      await grants(nextUser),
      shared.map((g) => ({ group_id: g.group_id, rate_multiplier: null, rpm_override: null })),
    )

    const customerSession = await login(gw, 'grant-customer', 'domain-test-pass')
    const available = await call('GET', '/groups', undefined, customerSession)
    assert.equal(available.status, 200, available.text)
    assert.deepEqual(
      available.json.data.items.map((g) => g.id).sort((x, y) => x - y),
      [1, 2],
    )
    const delegatedGroups = await call('GET', `/groups?available_to=${customer.id}`)
    assert.equal(delegatedGroups.status, 200, delegatedGroups.text)
    assert.deepEqual(
      delegatedGroups.json.data.items.map((g) => g.id).sort((x, y) => x - y),
      [1, 2],
    )
    const customerKey = await call(
      'POST',
      '/api-keys',
      { name: 'inherited-customer-key', group_id: 1 },
      customerSession,
    )
    assert.equal(customerKey.status, 201, customerKey.text)
    const adminKey = await call('POST', '/api-keys', { name: 'domain-admin-key', group_id: 1 }, peerSession)
    assert.equal(adminKey.status, 201, adminKey.text)
    const noGroup = await call('POST', '/api-keys', { name: 'admin-without-group' }, peerSession)
    assert.equal(noGroup.status, 400, noGroup.text)
    assert.equal(noGroup.json.error.code, 'group_required')
    const clearKeyGroup = await call('PATCH', `/api-keys/${adminKey.json.item.id}`, { group_id: null }, peerSession)
    assert.equal(clearKeyGroup.status, 400, clearKeyGroup.text)
    assert.equal(clearKeyGroup.json.error.code, 'group_required')

    // Editing a user's own subset does not rewrite its peers or its domain policy.
    await set(nextUser, [2], nextSession)
    assert.deepEqual(groupIds(await grants(nextUser)), [2])
    assert.deepEqual(await grants(nextAdmin), shared)
    assert.deepEqual(groupIds(await grants(customer)), [1, 2])
    const hiddenGroup = await call('POST', '/groups', { name: 'outside-domain', platform: 'anthropic' })
    assert.equal(hiddenGroup.status, 201, hiddenGroup.text)
    const outsideId = hiddenGroup.json.data.item.id
    for (const [target, values, expected] of [
      [peer, [1], 403],
      [customer, [outsideId], 403],
      [foreign, [1], 404],
      [b, [1], 404],
    ]) {
      const denied = await call('PUT', `/users/${target.id}/groups`, { groups: values }, aSession)
      assert.equal(denied.status, expected, denied.text)
    }
    const deniedKey = await call('POST', '/api-keys', { group_id: outsideId }, aSession)
    assert.equal(deniedKey.status, 403, deniedKey.text)
    assert.equal(deniedKey.json.error.code, 'group_forbidden')

    const rejected = await call('PATCH', `/users/${peer.id}`, {
      concurrency: 3,
      groups: [{ group_id: 1, rate_multiplier: 1 }, { group_id: 999999 }],
    })
    assert.equal(rejected.status, 400, rejected.text)
    const afterRejected = await call('GET', '/users')
    assert.equal(afterRejected.json.data.items.find((u) => u.id === peer.id).concurrency, 0)
    for (const admin of [a, peer, nextAdmin]) assert.deepEqual(await grants(admin), shared)
    assert.deepEqual(groupIds(await grants(nextUser)), [2])

    await set(peer, [])
    for (const user of [a, peer, nextAdmin, customer, nextUser]) assert.deepEqual(await grants(user), [])
    assert.deepEqual(groupIds(await grants(b)), [2])
    assert.deepEqual(groupIds(await grants(foreign)), [2])
    const emptyGroups = await call('GET', '/groups', undefined, customerSession)
    assert.equal(emptyGroups.status, 200, emptyGroups.text)
    assert.deepEqual(emptyGroups.json.data.items, [])
    for (const key of [customerKey.json.item, adminKey.json.item]) {
      const denied = await api(gw, 'POST', '/v1/messages', {
        headers: { authorization: `Bearer ${key.key}` },
        body: { model: 'claude-sonnet-5', max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] },
      })
      assert.equal(denied.status, 403, denied.text)
      assert.equal(denied.json.error.code, 'group_forbidden')
    }
    // Old ungrouped administrator Keys must not keep the platform-only access path.
    const db = new DatabaseSync(path.join(gw.project, 'data', 'kin.db'))
    try {
      db.prepare('UPDATE api_keys SET group_id=NULL WHERE id=?').run(adminKey.json.item.id)
    } finally {
      db.close()
    }
    const legacyNoGroup = await api(gw, 'POST', '/v1/messages', {
      headers: { authorization: `Bearer ${adminKey.json.item.key}` },
      body: { model: 'claude-sonnet-5', max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] },
    })
    assert.equal(legacyNoGroup.status, 403, legacyNoGroup.text)
    assert.equal(legacyNoGroup.json.error.code, 'group_required')
  } finally {
    await gw.stop()
    fs.rmSync(gw.project, { recursive: true, force: true })
  }
})

test('master API key still administers panel users', async () => {
  const gw = await startGateway()
  try {
    const list = await api(gw, 'GET', '/api/panel/users')
    assert.equal(list.status, 200, list.text)
    const items = list.json.data?.items || list.json.items
    assert.ok(Array.isArray(items))
    assert.ok(items.some((u) => u.username === 'admin' && u.role === 'super_admin'))
  } finally {
    await gw.stop()
  }
})

test('disabled environment administrator cannot fall back to its configured password', async () => {
  const gw = await startGateway()
  try {
    const sa = await login(gw, 'admin', 'testpass')
    const list = await panel(gw, 'GET', '/api/panel/users', { cookie: sa.cookie })
    const original = list.json.data.items.find((u) => u.username === 'admin')
    const second = await panel(gw, 'POST', '/api/panel/users', {
      cookie: sa.cookie,
      body: { username: 'second-sa', password: 'second-sa-pass', role: 'super_admin' },
    })
    assert.equal(second.status, 201, second.text)
    const other = await login(gw, 'second-sa', 'second-sa-pass')
    assert.equal(
      (await panel(gw, 'PATCH', '/api/panel/users/' + original.id, { cookie: other.cookie, body: { enabled: false } }))
        .status,
      200,
    )
    assert.equal((await login(gw, 'admin', 'testpass')).status, 401)
    assert.equal((await panel(gw, 'GET', '/api/panel/me', { cookie: sa.cookie })).status, 401)
  } finally {
    await gw.stop()
  }
})
