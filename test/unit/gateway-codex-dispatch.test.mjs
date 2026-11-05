import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { handleCodexProtocol } from '../../src/lib/protocol/handle-codex.mjs'
import { gatewayAccountProtection, gatewayForwardHeaders } from '../../src/lib/gateway-worker/gateway-execution.mjs'
import { SettingsRepo } from '../../src/lib/db/repos/settings-repo.mjs'
import { GatewayWorkerClient } from '../../src/lib/gateway-worker/gateway-client.mjs'
import { GatewayWorkerRepo } from '../../src/lib/gateway-worker/gateway-repo.mjs'
import { createGatewayWorkerReconciler } from '../../src/lib/gateway-worker/receipt-reconciler.mjs'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { setDetachedCodexSettings } from '../../src/lib/executor/settings-store.mjs'
import { pickCodexLocalSettings } from '../../src/lib/executor/codex-settings.mjs'
import { bodyHash } from '../../src/lib/gateway-worker/gateway-auth.mjs'

const SSE = [
  'data: {"type":"response.created","response":{"id":"resp_gw","model":"gpt-5.5"}}',
  'data: {"type":"response.output_text.delta","delta":"Hel"}',
  'data: {"type":"response.output_text.delta","delta":"lo"}',
  'data: {"type":"response.completed","response":{"id":"resp_gw","model":"gpt-5.5","usage":{"input_tokens":3,"output_tokens":2}}}',
  '',
].join('\n\n')

function fakeGateway(sse = SSE, { status = 200, headers = {} } = {}) {
  const calls = []
  return {
    calls,
    repo: { findAccountByRuntime: () => null },
    shouldUse: () => true,
    cancel: async () => {},
    async execute(args) {
      calls.push(args)
      // 分成两块，验证跨块的行拼接。
      const bytes = Buffer.from(sse)
      const mid = Math.floor(bytes.length / 2)
      return {
        ok: status >= 200 && status < 300,
        status,
        stream: true,
        headers: { 'x-kin-gateway-account': 'acct_1', 'content-type': 'text/event-stream', ...headers },
        body: Readable.toWeb(Readable.from([bytes.subarray(0, mid), bytes.subarray(mid)])),
        instance_id: 'gw_1',
        dispatch_id: 'dispatch_1',
        release() {},
      }
    },
  }
}

function fakeRes() {
  const res = {
    headersSent: false,
    statusCode: 0,
    headers: {},
    chunks: [],
    writableEnded: false,
    setHeader(key, value) {
      res.headers[key.toLowerCase()] = value
    },
    writeHead(status) {
      res.statusCode = status
      res.headersSent = true
    },
    write(chunk) {
      res.headersSent = true
      res.chunks.push(String(chunk))
      return true
    },
    end() {
      res.writableEnded = true
    },
    once() {},
  }
  return res
}

async function dispatch({
  protocol,
  body,
  gateway = fakeGateway(),
  headers = {},
  codex = {},
  keepaliveMs,
  req = {},
  res = fakeRes(),
  codexVmReady = null,
}) {
  const logBag = {}
  // Codex 本地设置（调度、BPS、Gateway 偏好）来自控制面设置存储；本文件不打开全局数据库，用未接数据库时的设置
  setDetachedCodexSettings(pickCodexLocalSettings(codex))
  const out = await handleCodexProtocol({
    req: {
      headers: { 'user-agent': 'openai-node/5', ...headers },
      apiKeyKind: 'user',
      apiKeyRecord: { id: 7, group_id: 3 },
      ...req,
    },
    res,
    protocol,
    ctx: { path: '/v1/x', body },
    inbound: body,
    logBag,
    stats: { errors: 0, requests: 0, by_route: {} },
    json: (_res, status, payload) => {
      res.statusCode = status
      res.body = payload
      return { status, body: payload }
    },
    writeSSEHeaders(r) {
      r.statusCode = 200
      r.headersSent = true
      r.sse = true
    },
    routing: { codex },
    projectRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'gw-dispatch-')),
    gatewayWorker: gateway,
    ...(keepaliveMs ? { gatewayKeepaliveMs: keepaliveMs } : {}),
    ...(codexVmReady ? { codexVmReady } : {}),
  })
  setDetachedCodexSettings(null)
  return { out, res, logBag, gateway }
}

test('Gateway Chat stream is converted back to chat.completion.chunk frames', async () => {
  const { res, gateway, logBag } = await dispatch({
    protocol: 'openai.chat',
    body: { model: 'gpt-5.5', stream: true, messages: [{ role: 'user', content: 'hi' }] },
  })
  assert.equal(gateway.calls[0].body.stream, true)
  assert.equal(gateway.calls[0].operation, 'chat')
  const text = res.chunks.join('')
  assert.equal(res.sse, true)
  assert.match(text, /"object":"chat\.completion\.chunk"/)
  assert.match(text, /"content":"Hel"/)
  assert.match(text, /data: \[DONE\]/)
  assert.doesNotMatch(text, /response\.output_text\.delta/)
  assert.equal(logBag.usage.input_tokens, 3)
  assert.equal(logBag.usage.output_tokens, 2)
  assert.equal(logBag.usage_complete, true)
  assert.equal(logBag.usage_confidence, 'complete')
})

test('Gateway non-stream Chat is assembled into one chat.completion JSON', async () => {
  const { res, gateway } = await dispatch({
    protocol: 'openai.chat',
    body: { model: 'gpt-5.5', stream: false, messages: [{ role: 'user', content: 'hi' }] },
  })
  // 上游只接受流式；非流式调用方由 Node 组装。
  assert.equal(gateway.calls[0].body.stream, true)
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.object, 'chat.completion')
  assert.equal(res.body.choices[0].message.content, 'Hello')
})

test('Gateway non-stream Completions and Anthropic Messages return their own wire format', async () => {
  const completions = await dispatch({
    protocol: 'openai.completions',
    body: { model: 'gpt-5.5', stream: false, prompt: 'hi' },
  })
  assert.equal(completions.res.body.object, 'text_completion')
  assert.equal(completions.res.body.choices[0].text, 'Hello')

  const anthropic = await dispatch({
    protocol: 'anthropic.messages',
    codex: {
      protocols: { 'anthropic.messages': { mode: 'convert', enabled: true } },
      convert: { anthropic_to_codex: true },
    },
    body: { model: 'gpt-5.5', stream: true, max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] },
  })
  const text = anthropic.res.chunks.join('')
  assert.equal(anthropic.gateway.calls.length, 1)
  assert.match(text, /event: message_start/)
  assert.match(text, /"text":"Hel"/)
  assert.doesNotMatch(text, /response\.output_text\.delta/)
})

test('Gateway non-stream Responses is assembled from the upstream stream', async () => {
  const { res, logBag } = await dispatch({
    protocol: 'openai.responses',
    body: { model: 'gpt-5.5', stream: false, input: 'hi' },
  })
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.id, 'resp_gw')
  assert.equal(res.body.output[0].content[0].text, 'Hello')
  assert.deepEqual(res.body.usage, { input_tokens: 3, output_tokens: 2 })
  assert.equal(logBag.usage_confidence, 'complete')
})

test('Gateway stream Responses passes Responses SSE through unchanged', async () => {
  const { res } = await dispatch({
    protocol: 'openai.responses',
    body: { model: 'gpt-5.5', stream: true, input: 'hi' },
  })
  assert.equal(res.chunks.join(''), SSE)
})

test('Gateway stream logs outbound session, first byte and first token like the VM path', async () => {
  const gateway = fakeGateway(SSE, { headers: { 'x-kin-gateway-outbound-session': 'outbound-session-1' } })
  const { logBag } = await dispatch({
    protocol: 'openai.responses',
    gateway,
    body: { model: 'gpt-5.5', stream: true, input: 'hi' },
  })
  assert.equal(logBag.outbound_session_id, 'outbound-session-1')
  assert.equal(typeof logBag.first_byte_ms, 'number')
  assert.equal(typeof logBag.first_token_ms, 'number')
  assert.ok(logBag.first_token_ms >= logBag.first_byte_ms)
})

test('Gateway failures without a stream keep the delivered status and record the error code', async () => {
  const gateway = {
    ...fakeGateway(),
    async execute() {
      return {
        ok: false,
        status: 503,
        stream: false,
        headers: { 'x-kin-gateway-error-category': 'capacity_unavailable' },
        body: { error: { type: 'server_error', code: 'server_is_overloaded', message: 'busy' } },
      }
    },
  }
  const { res, logBag } = await dispatch({
    protocol: 'openai.responses',
    gateway,
    body: { model: 'gpt-5.5', input: 'hi' },
  })
  assert.equal(res.statusCode, 503)
  assert.equal(logBag.final_state, 'upstream_error')
  assert.equal(logBag.error_code, 'server_is_overloaded')
})

test('Gateway requests the Worker never sent fall back to the group VM pool only when it has a serviceable slot', async () => {
  const notSent = (hasVm) => ({
    ...fakeGateway(),
    calls: [],
    hasVmScope: () => hasVm,
    async execute(args) {
      this.calls.push(args)
      return {
        ok: false,
        status: 503,
        send_state: 'not_sent',
        body: {
          error: { type: 'server_error', code: 'gateway_worker_unavailable', message: 'Gateway Worker 暂不可用' },
        },
      }
    },
  })
  const withVm = await dispatch({
    protocol: 'openai.responses',
    gateway: notSent(true),
    codexVmReady: () => true,
    body: { model: 'gpt-5.5', input: 'hi' },
  })
  assert.equal(withVm.logBag.via, 'codex-kernel-fallback')
  assert.equal(withVm.logBag.gateway_fallback, 'gateway_worker_unavailable')
  // 分组绑定了 VM 但没有能接单的 Codex 槽位：不回退，原样交付 Worker 的错误（不再以 no_codex_vm 结束）
  const noServiceableVm = await dispatch({
    protocol: 'openai.responses',
    gateway: notSent(true),
    codexVmReady: () => false,
    body: { model: 'gpt-5.5', input: 'hi' },
  })
  assert.equal(noServiceableVm.logBag.via, 'gateway-worker')
  assert.equal(noServiceableVm.res.statusCode, 503)
  assert.equal(noServiceableVm.logBag.error_code, 'gateway_worker_unavailable')
  const onlyGateway = await dispatch({
    protocol: 'openai.responses',
    gateway: notSent(false),
    body: { model: 'gpt-5.5', input: 'hi' },
  })
  assert.equal(onlyGateway.logBag.via, 'gateway-worker')
  assert.equal(onlyGateway.res.statusCode, 503)
  const forced = await dispatch({
    protocol: 'openai.responses',
    gateway: notSent(true),
    codexVmReady: () => true,
    codex: { gateway_worker: { preference: 'gateway_worker' } },
    body: { model: 'gpt-5.5', input: 'hi' },
  })
  assert.equal(forced.logBag.via, 'gateway-worker')
})

