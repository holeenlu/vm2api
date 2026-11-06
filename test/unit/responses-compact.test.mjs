import test from 'node:test'
import assert from 'node:assert/strict'
import { compactResponsesBody, handleResponsesCompact } from '../../src/lib/protocol/responses-compact.mjs'

function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: null,
    writableEnded: false,
    destroyed: false,
    setHeader(name, value) {
      this.headers[name] = value
    },
    once() {},
  }
}

const json = (res, status, body) => {
  res.statusCode = status
  res.body = body
  res.writableEnded = true
}

test('compaction requests become Responses requests ending with a compaction trigger', () => {
  const body = compactResponsesBody({ model: 'gpt-5.5', input: 'long', previous_response_id: 'resp_x', stream: true })
  assert.deepEqual(body.input.at(-1), { type: 'compaction_trigger' })
  assert.equal(body.tool_choice, 'none')
  assert.equal(body.stream, false)
  assert.equal(body.previous_response_id, undefined)
  assert.equal(compactResponsesBody({ model: 'gpt-5.5' }), null)
})

test('the compact endpoint returns the compaction output of the inner Responses call', async () => {
  let inner
  const res = fakeRes()
  const req = { headers: { authorization: 'Bearer k', 'transfer-encoding': 'chunked' }, socket: {}, once() {} }
  await handleResponsesCompact(req, res, {
    readBody: async () => ({ model: 'gpt-5.5', input: [{ role: 'user', content: 'hi' }] }),
    json,
    async handleProtocol(protocolReq, captured) {
      const chunks = []
      for await (const chunk of protocolReq) chunks.push(chunk)
      inner = { headers: protocolReq.headers, body: JSON.parse(Buffer.concat(chunks).toString()) }
      captured.writeHead(200, { 'content-type': 'application/json' })
      captured.end(
        JSON.stringify({
          object: 'response',
          id: 'resp_c',
          output: [{ type: 'compaction', encrypted_content: 'x' }],
          usage: { input_tokens: 3 },
        }),
      )
    },
  })
  assert.equal(inner.headers.authorization, 'Bearer k')
  assert.equal(inner.headers['transfer-encoding'], undefined)
  assert.deepEqual(inner.body.input.at(-1), { type: 'compaction_trigger' })
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.object, 'response.compaction')
  assert.equal(res.body.output[0].type, 'compaction')
  assert.deepEqual(res.body.usage, { input_tokens: 3 })
})

test('compact errors keep the upstream status and body', async () => {
  const res = fakeRes()
  await handleResponsesCompact({ headers: {}, socket: {}, once() {} }, res, {
    readBody: async () => ({ model: 'gpt-5.5', input: 'x' }),
    json,
    async handleProtocol(_req, captured) {
      captured.setHeader('retry-after', '3')
      captured.writeHead(503, { 'content-type': 'application/json' })
      captured.end(JSON.stringify({ error: { code: 'server_is_overloaded' } }))
    },
  })
  assert.equal(res.statusCode, 503)
  assert.equal(res.headers['retry-after'], '3')
  assert.equal(res.body.error.code, 'server_is_overloaded')
})
