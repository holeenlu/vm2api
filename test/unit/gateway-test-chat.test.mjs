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