test('Gateway streams that end in response.failed are logged as upstream errors, not success', async () => {
  const failed = [
    'data: {"type":"response.created","response":{"id":"resp_f","model":"gpt-5.5"}}',
    'data: {"type":"response.failed","response":{"id":"resp_f","error":{"type":"server_error","code":"server_is_overloaded"}}}',
    '',
  ].join('\n\n')
  const { logBag } = await dispatch({
    protocol: 'openai.responses',
    gateway: fakeGateway(failed),
    body: { model: 'gpt-5.5', stream: true, input: 'hi' },
  })
  assert.equal(logBag.final_state, 'upstream_error')
  assert.equal(logBag.error_code, 'server_is_overloaded')
})

test('Gateway upstream errors are returned as JSON with the upstream status', async () => {
  const gateway = fakeGateway('{"error":{"type":"usage_limit_reached","message":"limit"}}', { status: 429 })
  const { res, logBag } = await dispatch({
    protocol: 'openai.chat',
    gateway,
    body: { model: 'gpt-5.5', stream: true, messages: [{ role: 'user', content: 'hi' }] },
  })
  assert.equal(res.statusCode, 429)
  assert.equal(res.body.error.type, 'usage_limit_reached')
  assert.equal(logBag.final_state, 'upstream_error')
})

test('Gateway Responses upstream errors hand the upstream turn-state back to the client', async () => {
  const gateway = fakeGateway('{"error":{"type":"invalid_request_error","code":"unsupported_value"}}', {
    status: 400,
    headers: { 'x-codex-turn-state': 'ts-fail' },
  })
  const { res } = await dispatch({ protocol: 'openai.responses', gateway, body: { model: 'gpt-5.5', input: 'hi' } })
  assert.equal(res.statusCode, 400)
  assert.equal(res.headers['x-codex-turn-state'], 'ts-fail')
})

test('Gateway failure records request diagnostics: error kind, upstream error, continuation reason and retry-after', async () => {
  const gateway = fakeGateway('', {
    status: 400,
    headers: {
      'x-kin-gateway-error-category': 'invalid_request',
      'x-kin-gateway-upstream-error': JSON.stringify({
        code: 'bad_param',
        type: 'invalid_request_error',
        param: 'input',
      }),
      'x-kin-gateway-continuation-reason': 'scope_unavailable',
      'retry-after': '2',
    },
  })
  gateway.execute = async (args) => {
    gateway.calls.push(args)
    return {
      ok: false,
      status: 400,
      stream: true,
      headers: {
        'x-kin-gateway-error-category': 'invalid_request',
        'x-kin-gateway-upstream-error': JSON.stringify({
          code: 'bad_param',
          type: 'invalid_request_error',
          param: 'input',
        }),
        'x-kin-gateway-continuation-reason': 'scope_unavailable',
        'retry-after': '2',
      },
      body: Readable.toWeb(Readable.from([Buffer.from('{"error":{"code":"bad_param","message":"x"}}')])),
      release() {},
    }
  }
  const { logBag } = await dispatch({ protocol: 'openai.responses', gateway, body: { model: 'gpt-5.5', input: 'hi' } })
  assert.equal(logBag.error_kind, 'invalid_request')
  assert.deepEqual(logBag.upstream_error, { code: 'bad_param', type: 'invalid_request_error', param: 'input' })
  assert.equal(logBag.continuation_unavailable_reason, 'scope_unavailable')
  assert.equal(logBag.retry_after_ms, 2000)
})

test('Gateway stream diagnostics arrive in the Worker trailer and never reach the caller', async () => {
  const gateway = fakeGateway(
    [
      'data: {"type":"response.created","response":{"id":"resp_gw"}}',
      'data: {"type":"response.output_text.delta","delta":"Hel"}',
      '',
    ].join('\n\n'),
  )
  const execute = gateway.execute
  gateway.execute = async (args) => {
    const result = await execute(args)
    return {
      ...result,
      trailers: () => ({
        'x-kin-gateway-diagnostic': JSON.stringify({
          websocket_close_code: 1006,
          close_reason: 'abnormal',
          last_event_type: 'response.output_text.delta',
          connection_exit_reason: 'closed_by_upstream',
        }),
      }),
    }
  }
  const { logBag, res } = await dispatch({
    protocol: 'openai.responses',
    gateway,
    body: { model: 'gpt-5.5', stream: true, input: 'hi' },
  })
  assert.equal(logBag.websocket_close_code, 1006)
  assert.equal(logBag.upstream_connection_exit_reason, 'closed_by_upstream')
  assert.deepEqual(logBag.upstream_error, { close_reason: 'abnormal', last_event_type: 'response.output_text.delta' })
  assert.equal(res.chunks.join('').includes('1006'), false)
})

test('native Responses requests pass other headers through a CPR-style blacklist', () => {
  const forwarded = gatewayForwardHeaders(
    {
      authorization: 'Bearer sk-caller',
      'x-api-key': 'caller',
      cookie: 'a=b',
      'user-agent': 'caller/1',
      'x-forwarded-for': '1.2.3.4',
      'cf-connecting-ip': '1.2.3.4',
      'x-stainless-os': 'mac',
      'x-kin-internal': '1',
      connection: 'keep-alive, x-hop',
      'x-hop': 'drop',
      'x-openai-account-routing-override': 'caller-route',
      'x-responsesapi-include-timing-metrics': 'true',
      'accept-language': 'zh-CN',
      'session-id': 'sess_1',
    },
    { passthrough: true },
  )
  assert.deepEqual(forwarded, {
    'x-responsesapi-include-timing-metrics': 'true',
    'accept-language': 'zh-CN',
    'session-id': 'sess_1',
  })
})

test('Gateway forwards Codex session and trace headers, never caller credentials or identity', () => {
  const forwarded = gatewayForwardHeaders({
    authorization: 'Bearer sk-caller',
    cookie: 'a=b',
    'x-api-key': 'caller',
    'user-agent': 'caller/1',
    originator: 'caller',
    version: '1',
    'chatgpt-account-id': 'caller',
    'x-codex-installation-id': 'caller-install',
    'session-id': 'sess_1',
    'x-codex-turn-metadata': 'turn',
    'openai-beta': 'responses=v1',
    accept: 'text/event-stream',
    traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
    tracestate: 'v=1',
    'sentry-trace': 'abc-def-1',
    baggage: 'k=v',
    'x-openai-fedramp': 'true',
    'x-openai-account-routing-override': 'caller-route',
  })
  assert.deepEqual(forwarded, {
    'session-id': 'sess_1',
    'x-codex-turn-metadata': 'turn',
    'openai-beta': 'responses=v1',
    accept: 'text/event-stream',
    traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
    tracestate: 'v=1',
    'sentry-trace': 'abc-def-1',
    baggage: 'k=v',
    'x-openai-fedramp': 'true',
  })
})

function withDb(fn) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-p0-'))
    const db = createDatabase({ dataDir: dir })
    try {
      await fn(db)
    } finally {
      db.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
}

