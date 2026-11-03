import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { handleCodexProtocol } from '../../src/lib/protocol/handle-codex.mjs'
import { streamCodexKernel } from '../../src/lib/transport/codex-kernel-client.mjs'
import { streamGoWorker } from '../../src/lib/transport/go-worker-client.mjs'
import { resetOpenAIAccountRuntime } from '../../src/lib/pool/openai-account-runtime.mjs'

const unixTest = process.platform === 'win32' ? test.skip : test
const usage = { input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 3 } }
const overload = { type: 'server_error', code: 'server_is_overloaded', status: 503, message: 'Upstream is overloaded' }
const created = { type: 'response.created', response: { id: 'resp_test', status: 'in_progress' } }
const output = { type: 'response.output_text.delta', delta: 'hello' }
const completed = {
  type: 'response.completed',
  response: { id: 'resp_test', status: 'completed', usage },
}
const failed = (error = overload, extra = {}) => ({
  type: 'response.failed',
  response: { id: 'resp_test', status: 'failed', error, ...extra },
})

function writeEvents(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`)
  res.end()
}

async function fixture(t, respond) {
  resetOpenAIAccountRuntime()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-'))
  const servers = []
  t.after(async () => {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))))
    fs.rmSync(root, { recursive: true, force: true })
    resetOpenAIAccountRuntime()
  })
  const tokenFile = path.join(root, 'internal.token')
  fs.writeFileSync(tokenFile, 'test-only')
  const calls = []
  const results = []
  for (const id of ['gpt-a', 'gpt-b']) {
    const socket = path.join(root, `${id}.sock`)
    const vm = {
      id,
      platform: 'openai',
      family: 'codex',
      schedulable: true,
      status: 'running',
      runtime: { codex_kernel_socket: socket, worker_token_file: tokenFile },
    }
    fs.mkdirSync(path.join(root, 'vms', id), { recursive: true })
    fs.writeFileSync(path.join(root, 'vms', `${id}.json`), JSON.stringify(vm))
    fs.writeFileSync(
      path.join(root, 'vms', id, 'codex-credentials.json'),
      JSON.stringify({ accounts: [{ id, access_token: 'test-only', chatgpt_account_id: id }] }),
    )
    const server = http.createServer((req, res) => {
      req.resume()
      assert.equal(req.headers['x-kin-internal-token'], 'test-only')
      if (req.url === '/internal/v1/cancel') return res.end('{"ok":true}')
      assert.equal(req.url, '/internal/v1/codex/responses')
      calls.push(id)
      respond(id, res)
    })
    servers.push(server)
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(socket, resolve)
    })
  }
  const chunks = []
  const res = {
    statusCode: 0,
    headersSent: false,
    write(chunk) {
      chunks.push(chunk)
    },
    end() {},
  }
  const body = { model: 'gpt-6.1-sol', input: 'test', stream: true }
  const args = {
    req: { headers: {}, apiKeyKind: 'master' },
    res,
    protocol: 'openai.responses',
    ctx: { body },
    inbound: body,
    logBag: {},
    stats: { errors: 0, requests: 0, by_route: {} },
    projectRoot: root,
    routing: { failover: { max_total_attempts: 2, max_same_account_retries: 0, max_account_switches: 1 } },
    json(_res, status, payload) {
      res.statusCode = status
      res.body = payload
    },
    writeSSEHeaders() {
      res.statusCode = 200
      res.headersSent = true
    },
    ops: {
      writeCodexKernelConfig() {},
      ensureCodexKernel: async () => ({ ok: true }),
      async streamCodexKernel(opts) {
        const result = await streamCodexKernel(opts)
        results.push(result)
        return result
      },
    },
  }
  return { args, res, calls, results, chunks, root, tokenFile, servers }
}

for (const [name, event] of [
  ['top-level error', { type: 'error', status: 503, error: overload }],
  ['nested response.failed', failed()],
]) {
  unixTest(`${name} before output is buffered and follows existing failover`, async (t) => {
    const fx = await fixture(t, (id, res) =>
      writeEvents(res, id === 'gpt-a' ? [created, event] : [created, output, completed]),
    )
    await handleCodexProtocol(fx.args)
    assert.deepEqual(fx.calls, ['gpt-a', 'gpt-b'])
    assert.equal(fx.results[0].committed, false)
    assert.equal(fx.results[0].explicitFailure, true)
    assert.equal(fx.results[0].status, 503)
    assert.equal(fx.results[0].body.error.code, overload.code)
    assert.equal(fx.res.statusCode, 200)
    assert.equal(fx.args.logBag.final_state, 'verified')
    assert.doesNotMatch(fx.chunks.join(''), /server_is_overloaded|response.failed/)
  })
}

for (const [name, event] of [
  ['nested response.failed', failed(overload, { usage })],
  ['top-level error', { type: 'error', status: 503, error: overload, usage }],
]) {
  unixTest(`${name} after output keeps usage evidence without replay or verified success`, async (t) => {
    const fx = await fixture(t, (_id, res) => writeEvents(res, [created, output, event]))
    await handleCodexProtocol(fx.args)
    assert.deepEqual(fx.calls, ['gpt-a'])
    assert.equal(fx.results[0].committed, true)
    assert.equal(fx.results[0].explicitFailure, true)
    assert.deepEqual(fx.results[0].usage, usage)
    assert.equal(fx.res.statusCode, 200)
    assert.equal(fx.args.logBag.final_state, 'incomplete')
    assert.equal(fx.args.logBag.error_code, overload.code)
    assert.equal(fx.args.logBag.error_message, overload.message)
    assert.equal(fx.args.logBag.vm_id, 'gpt-a')
    assert.equal(fx.args.logBag.account_id, 'gpt-a')
    assert.equal(fx.args.logBag.final_account_id, 'gpt-a')
    assert.equal(fx.args.logBag.usage.input_tokens, 7)
    assert.equal(fx.args.logBag.usage.cache_read_input_tokens, 3)
    assert.equal(fx.args.logBag.usage.output_tokens, 2)
    assert.equal(fx.args.stats.errors, 1)
    const events = fx.chunks
      .join('')
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => JSON.parse(line.slice(5)))
    assert.equal(events.filter((item) => item.type === event.type).length, 1)
  })
}

unixTest('exhausted rejection logs the final account and only a bounded sanitized message', async (t) => {
  const message =
    'Busy Bearer bearer-secret https://proxy-user:proxy-password@example.invalid/?token=query-secret ' +
    'refresh_token=refresh-secret sk-project-secret eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature ' +
    'details '.repeat(80) +
    'request_body: {"input":"private-prompt"}\nCookie: private-cookie'
  const fx = await fixture(t, (_id, res) => writeEvents(res, [created, failed({ ...overload, message })]))
  await handleCodexProtocol(fx.args)
  assert.deepEqual(fx.calls, ['gpt-a', 'gpt-b'])
  assert.equal(fx.res.statusCode, 503)
  assert.equal(fx.res.body.error.message, message)
  assert.equal(fx.args.logBag.final_state, 'rejected')
  assert.equal(fx.args.logBag.vm_id, 'gpt-b')
  assert.equal(fx.args.logBag.account_id, 'gpt-b')
  assert.equal(fx.args.logBag.final_account_id, 'gpt-b')
  assert.equal(fx.args.logBag.attempt_count, 2)
  assert.equal(fx.args.logBag.error_message.length, 300)
  assert.match(fx.args.logBag.error_message, /^Busy/)
  assert.doesNotMatch(
    fx.args.logBag.error_message,
    /bearer-secret|proxy-user|proxy-password|query-secret|refresh-secret|project-secret|eyJ|private-prompt|private-cookie/,
  )
})

unixTest('normal completed remains successful through the real socket transport', async (t) => {
  const fx = await fixture(t, (_id, res) => writeEvents(res, [created, output, completed]))
  await handleCodexProtocol(fx.args)
  assert.deepEqual(fx.calls, ['gpt-a'])
  assert.equal(fx.results[0].explicitFailure, false)
  assert.equal(fx.res.statusCode, 200)
  assert.equal(fx.args.logBag.final_state, 'verified')
  assert.equal(fx.args.stats.errors, 0)
})

unixTest('a non-stream failure after buffered output returns an error JSON without replay', async (t) => {
  const fx = await fixture(t, (_id, res) => writeEvents(res, [created, output, failed(overload, { usage })]))
  fx.args.inbound.stream = false
  await handleCodexProtocol(fx.args)
  assert.deepEqual(fx.calls, ['gpt-a'])
  assert.equal(fx.results[0].committed, true)
  assert.equal(fx.res.headersSent, false)
  assert.equal(fx.res.statusCode, 503)
  assert.equal(fx.res.body.error.code, overload.code)
  assert.equal(fx.args.logBag.final_state, 'incomplete')
  assert.equal(fx.args.logBag.usage.output_tokens, 2)
  assert.deepEqual(fx.chunks, [])
})

unixTest('response.failed without an error still retains an explicit failure', async (t) => {
  const event = { type: 'response.failed', response: { id: 'resp_test', status: 'failed' } }
  const fx = await fixture(t, (_id, res) => writeEvents(res, [created, event]))
  await handleCodexProtocol(fx.args)
  assert.deepEqual(fx.calls, ['gpt-a'])
  assert.equal(fx.res.statusCode, 502)
  assert.equal(fx.res.body.error.code, 'response_failed')
  assert.equal(fx.args.logBag.final_state, 'rejected')
  assert.equal(fx.results[0].explicitFailure, true)
})

for (const terminalEvents of [
  [failed(overload, { usage }), completed],
  [completed, failed(overload, { usage })],
]) {
  unixTest(`explicit failure wins when ${terminalEvents[0].type} precedes ${terminalEvents[1].type}`, async (t) => {
    const fx = await fixture(t, (_id, res) => writeEvents(res, [created, output, ...terminalEvents]))
    await handleCodexProtocol(fx.args)
    assert.deepEqual(fx.calls, ['gpt-a'])
    assert.equal(fx.args.logBag.final_state, 'incomplete')
    assert.equal(fx.args.logBag.error_code, overload.code)
    assert.equal(fx.args.logBag.usage_complete, true)
    assert.equal(fx.args.stats.errors, 1)
    assert.equal(fx.chunks.join('').match(/"type":"response.failed"/g)?.length, 1)
    assert.doesNotMatch(fx.chunks.join(''), /event: error/)
  })
}

for (const terminalBeforeReset of [null, completed]) {
  unixTest(
    `a reset after output ${terminalBeforeReset ? 'does not append an error after completed' : 'adds one error frame'}`,
    async (t) => {
      let disconnect
      const events = [created, output, ...(terminalBeforeReset ? [terminalBeforeReset] : [])]
      const fx = await fixture(t, (_id, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`)
        disconnect = () => res.destroy()
      })
      const hop = fx.args.ops.streamCodexKernel
      fx.args.ops.streamCodexKernel = (opts) =>
        hop({
          ...opts,
          onEvent: async (line) => {
            await opts.onEvent(line)
            if (line.startsWith('data:') && JSON.parse(line.slice(5)).type === events.at(-1).type)
              setImmediate(disconnect)
          },
        })
      await handleCodexProtocol(fx.args)
      assert.deepEqual(fx.calls, ['gpt-a'])
      assert.equal(fx.args.logBag.final_state, 'incomplete')
      assert.equal(fx.args.logBag.error_code, 'ECONNRESET')
      assert.equal(fx.res.statusCode, 200)
      assert.equal(fx.chunks.join('').match(/event: error/g)?.length || 0, terminalBeforeReset ? 0 : 1)
    },
  )
}

