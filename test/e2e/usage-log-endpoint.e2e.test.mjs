import test from 'node:test'
import fs from 'node:fs'
import assert from 'node:assert/strict'
import { startGateway, api } from '../harness.mjs'

// 超级管理员「端点」「类型」列：VM 槽位按 Anthropic Messages 经 HTTP 发往上游，入站为 HTTP
test('slot requests record inbound and upstream endpoints with their transports', async () => {
  const gw = await startGateway({ disableWatchdog: true })
  try {
    const r = await api(gw, 'POST', '/v1/messages', {
      body: { model: 'claude-haiku-4-5-20251001', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] },
    })
    assert.equal(r.status, 200, r.text)
    let row = null
    for (let i = 0; i < 40 && !row; i++) {
      const listed = await api(gw, 'GET', '/api/panel/usage-logs?include_muted=1')
      row = listed.json?.data?.logs?.find((l) => l.endpoint === '/v1/messages') || null
      if (!row) await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.ok(row, 'usage row not written')
    assert.equal(row.inboundTransport, 'http')
    assert.equal(row.upstreamEndpoint, '/v1/messages')
    assert.equal(row.upstreamTransport, 'http')
  } finally {
    await gw.stop()
    fs.rmSync(gw.project, { recursive: true, force: true })
  }
})