test(
  'non-stream execute waits beyond the 15s control timeout',
  withDb(async (db) => {
    const server = http.createServer((req, res) => {
      req.resume()
      setTimeout(() => {
        res.setHeader('content-type', 'application/json')
        res.end('{"data":[]}')
      }, 120)
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const repo = new GatewayWorkerRepo(db)
      await repo.upsertInstance({
        id: 'gw_slow',
        name: 'slow',
        base_url: `http://127.0.0.1:${server.address().port}`,
        health_state: 'healthy',
      })
      // 控制接口超时设为 50ms；执行接口必须使用独立的长超时。
      const client = new GatewayWorkerClient({ repo, secret: 's', timeoutMs: 50 })
      const result = await client.execute({
        instanceId: 'gw_slow',
        requestId: 'req_slow',
        protocol: 'openai.images',
        operation: 'images.generations',
        model: 'gpt-image-1',
        scope: {},
        body: { prompt: 'x' },
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })
      assert.equal(result.ok, true)
      assert.deepEqual(result.data, { data: [] })
    } finally {
      server.close()
    }
  }),
)

test(
  'a streaming execute is not cut by the header timeout once the Worker has responded',
  withDb(async (db) => {
    let finish
    const server = http.createServer((req, res) => {
      req.resume()
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: first\n\n')
      finish = () => res.end('data: last\n\n')
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const repo = new GatewayWorkerRepo(db)
      await repo.upsertInstance({
        id: 'gw_long',
        name: 'long',
        base_url: `http://127.0.0.1:${server.address().port}`,
        health_state: 'healthy',
      })
      const client = new GatewayWorkerClient({ repo, secret: 's' })
      test.mock.timers.enable({ apis: ['setTimeout'] })
      let result
      try {
        result = await client.execute({
          instanceId: 'gw_long',
          requestId: 'req_long',
          protocol: 'openai.responses',
          operation: 'responses',
          model: 'gpt-test',
          scope: {},
          body: { stream: true, input: 'hi' },
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        })
        // 越过 900s 的等待响应头时限：已开始的流不能被截断
        test.mock.timers.tick(1_000_000)
      } finally {
        test.mock.timers.reset()
      }
      finish()
      let text = ''
      for await (const chunk of Readable.fromWeb(result.body)) text += Buffer.from(chunk).toString('utf8')
      assert.equal(text, 'data: first\n\ndata: last\n\n')
    } finally {
      server.close()
    }
  }),
)

test(
  'a caller cancel before the Worker responds closes the Worker request and marks the dispatch cancelled',
  withDb(async (db) => {
    let workerSawClose = false
    const server = http.createServer((req) => {
      req.resume()
      // 不回应：模拟 Worker 正在排队或重试
      req.once('close', () => {
        workerSawClose = true
      })
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const repo = new GatewayWorkerRepo(db)
      await repo.upsertInstance({
        id: 'gw_wait',
        name: 'wait',
        base_url: `http://127.0.0.1:${server.address().port}`,
        health_state: 'healthy',
      })
      const client = new GatewayWorkerClient({ repo, secret: 's' })
      const abort = new AbortController()
      const pending = client.execute({
        instanceId: 'gw_wait',
        requestId: 'req_wait',
        protocol: 'openai.responses',
        operation: 'responses',
        model: 'gpt-test',
        scope: {},
        body: { stream: true, input: 'hi' },
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        signal: abort.signal,
      })
      setTimeout(() => abort.abort(), 50)
      await assert.rejects(pending, (error) => error.code === 'client_cancelled' && error.send_state === 'cancelled')
      for (let i = 0; i < 50 && !workerSawClose; i++) await new Promise((resolve) => setTimeout(resolve, 10))
      assert.equal(workerSawClose, true)
      assert.equal(
        db.prepare("SELECT status FROM gateway_worker_dispatches WHERE request_id='req_wait'").get().status,
        'cancelled',
      )
    } finally {
      server.close()
    }
  }),
)

test('Gateway dispatch aborted by the caller before the Worker responds is logged as cancelled', async () => {
  const { EventEmitter } = await import('node:events')
  const req = Object.assign(new EventEmitter(), {
    headers: { 'user-agent': 'openai-node/5' },
    apiKeyKind: 'user',
    apiKeyRecord: { id: 7, group_id: 3 },
  })
  let seenSignal = null
  const gateway = {
    ...fakeGateway(),
    execute({ signal }) {
      seenSignal = signal
      return new Promise((_, reject) =>
        signal.addEventListener('abort', () =>
          reject(Object.assign(new Error('client cancelled'), { code: 'client_cancelled', send_state: 'cancelled' })),
        ),
      )
    },
  }
  const res = Object.assign(new EventEmitter(), fakeRes())
  const logBag = {}
  const pending = handleCodexProtocol({
    req,
    res,
    protocol: 'openai.responses',
    ctx: { path: '/v1/responses', body: { model: 'gpt-5.5', input: 'hi' } },
    inbound: { model: 'gpt-5.5', input: 'hi' },
    logBag,
    stats: { errors: 0, requests: 0, by_route: {} },
    json: (_res, status, payload) => {
      res.statusCode = status
      res.body = payload
    },
    writeSSEHeaders() {},
    routing: { codex: {} },
    projectRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'gw-dispatch-')),
    gatewayWorker: gateway,
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.ok(seenSignal, 'execute did not receive a signal')
  req.emit('aborted')
  await pending
  assert.equal(logBag.final_state, 'cancelled')
  assert.equal(logBag.error_code, 'client_cancelled')
  assert.equal(res.body, undefined)
})

test(
  'reconciler replays spooled Receipts from online Workers and acks them',
  withDb(async (db) => {
    const repo = new GatewayWorkerRepo(db)
    await repo.upsertInstance({
      id: 'gw_spool',
      name: 'spool',
      base_url: 'http://127.0.0.1:1',
      health_state: 'healthy',
    })
    await repo.upsertInstance({ id: 'gw_off', name: 'off', base_url: 'http://127.0.0.1:2', health_state: 'offline' })
    const dispatchId = await repo.createDispatch({
      requestId: 'req_spool',
      instanceId: 'gw_spool',
      protocol: 'openai.responses',
      model: 'gpt-test',
      scope: {},
      nonce: 'n',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    const unsigned = {
      receipt_id: 'receipt_spool',
      dispatch_id: dispatchId,
      request_id: 'req_spool',
      gateway_instance_id: 'gw_spool',
      terminal_state: 'completed',
      usage_confidence: 'complete',
      usage: { input_tokens: 1, output_tokens: 1 },
    }
    const receipt = { ...unsigned, payload_hash: bodyHash(unsigned) }
    const foreign = { ...unsigned, dispatch_id: 'dispatch_other', gateway_instance_id: 'gw_other' }
    const replayCalls = []
    const acks = []
    const client = {
      async replayReceipts(instanceId) {
        replayCalls.push(instanceId)
        return { ok: true, data: { items: [receipt, foreign] } }
      },
      async ackReceipt(instanceId, dispatch, receiptId) {
        acks.push([instanceId, dispatch, receiptId])
      },
    }
    let clock = 1_000_000
    const reconciler = createGatewayWorkerReconciler({ db, client, now: () => clock, replayIntervalMs: 60_000 })
    await reconciler.tick()
    assert.deepEqual(replayCalls, ['gw_spool'])
    assert.equal((await repo.listReceipts('req_spool')).length, 1)
    assert.deepEqual(acks, [['gw_spool', dispatchId, 'receipt_spool']])
    // 未到间隔不重复拉取；到期后重复回执仍 ack 但不重复入库。
    await reconciler.tick()
    assert.equal(replayCalls.length, 1)
    clock += 60_000
    await reconciler.tick()
    assert.equal(replayCalls.length, 2)
    assert.equal((await repo.listReceipts('req_spool')).length, 1)
    assert.equal(acks.length, 2)
  }),
)

test(
  'reconciler closes failed or context-free Receipts as unmetered and keeps dead letters for real gaps',
  withDb(async (db) => {
    const repo = new GatewayWorkerRepo(db)
    await repo.upsertInstance({ id: 'gw_rec', name: 'rec', base_url: 'http://127.0.0.1:1', health_state: 'offline' })
    const settle = async (requestId, { terminal, confidence, context = null, liveState = 'verified' }) => {
      const dispatchId = await repo.createDispatch({
        requestId,
        instanceId: 'gw_rec',
        protocol: 'openai.responses',
        model: 'gpt-test',
        scope: {},
        nonce: requestId,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })
      db.prepare(
        `INSERT INTO usage_logs(id,request_id,created_at,execution_kind,gateway_instance_id,dispatch_id,final_state,billing_status)
         VALUES(?,?,?,?,?,?,?,?)`,
      ).run(
        `log_${requestId}`,
        requestId,
        new Date().toISOString(),
        'gateway_worker',
        'gw_rec',
        dispatchId,
        liveState,
        'settlement_pending',
      )
      // 实时日志判定待结算时带计费上下文入队；回执入库只补齐已有任务
      if (context) await repo.enqueueReconciliation({ gatewayInstanceId: 'gw_rec', dispatchId, requestId, context })
      const unsigned = {
        receipt_id: `receipt_${requestId}`,
        dispatch_id: dispatchId,
        request_id: requestId,
        gateway_instance_id: 'gw_rec',
        terminal_state: terminal,
        usage_confidence: confidence,
        usage: confidence === 'unknown' ? null : { input_tokens: 5 },
      }
      assert.equal((await repo.ingestReceipt({ ...unsigned, payload_hash: bodyHash(unsigned) })).rejected, undefined)
      return dispatchId
    }
    const context = { request_id: 'ctx' }
    // 提交后上游过载：旧版实时日志记为 verified 并待结算，回执确认 upstream_error
    const failed = await settle('req_failed', { terminal: 'upstream_error', confidence: 'partial', context })
    // 提交前被拒：实时日志已不计量，只有回执入库的任务
    const rejected = await settle('req_rejected', {
      terminal: 'upstream_error',
      confidence: 'unknown',
      liveState: 'upstream_error',
    })
    // 成功但没有计费上下文（实时日志已结算或不计量）
    const contextFree = await settle('req_free', { terminal: 'completed', confidence: 'partial' })
    // 成功、待结算但用量证据不全：保留重试，最终才进 dead letter
    const gap = await settle('req_gap', { terminal: 'completed', confidence: 'partial', context })
    const reconciler = createGatewayWorkerReconciler({
      db,
      client: { replayReceipts: async () => ({ ok: true, data: { items: [] } }), ackReceipt: async () => {} },
    })
    await reconciler.tick()
    const job = (dispatchId) =>
      db.prepare('SELECT status,last_error FROM gateway_worker_reconciliation_jobs WHERE dispatch_id=?').get(dispatchId)
    const billing = (dispatchId) =>
      db.prepare('SELECT billing_status FROM usage_logs WHERE dispatch_id=?').get(dispatchId).billing_status
    assert.deepEqual({ ...job(failed) }, { status: 'unmetered', last_error: 'request_not_completed' })
    assert.equal(billing(failed), 'unmetered')
    // 没有待结算任务的回执（提交前被拒、实时日志已结算或不计量）不再新建对账任务
    assert.equal(job(rejected), undefined)
    assert.equal(job(contextFree), undefined)
    assert.deepEqual({ ...job(gap) }, { status: 'pending', last_error: 'usage_evidence_incomplete' })
    assert.equal(billing(gap), 'settlement_pending')
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM gateway_worker_dead_letters').get().n, 0)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM billing_charges').get().n, 0)
  }),
)

test(
  'reconciler closes usage_logs with the job when retries run out or context is missing',
  withDb(async (db) => {
    const repo = new GatewayWorkerRepo(db)
    await repo.upsertInstance({
      id: 'gw_stuck',
      name: 'stuck',
      base_url: 'http://127.0.0.1:1',
      health_state: 'offline',
    })
    const pending = async (
      requestId,
      { terminal, confidence, context, liveState, billingStatus = 'settlement_pending' },
    ) => {
      const dispatchId = await repo.createDispatch({
        requestId,
        instanceId: 'gw_stuck',
        protocol: 'openai.responses',
        model: 'gpt-test',
        scope: {},
        nonce: requestId,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })
      db.prepare(
        `INSERT INTO usage_logs(id,request_id,created_at,execution_kind,gateway_instance_id,dispatch_id,final_state,billing_status)
         VALUES(?,?,?,?,?,?,?,?)`,
      ).run(
        `log_${requestId}`,
        requestId,
        new Date().toISOString(),
        'gateway_worker',
        'gw_stuck',
        dispatchId,
        liveState,
        billingStatus,
      )
      await repo.enqueueReconciliation({ gatewayInstanceId: 'gw_stuck', dispatchId, requestId, context })
      const unsigned = {
        receipt_id: `receipt_${requestId}`,
        dispatch_id: dispatchId,
        request_id: requestId,
        gateway_instance_id: 'gw_stuck',
        terminal_state: terminal,
        usage_confidence: confidence,
        usage: null,
      }
      await repo.ingestReceipt({ ...unsigned, payload_hash: bodyHash(unsigned) })
      return dispatchId
    }
    const context = { request_id: 'ctx' }
    // 生产形态：调用方提交后断开，Worker 回执为 ambiguous（stream_copy_error）且没有用量
    const ambiguous = await pending('req_ambiguous', {
      terminal: 'ambiguous',
      confidence: 'unknown',
      context,
      liveState: 'cancelled',
    })
    // 图片请求完成但回执只有 partial 置信度、没有 token 用量
    const imageGap = await pending('req_image_gap', {
      terminal: 'completed',
      confidence: 'partial',
      context,
      liveState: 'verified',
    })
    // 第 11 次处理（leaseReconciliation 已累计 10 次）
    db.prepare('UPDATE gateway_worker_reconciliation_jobs SET attempts=10 WHERE dispatch_id IN (?,?)').run(
      ambiguous,
      imageGap,
    )
    // 没有计费上下文的任务：实时日志若仍是 settlement_pending 也要收口；已结算的行不被改写
    const noContext = await pending('req_no_ctx', {
      terminal: 'completed',
      confidence: 'partial',
      context: null,
      liveState: 'verified',
    })
    const settledNoContext = await pending('req_settled_no_ctx', {
      terminal: 'completed',
      confidence: 'partial',
      context: null,
      liveState: 'verified',
      billingStatus: 'settled',
    })
    const reconciler = createGatewayWorkerReconciler({
      db,
      client: { replayReceipts: async () => ({ ok: true, data: { items: [] } }), ackReceipt: async () => {} },
    })
    await reconciler.tick()
    const job = (dispatchId) =>
      db.prepare('SELECT status,last_error FROM gateway_worker_reconciliation_jobs WHERE dispatch_id=?').get(dispatchId)
    const billing = (dispatchId) =>
      db.prepare('SELECT billing_status FROM usage_logs WHERE dispatch_id=?').get(dispatchId).billing_status
    for (const dispatchId of [ambiguous, imageGap]) {
      assert.deepEqual({ ...job(dispatchId) }, { status: 'unmetered', last_error: 'usage_evidence_incomplete' })
      assert.equal(billing(dispatchId), 'unmetered')
    }
    assert.deepEqual({ ...job(noContext) }, { status: 'unmetered', last_error: 'billing_context_missing' })
    assert.equal(billing(noContext), 'unmetered')
    assert.equal(billing(settledNoContext), 'settled')
    // 证据缺口仍留 dead letter 供人工核对，且不产生 0 元扣费记录
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM gateway_worker_dead_letters').get().n, 2)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM billing_charges').get().n, 0)
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM usage_logs WHERE billing_status='settlement_pending'").get().n,
      0,
    )
  }),
)

