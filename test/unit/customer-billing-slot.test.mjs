import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { FailoverRunner } from '../../src/lib/pool/failover-runner.mjs'
import { clearConversationCacheTtls } from '../../src/lib/protocol/cache-ttl.mjs'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'
import { gatewayInjectedTokens } from '../../src/lib/identity/crs-persona-usage.mjs'
import { calculateCost, costColumnsFromUsage } from '../../src/lib/admin/pricing.mjs'

// 槽位 cli-hop（生产 TonyTest 的路径）：客户计费与客户 usage 扣掉网关注入、
// 按客户自己的缓存语义计价、拒答不计费；请求日志保留上游真实消耗。
const model = 'claude-sonnet-4-5'

async function slotCall(t, { input = {}, upstream }) {
  clearConversationCacheTtls()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'customer-billing-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const routing = {
    sticky: { outbound_session: 'passthrough' },
    compatibility: { persona_preset: 'official_full', overlay_preset: 'off', cache_ttl: '1h' },
  }
  const routingFile = path.join(root, 'routing.json')
  fs.writeFileSync(routingFile, JSON.stringify(routing))
  const incoming = { model, max_tokens: 128, stream: false, messages: [{ role: 'user', content: 'Hello' }], ...input }
  const sent = []
  const vm = { id: 'fixture-slot', persona_preset: 'official_full', official_cc_inference: 'cli-hop' }
  const runner = new FailoverRunner({
    scheduler: {
      async selectAndReserve() {
        return { ok: true, vmId: vm.id, accountId: vm.id, vm, exec: { vmId: vm.id, vm, homeDir: root }, release() {} }
      },
      markSuccess() {},
      markCooldown() {},
      releaseAccountSessions() {},
    },
    config: { max_same_account_retries: 0 },
  })
  const logged = []
  const charged = []
  let finish
  const response = {
    headersSent: false,
    on(event, fn) {
      if (event === 'finish') finish = fn
    },
    once() {},
    off() {},
    write() {},
    end() {},
  }
  const handler = createHandleProtocol({
    json(_res, status, body) {
      response.status = status
      response.body = body
      return body
    },
    writeSSEHeaders() {},
    readBody: async () => structuredClone(incoming),
    requireAuth: () => true,
    cfg: {
      rewrite: { enabled: false },
      intercept: { rules: [] },
      distill: { enabled: false },
      limits: { max_body_bytes: 1024 * 1024, upstream_timeout_ms: 2000 },
      paths: { data: root, project: root },
    },
    requestLog: {
      start: () => ({ request_id: 'customer-billing-fixture' }),
      finish: (_ctx, row) => logged.push(row),
    },
    stickyRouter: { extractPoolKey: () => null, collectPoolKeys: () => [] },
    accountQuota: { ingestHeaders() {} },
    apiKeyStore: {
      canAccept: (record) => ({ ok: true, record }),
      db: {
        isTransaction: false,
        exec() {},
        prepare() {
          return { get: () => null }
        },
      },
      acquire: () => ({ ok: true }),
      release() {},
      recordUsage: (_key, usage, options) => charged.push({ usage, options }),
    },
    apiScheduler: { pick: () => ({ ok: false }) },
    apiEndpointStore: {},
    stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
    routingConfigPath: routingFile,
    routingConfig: routing,
    groupsRepo: { rateMultiplier: () => 1 },
    failoverRunner: {
      run(opts) {
        return runner.run({
          ...opts,
          callAttempt({ body }) {
            sent.push(structuredClone(body))
            return structuredClone(upstream)
          },
        })
      },
    },
  })
  await handler.handleProtocol(
    {
      method: 'POST',
      url: '/v1/messages',
      headers: { authorization: 'Bearer fixture', 'user-agent': 'test-client' },
      apiKeyKind: 'managed',
      apiKeyRecord: { id: 'fixture', name: 'TonyTest' },
      once() {},
      off() {},
    },
    response,
    'anthropic.messages',
    '/v1/messages',
  )
  finish?.()
  await new Promise((resolve) => setImmediate(resolve))
  return { response, logged, charged, sent, incoming }
}

const okMessage = (usage, extra = {}) => ({
  ok: true,
  status: 200,
  terminalState: 'verified',
  body: {
    id: 'fixture',
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text: 'OK' }],
    stop_reason: 'end_turn',
    usage,
    ...extra,
  },
})
const hourWrite = (tokens) => ({
  cache_creation_input_tokens: tokens,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: tokens },
})

