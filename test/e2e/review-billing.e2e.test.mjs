import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { startGateway, api, seedVm } from '../harness.mjs'

const model = 'claude-sonnet-5'
const item = (r) => r.json?.data?.item || r.json?.item

test('API billing retains complete raw usage for every client protocol without reservation or reconciliation state', async (t) => {
  const gw = await startGateway()
  let mode = 'complete',
    hits = 0
  const kernel = http.createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    hits++
    const envelope = JSON.parse(raw)
    const events = envelope.url.includes('/responses')
      ? [
          {
            type: 'response.created',
            response: { id: 'resp_test', object: 'response', status: 'in_progress', output: [] },
          },
          ...(mode === 'complete'
            ? [
                {
                  type: 'response.completed',
                  response: {
                    id: 'resp_test',
                    object: 'response',
                    status: 'completed',
                    output: [
                      {
                        type: 'message',
                        id: 'out',
                        role: 'assistant',
                        content: [{ type: 'output_text', text: 'answer' }],
                      },
                    ],
                    usage: { input_tokens: 100, output_tokens: 25 },
                  },
                },
              ]
            : []),
        ]
      : [
          {
            type: 'message_start',
            message: {
              id: 'msg_test',
              type: 'message',
              role: 'assistant',
              content: [],
              model,
              usage: { input_tokens: 100, output_tokens: 0 },
            },
          },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'answer' } },
          { type: 'content_block_stop', index: 0 },
          ...(mode !== 'incomplete'
            ? [
                {
                  type: 'message_delta',
                  delta: { stop_reason: 'end_turn' },
                  usage: { output_tokens: mode === 'zero' ? 0 : 25 },
                },
              ]
            : []),
          ...(mode === 'complete' || mode === 'zero' ? [{ type: 'message_stop' }] : []),
          ...(mode === 'error-after-usage'
            ? [{ type: 'error', error: { type: 'api_error', status: 502, message: 'failed after final usage' } }]
            : []),
        ]
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    res.end()
  })
  await new Promise((resolve) => kernel.listen(path.join(gw.project, 'data/run/api-kernel.sock'), resolve))
  const db = new DatabaseSync(path.join(gw.project, 'data/kin.db'), { readOnly: true })
  t.after(async () => {
    db.close()
    await new Promise((resolve) => kernel.close(resolve))
    await gw.stop()
    fs.rmSync(gw.project, { recursive: true, force: true })
  })
  const call = (method, suffix, body) => api(gw, method, '/api/panel' + suffix, { body })
  const user = item(await call('POST', '/users', { username: 'billing-regression', password: 'test-password' }))
  const ep = item(
    await call('POST', '/api-endpoints', {
      name: 'billing',
      kind: 'custom',
      protocol: 'anthropic',
      base_url: 'https://fixture.invalid',
      api_key_entries: [{ api_key: 'fixture-upstream-secret' }],
      models: [{ name: model, alias: model }],
    }),
  )
  const group = item(await call('POST', '/groups', { name: 'billing', platform: 'anthropic', models: [model] }))
  assert.equal(
    (
      await call('PUT', '/groups/' + group.id + '/resources', {
        expected_version: group.version,
        resources: [{ resource_kind: 'api_endpoint', resource_id: ep.id }],
      })
    ).status,
    200,
  )
  await call('PUT', '/users/' + user.id + '/groups', { groups: [group.id] })
  await call('POST', '/users/' + user.id + '/balance', {
    amount: 10,
    reason: 'test',
    idempotency_key: 'billing-credit',
  })
  const key = item(await call('POST', '/api-keys', { user_id: user.id, group_id: group.id }))
  const requestBody = (route, stream) => ({
    model,
    stream,
    max_tokens: 64,
    ...(route === '/v1/responses'
      ? { input: 'hello' }
      : route === '/v1/completions'
        ? { prompt: 'hello' }
        : { messages: [{ role: 'user', content: 'hello' }] }),
  })
  let completedRequests = 0
  const lastCharge = async () => {
    const deadline = Date.now() + 2000
    for (;;) {
      const count = db.prepare('SELECT COUNT(*) n FROM usage_logs WHERE api_key_id=?').get(key.id).n
      if (count > completedRequests) {
        completedRequests = count
        const log = db
          .prepare('SELECT request_id FROM usage_logs WHERE api_key_id=? ORDER BY rowid DESC LIMIT 1')
          .get(key.id)
        return db.prepare('SELECT * FROM billing_charges WHERE request_id=?').get(log.request_id)
      }
      assert.ok(Date.now() < deadline, 'request did not finish: ' + gw.stderr())
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  for (const protocol of ['anthropic', 'openai']) {
    assert.equal((await call('PATCH', '/api-endpoints/' + ep.id, { protocol })).status, 200)
    for (const route of ['/v1/messages', '/v1/chat/completions', '/v1/responses', '/v1/completions']) {
      for (const stream of [false, true]) {
        mode = 'complete'
        const response = await api(gw, 'POST', route, {
          headers: { authorization: 'Bearer ' + key.key },
          body: requestBody(route, stream),
        })
        assert.equal(response.status, 200, `${protocol} ${route} ${stream}: ${response.text}`)
        const ticket = await lastCharge()
        assert.equal(JSON.parse(ticket.usage_json).output_tokens, 25)
        assert.equal(ticket.actual_micros, 450)
        assert.equal(
          db.prepare("SELECT COUNT(*) n FROM wallet_ledger WHERE request_id=? AND kind='usage'").get(ticket.request_id)
            .n,
          1,
        )
      }
    }
  }
  await call('PATCH', '/api-endpoints/' + ep.id, { protocol: 'anthropic' })
  for (const scenario of ['incomplete', 'error-after-usage', 'zero']) {
    for (const stream of [false, true]) {
      mode = scenario
      const before = db.prepare('SELECT balance_micros FROM users WHERE id=?').get(user.id).balance_micros
      await api(gw, 'POST', '/v1/messages', {
        headers: { authorization: 'Bearer ' + key.key },
        body: requestBody('/v1/messages', stream),
      })
      const charge = await lastCharge()
      const after = db.prepare('SELECT balance_micros FROM users WHERE id=?').get(user.id).balance_micros
      // Same as upstream: API transport's successful partial stream meters known input;
      // failed results do not meter, and zero-output successful usage still counts input.
      const expected = scenario === 'zero' || (scenario === 'incomplete' && stream) ? 200 : 0
      assert.equal(before - after, expected, `${scenario} stream=${stream}`)
      if (expected) assert.equal(charge.actual_micros, expected)
      else assert.equal(charge, undefined)
      assert.equal(db.prepare('SELECT COUNT(*) n FROM billing_reservations').get().n, 0)
    }
  }
  // Slow upload: flush the first byte, then revoke before allowing the body to complete.
  mode = 'complete'
  const body = JSON.stringify(requestBody('/v1/messages', false))
  let finishUpload
  const response = new Promise((resolve, reject) => {
    const req = http.request(
      gw.baseUrl + '/v1/messages',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + key.key,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode))
      },
    )
    req.on('error', reject)
    req.write(body.slice(0, 1))
    finishUpload = () => req.end(body.slice(1))
  })
  await call('PATCH', '/api-keys/' + key.id, { status: 'disabled' })
  const before = hits
  finishUpload()
  assert.equal(await response, 403)
  assert.equal(hits, before)
})

