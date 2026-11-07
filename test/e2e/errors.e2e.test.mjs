import test from 'node:test'
import assert from 'node:assert/strict'
import { startGateway, api } from '../harness.mjs'
import { callAnthropicMessages, streamAnthropicMessages } from '../../src/lib/protocol/anthropic-messages.mjs'

const MODEL = 'claude-haiku-4-5-20251001'

test('host-process Anthropic hop stays 501 (CRS is uid/mock)', async () => {
  const a = await callAnthropicMessages({ accessToken: 'sk-ant-oat01-FAKE' })
  const b = await streamAnthropicMessages({ accessToken: 'sk-ant-oat01-FAKE' })
  assert.equal(a.status, 501)
  assert.equal(b.status, 501)
})

test('VM without credentials is excluded and pool fails closed', async () => {
  const gw = await startGateway({ oauth: false })
  try {
    const r = await api(gw, 'POST', '/v1/messages', {
      body: { model: MODEL, max_tokens: 8, messages: [{ role: 'user', content: 'x' }] },
    })
    assert.equal(r.status, 503, r.text)
    const blob = JSON.stringify(r.json)
    assert.match(blob, /号池当前没有可用账号/)
    assert.doesNotMatch(blob, /负载过高/)
    assert.equal(r.json?.error?.code, 'pool_unavailable')
    assert.doesNotMatch(blob, /eligible|no ready api|account_pool_exhausted/i)
  } finally {
    await gw.stop()
  }
})

test('unknown model is rejected without hop', async () => {
  const gw = await startGateway()
  try {
    const r = await api(gw, 'POST', '/v1/messages', {
      body: { model: 'gpt-4o', max_tokens: 8, messages: [{ role: 'user', content: 'x' }] },
    })
    assert.ok(r.status >= 400, r.text)
    assert.match(JSON.stringify(r.json), /model/i)
  } finally {
    await gw.stop()
  }
})

test('legacy CLI selector header is ignored — Go worker still serves', async () => {
  const gw = await startGateway({ scenario: 'hang', timeoutMs: 800 })
  try {
    const r = await api(gw, 'POST', '/v1/messages', {
      headers: { 'x-kin-forward': 'cli' },
      body: { model: MODEL, max_tokens: 8, messages: [{ role: 'user', content: 'x' }] },
    })
    assert.equal(r.status, 200, r.text)
  } finally {
    await gw.stop()
  }
})

test('single-account rate limit is returned after bounded pool exhaustion', async () => {
  const gw = await startGateway({ scenario: 'rate_limit' })
  try {
    const r = await api(gw, 'POST', '/v1/messages', {
      body: { model: MODEL, max_tokens: 8, messages: [{ role: 'user', content: 'x' }] },
    })
    assert.equal(r.status, 429, r.text)
    assert.match(JSON.stringify(r.json), /rate.limit|quota/i)
    const q = await api(gw, 'GET', '/admin/quota')
    assert.equal(q.status, 200, q.text)
    assert.ok(q.json)
  } finally {
    await gw.stop()
  }
})

test('#689 kernel job stream overflow is its own error, logged with request id, slot and forwarded counts', async () => {
  const gw = await startGateway({
    env: { KIN_MOCK_ACCOUNT_SCENARIOS: JSON.stringify({ 'vm-sim-01': 'job_stream_overflow' }) },
  })
  try {
    const response = await fetch(gw.baseUrl + '/v1/messages', {
      method: 'POST',
      headers: { authorization: `Bearer ${gw.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, stream: true, max_tokens: 16, messages: [{ role: 'user', content: 'go' }] }),
    })
    assert.equal(response.status, 200)
    const requestId = response.headers.get('x-request-id')
    assert.ok(requestId)
    const body = await response.text()
    assert.match(body, /partial/)
    const frames = body
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => JSON.parse(line.slice(5)))
      .filter((event) => event.type === 'error')
    assert.equal(frames.length, 1, body)
    assert.equal(frames[0].error.code, 'kernel_stream_overflow')
    assert.equal(frames[0].error.type, 'api_error')
    assert.equal(frames[0].error.request_id, requestId)
    assert.doesNotMatch(body, /upstream_error/)
    await new Promise((r) => setTimeout(r, 50))
    const logged = gw
      .stderr()
      .split('\n')
      .filter((line) => line.includes('"event":"kernel_stream_overflow"'))
      .map((line) => JSON.parse(line))
    assert.equal(logged.length, 1, gw.stderr())
    assert.equal(logged[0].request_id, requestId)
    assert.equal(logged[0].vm_id, 'vm-sim-01')
    assert.ok(logged[0].forwarded_frames >= 2, JSON.stringify(logged[0]))
    assert.ok(logged[0].forwarded_bytes > 0)
    const row = await api(gw, 'GET', `/api/panel/request-logs/${requestId}`)
    assert.equal(row.status, 200, row.text)
    assert.equal(row.json.item.error_code, 'kernel_stream_overflow')
  } finally {
    await gw.stop()
  }
})
