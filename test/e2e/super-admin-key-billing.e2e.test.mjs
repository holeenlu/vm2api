import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { startGateway, api } from '../harness.mjs'

test('super-admin platform Key keeps upstream inference and its USD limit at zero wallet balance', async () => {
  const gw = await startGateway({ scenario: 'text', mockText: 'platform-key-ok' })
  try {
    const login = await api(gw, 'POST', '/api/panel/login', { body: { username: 'admin', password: 'testpass' } })
    const headers = { authorization: '', cookie: login.headers.get('set-cookie') }
    assert.equal(login.status, 200, login.text)
    const created = await api(gw, 'POST', '/api/panel/api-keys', {
      headers,
      body: { name: 'platform-key', quota_usd: 0.000001, group_id: null },
    })
    assert.equal(created.status, 201, created.text)
    const key = created.json.item
    assert.equal(key.group_id, null)
    const send = () =>
      api(gw, 'POST', '/v1/messages', {
        headers: { authorization: `Bearer ${key.key}` },
        body: { model: 'claude-sonnet-5', max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] },
      })
    const response = await send()
    assert.equal(response.status, 200, response.text)
    assert.match(response.text, /platform-key-ok/)
    const db = new DatabaseSync(path.join(gw.project, 'data', 'kin.db'))
    try {
      assert.equal(db.prepare('SELECT balance_micros FROM users WHERE id=?').get(key.user_id).balance_micros, 0)
      assert.equal(db.prepare('SELECT COUNT(*) n FROM billing_reservations WHERE api_key_id=?').get(key.id).n, 0)
      const deadline = Date.now() + 2000
      let metered
      do {
        metered = db.prepare('SELECT quota_used,status,requests FROM api_keys WHERE id=?').get(key.id)
        if (metered.requests > 0) break
        await new Promise((resolve) => setTimeout(resolve, 20))
      } while (Date.now() < deadline)
      assert.ok(metered.quota_used > 0, JSON.stringify(metered) + '\n' + gw.stderr())
      assert.equal(metered.status, 'quota_exhausted')
    } finally {
      db.close()
    }
    assert.equal((await send()).status, 429)
  } finally {
    await gw.stop()
    fs.rmSync(gw.project, { recursive: true, force: true })
  }
})