for (const event of [failed(overload, { usage }), completed]) {
  unixTest(`a multiline ${event.type} before reset prevents a duplicate error frame`, async (t) => {
    let disconnect
    const fx = await fixture(t, (_id, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const item of [created, output]) res.write(`data: ${JSON.stringify(item)}\n\n`)
      res.write(`data: ${JSON.stringify(event).replace(',"response":', ',\ndata: "response":')}\n\n`)
      disconnect = () => res.destroy()
    })
    const hop = fx.args.ops.streamCodexKernel
    fx.args.ops.streamCodexKernel = (opts) =>
      hop({
        ...opts,
        onEvent: async (line) => {
          await opts.onEvent(line)
          if (line.startsWith('data: "response":')) setImmediate(disconnect)
        },
      })
    await handleCodexProtocol(fx.args)
    assert.deepEqual(fx.calls, ['gpt-a'])
    assert.equal(fx.results[0].terminalEventSeen, true)
    assert.equal(fx.args.logBag.error_code, 'ECONNRESET')
    assert.doesNotMatch(fx.chunks.join(''), /event: error/)
  })
}

unixTest('a conversion error already emitted to Chat is not emitted again', async (t) => {
  const events = [
    created,
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'function_call', id: 'fc', call_id: 'call', name: 'lookup', arguments: '' },
    },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc', delta: '{"q":"a' },
    { type: 'response.function_call_arguments.done', output_index: 0, item_id: 'fc', arguments: '{"q":"b"}' },
  ]
  const fx = await fixture(t, (_id, res) => writeEvents(res, events))
  fx.args.protocol = 'openai.chat'
  fx.args.inbound.messages = [{ role: 'user', content: 'test' }]
  await handleCodexProtocol(fx.args)
  assert.deepEqual(fx.calls, ['gpt-a'])
  assert.equal(fx.args.logBag.final_state, 'incomplete')
  assert.equal(fx.args.logBag.error_code, 'tool_arguments_mismatch')
  assert.equal(fx.chunks.join('').match(/"error":/g)?.length, 1)
})