test('commercial Codex connection does not advertise standalone search rejected by the runtime', async (t) => {
  const gw = await startGateway()
  t.after(async () => {
    await gw.stop()
    fs.rmSync(gw.project, { recursive: true, force: true })
  })
  const call = (method, suffix, body) => api(gw, method, '/api/panel' + suffix, { body })
  const group = item(await call('POST', '/groups', { name: 'openai-search', platform: 'openai' }))
  const vm = seedVm({ project: gw.project, id: 'vm-search', oauth: false })
  vm.platform = 'openai'
  vm.family = 'codex'
  vm.codex = {}
  delete vm.claude
  fs.writeFileSync(path.join(gw.project, 'vms', vm.id + '.json'), JSON.stringify(vm))
  await call('PUT', '/vms/' + vm.id + '/groups', { group_ids: [group.id], expected_version: 0 })
  const user = item(await call('POST', '/users', { username: 'search-regression', password: 'test-password' }))
  await call('PUT', '/users/' + user.id + '/groups', { groups: [group.id] })
  const key = item(await call('POST', '/api-keys', { user_id: user.id, group_id: group.id }))
  const connection = await call('GET', '/api-keys/' + key.id + '/connection')
  assert.equal(connection.status, 200)
  assert.equal(connection.json.data.standalone_search, false)
  assert.equal(connection.json.data.websocket, true)
  assert.ok(connection.json.data.models.length > 0)
  const response = await api(gw, 'POST', '/v1/alpha/search', {
    headers: { authorization: 'Bearer ' + key.key },
    body: { query: 'test' },
  })
  assert.equal(response.status, 403)
  assert.equal(response.json.error.code, 'commercial_search_unpriced')
})
