import test from 'node:test'
import assert from 'node:assert/strict'
import { startGateway, api } from '../harness.mjs'

const MODEL = 'claude-haiku-4-5-20251001'

// 上游 #862 的真实会话回归，按 tapmodels 契约改写：商业 Key 必须绑定授权分组；用户只能看到和操作自己的 Key，
// 伪造的 user_id 查询不能扩大范围；超级管理员 / master 保留全量视图（管理员分支范围见 panel-api-key-routes 单测）。
test('real user sessions cannot list or operate other users or platform keys', async () => {
  const gw = await startGateway()
  try {
    const data = (r) => r.json?.data || r.json
    const login = async (username, password) => {
      const response = await api(gw, 'POST', '/api/panel/login', { body: { username, password } })
      assert.equal(response.status, 200, response.text)
      return response.headers.get('set-cookie')
    }
    const group = data(await api(gw, 'POST', '/api/panel/groups', { body: { name: 'Keys', platform: 'mixed' } })).item
    const users = []
    for (const username of ['key-owner', 'key-other']) {
      const created = await api(gw, 'POST', '/api/panel/users', {
        body: { username, password: `fixture-${username}-pass`, role: 'user' },
      })
      assert.equal(created.status, 201, created.text)
      const id = data(created).item.id
      await api(gw, 'PUT', `/api/panel/users/${id}/groups`, { body: { groups: [{ group_id: group.id }] } })
      users.push({ id, cookie: await login(username, `fixture-${username}-pass`) })
    }
    const personal = (cookie, method, path, body) =>
      api(gw, method, path, { headers: { authorization: '', cookie }, body })
    const platform = await api(gw, 'POST', '/api/panel/api-keys', { body: { name: 'platform' } })
    assert.equal(platform.status, 201, platform.text)
    const keys = []
    for (const user of users) {
      // 调用方伪造的 user_id 被忽略，属主取认证用户
      const created = await personal(user.cookie, 'POST', '/api/panel/api-keys', {
        name: 'mine',
        group_id: group.id,
        user_id: users.find((u) => u !== user).id,
      })
      assert.equal(created.status, 201, created.text)
      keys.push(created.json.item)
      assert.equal(keys.at(-1).user_id, user.id)
    }
    for (const [index, user] of users.entries()) {
      const own = keys[index].id
      const foreign = keys[1 - index].id
      const list = await personal(user.cookie, 'GET', `/api/panel/api-keys?user_id=${users[1 - index].id}`)
      assert.equal(list.status, 200, list.text)
      assert.deepEqual(
        list.json.keys.map((key) => key.id),
        [own],
      )
      assert.equal(list.json.total, 1)
      for (const [method, suffix] of [
        ['GET', '/stats'],
        ['POST', '/reveal'],
        ['PATCH', ''],
        ['POST', '/rotate'],
        ['POST', '/reset-quota'],
        ['DELETE', ''],
      ]) {
        for (const id of [foreign, platform.json.item.id, 'missing']) {
          const denied = await personal(
            user.cookie,
            method,
            `/api/panel/api-keys/${id}${suffix}`,
            method === 'PATCH' ? { name: 'hijacked' } : undefined,
          )
          assert.equal(denied.status, 404, `${method} ${suffix} ${id}: ${denied.text}`)
        }
      }
      const reveal = await personal(user.cookie, 'POST', `/api/panel/api-keys/${own}/reveal`)
      assert.equal(reveal.status, 200, reveal.text)
    }
    const masterList = await api(gw, 'GET', '/api/panel/api-keys')
    assert.deepEqual(
      new Set(masterList.json.keys.map((key) => key.id)),
      new Set([platform.json.item.id, ...keys.map((key) => key.id)]),
    )
  } finally {
    await gw.stop()
  }
})