unixTest('an already committed cancelled result is not relabeled or given an error frame', async (t) => {
  const controller = new AbortController()
  const fx = await fixture(t, (_id, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const event of [created, output]) res.write(`data: ${JSON.stringify(event)}\n\n`)
  })
  const hop = fx.args.ops.streamCodexKernel
  fx.args.ops.streamCodexKernel = (opts) =>
    hop({
      ...opts,
      signal: controller.signal,
      onEvent: async (line) => {
        await opts.onEvent(line)
        if (line.startsWith('data:') && JSON.parse(line.slice(5)).type === output.type) controller.abort()
      },
    })
  await handleCodexProtocol(fx.args)
  assert.deepEqual(fx.calls, ['gpt-a'])
  assert.equal(fx.results[0].clientCancelled, true)
  assert.equal(fx.args.logBag.final_state, 'cancelled')
  assert.equal(fx.args.logBag.error_code, 'client_cancelled')
  assert.doesNotMatch(fx.chunks.join(''), /event: error|"type":"error"/)
})

unixTest('failure summaries omit request payloads from the upstream message', async (t) => {
  const message = 'Upstream rejected request_body: {"input":"private-prompt","api_key":"private-key"}'
  const fx = await fixture(t, (_id, res) => writeEvents(res, [created, failed({ ...overload, message })]))
  fx.args.routing.failover.max_total_attempts = 1
  await handleCodexProtocol(fx.args)
  assert.equal(fx.args.logBag.error_message, 'Upstream rejected [request content omitted]')
  assert.doesNotMatch(fx.args.logBag.error_message, /private-prompt|private-key/)
})

