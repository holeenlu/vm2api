import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  codexBodyToAnthropicMessage,
  createAnthropicSseState,
  createChatSseState,
  responsesSseToAnthropicEvents,
  responsesSseToChatChunk,
  toCodexResponses,
} from '../../src/lib/protocol/codex-convert.mjs'

const anthropicToCodex = (body) => toCodexResponses('anthropic.messages', body, { anthropic_to_codex: true }).body
import {
  claudeSSELineToOpenAIChatChunks,
  claudeStopReasonToOpenAIFinish,
  createOpenAIChatStreamState,
} from '../../src/lib/protocol/convert.mjs'
import { responsesNeedsUnsupportedItems } from '../../src/lib/pool/api-protocol.mjs'
import { FailoverRunner } from '../../src/lib/pool/failover-runner.mjs'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'
import { clearConversationCacheTtls } from '../../src/lib/protocol/cache-ttl.mjs'

const sse = (event) => `data: ${JSON.stringify(event)}`

test('Codex reasoning summaries never leak into the Anthropic answer text (audit P1-P3)', () => {
  const state = createAnthropicSseState()
  const out = [
    sse({ type: 'response.created', response: { id: 'r1', model: 'gpt-test' } }),
    sse({ type: 'response.reasoning_summary_text.delta', delta: 'secret plan' }),
    sse({ type: 'response.output_text.delta', delta: 'Hello' }),
    sse({ type: 'response.completed', response: { id: 'r1', status: 'completed', usage: {} } }),
  ]
    .map((line) => responsesSseToAnthropicEvents(line, state) || '')
    .join('')
  assert.ok(out.includes('Hello'))
  assert.ok(!out.includes('secret plan'))
})

test('an incomplete Codex response ends as a truncation in every converted shape', () => {
  const incomplete = {
    type: 'response.incomplete',
    response: { id: 'r2', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, usage: {} },
  }
  const anthropic = createAnthropicSseState()
  responsesSseToAnthropicEvents(sse({ type: 'response.output_text.delta', delta: 'partial' }), anthropic)
  const closing = responsesSseToAnthropicEvents(sse(incomplete), anthropic)
  assert.match(closing, /"stop_reason":"max_tokens"/)
  assert.match(closing, /message_stop/)

  const chat = createChatSseState('c1')
  responsesSseToChatChunk(sse({ type: 'response.output_text.delta', delta: 'partial' }), 'c1', chat)
  const chatEnd = responsesSseToChatChunk(sse(incomplete), 'c1', chat)
  assert.match(chatEnd, /"finish_reason":"length"/)
  assert.match(chatEnd, /\[DONE\]/)

  const message = codexBodyToAnthropicMessage({
    status: 'incomplete',
    incomplete_details: { reason: 'max_output_tokens' },
    output: [{ type: 'message', content: [{ type: 'output_text', text: 'partial' }] }],
  })
  assert.equal(message.stop_reason, 'max_tokens')
})

test('Anthropic images and reasoning effort survive conversion to Codex (audit P1-P4)', () => {
  const body = anthropicToCodex({
    model: 'gpt-test',
    max_tokens: 100,
    thinking: { type: 'enabled', budget_tokens: 20000 },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is this?' },
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } },
        ],
      },
    ],
  })
  assert.equal(body.reasoning?.effort, 'high')
  assert.ok(JSON.stringify(body.input).includes('data:image/jpeg;base64,QUJD'))
  const explicit = anthropicToCodex({
    model: 'gpt-test',
    output_config: { effort: 'low' },
    messages: [{ role: 'user', content: 'hi' }],
  })
  assert.equal(explicit.reasoning?.effort, 'low')
})

test('Chat stream usage keeps the prompt tokens from message_start and context exhaustion is a length stop', () => {
  const state = createOpenAIChatStreamState('claude-test', 'vm-1')
  claudeSSELineToOpenAIChatChunks(
    sse({ type: 'message_start', message: { usage: { input_tokens: 120, cache_read_input_tokens: 30 } } }),
    state,
  )
  const [last] = claudeSSELineToOpenAIChatChunks(
    sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } }),
    state,
  )
  assert.equal(last.usage.prompt_tokens, 150)
  assert.equal(last.usage.completion_tokens, 7)
  assert.equal(claudeStopReasonToOpenAIFinish('model_context_window_exceeded'), 'length')
})