test('cli-hop: injected persona is excluded from billed and reported usage; no cache_control bills as input', async (t) => {
  const raw = { input_tokens: 12, ...hourWrite(5000), output_tokens: 20 }
  const { response, logged, charged, sent, incoming } = await slotCall(t, { upstream: okMessage(raw) })
  assert.equal(response.status, 200, JSON.stringify(response.body))
  assert.equal(sent.length, 1)
  const injected = gatewayInjectedTokens(incoming, sent[0])
  assert.ok(injected > 300, `injected=${injected}`)
  // 客户没写 cache_control：剩余缓存写入并入 input，缓存桶归零
  const client = response.body.usage
  assert.equal(client.input_tokens, 12 + 5000 - injected)
  assert.equal(client.cache_creation_input_tokens, 0)
  assert.deepEqual(client.cache_creation, { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 })
  assert.equal(charged.length, 1)
  assert.deepEqual(
    { input: charged[0].usage.input_tokens, cache: charged[0].usage.cache_creation_input_tokens },
    { input: client.input_tokens, cache: 0 },
  )
  assert.equal(
    charged[0].options.officialCostMicros,
    calculateCost({ input_tokens: client.input_tokens, output_tokens: 20 }, model).total_cost_micros,
  )
  // 账号口径：请求日志的 token 与 total_cost 仍是上游真实值
  assert.equal(logged.length, 1)
  assert.equal(logged[0].usage.input_tokens, 12)
  assert.equal(logged[0].usage.cache_creation_input_tokens, 5000)
  assert.equal(logged[0].total_cost, costColumnsFromUsage(raw, model).total_cost)
  assert.ok(charged[0].options.officialCostMicros < logged[0].total_cost_micros)
})

test('cli-hop: caller cache_control without ttl is billed at the 5m write price although 1h went upstream', async (t) => {
  const raw = { input_tokens: 3, ...hourWrite(4000), output_tokens: 5 }
  const { response, charged, sent, incoming } = await slotCall(t, {
    input: {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello', cache_control: { type: 'ephemeral' } }] }],
    },
    upstream: okMessage(raw),
  })
  assert.equal(response.status, 200, JSON.stringify(response.body))
  // 网关把无 ttl 标记补成了 1h 发往上游
  assert.ok(JSON.stringify(sent[0].messages).includes('"ttl":"1h"'))
  const injected = gatewayInjectedTokens(incoming, sent[0])
  const expected = { ephemeral_5m_input_tokens: 4000 - injected, ephemeral_1h_input_tokens: 0 }
  assert.deepEqual(response.body.usage.cache_creation, expected)
  assert.deepEqual(charged[0].usage.cache_creation, expected)
  assert.equal(charged[0].usage.input_tokens, 3)
  const price = calculateCost(charged[0].usage, model)
  assert.equal(price.cache_creation_1h_cost, 0)
  assert.equal(charged[0].options.officialCostMicros, price.total_cost_micros)
})

test('cli-hop: explicit 1h ttl is billed at the 1h write price', async (t) => {
  const raw = { input_tokens: 3, ...hourWrite(4000), output_tokens: 5 }
  const { charged, sent, incoming } = await slotCall(t, {
    input: {
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Hello', cache_control: { type: 'ephemeral', ttl: '1h' } }] },
      ],
    },
    upstream: okMessage(raw),
  })
  const injected = gatewayInjectedTokens(incoming, sent[0])
  assert.deepEqual(charged[0].usage.cache_creation, {
    ephemeral_5m_input_tokens: 0,
    ephemeral_1h_input_tokens: 4000 - injected,
  })
  assert.ok(calculateCost(charged[0].usage, model).cache_creation_1h_cost > 0)
})

for (const [name, committed, billed] of [
  ['after output was committed is billed by the upstream usage', true, 1],
  ['before any output is not billed', false, 0],
]) {
  test(`slot path: client cancel ${name} (audit P0-2)`, async (t) => {
    const usage = { input_tokens: 1200, output_tokens: 300 }
    const { charged } = await slotCall(t, {
      upstream: {
        ok: false,
        status: 499,
        clientCancelled: true,
        terminalState: 'cancelled',
        committed,
        usage,
        body: { type: 'error', error: { type: 'client_cancelled', code: 'client_cancelled', message: 'gone' } },
      },
    })
    assert.equal(charged.length, billed)
    if (billed) assert.equal(charged[0].usage.output_tokens, 300)
  })
}

for (const [name, content] of [
  ['silent refusal', []],
  ['refusal after visible text', [{ type: 'text', text: 'I can help with part of that, but' }]],
]) {
  test(`slot path: ${name} is not billed and stays unmetered`, async (t) => {
    const raw = { input_tokens: 9000, output_tokens: 3 }
    const { logged, charged } = await slotCall(t, {
      upstream: okMessage(raw, { content, stop_reason: 'refusal' }),
    })
    assert.equal(charged.length, 0)
    assert.equal(logged.length, 1)
    assert.equal(logged[0].billing_status, 'unmetered')
    assert.equal(logged[0].actual_cost, null)
    // 账号侧仍记录真实消耗
    assert.equal(logged[0].usage.input_tokens, 9000)
  })
}