test(
  'reconciler bills interrupted and cut-off-completed BPS streams by the partial usage the Worker accumulated',
  withDb(async (db) => {
    const repo = new GatewayWorkerRepo(db)
    await repo.upsertInstance({ id: 'gw_bps', name: 'bps', base_url: 'http://127.0.0.1:1', health_state: 'offline' })
    const settle = async (requestId, { terminal, mode, errorCode, usage = { input_tokens: 50, output_tokens: 5 } }) => {
      const dispatchId = await repo.createDispatch({
        requestId,
        instanceId: 'gw_bps',
        protocol: 'openai.responses',
        model: 'gpt-test',
        scope: {},
        nonce: requestId,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })
      db.prepare(
        `INSERT INTO usage_logs(id,request_id,created_at,execution_kind,gateway_instance_id,dispatch_id,final_state,billing_status,authorization_mode)
         VALUES(?,?,?,?,?,?,?,?,?)`,
      ).run(
        `log_${requestId}`,
        requestId,
        new Date().toISOString(),
        'gateway_worker',
        'gw_bps',
        dispatchId,
        'cancelled',
        'settlement_pending',
        mode,
      )
      await repo.enqueueReconciliation({
        gatewayInstanceId: 'gw_bps',
        dispatchId,
        requestId,
        context: { request_id: requestId },
      })
      const unsigned = {
        receipt_id: `receipt_${requestId}`,
        dispatch_id: dispatchId,
        request_id: requestId,
        gateway_instance_id: 'gw_bps',
        terminal_state: terminal,
        usage_confidence: usage ? 'partial' : 'unknown',
        usage,
        ...(errorCode ? { error_code: errorCode } : {}),
      }
      await repo.ingestReceipt({ ...unsigned, payload_hash: bodyHash(unsigned) })
      return dispatchId
    }
    const bpsCut = await settle('req_bps_cut', { terminal: 'incomplete', mode: 'bps' })
    // 审计 C1：断流后补出的完成与复制中断（ambiguous）同样按下限结算；补完成却没有任何用量时明确不计量、不进死信
    const bpsSynthesized = await settle('req_bps_synth', {
      terminal: 'completed',
      mode: 'bps',
      errorCode: 'bps_cutoff_completed',
    })
    const bpsAmbiguous = await settle('req_bps_ambiguous', { terminal: 'ambiguous', mode: 'bps' })
    const bpsNoUsage = await settle('req_bps_no_usage', {
      terminal: 'completed',
      mode: 'bps',
      errorCode: 'bps_cutoff_completed',
      usage: null,
    })
    const bpsAmbiguousNoUsage = await settle('req_bps_ambiguous_no_usage', {
      terminal: 'ambiguous',
      mode: 'bps',
      usage: null,
    })
    const nativeCompletedPartial = await settle('req_native_partial', { terminal: 'completed', mode: 'native' })
    const bpsFailed = await settle('req_bps_failed', { terminal: 'upstream_error', mode: 'bps' })
    const nativeCut = await settle('req_native_cut', { terminal: 'incomplete', mode: 'native' })
    const reconciler = createGatewayWorkerReconciler({
      db,
      client: { replayReceipts: async () => ({ ok: true, data: { items: [] } }), ackReceipt: async () => {} },
    })
    await reconciler.tick()
    const job = (dispatchId) =>
      db.prepare('SELECT status,last_error FROM gateway_worker_reconciliation_jobs WHERE dispatch_id=?').get(dispatchId)
    const billing = (dispatchId) =>
      db.prepare('SELECT billing_status FROM usage_logs WHERE dispatch_id=?').get(dispatchId).billing_status
    // 中断的 BPS 流进入结算（本测试的最小上下文缺少钱包，结算阶段报错重试，但不再按“未完成/证据不全”关闭）
    assert.notEqual(job(bpsCut).status, 'unmetered')
    assert.ok(!['request_not_completed', 'usage_evidence_incomplete'].includes(job(bpsCut).last_error))
    assert.equal(billing(bpsFailed), 'unmetered')
    assert.equal(billing(nativeCut), 'unmetered')
    for (const dispatchId of [bpsSynthesized, bpsAmbiguous]) {
      assert.notEqual(job(dispatchId).status, 'unmetered')
      assert.ok(!['request_not_completed', 'usage_evidence_incomplete'].includes(job(dispatchId).last_error))
    }
    assert.deepEqual({ ...job(bpsNoUsage) }, { status: 'unmetered', last_error: 'bps_cutoff_no_usage' })
    assert.deepEqual({ ...job(bpsAmbiguousNoUsage) }, { status: 'unmetered', last_error: 'bps_cutoff_no_usage' })
    assert.equal(billing(bpsNoUsage), 'unmetered')
    // 原生通道的 completed + partial 仍等完整用量
    assert.deepEqual({ ...job(nativeCompletedPartial) }, { status: 'pending', last_error: 'usage_evidence_incomplete' })
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM gateway_worker_dead_letters').get().n, 0)
  }),
)

test(
  'hot-path writes: shared owners repo per db, single-write attempts, receipts only attach to existing jobs',
  withDb(async (db) => {
    const { codexResponseOwners } = await import('../../src/lib/db/repos/codex-response-owners-repo.mjs')
    assert.equal(codexResponseOwners(db), codexResponseOwners(db))
    const { RequestAttemptsRepo } = await import('../../src/lib/db/repos/request-attempts-repo.mjs')
    const attempts = new RequestAttemptsRepo(db)
    const { recordGatewayAttempts } = await import('../../src/lib/gateway-worker/gateway-execution.mjs')
    recordGatewayAttempts(attempts, {
      requestId: 'req_attempts',
      model: 'gpt-5.5',
      result: { status: 200, headers: {} },
      accountId: 'acct_1',
      final: { terminalState: 'verified', downstreamCommitted: true, usage: { input_tokens: 3 } },
    })
    recordGatewayAttempts(attempts, {
      requestId: 'req_bps_stage',
      model: 'gpt-5.5',
      result: {
        status: 200,
        headers: {
          'x-kin-gateway-attempts': JSON.stringify([
            { account: 'acct_1', status: 429, category: 'rate_limited', route: 'bps', stage: 'attachments' },
            { account: 'acct_2', status: 200 },
          ]),
        },
      },
      final: { terminalState: 'verified', downstreamCommitted: true },
    })
    const [staged] = attempts.list('req_bps_stage')
    assert.equal(staged.action, 'rate_limited')
    assert.equal(staged.route, 'bps')
    assert.equal(staged.stage, 'attachments')
    assert.equal(attempts.list('req_bps_stage')[1].route, 'native')
    const [row] = attempts.list('req_attempts')
    assert.equal(row.terminal_state, 'verified')
    assert.equal(Boolean(row.downstream_committed), true)
    assert.equal(row.upstream_status, 200)
    assert.ok(row.started_at && row.completed_at)
    const repo = new GatewayWorkerRepo(db)
    db.exec('PRAGMA foreign_keys=OFF')
    await repo.attachReceiptToReconciliation({ gatewayInstanceId: 'gw', dispatchId: 'd_none', receiptId: 'r0' })
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM gateway_worker_reconciliation_jobs').get().n, 0)
    await repo.enqueueReconciliation({
      gatewayInstanceId: 'gw',
      dispatchId: 'd_job',
      requestId: 'req_job',
      context: { a: 1 },
    })
    db.prepare("UPDATE gateway_worker_reconciliation_jobs SET status='unmetered',next_attempt_at=NULL").run()
    await repo.attachReceiptToReconciliation({
      gatewayInstanceId: 'gw',
      dispatchId: 'd_job',
      receiptId: 'r1',
      usage: { input_tokens: 1 },
    })
    const job = db
      .prepare("SELECT status,receipt_id,usage_json FROM gateway_worker_reconciliation_jobs WHERE dispatch_id='d_job'")
      .get()
    assert.deepEqual({ ...job }, { status: 'pending', receipt_id: 'r1', usage_json: '{"input_tokens":1}' })
  }),
)