test('panel creates managed key; key can call /v1/messages', async () => {
  const gw = await startGateway({ mockText: 'hello-key' })
  try {
    const created = await api(gw, 'POST', '/api/panel/api-keys', {
      body: { name: 'e2e', max_concurrency: 2, quota_requests: 5, rpm: 60 },
    })
    assert.equal(created.status, 201, created.text)
    assert.ok(created.json.item?.key?.startsWith('sk-vm-'))
    const key = created.json.item.key

    const r = await api(gw, 'POST', '/v1/messages', {
      headers: { authorization: `Bearer ${key}` },
      body: { model: MODEL, max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] },
    })
    assert.equal(r.status, 200, r.text)
    assert.match(JSON.stringify(r.json), /hello-key/)

    const list = await api(gw, 'GET', '/api/panel/api-keys')
    assert.equal(list.status, 200)
    assert.ok(list.json.keys.some((k) => k.name === 'e2e'))
    assert.ok(list.json.keys[0].key.includes('…'))
  } finally {
    await gw.stop()
  }
})

test('panel re-reveals a used key; rotate swaps the plaintext', async () => {
  const gw = await startGateway({ mockText: 'copyable' })
  try {
    const created = await api(gw, 'POST', '/api/panel/api-keys', { body: { name: 'copy' } })
    assert.equal(created.status, 201, created.text)
    const id = created.json.item.id
    const key = created.json.item.key

    const call = await api(gw, 'POST', '/v1/messages', {
      headers: { authorization: `Bearer ${key}` },
      body: { model: MODEL, max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] },
    })
    assert.equal(call.status, 200, call.text)

    const shown = await api(gw, 'POST', `/api/panel/api-keys/${id}/reveal`)
    assert.equal(shown.status, 200, shown.text)
    assert.equal(shown.json.key, key)

    const rotated = await api(gw, 'POST', `/api/panel/api-keys/${id}/rotate`)
    assert.equal(rotated.status, 200, rotated.text)
    const next = rotated.json.item.key
    assert.ok(next.startsWith('sk-vm-'))
    assert.notEqual(next, key)

    const old = await api(gw, 'POST', '/v1/messages', {
      headers: { authorization: `Bearer ${key}` },
      body: { model: MODEL, max_tokens: 8, messages: [{ role: 'user', content: 'x' }] },
    })
    assert.equal(old.status, 401, old.text)

    const fresh = await api(gw, 'POST', '/v1/messages', {
      headers: { authorization: `Bearer ${next}` },
      body: { model: MODEL, max_tokens: 8, messages: [{ role: 'user', content: 'x' }] },
    })
    assert.equal(fresh.status, 200, fresh.text)
  } finally {
    await gw.stop()
  }
})

test('quota_requests=1 rejects second call', async () => {
  const gw = await startGateway({ mockText: 'once' })
  try {
    const created = await api(gw, 'POST', '/api/panel/api-keys', {
      body: { name: 'quota1', max_concurrency: 2, quota_requests: 1, rpm: 0 },
    })
    assert.equal(created.status, 201, created.text)
    const key = created.json.item.key

    const a = await api(gw, 'POST', '/v1/messages', {
      headers: { authorization: `Bearer ${key}` },
      body: { model: MODEL, max_tokens: 8, messages: [{ role: 'user', content: '1' }] },
    })
    assert.equal(a.status, 200, a.text)

    const b = await api(gw, 'POST', '/v1/messages', {
      headers: { authorization: `Bearer ${key}` },
      body: { model: MODEL, max_tokens: 8, messages: [{ role: 'user', content: '2' }] },
    })
    assert.equal(b.status, 429, b.text)
    assert.match(JSON.stringify(b.json), /quota/i)
  } finally {
    await gw.stop()
  }
})

test('panel quota aliases keep request and USD units consistent on create and update', async () => {
  const gw = await startGateway()
  try {
    const created = await api(gw, 'POST', '/api/panel/api-keys', {
      body: { name: 'quota-aliases', quota: 10, quota_usd: 5 },
    })
    assert.equal(created.status, 201, created.text)
    assert.equal(created.json.item.quota_requests, 10)
    assert.equal(created.json.item.quota_usd, 5)

    const updated = await api(gw, 'PATCH', `/api/panel/api-keys/${created.json.item.id}`, {
      body: { quota: 20, quota_usd: 7 },
    })
    assert.equal(updated.status, 200, updated.text)
    assert.equal(updated.json.item.quota_requests, 20)
    assert.equal(updated.json.item.quota_usd, 7)
  } finally {
    await gw.stop()
  }
})

