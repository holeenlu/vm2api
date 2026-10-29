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
      body: { username: 'reader', password: 'reader-pass', role: 'user' },
    })
    assert.equal(created.status, 201, JSON.stringify(created.json))
    const item = created.json.data?.item || created.json.item
    assert.equal(item.username, 'reader')
    assert.equal(item.role, 'user')
    assert.equal(item.password_hash, undefined)

    const readerBefore = await login(gw, 'reader', 'reader-pass')
    assert.equal(readerBefore.status, 200)

    const changed = await panel(gw, 'PATCH', `/api/panel/users/${item.id}`, {
      cookie: admin.cookie,
      body: { password: 'reader-next' },
    })
    assert.equal(changed.status, 200, JSON.stringify(changed.json))

    const staleSession = await panel(gw, 'GET', '/api/panel/me', { cookie: readerBefore.cookie })
    assert.equal(staleSession.status, 401)
    const oldLogin = await login(gw, 'reader', 'reader-pass')
    assert.equal(oldLogin.status, 401)
    const nextLogin = await login(gw, 'reader', 'reader-next')
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

test('AD manages only ordinary users and cannot maintain VM supply or finance', async () => {
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
      ['POST', '/api/panel/users/' + uid + '/balance', { amount: 1 }],
    ])
      assert.equal((await panel(gw, method, path, { cookie: ad.cookie, body })).status, 403, path)
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
    assert.deepEqual(
      visible.json.data.logs.map((r) => r.id),
      ['consumer-log'],
    )
    const forged = await panel(gw, 'GET', '/api/panel/usage-logs?user_id=' + saId, { cookie: ad.cookie })
    assert.deepEqual(forged.json.data.logs, [])
    assert.equal((await panel(gw, 'GET', '/api/panel/request-logs/sa-log', { cookie: ad.cookie })).status, 404)
    const summary = await panel(gw, 'GET', '/api/panel/usage-logs/summary', { cookie: ad.cookie })
    assert.equal(summary.status, 200, summary.text)
    const options = await panel(gw, 'GET', '/api/panel/usage-logs/filter-options', { cookie: ad.cookie })
    assert.ok(options.json.data.users.every((u) => u.id === uid))
    for (const [id, amount] of [
      [uid, 4],
      [saId, 100],
    ])
      assert.equal(
        (
          await panel(gw, 'POST', '/api/panel/users/' + id + '/balance', {
            cookie: sa.cookie,
            body: { amount, reason: 'scope regression', idempotency_key: 'role-scope-' + id },
          })
        ).status,
        200,
      )
    const bill = await panel(gw, 'GET', '/api/panel/billing', { cookie: ad.cookie })
    assert.equal(bill.json.data.balance, 4, bill.text)
    assert.ok(bill.json.data.items.every((r) => r.user_id === uid))
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
      body: { username: 'branch-a', password: 'branch-a-pass', role: 'admin' },
    })
    const second = await panel(gw, 'POST', '/api/panel/users', {
      cookie: root.cookie,
      body: { username: 'branch-b', password: 'branch-b-pass', role: 'admin' },
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
    assert.equal(
      (await panel(gw, 'PUT', `/api/panel/users/${own.json.data.item.id}/groups`, {
        cookie: a.cookie,
        body: { groups: [1] },
      })).status,
      200,
    )
    assert.equal(
      (await panel(gw, 'PUT', `/api/panel/users/${foreign.json.data.item.id}/groups`, {
        cookie: b.cookie,
        body: { groups: [1] },
      })).status,
      200,
    )
    const keyA = await panel(gw, 'POST', '/api/panel/api-keys', {
      cookie: a.cookie,
      body: { user_id: JSON.parse(JSON.stringify(own.json.data.item)).id, name: 'branch-a-key', group_id: 1 },
    })
    assert.equal(keyA.status, 201, keyA.text)
    const keyB = await panel(gw, 'POST', '/api/panel/api-keys', {
      cookie: b.cookie,
      body: { user_id: JSON.parse(JSON.stringify(foreign.json.data.item)).id, name: 'branch-b-key', group_id: 1 },
    })
    assert.equal(keyB.status, 201, keyB.text)
    const keysA = await panel(gw, 'GET', '/api/panel/api-keys', { cookie: a.cookie })
    assert.deepEqual(keysA.json.keys.map((item) => item.name), ['branch-a-key'])
    const crossKey = await panel(gw, 'GET', `/api/panel/api-keys/${keyB.json.item.id}`, { cookie: a.cookie })
    assert.equal(crossKey.status, 404)
    const listedA = await panel(gw, 'GET', '/api/panel/users', { cookie: a.cookie })
    assert.deepEqual(
      listedA.json.data.items.map((item) => item.username).sort(),
      ['branch-a-child', 'branch-a-user'],
    )
    const listedB = await panel(gw, 'GET', '/api/panel/users', { cookie: b.cookie })
    assert.deepEqual(listedB.json.data.items.map((item) => item.username), ['branch-b-user'])
  } finally {
    await gw.stop()
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