test(
  'Receipt lookups of usage_logs by dispatch use the gateway dispatch index instead of a table scan',
  withDb(async (db) => {
    const plan = (sql) =>
      db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all('d')
        .map((row) => row.detail)
        .join(' | ')
    for (const sql of [
      "SELECT * FROM usage_logs WHERE execution_kind='gateway_worker' AND dispatch_id=? LIMIT 1",
      "UPDATE usage_logs SET billing_status='unmetered' WHERE execution_kind='gateway_worker' AND dispatch_id=?",
    ])
      assert.match(plan(sql), /idx_usage_logs_gateway_dispatch/, sql)
    // 不带 execution_kind 时整表扫描（回执与对账原先的写法）
    assert.match(plan('SELECT * FROM usage_logs WHERE dispatch_id=? LIMIT 1'), /SCAN usage_logs/)
  }),
)

test('Gateway logs the Worker attempt count, including same-account retries and switches', async () => {
  const { logBag } = await dispatch({
    protocol: 'openai.responses',
    gateway: fakeGateway(SSE, {
      headers: {
        'x-kin-gateway-attempts': JSON.stringify([
          { account: 'acct_0', status: 503, category: 'capacity_unavailable' },
          { account: 'acct_1', status: 200 },
        ]),
      },
    }),
    body: { model: 'gpt-5.5', stream: true, input: 'hi' },
  })
  assert.equal(logBag.attempt_count, 2)
  const single = await dispatch({ protocol: 'openai.responses', body: { model: 'gpt-5.5', stream: true, input: 'hi' } })
  assert.equal(single.logBag.attempt_count, 1)
})

test('Gateway stream cut before a terminal event is reported, not settled as success', async () => {
  const cut = SSE.split('\n\n').slice(0, 2).join('\n\n') + '\n\n'
  const chat = await dispatch({
    protocol: 'openai.chat',
    gateway: fakeGateway(cut),
    body: { model: 'gpt-5.5', stream: true, messages: [{ role: 'user', content: 'hi' }] },
  })
  assert.equal(chat.logBag.final_state, 'incomplete')
  assert.match(chat.res.chunks.join(''), /gateway_stream_incomplete[\s\S]*data: \[DONE\]/)

  const json = await dispatch({
    protocol: 'openai.responses',
    gateway: fakeGateway(cut),
    body: { model: 'gpt-5.5', stream: false, input: 'hi' },
  })
  assert.equal(json.res.statusCode, 502)
  assert.equal(json.res.body.error.code, 'gateway_stream_incomplete')
})

