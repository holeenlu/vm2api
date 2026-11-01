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
  assert.equal(res.status, 200)
  return res.headers.get('set-cookie') || ''
}
async function call(gw, cookie, route, body) {
  const res = await fetch(gw.baseUrl + '/api/panel' + route, {
    method: body ? 'POST' : 'GET',
    headers: { cookie, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let data
  try {
    const parsed = JSON.parse(text)
    data = parsed.data || parsed
  } catch {}
  return { status: res.status, data, text }
}

test('usage filters: role scopes, candidates, diagnostics, rankings and exports agree', async (t) => {
  const gw = await startGateway({ disableWatchdog: true })
  t.after(async () => {
    await gw.stop()
    fs.rmSync(gw.project, { recursive: true, force: true })
  })
  const sa = await login(gw, 'admin', 'testpass')
  const manager = await call(gw, sa, '/users', { username: 'filter-manager', password: 'filter-pass', role: 'admin' })
  assert.equal(manager.status, 201, manager.text)
  const adminId = manager.data.item.id
  const ad = await login(gw, 'filter-manager', 'filter-pass')
  const customer = await call(gw, ad, '/users', { username: 'filter-customer', password: 'filter-pass', role: 'user' })
  assert.equal(customer.status, 201, customer.text)
  const userId = customer.data.item.id
  const user = await login(gw, 'filter-customer', 'filter-pass')
  const outsider = await call(gw, sa, '/users', { username: 'filter-outsider', password: 'filter-pass', role: 'user' })
  assert.equal(outsider.status, 201, outsider.text)
  const db = new DatabaseSync(path.join(gw.project, 'data', 'kin.db'))
  try {
    db.exec("INSERT INTO groups(id,name) VALUES(301,'Visible history group'),(302,'Hidden group')")
    const key = db.prepare('INSERT INTO api_keys(id,name,key,user_id,created_by_user_id) VALUES(?,?,?,?,?)')
    key.run('filter-k1', 'Managed key', 'fixture-k1', userId, adminId)
    key.run('filter-k2', 'User key', 'fixture-k2', userId, userId)
    key.run('filter-k3', 'Hidden key', 'fixture-k3', outsider.data.item.id, outsider.data.item.id)
    const row =
      db.prepare(`INSERT INTO usage_logs(id,request_id,user_id,api_key_id,created_at,model,group_id,billing_group_id,status,path,protocol,vm_id,account_id,outbound_session_id,attempt_count,log_mode)
      VALUES(?,?,?,?,?,?,?,?,?,'/v1/responses','openai.responses','vm-private','account-private','session-private',1,'normal')`)
    row.run('filter-ok', 'filter-ok', userId, 'filter-k1', new Date().toISOString(), 'visible-model', 301, null, 200)
    row.run('filter-error', 'filter-error', userId, 'filter-k2', new Date().toISOString(), 'visible-model', 1, 301, 500)
    row.run(
      'filter-hidden',
      'filter-hidden',
      outsider.data.item.id,
      'filter-k3',
      new Date().toISOString(),
      'hidden-model',
      302,
      null,
      200,
    )
  } finally {
    db.close()
  }
  const ids = (out) => {
    assert.equal(out.status, 200, out.text)
    return out.data.logs.map((r) => r.id).sort()
  }
  const visible = ['filter-error', 'filter-ok']
  for (const cookie of [ad, user]) {
    assert.deepEqual(ids(await call(gw, cookie, '/usage-logs?include_muted=1')), visible)
    const options = await call(gw, cookie, '/usage-logs/filter-options')
    assert.equal(options.status, 200, options.text)
    assert.deepEqual(options.data.keys.map((k) => k.id).sort(), ['filter-k1', 'filter-k2'])
    assert.deepEqual(options.data.groups, [{ id: '301', name: 'Visible history group' }])
    assert.deepEqual(options.data.models, ['visible-model'])
    assert.equal(options.data.accounts, undefined)
    assert.equal(options.data.vms, undefined)
    assert.deepEqual(ids(await call(gw, cookie, '/usage-logs?group_id=301&include_muted=1')), visible)
    assert.deepEqual(ids(await call(gw, cookie, '/usage-logs?key_id=filter-k1&include_muted=1')), ['filter-ok'])
    assert.deepEqual(ids(await call(gw, cookie, '/usage-logs?key_id=filter-k3&include_muted=1')), [])
    assert.deepEqual(ids(await call(gw, cookie, '/usage-logs?group_id=302&include_muted=1')), [])
    const restricted =
      'vm_id=never&account_id=never&session_id=never&model_mismatch=1&min_attempt_count=1000&log_mode=debug&include_muted=1'
    assert.deepEqual(ids(await call(gw, cookie, '/usage-logs?' + restricted)), visible)
    assert.equal((await call(gw, cookie, '/usage-logs/session-suggestions?q=se')).status, 403)
    const exported = await call(gw, cookie, '/request-logs/export?format=jsonl&errors_only=1&include_muted=1')
    assert.equal(exported.status, 200, exported.text)
    assert.deepEqual(
      exported.text
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l).request_id),
      ['filter-error'],
    )
    const summary = await call(gw, cookie, '/usage-logs/summary?status_code=500&include_muted=1')
    assert.equal(summary.data.totalRequests, 1)
  }
  assert.deepEqual(ids(await call(gw, ad, '/usage-logs?scope=mine&include_muted=1')), ['filter-ok'])
  const mine = await call(gw, ad, '/usage-logs/filter-options?scope=mine')
  assert.deepEqual(
    mine.data.keys.map((k) => k.id),
    ['filter-k1'],
  )
  const ranking = await call(gw, ad, '/usage-logs/ranking?scope=mine&rank_by=key&include_muted=1')
  assert.equal(ranking.status, 200, ranking.text)
  assert.deepEqual(
    ranking.data.entries.map((e) => e.id),
    ['filter-k1'],
  )
  assert.equal((await call(gw, user, '/usage-logs/ranking?rank_by=user')).status, 403)
  assert.deepEqual(ids(await call(gw, sa, '/usage-logs?vm_id=never&include_muted=1')), [])
  assert.equal((await call(gw, sa, '/usage-logs/session-suggestions?q=se')).data.includes('session-private'), true)
  const all = await api(gw, 'GET', '/api/panel/usage-logs?include_muted=1')
  assert.equal(all.json.data.logs.length, 3)
})
