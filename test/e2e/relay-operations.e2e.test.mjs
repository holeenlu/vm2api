import test from 'node:test'
import assert from 'node:assert/strict'
import { startGateway, api } from '../harness.mjs'

async function login(gw, username, password) {
  const r = await api(gw, 'POST', '/api/panel/login', { body: { username, password } })
  assert.equal(r.status, 200, r.text)
  return { authorization: '', cookie: r.headers.get('set-cookie') }
}
const item = (r) => r.json?.data?.item || r.json?.item
const data = (r) => r.json?.data || r.json

test('commercial HTTP flow: staff resources, customer keys, wallet, isolated history and revocation', async () => {
  const gw = process.env.RELAY_ACCEPTANCE_URL
    ? {
        baseUrl: process.env.RELAY_ACCEPTANCE_URL,
        apiKey: process.env.RELAY_ACCEPTANCE_KEY || '',
        stderr: () => '',
        stop: async () => {},
      }
    : await startGateway({ disableWatchdog: true })
  try {
    const admin = await login(gw, 'admin', 'testpass')
    const call = (method, path, body, headers = admin) => api(gw, method, '/api/panel' + path, { body, headers })
    const createUser = async (username, role = 'user') => {
      const r = await call('POST', '/users', { username, password: 'acceptance-pass-2026', role, concurrency: 2 })
      assert.equal(r.status, 201, r.text)
      return item(r)
    }
    const customer = await createUser('relay-customer'),
      other = await createUser('relay-other'),
      operator = await createUser('relay-ops', 'super_admin')
    const user = await login(gw, customer.username, 'acceptance-pass-2026'),
      second = await login(gw, other.username, 'acceptance-pass-2026'),
      superUser = await login(gw, operator.username, 'acceptance-pass-2026')
    for (const [method, path, body] of [
      ['GET', '/vms'],
      ['POST', '/vms/create', { id: 'forbidden' }],
      ['GET', '/proxies'],
      ['POST', '/groups', { name: 'forbidden' }],
      ['POST', '/users/' + customer.id + '/balance', { amount: 100 }],
    ])
      assert.equal((await call(method, path, body, user)).status, 403, path)
    assert.equal((await call('GET', '/vms', undefined, superUser)).status, 200)
    assert.equal((await api(gw, 'GET', '/v1/models', { headers: user })).status, 403)
    assert.equal(
      (
        await api(gw, 'POST', '/v1/messages', {
          headers: user,
          body: { model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'bypass' }] },
        })
      ).status,
      403,
    )
    assert.equal((await call('POST', '/users/' + customer.id + '/balance', { amount: 100 }, user)).status, 403)
    const made = await call('POST', '/groups', {
      name: 'Claude 商业测试',
      platform: 'anthropic',
      is_exclusive: true,
      models: ['claude-sonnet-5'],
      rate_multiplier: 2,
    })
    assert.equal(
      (await call('POST', '/billing/requests/retired', { action: 'release', reason: 'retired' })).status,
      404,
    )
    const ops = data(await call('GET', '/ops'))
    assert.equal(ops.billing_pending, undefined)
    assert.equal(
      ops.alerts.some((alert) => alert.code === 'billing_pending'),
      false,
    )
    assert.equal(made.status, 201, made.text)
    const group = item(made)
    const group2 = item(
      await call('POST', '/groups', {
        name: 'Claude 第二组',
        platform: 'anthropic',
        is_exclusive: true,
        models: ['claude-sonnet-5'],
      }),
    )
    const assigned = await call(
      'PUT',
      '/vms/vm-sim-01/groups',
      { group_ids: [group.id, group2.id], expected_version: 0 },
      superUser,
    )
    assert.equal(assigned.status, 200, assigned.text)
    assert.equal(data(assigned).group_ids.length, 2)
    const listed = data(await call('GET', '/vms')).items.find((v) => v.id === 'vm-sim-01')
    assert.equal(listed.groups.length, 2)
    assert.equal(listed.groups_version, 1)
    const detail = data(await call('GET', '/vms/vm-sim-01'))
    assert.equal((detail.vm || detail).groups.length, 2)
    assert.equal((await call('PUT', '/vms/vm-sim-01/groups', { group_ids: [], expected_version: 0 })).status, 409)
    const failedBatch = await call(
      'POST',
      '/vms/groups/batch',
      {
        operation: 'remove',
        group_ids: [group2.id],
        items: [
          { id: 'vm-sim-01', expected_version: 1 },
          { id: 'missing-vm', expected_version: 0 },
        ],
      },
      superUser,
    )
    assert.equal(failedBatch.status, 404)
    const unchanged = data(await call('GET', '/vms')).items.find((v) => v.id === 'vm-sim-01')
    assert.equal(unchanged.groups_version, 1)
    assert.equal(unchanged.groups.length, 2)
    for (const [operation, version, ids, size] of [
      ['remove', 1, [group2.id], 1],
      ['add', 2, [group2.id], 2],
      ['replace', 3, [group.id, group2.id], 2],
    ]) {
      const batch = await call(
        'POST',
        '/vms/groups/batch',
        {
          operation,
          group_ids: ids,
          items: [{ id: 'vm-sim-01', expected_version: version }],
        },
        superUser,
      )
      assert.equal(batch.status, 200, batch.text)
      assert.equal(data(batch).items[0].groups.length, size)
      assert.equal(data(batch).items[0].groups_version, version + 1)
    }
    assert.equal((await call('PATCH', '/vms/vm-sim-01/owner', { owner_user_id: customer.id })).status, 404)
    assert.equal((await call('GET', '/vm-pools')).status, 404)
    assert.equal((await call('POST', '/api-keys', { name: 'no grant', group_id: group.id }, user)).status, 403)
    assert.equal(
      (
        await call('PUT', '/users/' + customer.id + '/groups', {
          groups: [{ group_id: group.id, rate_multiplier: 1.5 }],
        })
      ).status,
      200,
    )
    const credit = { amount: 10, reason: '验收充值', idempotency_key: 'accept-credit-001' }
    const service = data(await call('GET', '/groups', undefined, user)).items.find((g) => g.id === group.id)
    assert.equal(service.rate_multiplier, 1.5)
    assert.equal(service.prices, undefined)
    assert.equal(service.usage.total_cost, 0)
    assert.equal(service.capacity, undefined)
    const operationsGroup = data(await call('GET', '/groups', undefined, superUser)).items.find(
      (g) => g.id === group.id,
    )
    assert.equal(operationsGroup.prices, undefined)
    assert.equal(operationsGroup.usage.total_cost, 0)
    assert.equal(operationsGroup.capacity.resources, 1)
    const credited = await call('POST', '/users/' + customer.id + '/balance', credit)
    assert.equal(credited.status, 200, credited.text)
    assert.equal(data(await call('POST', '/users/' + customer.id + '/balance', credit)).balance, 10)
    const created = await call(
      'POST',
      '/api-keys',
      { name: '客户 Key', group_id: group.id, user_id: other.id, category: 'api' },
      user,
    )
    assert.equal(created.status, 201, created.text)
    const key = item(created)
    assert.equal(key.user_id, customer.id)
    assert.equal(key.category, 'oauth')
    const key2 = item(await call('POST', '/api-keys', { name: '第二 Key', group_id: group.id }, user))
    assert.equal((await call('POST', '/api-keys/' + key.id + '/reveal', {}, second)).status, 404)
    const inference = async (k, model = 'claude-sonnet-5', stream = false) =>
      api(gw, 'POST', '/v1/messages', {
        headers: { authorization: 'Bearer ' + k, 'x-request-id': 'same-caller-controlled-id' },
        body: { model, max_tokens: 32, stream, messages: [{ role: 'user', content: 'Please answer with pong.' }] },
      })
    const result = await inference(key.key)
    assert.equal(result.status, 200, result.text + '\n' + gw.stderr())
    const streamed = await inference(key2.key, 'claude-sonnet-5', true)
    assert.equal(streamed.status, 200, streamed.text)
    assert.match(streamed.text, /message_stop/)
    const wallet = data(await call('GET', '/billing', undefined, user))
    assert.ok(wallet.balance < 10 && wallet.balance > 0, JSON.stringify(wallet) + gw.stderr())
    assert.equal(wallet.reserved, undefined)
    assert.equal(wallet.items.filter((r) => r.kind === 'usage').length, 0)
    const keySpend = (await call('GET', '/api-keys', undefined, user)).json.keys.reduce(
      (sum, k) => sum + k.quota_usd_used,
      0,
    )
    assert.ok(keySpend > 0)
    const rows = data(await call('GET', '/usage-logs', undefined, user)).logs
    assert.equal(rows.length, 2, JSON.stringify(rows))
    for (const r of rows) {
      assert.equal(r.vmId, undefined)
      assert.equal(r.providerChain, undefined)
      assert.equal(r.accountId, undefined)
      assert.equal(r.actualResponseModel, undefined)
      assert.equal(r.costUsd, r.actualCostUsd)
    }
    assert.equal(data(await call('GET', '/usage-logs?user_id=' + customer.id, undefined, second)).logs.length, 0)
    assert.equal((await call('GET', '/request-logs?mode=debug', undefined, user)).status, 403)
    const exported = await call('GET', '/request-logs/export?format=jsonl', undefined, user)
    assert.equal(exported.status, 200)
    assert.doesNotMatch(exported.text, /acct-seed|vm-sim-01|sk-ant-oat/)
    const ranking = await call('GET', '/usage-logs/ranking?scope=key', undefined, user)
    assert.equal(ranking.status, 200, ranking.text)
    assert.equal(data(ranking).entries.length, 2)
    assert.ok(data(ranking).entries.every((e) => !e.owner))
    assert.equal((await call('GET', '/usage-logs/ranking?scope=user', undefined, user)).status, 403)
    const global = data(await call('GET', '/usage-logs'))
    assert.equal(global.logs.length, 2)
    assert.equal((await inference(key.key, 'claude-opus-5')).status, 403)
    const badIp = await call('PATCH', '/api-keys/' + key.id, { ip_whitelist: ['invalid-ip'] }, user)
    assert.equal(badIp.status, 400, badIp.text)
    assert.equal((await call('PATCH', '/api-keys/' + key.id, { ip_whitelist: ['192.0.2.0/24'] }, user)).status, 200)
    assert.equal((await inference(key.key)).status, 403)
    await call('PUT', '/users/' + customer.id + '/groups', { groups: [] })
    assert.equal((await inference(key2.key)).status, 403)
    assert.equal((await call('GET', '/ops', undefined, superUser)).status, 200)
    assert.doesNotMatch(gw.stderr(), /recoverable transaction failure|settlement pending/)
  } finally {
    await gw.stop()
  }
})