unixTest('max_output_tokens incomplete is not reclassified as an explicit failure', async (t) => {
  const event = {
    type: 'response.incomplete',
    response: { id: 'resp_test', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, usage },
  }
  const fx = await fixture(t, (_id, res) => writeEvents(res, [created, output, event]))
  await handleCodexProtocol(fx.args)
  assert.deepEqual(fx.calls, ['gpt-a'])
  assert.equal(fx.results[0].explicitFailure, false)
  assert.equal(fx.res.statusCode, 200)
  assert.equal(fx.args.stats.errors, 0)
  assert.match(fx.chunks.join(''), /max_output_tokens/)
})

unixTest('ordinary Claude stream errors retain their status and buffering', async (t) => {
  const fx = await fixture(t, () => assert.fail('Codex handler must not run'))
  const socket = path.join(fx.root, 'claude.sock')
  const server = http.createServer((req, res) => {
    req.resume()
    writeEvents(res, [
      { type: 'message_start', message: {} },
      { type: 'error', error: { type: 'overloaded_error', message: 'busy' } },
    ])
  })
  fx.servers.push(server)
  await new Promise((resolve) => server.listen(socket, resolve))
  const lines = []
  const result = await streamGoWorker({
    exec: { vm: { runtime: { worker_socket: socket, worker_token_file: fx.tokenFile } } },
    envelope: { body: { model: 'claude-test', stream: true }, stream: true },
    onEvent: (line) => lines.push(line),
  })
  assert.equal(result.status, 529)
  assert.equal(result.committed, false)
  assert.equal(result.body.error.message, 'busy')
  assert.deepEqual(lines, [])
})

for (const protocol of ['openai.chat', 'anthropic.messages']) {
  unixTest(`a failed Responses event is delivered as one ${protocol} error after conversion`, async (t) => {
    const fx = await fixture(t, (_id, res) => writeEvents(res, [created, output, failed(overload, { usage })]))
    fx.args.protocol = protocol
    if (protocol === 'anthropic.messages') {
      fx.args.routing.codex = {
        protocols: { 'anthropic.messages': { mode: 'convert', enabled: true } },
        convert: { anthropic_to_codex: true },
      }
    }
    fx.args.inbound.messages = [{ role: 'user', content: 'test' }]
    await handleCodexProtocol(fx.args)
    assert.deepEqual(fx.calls, ['gpt-a'])
    assert.equal(fx.args.logBag.final_state, 'incomplete')
    assert.equal(fx.chunks.join('').match(/"error":/g)?.length, 1)
    assert.match(fx.chunks.join(''), /server_is_overloaded/)
  })
}

unixTest('failed response with an uncoded error stays an error rather than an empty success', async (t) => {
  const fx = await fixture(t, (_id, res) => writeEvents(res, [created, failed({ message: 'Failed upstream' })]))
  await handleCodexProtocol(fx.args)
  assert.equal(fx.res.statusCode, 502)
  assert.equal(fx.args.logBag.error_code, 'response_failed')
  assert.equal(fx.args.logBag.final_state, 'rejected')
})