test(
  'Worker attempts are recorded one row per upstream try with the final delivery on the last',
  withDb(async (db) => {
    const { RequestAttemptsRepo } = await import('../../src/lib/db/repos/request-attempts-repo.mjs')
    const { recordGatewayAttempts } = await import('../../src/lib/gateway-worker/gateway-execution.mjs')
    const repo = new RequestAttemptsRepo(db)
    const attempts = [
      { account: 'acct_a', status: 429, category: 'usage_limit_exhausted', send_state: 'sent' },
      { account: 'acct_b', status: 200, send_state: 'sent' },
    ]
    recordGatewayAttempts(repo, {
      requestId: 'req_multi',
      model: 'gpt-5.5',
      result: {
        status: 200,
        instance_id: 'gw_1',
        dispatch_id: 'd_1',
        headers: { 'x-kin-gateway-attempts': JSON.stringify(attempts) },
      },
      accountId: 'acct_b',
      final: {
        sendState: 'sent',
        terminalState: 'verified',
        downstreamCommitted: true,
        usageConfidence: 'complete',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    })
    const rows = repo.list('req_multi')
    assert.equal(rows.length, 2)
    assert.equal(rows[0].account_id, 'acct_a')
    assert.equal(rows[0].upstream_status, 429)
    assert.equal(rows[0].downstream_committed, false)
    assert.equal(rows[1].account_id, 'acct_b')
    assert.equal(rows[1].terminal_state, 'verified')
    assert.equal(rows[1].downstream_committed, true)
  }),
)

test('control plane hops to another Worker only when the first reports not_sent', async () => {
  const { GatewayWorkerService } = await import('../../src/lib/gateway-worker/gateway-execution.mjs')
  const instances = [{ id: 'gw_a' }, { id: 'gw_b' }]
  const repo = {
    pickInstance: ({ exclude }) => instances.find((item) => !exclude?.has(item.id)) || null,
    // gw_a 上有一个未同步账号：只排除它，实例照常接单
    unsyncedRuntimeAccounts: (id) => (id === 'gw_a' ? ['gwacct_stale'] : []),
  }
  const calls = []
  const scopes = {}
  const make = (responses) => {
    const service = new GatewayWorkerService({ repo, secret: 's' })
    service.client = {
      async execute({ instanceId, scope }) {
        calls.push(instanceId)
        scopes[instanceId] = scope
        const next = responses[instanceId]
        if (next instanceof Error) throw next
        return next
      },
    }
    return service
  }
  const notSent = {
    ok: false,
    status: 503,
    data: { error: { code: 'gateway_worker_capacity_exhausted' } },
    headers: { 'x-kin-gateway-send-state': 'not_sent' },
  }
  const ok = { ok: true, status: 200, data: { id: 'resp' }, headers: { 'x-kin-gateway-send-state': 'sent' } }
  let out = await make({ gw_a: notSent, gw_b: ok }).execute({ protocol: 'openai.responses', body: {}, requestId: 'r1' })
  assert.deepEqual(calls.splice(0), ['gw_a', 'gw_b'])
  assert.equal(out.instance_id, 'gw_b')
  assert.equal(out.ok, true)
  assert.deepEqual(scopes.gw_a.exclude_accounts, ['gwacct_stale'])
  assert.equal(scopes.gw_b.exclude_accounts, undefined)

  // 已发送的上游失败不跨实例重放
  const sentFailure = {
    ok: false,
    status: 429,
    data: { error: { type: 'usage_limit_reached' } },
    headers: { 'x-kin-gateway-send-state': 'sent' },
  }
  out = await make({ gw_a: sentFailure, gw_b: ok }).execute({ protocol: 'openai.responses', body: {}, requestId: 'r2' })
  assert.deepEqual(calls.splice(0), ['gw_a'])
  assert.equal(out.status, 429)

  // 未连上 Worker 视为未发送；结果不明的错误直接抛出
  const refused = Object.assign(new Error('refused'), {
    code: 'ECONNREFUSED',
    send_state: 'not_sent',
    dispatch_id: 'd',
  })
  out = await make({ gw_a: refused, gw_b: ok }).execute({ protocol: 'openai.responses', body: {}, requestId: 'r3' })
  assert.deepEqual(calls.splice(0), ['gw_a', 'gw_b'])
  assert.equal(out.ok, true)
  const reset = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET', send_state: 'ambiguous' })
  await assert.rejects(
    make({ gw_a: reset, gw_b: ok }).execute({ protocol: 'openai.responses', body: {}, requestId: 'r4' }),
    /socket hang up/,
  )
  assert.deepEqual(calls.splice(0), ['gw_a'])
})

test('Gateway logs the sent model as upstream_model and keeps the response echo apart', async () => {
  const sse = [
    'data: {"type":"response.created","response":{"id":"r","model":"gpt-5.4-mini"}}',
    'data: {"type":"response.completed","response":{"id":"r","model":"gpt-5.4-mini","usage":{"input_tokens":10,"output_tokens":5}}}',
    '',
  ].join('\n\n')
  const { logBag } = await dispatch({
    protocol: 'openai.responses',
    gateway: fakeGateway(sse),
    body: { model: 'gpt-5.5', stream: true, input: 'hi' },
  })
  assert.equal(logBag.upstream_model, 'gpt-5.5')
  assert.equal(logBag.response_model, 'gpt-5.4-mini')
  const { responseModelForLog } = await import('../../src/lib/protocol/log-fields.mjs')
  // 上游未回显模型时不能拿发送模型冒充回显
  assert.equal(responseModelForLog({ via: 'gateway-worker', upstream_model: 'gpt-5.5', response_model: null }), null)
  assert.equal(responseModelForLog({ via: 'codex-kernel-fallback', upstream_model: 'gpt-5.5' }), null)
})

test('inbound WS native continuation keeps the processed top-level fields and only the incremental input', async () => {
  const gateway = fakeGateway()
  await dispatch({
    protocol: 'openai.responses',
    gateway,
    // ctx.body 是展开历史并经过模型映射后的请求；nativeBody 是原始增量帧
    body: {
      model: 'gpt-5.5',
      stream: true,
      input: [
        { type: 'message', role: 'user', content: 'first' },
        { type: 'message', role: 'user', content: 'next' },
      ],
    },
    req: {
      gatewayWs: {
        connectionKey: 'wsc_1',
        nativeBody: { model: 'gpt-alias', stream: true, input: 'next', previous_response_id: 'resp_prev' },
      },
    },
  })
  const call = gateway.calls[0]
  assert.equal(call.model, 'gpt-5.5')
  assert.equal(call.body.model, 'gpt-5.5')
  assert.equal(call.body.previous_response_id, 'resp_prev')
  assert.equal(call.body.input.length, 1)
  assert.equal(call.replayBody.input.length, 2)
  assert.equal(call.replayBody.previous_response_id, undefined)
})

test('a caller that disconnects before the terminal event is logged as cancelled, not verified', async () => {
  const res = fakeRes()
  async function* events() {
    yield Buffer.from('data: {"type":"response.created","response":{"id":"r_c","model":"gpt-5.5"}}\n\n')
    // 调用方在终态前断开
    res.destroyed = true
    yield Buffer.from('data: {"type":"response.output_text.delta","delta":"hi"}\n\n')
  }
  let cancelled = 0
  const gateway = {
    ...fakeGateway(),
    cancel: async () => {
      cancelled++
    },
    async execute() {
      return {
        ok: true,
        status: 200,
        stream: true,
        headers: { 'x-kin-gateway-account': 'acct_1', 'content-type': 'text/event-stream' },
        body: Readable.toWeb(Readable.from(events())),
        instance_id: 'gw_1',
        dispatch_id: 'dispatch_c',
        release() {},
        cancel() {
          cancelled++
        },
      }
    },
  }
  const { logBag } = await dispatch({
    protocol: 'openai.responses',
    gateway,
    res,
    body: { model: 'gpt-5.5', stream: true, input: 'hi' },
  })
  assert.equal(logBag.final_state, 'cancelled')
  assert.equal(logBag.error_code, 'client_cancelled')
  assert.equal(logBag.gateway_await_receipt, true)
  assert.ok(cancelled > 0)
})

test('only successful, ambiguous, committed-then-cancelled or BPS-truncated Gateway requests wait for the Receipt', async () => {
  const { awaitsGatewayReceipt } = await import('../../src/lib/gateway-worker/gateway-execution.mjs')
  const bag = (extra) => ({ execution_kind: 'gateway_worker', usage_confidence: 'unknown', ...extra })
  assert.equal(awaitsGatewayReceipt(bag({ final_state: 'verified' })), true)
  assert.equal(awaitsGatewayReceipt(bag({ final_state: 'ambiguous' })), true)
  assert.equal(awaitsGatewayReceipt(bag({ final_state: 'cancelled', gateway_await_receipt: true })), true)
  // 提交前取消、失败与截断不等回执
  assert.equal(awaitsGatewayReceipt(bag({ final_state: 'cancelled' })), false)
  for (const state of ['upstream_error', 'incomplete', 'rejected'])
    assert.equal(awaitsGatewayReceipt(bag({ final_state: state })), false)
  assert.equal(awaitsGatewayReceipt(bag({ final_state: 'verified', usage_confidence: 'complete' })), false)
  assert.equal(awaitsGatewayReceipt({ final_state: 'verified', usage_confidence: 'unknown' }), false)
  // BPS 上游截断等回执按已消耗用量下限结算（实时路径不计费，即使中途用量看似完整）；原生截断、
  // 控制面协议转换失败（上游流完整、调用方收到错误）不等（复核 W1）
  const cut = { final_state: 'incomplete', authorization_mode: 'bps', error_code: 'gateway_stream_incomplete' }
  assert.equal(awaitsGatewayReceipt(bag(cut)), true)
  assert.equal(awaitsGatewayReceipt(bag({ ...cut, usage_confidence: 'complete' })), true)
  assert.equal(awaitsGatewayReceipt(bag({ ...cut, error_code: 'tool_arguments_invalid_json' })), false)
  assert.equal(awaitsGatewayReceipt(bag({ ...cut, authorization_mode: 'native' })), false)
})

test('Gateway stream parses each event once and skips delta lines after the first token', async () => {
  const deltas = Array.from({ length: 50 }, (_, i) => `data: {"type":"response.output_text.delta","delta":"t${i}"}`)
  const sse = [
    'data: {"type":"response.created","response":{"id":"r_d","model":"gpt-5.5"}}',
    ...deltas,
    'data: {"type":"response.completed","response":{"id":"r_d","model":"gpt-5.5","service_tier":"default","usage":{"input_tokens":12,"output_tokens":50}}}',
    '',
  ].join('\n\n')
  const { CodexResponseOwnersRepo } = await import('../../src/lib/db/repos/codex-response-owners-repo.mjs')
  const original = CodexResponseOwnersRepo.prototype.remember
  const remembered = []
  CodexResponseOwnersRepo.prototype.remember = function (scope, id) {
    remembered.push(id)
    return true
  }
  const db = await import('../../src/lib/db/database.mjs')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-delta-'))
  db.openDatabase({ dataDir: dir })
  const parse = JSON.parse
  let parsed = 0
  JSON.parse = (...args) => {
    parsed++
    return parse(...args)
  }
  let logBag
  try {
    ;({ logBag } = await dispatch({
      protocol: 'openai.responses',
      gateway: fakeGateway(sse, { headers: { 'x-kin-gateway-account': 'acct_1' } }),
      body: { model: 'gpt-5.5', stream: true, input: 'hi' },
      req: { apiKeyRecord: { id: 7, group_id: 3, user_id: 1 } },
    }))
  } finally {
    JSON.parse = parse
    CodexResponseOwnersRepo.prototype.remember = original
    db.closeDatabase()
    fs.rmSync(dir, { recursive: true, force: true })
  }
  assert.equal(logBag.final_state, 'verified')
  assert.equal(logBag.usage.input_tokens, 12)
  assert.equal(logBag.usage.output_tokens, 50)
  assert.equal(logBag.upstream_service_tier, 'default')
  assert.equal(logBag.response_model, 'gpt-5.5')
  assert.ok(logBag.first_token_ms != null)
  // 首个增量之后的 49 行不解析
  assert.ok(parsed < 20, `parsed ${parsed} times`)
  assert.ok(remembered.length <= 1, `remembered ${remembered.length} times`)
})

test('continuation pins only the runtime account, not the credential revision', async () => {
  const gateway = fakeGateway()
  const { CodexResponseOwnersRepo } = await import('../../src/lib/db/repos/codex-response-owners-repo.mjs')
  const original = CodexResponseOwnersRepo.prototype.resolve
  CodexResponseOwnersRepo.prototype.resolve = () => ({
    execution_kind: 'gateway_worker',
    runtime_account_id: 'acct_1',
    account_resource_id: 'res_1',
    credential_revision: 3,
  })
  const db = await import('../../src/lib/db/database.mjs')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-cont-'))
  db.openDatabase({ dataDir: dir })
  try {
    await dispatch({
      protocol: 'openai.responses',
      gateway,
      body: { model: 'gpt-5.5', stream: true, input: 'hi', previous_response_id: 'resp_prev' },
    })
  } finally {
    CodexResponseOwnersRepo.prototype.resolve = original
    db.closeDatabase()
    fs.rmSync(dir, { recursive: true, force: true })
  }
  assert.equal(gateway.calls[0].scope.runtime_account_id, 'acct_1')
  assert.equal(gateway.calls[0].scope.credential_revision, undefined)
})

test('quota actions run once on a healthy Worker and write the snapshot back to every binding', async () => {
  const { GatewayWorkerService } = await import('../../src/lib/gateway-worker/gateway-execution.mjs')
  const recorded = []
  const repo = {
    listAccountBindings: () => [
      { gateway_instance_id: 'gw_off', runtime_account_id: 'acct_1' },
      { gateway_instance_id: 'gw_on', runtime_account_id: 'acct_1' },
    ],
    getInstance: (id) => ({ id, health_state: id === 'gw_on' ? 'healthy' : 'offline' }),
    recordAccountQuota: (resourceId, quota) => recorded.push([resourceId, quota]),
  }
  const service = new GatewayWorkerService({ repo, secret: 's' })
  const calls = []
  service.client = {
    async accountAction(instanceId, accountId, action, body) {
      calls.push([instanceId, accountId, action, body])
      return {
        ok: true,
        status: 200,
        data: { quota: { primary_window: { used_percent: 10 } }, reset_credits: { available_count: 1 } },
      }
    },
  }
  const out = await service.accountAction('res_1', 'quota')
  assert.equal(out.ok, true)
  assert.deepEqual(calls, [['gw_on', 'acct_1', 'quota', {}]])
  assert.deepEqual(recorded, [['res_1', { primary_window: { used_percent: 10 } }]])

  calls.length = 0
  await service.accountAction('res_1', 'reset-credits', { credit_id: 'c1', redeem_request_id: 'r1', extra: 'x' })
  assert.deepEqual(calls[0][3], { credit_id: 'c1', redeem_request_id: 'r1' })
})

test(
  'recordAccountQuota writes the quota to all bindings of the account',
  withDb(async (db) => {
    const repo = new GatewayWorkerRepo(db)
    // 只验证写回范围，不构造完整的供应商资源与实例外键
    db.exec('PRAGMA foreign_keys=OFF')
    db.prepare(
      `INSERT INTO gateway_worker_account_bindings(id,account_resource_id,gateway_instance_id,runtime_account_id,projection_status,created_at,updated_at) VALUES('b1','res_q','gw_a','acct','synced','2026-01-01','2026-01-01'),('b2','res_q','gw_b','acct','synced','2026-01-01','2026-01-01'),('b3','res_other','gw_a','acct_2','synced','2026-01-01','2026-01-01')`,
    ).run()
    assert.equal(await repo.recordAccountQuota('res_q', { credits: { has_credits: true } }), 2)
    const rows = db
      .prepare("SELECT quota_json FROM gateway_worker_account_bindings WHERE account_resource_id='res_q'")
      .all()
    assert.ok(rows.every((row) => JSON.parse(row.quota_json).credits.has_credits === true))
    assert.equal(
      db.prepare("SELECT quota_json FROM gateway_worker_account_bindings WHERE id='b3'").get().quota_json,
      null,
    )
  }),
)

function seedQuotaBindings(db) {
  db.exec('PRAGMA foreign_keys=OFF')
  db.prepare(
    `INSERT INTO vendor_resources(id,vendor_id,resource_type,name,config_json,created_by,created_at,updated_at) VALUES('res_q',NULL,'account','acct','{"platform":"openai","execution_kind":"gateway_worker"}','test','now','now')`,
  ).run()
  db.prepare(
    `INSERT INTO gateway_worker_account_bindings(id,account_resource_id,gateway_instance_id,runtime_account_id,projection_status,quota_json,created_at,updated_at) VALUES('b1','res_q','gw_a','acct','synced',?,'2026-01-01','2026-01-01'),('b2','res_q','gw_b','acct','synced',NULL,'2026-01-01','2026-01-01')`,
  ).run(
    JSON.stringify({
      primary_window: { used_percent: 81, window_minutes: 10080 },
      plan_type: 'pro',
      updated_at: '2026-11-03T05:00:00Z',
    }),
  )
  const read = (id) =>
    JSON.parse(
      db.prepare('SELECT quota_json FROM gateway_worker_account_bindings WHERE id=?').get(id).quota_json || 'null',
    )
  return read
}

test(
  'heartbeat quota snapshots update every binding unless the stored snapshot is newer',
  withDb(async (db) => {
    const repo = new GatewayWorkerRepo(db)
    const read = seedQuotaBindings(db)
    const snapshot = {
      primary_window: { used_percent: 100, window_minutes: 10080 },
      source: 'wham_usage',
      updated_at: '2026-11-03T06:02:23.922650196Z',
    }
    assert.equal(
      await repo.recordRuntimeQuotas('gw_a', [
        { account_id: 'acct', quota: snapshot },
        { account_id: 'unknown', quota: snapshot },
        { account_id: 'acct' },
      ]),
      2,
    )
    assert.deepEqual(read('b1'), snapshot)
    assert.deepEqual(read('b2'), snapshot)
    // 较旧的心跳快照不覆盖控制面已有的新快照
    assert.equal(
      await repo.recordRuntimeQuotas('gw_b', [
        { account_id: 'acct', quota: { primary_window: { used_percent: 90 }, updated_at: '2026-11-03T06:00:00Z' } },
      ]),
      0,
    )
    assert.equal(read('b2').primary_window.used_percent, 100)
  }),
)

test(
  'receipt quota without observations keeps the stored snapshot and partial evidence is merged',
  withDb(async (db) => {
    const repo = new GatewayWorkerRepo(db)
    const read = seedQuotaBindings(db)
    await repo.updateBindingFromReceipt({
      gateway_instance_id: 'gw_a',
      runtime_account_id: 'acct',
      quota: { confidence: 'unknown', updated_at: '2026-11-03T05:51:16Z' },
    })
    assert.equal(read('b1').primary_window.used_percent, 81)
    await repo.updateBindingFromReceipt({
      gateway_instance_id: 'gw_a',
      runtime_account_id: 'acct',
      quota: {
        secondary_window: { used_percent: 12, window_minutes: 300 },
        primary_window: null,
        confidence: 'partial',
        updated_at: '2026-11-03T05:52:00Z',
      },
    })
    const merged = read('b1')
    assert.equal(merged.primary_window.used_percent, 81)
    assert.equal(merged.secondary_window.used_percent, 12)
    assert.equal(merged.plan_type, 'pro')
    assert.equal(merged.updated_at, '2026-11-03T05:52:00Z')
  }),
)

test('quota probe queries every active Gateway account and reports per-account results', async () => {
  const { GatewayWorkerService } = await import('../../src/lib/gateway-worker/gateway-execution.mjs')
  const service = new GatewayWorkerService({
    repo: {
      listCodexAccounts: () => [
        { id: 'res_ok', name: 'ok', status: 'active', runtime_account_id: 'r1', credential_revision: 1 },
        { id: 'res_bad', name: 'bad', status: 'active', runtime_account_id: 'r2', credential_revision: 1 },
        { id: 'res_paused', name: 'paused', status: 'paused', runtime_account_id: 'r3', credential_revision: 1 },
        { id: 'res_pending', name: 'pending', status: 'active', runtime_account_id: null, credential_revision: 0 },
      ],
    },
    secret: 's',
  })
  const calls = []
  service.accountAction = async (id, action) => {
    calls.push([id, action])
    return id === 'res_ok'
      ? { ok: true, status: 200, data: { quota: {} } }
      : { ok: false, status: 401, data: { error: { code: 'token_invalidated', message: 'credential invalid' } } }
  }
  const items = await service.probeAccountQuotas()
  assert.deepEqual(calls.sort(), [
    ['res_bad', 'quota'],
    ['res_ok', 'quota'],
  ])
  assert.deepEqual(
    items.sort((a, b) => a.id.localeCompare(b.id)),
    [
      { id: 'bad', ok: false, error: 'credential invalid' },
      { id: 'ok', ok: true },
    ],
  )
})

test('Gateway dispatch forwards the frozen scheduling policy and wait budget', async () => {
  const gateway = fakeGateway()
  await dispatch({
    protocol: 'openai.responses',
    gateway,
    codex: { scheduling: { strategy: 'round_robin', affinity: 'strict' } },
    body: { model: 'gpt-5.5', stream: true, input: 'hi' },
  })
  const scheduling = gateway.calls[0].scheduling
  assert.equal(scheduling.strategy, 'round_robin')
  assert.equal(scheduling.affinity, 'strict')
  assert.equal(typeof scheduling.wait_timeout_ms, 'number')
  assert.ok(scheduling.smart_weights.load >= 0)
})

test('Gateway usage uses the VM billing shape: cached input is disjoint and reasoning stays an output subset', async () => {
  const sse = [
    'data: {"type":"response.created","response":{"id":"r","model":"gpt-5.5"}}',
    'data: {"type":"response.completed","response":{"id":"r","service_tier":"default","usage":{"input_tokens":100,"input_tokens_details":{"cached_tokens":40},"output_tokens":30,"output_tokens_details":{"reasoning_tokens":12}}}}',
    '',
  ].join('\n\n')
  const { logBag } = await dispatch({
    protocol: 'openai.responses',
    gateway: fakeGateway(sse),
    body: { model: 'gpt-5.5', stream: true, input: 'hi', service_tier: 'priority' },
  })
  assert.equal(logBag.usage.input_tokens, 60)
  assert.equal(logBag.usage.cache_read_input_tokens, 40)
  assert.equal(logBag.usage.output_tokens, 30)
  assert.equal(logBag.usage.reasoning_tokens, 12)
  assert.equal(logBag.usage.service_tier, 'priority')
  assert.equal(logBag.upstream_service_tier, 'default')
})

test(
  'Receipt backfill applies the same disjoint usage to usage_logs',
  withDb(async (db) => {
    const repo = new GatewayWorkerRepo(db)
    db.exec('PRAGMA foreign_keys=OFF')
    db.prepare(
      "INSERT INTO usage_logs(request_id,dispatch_id,execution_kind,model,status,created_at) VALUES('req_u','d_u','gateway_worker','gpt-5.5',200,'2026-11-03T00:00:00Z')",
    ).run()
    await repo.applyReceiptToUsage({
      dispatch_id: 'd_u',
      usage_confidence: 'complete',
      upstream_model: 'gpt-5.5',
      usage: {
        input_tokens: 100,
        input_tokens_details: { cached_tokens: 40 },
        output_tokens: 30,
        output_tokens_details: { reasoning_tokens: 12 },
      },
    })
    const row = db
      .prepare("SELECT input_tokens,output_tokens,cache_read_tokens FROM usage_logs WHERE dispatch_id='d_u'")
      .get()
    assert.deepEqual({ ...row }, { input_tokens: 60, output_tokens: 30, cache_read_tokens: 40 })
  }),
)

test(
  'Receipt replay from the reconciler prices stored usage_json and never zeroes cost or rewrites the client status',
  withDb(async (db) => {
    const repo = new GatewayWorkerRepo(db)
    db.exec('PRAGMA foreign_keys=OFF')
    const insert = db.prepare(
      "INSERT INTO usage_logs(request_id,dispatch_id,execution_kind,model,status,final_state,input_tokens,output_tokens,total_cost,created_at) VALUES(?,?,'gateway_worker','gpt-5.5',?,?,?,?,?,'2026-11-03T00:00:00Z')",
    )
    insert.run('req_ok', 'd_ok', 200, 'verified', 60, 30, 0.5)
    insert.run('req_fail', 'd_fail', 503, 'upstream_error', 0, 0, null)
    // 对账任务传入数据库行：usage 只在 usage_json 里
    await repo.applyReceiptToUsage({
      dispatch_id: 'd_ok',
      usage_confidence: 'complete',
      upstream_status: 200,
      terminal_state: 'completed',
      upstream_model: 'gpt-5.5',
      usage_json: JSON.stringify({ input_tokens: 100, input_tokens_details: { cached_tokens: 40 }, output_tokens: 30 }),
    })
    const ok = db.prepare("SELECT * FROM usage_logs WHERE dispatch_id='d_ok'").get()
    assert.equal(ok.input_tokens, 60)
    assert.equal(ok.cache_read_tokens, 40)
    assert.ok(ok.total_cost > 0, `cost was zeroed: ${ok.total_cost}`)
    assert.equal(ok.status, 200)
    assert.equal(ok.final_state, 'verified')
    // 没有 token 证据的回执不能把已算好的成本覆盖成 0
    await repo.applyReceiptToUsage({ dispatch_id: 'd_ok', usage_confidence: 'complete', usage_json: '{}' })
    assert.equal(
      db.prepare("SELECT total_cost FROM usage_logs WHERE dispatch_id='d_ok'").get().total_cost,
      ok.total_cost,
    )
    // 流内失败：上游 HTTP 200 不能覆盖交付给调用方的 503 与终态
    await repo.applyReceiptToUsage({
      dispatch_id: 'd_fail',
      usage_confidence: 'partial',
      upstream_status: 200,
      terminal_state: 'upstream_error',
      usage_json: '{}',
    })
    const failed = db.prepare("SELECT status,final_state,total_cost FROM usage_logs WHERE dispatch_id='d_fail'").get()
    assert.deepEqual({ ...failed }, { status: 503, final_state: 'upstream_error', total_cost: null })
  }),
)

test(
  'Receipt backfill keeps the cost the live log already priced from complete usage',
  withDb(async (db) => {
    const repo = new GatewayWorkerRepo(db)
    db.exec('PRAGMA foreign_keys=OFF')
    db.prepare(
      "INSERT INTO usage_logs(request_id,dispatch_id,execution_kind,model,upstream_model,status,usage_confidence,input_tokens,output_tokens,total_cost,pricing_model,created_at) VALUES('req_p','d_p','gateway_worker','gpt-5.5','gpt-5.5',200,'complete',60,30,0.25,'group:image_count','2026-11-03T00:00:00Z')",
    ).run()
    await repo.applyReceiptToUsage({
      dispatch_id: 'd_p',
      usage_confidence: 'complete',
      upstream_model: 'gpt-5.5',
      usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 40 }, output_tokens: 30 },
    })
    const row = db.prepare("SELECT total_cost,pricing_model,input_tokens FROM usage_logs WHERE dispatch_id='d_p'").get()
    assert.deepEqual({ ...row }, { total_cost: 0.25, pricing_model: 'group:image_count', input_tokens: 60 })
  }),
)