test('API endpoint backend uses the same group and wallet settlement, then loses access when detached', async () => {
  const gw = await startGateway({ disableWatchdog: true })
  const { default: http } = await import('node:http')
  const { default: path } = await import('node:path')
  const socket = path.join(gw.project, 'data', 'run', 'api-kernel.sock')
  const upstreamUrls = []
  const mock = http.createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const envelope = JSON.parse(raw),
      body = JSON.parse(envelope.body)
    upstreamUrls.push(envelope.url)
    assert.match(envelope.url, /allowed\.example/)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const message = {
      id: 'msg_api',
      type: 'message',
      role: 'assistant',
      content: [],
      model: body.model,
      usage: { input_tokens: 100, output_tokens: 0 },
    }
    const events = [
      ['message_start', { type: 'message_start', message }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
      [
        'content_block_delta',
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'API pong' } },
      ],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      [
        'message_delta',
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 100, output_tokens: 25 } },
      ],
      ['message_stop', { type: 'message_stop' }],
    ]
    for (const [type, event] of events) res.write('event: ' + type + '\ndata: ' + JSON.stringify(event) + '\n\n')
    res.end()
  })
  await new Promise((resolve) => mock.listen(socket, resolve))
  try {
    const admin = await login(gw, 'admin', 'testpass')
    const call = (method, path, body, headers = admin) => api(gw, method, '/api/panel' + path, { body, headers })
    const user = item(
      await call('POST', '/users', { username: 'api-customer', password: 'acceptance-pass-2026', role: 'user' }),
    )
    const session = await login(gw, user.username, 'acceptance-pass-2026')
    const ep = item(
      await call('POST', '/api-endpoints', {
        name: 'mock API',
        kind: 'custom',
        protocol: 'anthropic',
        base_url: 'https://allowed.example',
        api_key_entries: [{ api_key: 'sk-test-upstream-secret' }],
        models: [{ name: 'claude-sonnet-5', alias: 'claude-sonnet-5' }],
      }),
    )
    assert.ok(ep, 'created API endpoint')
    const secondEp = item(
      await call('POST', '/api-endpoints', {
        name: 'second API',
        kind: 'custom',
        protocol: 'anthropic',
        base_url: 'https://allowed.example/second',
        api_key_entries: [{ api_key: 'sk-test-second-upstream-secret' }],
        models: [{ name: 'claude-sonnet-5', alias: 'claude-sonnet-5' }],
      }),
    )
    const g = item(
      await call('POST', '/groups', {
        name: 'API commercial',
        platform: 'anthropic',
        models: ['claude-sonnet-5'],
        rate_multiplier: 2,
      }),
    )
    assert.equal(
      (
        await call('PUT', '/groups/' + g.id + '/resources', {
          resources: [
            { resource_kind: 'api_endpoint', resource_id: ep.id, priority: 1 },
            { resource_kind: 'api_endpoint', resource_id: secondEp.id, priority: 90 },
          ],
          expected_version: g.version,
        })
      ).status,
      200,
    )
    await call('PUT', '/users/' + user.id + '/groups', { groups: [g.id] })
    await call('POST', '/users/' + user.id + '/balance', {
      amount: 1,
      reason: 'API acceptance',
      idempotency_key: 'api-credit-0001',
    })
    const k = item(await call('POST', '/api-keys', { name: 'API Key', group_id: g.id }, session))
    assert.equal(k.category, 'api')
    const infer = () =>
      api(gw, 'POST', '/v1/messages', {
        headers: { authorization: 'Bearer ' + k.key },
        body: { model: 'claude-sonnet-5', max_tokens: 50, messages: [{ role: 'user', content: 'pong' }] },
      })
    const result = await infer()
    assert.equal(result.status, 200, result.text + gw.stderr())
    const secondResult = await infer()
    assert.equal(secondResult.status, 200, secondResult.text + gw.stderr())
    assert.equal(
      new Set(upstreamUrls).size,
      2,
      'API addresses keep upstream round-robin despite historical group priorities',
    )
    const wallet = data(await call('GET', '/billing', undefined, session))
    assert.ok(wallet.balance < 1 && wallet.balance > 0, JSON.stringify(wallet) + gw.stderr())
    assert.equal(wallet.items.filter((r) => r.kind === 'usage').length, 0)
    assert.equal(data(await call('GET', '/usage-logs', undefined, session)).logs.length, 2)
    const current = item(await call('GET', '/groups/' + g.id))
    await call('PUT', '/groups/' + g.id + '/resources', { resources: [], expected_version: current.version })
    assert.notEqual((await infer()).status, 200)
    assert.equal(upstreamUrls.length, 2)
    assert.equal(data(await call('GET', '/billing', undefined, session)).reserved, undefined)
  } finally {
    await new Promise((resolve) => mock.close(resolve))
    await gw.stop()
  }
})