test('Responses features that the Anthropic endpoint conversion would flatten are detected (audit P1-P5)', () => {
  assert.equal(responsesNeedsUnsupportedItems({ input: 'plain text' }), false)
  assert.equal(responsesNeedsUnsupportedItems({ input: [{ role: 'user', content: 'hi' }] }), false)
  assert.equal(responsesNeedsUnsupportedItems({ tools: [{ type: 'function', name: 'f' }], input: 'x' }), true)
  assert.equal(
    responsesNeedsUnsupportedItems({ input: [{ type: 'function_call_output', call_id: 'c', output: '1' }] }),
    true,
  )
  assert.equal(
    responsesNeedsUnsupportedItems({
      input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'https://x/y.png' }] }],
    }),
    true,
  )
})

test('a conversation whose account credential died gets a retryable 503, not the upstream 401 (audit P1-P7)', async () => {
  let forgot = 0
  const runner = new FailoverRunner({
    scheduler: {
      async selectAndReserve() {
        return { ok: true, vmId: 'vm-1', accountId: 'acc-1', vm: { id: 'vm-1' }, release() {} }
      },
      markSuccess() {},
      markCooldown() {},
      releaseAccountSessions() {},
    },
    config: { max_same_account_retries: 0 },
  })
  runner.forgetCredential = async () => {
    forgot++
  }
  const result = await runner.run({
    requestId: 'req-family',
    canonicalBody: { model: 'claude-sonnet-test', metadata: { user_id: 'family-user' } },
    model: 'claude-sonnet-test',
    familyKey: 'family:1',
    callAttempt: () => ({
      ok: false,
      status: 401,
      body: { type: 'error', error: { type: 'authentication_error', message: 'OAuth token has been revoked' } },
    }),
  })
  assert.ok(forgot > 0, 'revoked credential takes the credential-death path')
  if (forgot) {
    assert.equal(result.status, 503)
    assert.equal(result.body.error.code, 'account_unavailable')
    assert.equal(result.accountCredentialStatus, 401)
  } else {
    // 运行器把这次 401 当作可换号的失败（没有触发凭据失效分支）时，也不能把 401 交给客户端当作 Key 失效
    assert.notEqual(result.body?.error?.type, 'authentication_error')
  }
})

async function streamCall(t, { protocol, upstream }) {
  clearConversationCacheTtls()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-failure-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const routing = { sticky: { outbound_session: 'passthrough' }, compatibility: { persona_preset: 'official_full' } }
  const routingFile = path.join(root, 'routing.json')
  fs.writeFileSync(routingFile, JSON.stringify(routing))
  const model = 'claude-sonnet-4-5'
  const incoming =
    protocol === 'openai.chat'
      ? { model, stream: true, messages: [{ role: 'user', content: 'Hello' }] }
      : { model, max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'Hello' }] }
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
  const written = []
  const response = {
    headersSent: true,
    writableEnded: false,
    on() {},
    once() {},
    off() {},
    setHeader() {},
    write(chunk) {
      written.push(String(chunk))
      return true
    },
    end(chunk) {
      if (chunk) written.push(String(chunk))
      this.writableEnded = true
    },
  }
  const handler = createHandleProtocol({
    json(_res, status, body) {
      response.status = status
      response.body = body
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
    requestLog: { start: () => ({ request_id: 'stream-failure-fixture' }), finish() {} },
    stickyRouter: { extractPoolKey: () => null, collectPoolKeys: () => [] },
    accountQuota: { ingestHeaders() {} },
    apiKeyStore: { canAccept: (record) => ({ ok: true, record }), acquire: () => ({ ok: true }), release() {} },
    apiScheduler: { pick: () => ({ ok: false }) },
    apiEndpointStore: {},
    stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
    routingConfigPath: routingFile,
    routingConfig: routing,
    groupsRepo: { rateMultiplier: () => 1 },
    failoverRunner: {
      run(opts) {
        return runner.run({ ...opts, callAttempt: () => structuredClone(upstream) })
      },
    },
  })
  await handler.handleProtocol(
    {
      method: 'POST',
      url: protocol === 'openai.chat' ? '/v1/chat/completions' : '/v1/messages',
      headers: { authorization: 'Bearer fixture', 'user-agent': 'test-client' },
      apiKeyKind: 'managed',
      apiKeyRecord: { id: 'fixture', name: 'fixture' },
      once() {},
      off() {},
    },
    response,
    protocol,
    protocol === 'openai.chat' ? '/v1/chat/completions' : '/v1/messages',
  )
  return written.join('')
}

const brokenStream = {
  ok: false,
  status: 502,
  committed: true,
  terminalState: 'incomplete',
  body: { type: 'error', error: { type: 'api_error', code: 'worker_timeout', message: 'stream idle timeout' } },
}

test('an OpenAI-protocol stream that fails after headers ends with an error frame and [DONE] (audit P1-P2)', async (t) => {
  const out = await streamCall(t, { protocol: 'openai.chat', upstream: brokenStream })
  assert.match(out, /"error"/)
  assert.match(out, /\[DONE\]/)
})
