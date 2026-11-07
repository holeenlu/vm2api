import test from 'node:test'
import assert from 'node:assert/strict'
import { runGatewayAccountTestChat } from '../../src/lib/gateway-worker/gateway-test-chat.mjs'

const account = { id: 'acct-1', name: 'codex-cn-01', status: 'active' }
const sse = (events) =>
  new ReadableStream({
    start(c) {
      for (const e of events) c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(e)}\n\n`))
      c.close()
    },
  })
function service(result) {
  const calls = []
  return {
    calls,
    repo: { getAccountBinding: () => ({ runtime_account_id: 'gwacct_acct-1' }) },
    async execute(opts) {
      calls.push(opts)
      return typeof result === 'function' ? result(opts) : result
    },
  }
}

test('test chat pins the Worker request to this account and returns the reply', async () => {
  const svc = service({
    ok: true,
    status: 200,
    stream: true,
    instance_id: 'gw-1',
    headers: { 'content-type': 'text/event-stream' },
    body: sse([
      { type: 'response.output_text.delta', delta: 'Hi ' },
      { type: 'response.output_text.delta', delta: 'there' },
      {
        type: 'response.completed',
        response: { id: 'r1', model: 'gpt-5.5', status: 'completed', usage: { input_tokens: 3 } },
      },
    ]),
  })
  const out = await runGatewayAccountTestChat({ service: svc, account, body: { model: 'gpt-5.5', prompt: 'hello' } })
  assert.equal(out.ok, true)
  assert.equal(out.text, 'Hi there')
  assert.equal(out.via, 'gateway-worker')
  assert.deepEqual(out.usage, { input_tokens: 3 })
  assert.equal(svc.calls[0].scope.runtime_account_id, 'gwacct_acct-1')
  assert.equal(svc.calls[0].scope.account_resource_id, 'acct-1')
  assert.equal(svc.calls[0].body.stream, true)
  assert.equal(svc.calls[0].body.reasoning.effort, 'medium')
})

test('test chat surfaces upstream errors and rejects non-GPT models before sending', async () => {
  const svc = service({
    ok: false,
    status: 401,
    stream: true,
    headers: { 'content-type': 'application/json' },
    body: new Response(JSON.stringify({ error: { code: 'token_revoked', message: 'revoked' } })).body,
  })
  const failed = await runGatewayAccountTestChat({ service: svc, account, body: { model: 'gpt-5.5' } })
  assert.equal(failed.ok, false)
  assert.equal(failed.status, 401)
  assert.equal(failed.error.code, 'token_revoked')
  const claude = await runGatewayAccountTestChat({ service: svc, account, body: { model: 'claude-haiku-5-5' } })
  assert.equal(claude.ok, false)
  assert.equal(claude.error.code, 'model_not_allowed')
  assert.equal(svc.calls.length, 1)
})

test('test chat routes through BPS when asked and reports the actual channel', async () => {
  const svc = service(() => ({
    ok: true,
    status: 200,
    stream: true,
    headers: { 'content-type': 'text/event-stream', 'x-kin-gateway-auth-mode': 'bps' },
    body: sse([{ type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', status: 'completed' } }]),
  }))
  const out = await runGatewayAccountTestChat({ service: svc, account, body: { model: 'gpt-5.5', route: 'bps' } })
  assert.equal(out.ok, true)
  assert.equal(out.authorization_mode, 'bps')
  assert.deepEqual(svc.calls[0].scheduling, { bps_enabled: true, route_policy: 'bps_only' })
  await runGatewayAccountTestChat({ service: svc, account, body: { model: 'gpt-5.5', route: 'native' } })
  assert.deepEqual(svc.calls[1].scheduling, { route_policy: 'native_only' })
  await runGatewayAccountTestChat({ service: svc, account, body: { model: 'gpt-5.5' } })
  assert.deepEqual(svc.calls[2].scheduling, { bps_enabled: true })
})

test('strict probe verifies the tool round trip, nonce, channel and model', async () => {
  let nonce = null
  const svc = service((opts) => {
    if (!nonce) nonce = /nonce "([0-9a-f]+)"/.exec(opts.body.input[0].content[0].text)[1]
    const second = opts.body.input.some((item) => item.type === 'function_call_output')
    const call = {
      type: 'function_call',
      call_id: 'call_1',
      name: 'kin_probe_echo',
      arguments: JSON.stringify({ nonce }),
    }
    return {
      ok: true,
      status: 200,
      stream: true,
      headers: { 'content-type': 'text/event-stream', 'x-kin-gateway-auth-mode': 'bps' },
      body: sse(
        second
          ? [
              { type: 'response.output_text.delta', delta: 'done' },
              { type: 'response.completed', response: { id: 'r2', model: 'gpt-5.5', status: 'completed', output: [] } },
            ]
          : [
              { type: 'response.output_item.done', item: call },
              {
                type: 'response.completed',
                response: { id: 'r1', model: 'gpt-5.5', status: 'completed', output: [call] },
              },
            ],
      ),
    }
  })
  const out = await runGatewayAccountTestChat({
    service: svc,
    account,
    body: { model: 'gpt-5.5', route: 'bps', verify_tools: true },
  })
  assert.equal(out.ok, true, JSON.stringify(out.error))
  assert.equal(out.probe.verified, true)
  assert.equal(out.probe.mode, 'bps')
  assert.equal(out.text, 'done')
  assert.equal(svc.calls.length, 2)
  assert.equal(svc.calls[0].body.tools[0].name, 'kin_probe_echo')
  const output = svc.calls[1].body.input.find((item) => item.type === 'function_call_output')
  assert.equal(output.call_id, 'call_1')
  // 走错通道或模型不符时失败
  const wrong = service(() => ({
    ok: true,
    status: 200,
    stream: true,
    headers: { 'content-type': 'text/event-stream', 'x-kin-gateway-auth-mode': 'native' },
    body: sse([
      { type: 'response.completed', response: { id: 'r', model: 'gpt-5.5', status: 'completed', output: [] } },
    ]),
  }))
  const mismatch = await runGatewayAccountTestChat({
    service: wrong,
    account,
    body: { model: 'gpt-5.5', route: 'bps', verify_tools: true },
  })
  assert.equal(mismatch.error.code, 'probe_route_mismatch')
})
