import test from 'node:test'
import assert from 'node:assert/strict'
import { startGateway, api } from '../harness.mjs'

const MODEL = 'claude-haiku-4-5-20251001'

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