test('key model catalog lists OpenAI models for groups that only bind Gateway Worker accounts', async () => {
  const { keyModelCatalog } = await import('../../src/lib/protocol/key-models.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-models-'))
  const scope = {
    platform: false,
    group_type: 'openai',
    allowed_vms: [],
    allowed_endpoints: [],
    allowed_gateway_accounts: ['res_1'],
    models: [],
  }
  const withGateway = keyModelCatalog({ scope, projectRoot: root })
  const without = keyModelCatalog({ scope: { ...scope, allowed_gateway_accounts: [] }, projectRoot: root })
  assert.ok(withGateway.data.length > 0)
  assert.ok(
    withGateway.data.every(
      (model) => /^(gpt|codex|o\d)/i.test(model.id) || model.id.includes('gpt') || model.id.includes('image'),
    ),
  )
  assert.equal(without.data.length, 0)
})

test('GPT catalog sync falls back to a Gateway Worker when no Codex VM slot exists', async () => {
  const { syncCodexCatalog } = await import('../../src/lib/admin/vm-test-chat.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-catalog-'))
  fs.mkdirSync(path.join(root, 'data'), { recursive: true })
  const calls = []
  const gatewayWorker = {
    async fetchModelCatalog(version) {
      calls.push(version)
      return { ok: true, instance_id: 'gw_1', catalog: { models: [{ slug: 'gpt-5.5', display_name: 'GPT-5.5' }] } }
    },
  }
  const result = await syncCodexCatalog({ projectRoot: root, gatewayWorker, catalogClientVersion: '0.170.0' })
  assert.equal(result.ok, true)
  assert.equal(result.source, 'gateway_worker')
  assert.deepEqual(result.ids, ['gpt-5.5'])
  assert.deepEqual(calls, ['0.170.0'])
  const failed = await syncCodexCatalog({
    projectRoot: root,
    gatewayWorker: { fetchModelCatalog: async () => ({ ok: false, error: 'model_catalog_unavailable' }) },
    catalogClientVersion: '0.170.0',
  })
  assert.equal(failed.ok, false)
  assert.equal(failed.error, 'model_catalog_unavailable')
})