test('disabled key returns 403', async () => {
  const gw = await startGateway()
  try {
    const created = await api(gw, 'POST', '/api/panel/api-keys', {
      body: { name: 'off' },
    })
    const id = created.json.item.id
    const key = created.json.item.key
    await api(gw, 'PATCH', `/api/panel/api-keys/${id}`, { body: { status: 'disabled' } })
    const r = await api(gw, 'POST', '/v1/messages', {
      headers: { authorization: `Bearer ${key}` },
      body: { model: MODEL, max_tokens: 8, messages: [{ role: 'user', content: 'x' }] },
    })
    assert.equal(r.status, 403, r.text)
  } finally {
    await gw.stop()
  }
})

test('master key still works; delete key invalidates', async () => {
  const gw = await startGateway({ mockText: 'master' })
  try {
    const created = await api(gw, 'POST', '/api/panel/api-keys', { body: { name: 'tmp' } })
    const id = created.json.item.id
    const key = created.json.item.key
    const del = await api(gw, 'DELETE', `/api/panel/api-keys/${id}`)
    assert.equal(del.status, 200)
    const r = await api(gw, 'POST', '/v1/messages', {
      headers: { authorization: `Bearer ${key}` },
      body: { model: MODEL, max_tokens: 8, messages: [{ role: 'user', content: 'x' }] },
    })
    assert.equal(r.status, 401, r.text)

    // master (harness apiKey) still works
    const m = await api(gw, 'POST', '/v1/messages', {
      body: { model: MODEL, max_tokens: 8, messages: [{ role: 'user', content: 'x' }] },
    })
    assert.equal(m.status, 200, m.text)
  } finally {
    await gw.stop()
  }
})

test('managed key cannot access panel admin APIs', async () => {
  const gw = await startGateway()
  try {
    const created = await api(gw, 'POST', '/api/panel/api-keys', {
      body: { name: 'client-only', max_concurrency: 2 },
    })
    assert.equal(created.status, 201, created.text)
    const key = created.json.item.key

    const dash = await api(gw, 'GET', '/api/panel/dashboard', {
      headers: { authorization: `Bearer ${key}` },
    })
    assert.equal(dash.status, 403, dash.text)

    const logs = await api(gw, 'GET', '/api/panel/request-logs?mode=debug', {
      headers: { authorization: `Bearer ${key}` },
    })
    assert.equal(logs.status, 403, logs.text)

    const keys = await api(gw, 'GET', '/api/panel/api-keys', {
      headers: { authorization: `Bearer ${key}` },
    })
    assert.equal(keys.status, 403, keys.text)
  } finally {
    await gw.stop()
  }
})

test('bulk key HTTP route saves selected fields atomically and rejects malformed patches', async () => {
  const gw = await startGateway({ disableWatchdog: true })
  try {
    const keys = []
    for (const name of ['bulk-one', 'bulk-two']) {
      const r = await api(gw, 'POST', '/api/panel/api-keys', { body: { name, quota_usd: 9, rpm: 5 } })
      assert.equal(r.status, 201, r.text)
      keys.push(r.json.item)
    }
    const update = (ids, patch) => api(gw, 'PATCH', '/api/panel/api-keys/bulk', { body: { ids, patch } })
    assert.equal((await update([keys[0].id, 'missing'], { rpm: 10 })).status, 404)
    assert.equal(
      (
        await update(
          keys.map((k) => k.id),
          { quota_usd: null },
        )
      ).status,
      400,
    )
    const saved = await update(
      keys.map((k) => k.id),
      { quota_usd: 12.5, rate_limit_5h: 1, rpm: 0 },
    )
    assert.equal(saved.status, 200, saved.text)
    assert.deepEqual(saved.json, { ok: true, updated: 2 })
    const listed = await api(gw, 'GET', '/api/panel/api-keys')
    for (const key of keys) {
      const row = listed.json.keys.find((k) => k.id === key.id)
      assert.equal(row.quota_usd, 12.5)
      assert.equal(row.rate_limit_5h, 1)
      assert.equal(row.rpm, 0)
      assert.equal(row.name, key.name)
      assert.ok(row.key.includes('…'))
    }
  } finally {
    await gw.stop()
  }
})
