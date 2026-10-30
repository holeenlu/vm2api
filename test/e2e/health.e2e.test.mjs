import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { startGateway, api } from '../harness.mjs'

test('root redirects to the existing console without changing health or other routes', async () => {
  const gw = await startGateway()
  try {
    const dist = path.join(gw.project, 'web', 'dist')
    fs.mkdirSync(dist, { recursive: true })
    const html = '<!doctype html><title>Console fixture</title>'
    fs.writeFileSync(path.join(dist, 'index.html'), html)

    for (const method of ['GET', 'HEAD']) {
      const response = await fetch(gw.baseUrl + '/', { method, redirect: 'manual' })
      assert.equal(response.status, 307)
      assert.equal(response.headers.get('location'), '/console/')
      assert.equal(response.headers.get('cache-control'), 'no-store')
      assert.equal(await response.text(), '')

      const followed = await fetch(gw.baseUrl + '/', { method })
      assert.equal(followed.url, gw.baseUrl + '/console/')
      assert.equal(followed.status, 200)
      assert.match(followed.headers.get('content-type'), /text\/html/)
      assert.equal(followed.headers.get('cache-control'), 'no-store')
      assert.equal(await followed.text(), method === 'HEAD' ? '' : html)
    }

    for (const entry of ['/console', '/console/', '/cc', '/cc/']) {
      for (const method of ['GET', 'HEAD']) {
        const response = await fetch(gw.baseUrl + entry, { method, redirect: 'manual' })
        assert.equal(response.status, 200, entry)
        assert.match(response.headers.get('content-type'), /text\/html/)
        assert.equal(response.headers.get('cache-control'), 'no-store')
        assert.equal(await response.text(), method === 'HEAD' ? '' : html, entry)
      }
    }
    const health = await fetch(gw.baseUrl + '/health', { redirect: 'manual' })
    assert.equal(health.status, 200)
    assert.equal((await health.json()).status, 'ok')
    const live = await fetch(gw.baseUrl + '/healthz')
    assert.equal(live.status, 200)
    assert.deepEqual(await live.json(), { status: 'ok' })
    const post = await fetch(gw.baseUrl + '/', { method: 'POST', redirect: 'manual' })
    assert.equal(post.status, 404)
    assert.equal(post.headers.get('location'), null)

    fs.unlinkSync(path.join(dist, 'index.html'))
    const missing = await fetch(gw.baseUrl + '/', { method: 'HEAD' })
    assert.equal(missing.status, 404, 'HEAD must not report success when the console is missing')
    assert.equal(await missing.text(), '')
  } finally {
    await gw.stop()
    fs.rmSync(gw.project, { recursive: true, force: true })
  }
})

test('harness /health 200 and honest capabilities', async () => {
  const gw = await startGateway()
  try {
    const r = await api(gw, 'GET', '/health')
    assert.equal(r.status, 200)
    assert.equal(r.json.status, 'ok')
    assert.equal(r.json.capabilities.workspace_default, 'client')
    assert.equal(r.json.capabilities.client_tools, true)
    assert.equal(r.json.capabilities.multi_turn_native, true)
    assert.equal(r.json.capabilities.worker, 'go-slot-worker')
    assert.equal(r.json.capabilities.forward_default, 'relay')
    assert.match(r.json.limitations.forward, /Rust kernel.*slot egress.*no Go hop/i)
    assert.match(r.json.limitations.oauth, /sole refresh (owner|manager)/i)
    assert.equal(r.json.active_vm, 'vm-sim-01')
  } finally {
    await gw.stop()
  }
})

test('GET /v1/models is harvested from mock catalog strings', async () => {
  const gw = await startGateway()
  try {
    const r = await api(gw, 'GET', '/v1/models')
    assert.equal(r.status, 200)
    const ids = (r.json.data || r.json.models || []).map((m) => m.id || m)
    assert.ok(ids.includes('claude-haiku-4-5-20251001'), JSON.stringify(ids))
  } finally {
    await gw.stop()
  }
})

test('missing API key → 401', async () => {
  const gw = await startGateway()
  try {
    const res = await fetch(gw.baseUrl + '/v1/models')
    assert.equal(res.status, 401)
  } finally {
    await gw.stop()
  }
})