test(
  'account receipts are listed through the account Worker bindings',
  withDb(async (db) => {
    const repo = new GatewayWorkerRepo(db)
    db.exec('PRAGMA foreign_keys=OFF')
    db.prepare(
      `INSERT INTO gateway_worker_account_bindings(id,account_resource_id,gateway_instance_id,runtime_account_id,projection_status,created_at,updated_at) VALUES('b1','res_r','gw_a','acct','synced','2026-01-01','2026-01-01')`,
    ).run()
    for (const [dispatch, instance, runtime] of [
      ['d1', 'gw_a', 'acct'],
      ['d2', 'gw_a', 'other'],
      ['d3', 'gw_b', 'acct'],
    ])
      await repo.ingestReceipt({
        receipt_id: `r_${dispatch}`,
        dispatch_id: dispatch,
        request_id: `req_${dispatch}`,
        gateway_instance_id: instance,
        runtime_account_id: runtime,
        terminal_state: 'completed',
      })
    assert.deepEqual(
      (await repo.listAccountReceipts('res_r')).map((row) => row.dispatch_id),
      ['d1'],
    )
  }),
)

test('gateway envelope carries the account error protection policy with its fingerprint', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-protection-'))
  const db = createDatabase({ dataDir: dir })
  try {
    const disabled = gatewayAccountProtection(db)
    assert.equal(disabled.enabled, false)
    assert.match(disabled.fingerprint, /^[0-9a-f]{64}$/)
    await new SettingsRepo(db).set('account_error_protection', {
      enabled: true,
      threshold: 3,
      windowMs: 600000,
      durationMs: 3600000,
      probeEnabled: true,
      probeModel: 'gpt-5.5',
      rules: [{ id: 'r1', name: 'flagged', conditions: [{ field: 'status', operator: 'equals', values: ['403'] }] }],
    })
    const policy = gatewayAccountProtection(db)
    assert.equal(policy.enabled, true)
    assert.equal(policy.threshold, 3)
    assert.equal(policy.rules[0].conditions[0].values[0], '403')
    assert.notEqual(policy.fingerprint, disabled.fingerprint)
    await new SettingsRepo(db).set('account_error_protection', { enabled: true, rules: [] })
    assert.equal(gatewayAccountProtection(db), null)
  } finally {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function delayedGateway(delayMs, inner) {
  return {
    ...inner,
    async execute(args) {
      await new Promise((resolve) => setTimeout(resolve, delayMs))
      return inner.execute(args)
    },
  }
}

test('Gateway streams keep the client alive while the Worker queues and turn late errors into response.failed', async () => {
  const failing = {
    ...fakeGateway(),
    async execute() {
      return {
        ok: false,
        status: 429,
        stream: false,
        headers: { 'retry-after': '7' },
        body: { error: { type: 'rate_limit_error', code: 'concurrency_queue_timeout', message: 'busy' } },
      }
    },
  }
  const late = await dispatch({
    protocol: 'openai.responses',
    body: { model: 'gpt-5.5', stream: true, input: 'hi' },
    gateway: delayedGateway(70, failing),
    keepaliveMs: 20,
  })
  const text = late.res.chunks.join('')
  assert.equal(late.res.sse, true)
  assert.match(text, /^: keep-alive\n\n/)
  assert.match(text, /event: response\.failed\ndata: /)
  const failed = JSON.parse(text.split('event: response.failed\ndata: ')[1].split('\n')[0])
  assert.equal(failed.response.status, 'failed')
  assert.equal(failed.response.error.code, 'concurrency_queue_timeout')
  assert.equal(failed.response.error.headers['retry-after'], '7')
  assert.match(text, /data: \[DONE\]\n\n$/)
  assert.equal(late.res.writableEnded, true)

  // 保活窗口内的失败仍保留原 HTTP 状态
  const fast = await dispatch({
    protocol: 'openai.responses',
    body: { model: 'gpt-5.5', stream: true, input: 'hi' },
    gateway: failing,
    keepaliveMs: 50,
  })
  assert.equal(fast.res.statusCode, 429)
  assert.equal(fast.res.chunks.length, 0)

  // 保活后成功：正文接在心跳之后，不重复写头
  const ok = await dispatch({
    protocol: 'openai.responses',
    body: { model: 'gpt-5.5', stream: true, input: 'hi' },
    gateway: delayedGateway(70, fakeGateway()),
    keepaliveMs: 20,
  })
  const body = ok.res.chunks.join('')
  assert.match(body, /^: keep-alive\n\n/)
  assert.match(body, /response\.completed/)
  assert.equal(ok.logBag.final_state, 'verified')

  // Chat 调用方收到 chat 错误帧
  const chat = await dispatch({
    protocol: 'openai.chat',
    body: { model: 'gpt-5.5', stream: true, messages: [{ role: 'user', content: 'hi' }] },
    gateway: delayedGateway(70, failing),
    keepaliveMs: 20,
  })
  assert.match(
    chat.res.chunks.join(''),
    /data: \{"error":\{"type":"rate_limit_error","code":"concurrency_queue_timeout"[\s\S]*data: \[DONE\]/,
  )
})

test('Gateway records the Worker-reported channel and forwards the BPS master switch (on by default)', async () => {
  const { logBag, gateway } = await dispatch({
    protocol: 'openai.responses',
    gateway: fakeGateway(SSE, { headers: { 'x-kin-gateway-auth-mode': 'bps' } }),
    body: { model: 'gpt-5.5', stream: true, input: 'hi' },
  })
  assert.equal(logBag.authorization_mode, 'bps')
  assert.equal(gateway.calls[0].scheduling.bps_enabled, true)
  assert.deepEqual(gateway.calls[0].scheduling.bps_images, {
    policy: 'auto_compact',
    max_images: 20,
    max_image_mib: 32,
    max_total_mib: 64,
    warning_remaining: 8,
    compact_reserve: 3,
  })
  const warn = await dispatch({
    protocol: 'openai.responses',
    gateway: fakeGateway(SSE),
    codex: {
      bps_images: { policy: 'warn', max_images: 6, warning_remaining: 9, compact_reserve: 0, max_total_mib: 500 },
    },
    body: { model: 'gpt-5.5', stream: true, input: 'hi' },
  })
  assert.deepEqual(warn.gateway.calls[0].scheduling.bps_images, {
    policy: 'warn',
    max_images: 6,
    max_image_mib: 32,
    max_total_mib: 64,
    warning_remaining: 5,
    compact_reserve: 0,
  })
  const off = await dispatch({
    protocol: 'openai.responses',
    gateway: fakeGateway(SSE, { headers: { 'x-kin-gateway-auth-mode': 'unexpected' } }),
    codex: { bps_enabled: false },
    body: { model: 'gpt-5.5', stream: true, input: 'hi' },
  })
  assert.equal(off.logBag.authorization_mode, undefined)
  assert.equal(off.gateway.calls[0].scheduling.bps_enabled, undefined)
  assert.equal(off.gateway.calls[0].scheduling.bps_images, undefined)
})

test('Gateway records the Worker-reported upstream path and transport for the endpoint column', async () => {
  const { logBag } = await dispatch({
    protocol: 'openai.responses',
    gateway: fakeGateway(SSE, {
      headers: {
        'x-kin-gateway-upstream-path': '/basispoints/api/responses',
        'x-kin-gateway-upstream-transport': 'websocket',
      },
    }),
    body: { model: 'gpt-5.5', stream: true, input: 'hi' },
  })
  assert.equal(logBag.upstream_path, '/basispoints/api/responses')
  assert.equal(logBag.upstream_transport, 'websocket')
  const bad = await dispatch({
    protocol: 'openai.responses',
    gateway: fakeGateway(SSE, {
      headers: { 'x-kin-gateway-upstream-path': 'not-a-path', 'x-kin-gateway-upstream-transport': 'carrier-pigeon' },
    }),
    body: { model: 'gpt-5.5', stream: true, input: 'hi' },
  })
  assert.equal(bad.logBag.upstream_path, undefined)
  assert.equal(bad.logBag.upstream_transport, undefined)
})