test('OpenAI API groups route through API supply and settle Responses and Chat without a Codex VM', async () => {
  const gw = await startGateway({ disableWatchdog: true })
  const { default: http } = await import('node:http')
  const { default: path } = await import('node:path')
  const mock = http.createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const envelope = JSON.parse(raw),
      body = JSON.parse(envelope.body)
    assert.match(envelope.url, /\/responses/)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const response = {
      id: 'resp_fixture',
      object: 'response',
      status: 'completed',
      model: body.model,
      output: [
        {
          id: 'msg_fixture',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'GPT pong' }],
        },
      ],
      usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110, input_tokens_details: { cached_tokens: 20 } },
    }
    const events = [
      { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { ...response.output[0], content: [] } },
      {
        type: 'response.content_part.added',
        item_id: 'msg_fixture',
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: '' },
      },
      {
        type: 'response.output_text.delta',
        item_id: 'msg_fixture',
        output_index: 0,
        content_index: 0,
        delta: 'GPT pong',
      },
      {
        type: 'response.output_text.done',
        item_id: 'msg_fixture',
        output_index: 0,
        content_index: 0,
        text: 'GPT pong',
      },
      { type: 'response.output_item.done', output_index: 0, item: response.output[0] },
      { type: 'response.completed', response },
    ]
    res.end(events.map((e) => 'event: ' + e.type + '\ndata: ' + JSON.stringify(e) + '\n\n').join(''))
  })
  await new Promise((resolve) => mock.listen(path.join(gw.project, 'data', 'run', 'api-kernel.sock'), resolve))
  try {
    const call = (method, path, body) => api(gw, method, '/api/panel' + path, { body })
    const user = item(
      await call('POST', '/users', { username: 'gpt-customer', password: 'acceptance-pass-2026', role: 'user' }),
    )
    const ep = item(
      await call('POST', '/api-endpoints', {
        name: 'OpenAI fixture',
        kind: 'openai',
        api_key_entries: [{ api_key: 'sk-test-fixture' }],
        models: [{ name: 'gpt-5.4', alias: 'gpt-5.4' }],
      }),
    )
    const g = item(await call('POST', '/groups', { name: 'GPT API', platform: 'openai', models: ['gpt-5.4'] }))
    assert.equal(
      (
        await call('PUT', '/groups/' + g.id + '/resources', {
          resources: [{ resource_kind: 'api_endpoint', resource_id: ep.id }],
          expected_version: g.version,
        })
      ).status,
      200,
    )
    await call('PUT', '/users/' + user.id + '/groups', { groups: [g.id] })
    await call('POST', '/users/' + user.id + '/balance', {
      amount: 10,
      reason: 'GPT acceptance',
      idempotency_key: 'gpt-credit-0001',
    })
    const key = item(await call('POST', '/api-keys', { name: 'GPT Key', user_id: user.id, group_id: g.id }))
    for (const [route, body] of [
      ['/v1/chat/completions', { messages: [{ role: 'user', content: 'hello' }], max_completion_tokens: 32 }],
      ['/v1/responses', { input: 'hello', max_output_tokens: 32 }],
    ]) {
      const result = await api(gw, 'POST', route, {
        headers: { authorization: 'Bearer ' + key.key },
        body: { model: 'gpt-5.4', ...body },
      })
      assert.equal(result.status, 200, result.text + gw.stderr())
      assert.match(result.text, /GPT pong/)
    }
    const wallet = data(await call('GET', '/users/' + user.id + '/balance-history'))
    assert.equal(wallet.items.filter((r) => r.kind === 'usage').length, 0, JSON.stringify(wallet) + gw.stderr())
    assert.equal(data(await call('GET', '/usage-logs?user_id=' + user.id)).logs.length, 2)
    assert.ok(wallet.balance < 10)
    assert.equal(wallet.reserved, undefined)
  } finally {
    await new Promise((resolve) => mock.close(resolve))
    await gw.stop()
  }
})
