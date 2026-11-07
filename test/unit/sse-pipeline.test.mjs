import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { parseSseLine, sseDataEvent, writeWithBackpressure } from '../../src/lib/protocol/sse-events.mjs'
import {
  createAnthropicSseState,
  createResponsesSseEventNamer,
  responsesSseToAnthropicEvents,
  responsesSseToChatChunk,
} from '../../src/lib/protocol/codex-convert.mjs'
import { createProtocolRes, WS_BUFFER_HIGH_WATER } from '../../src/lib/protocol/responses-ws.mjs'

// 审计阶段 2 W15：每条 SSE data 行只解析一次，写给客户端时有背压

test('an SSE line parses into skip, done or one event object', () => {
  assert.deepEqual(parseSseLine('event: response'), { skip: true })
  assert.deepEqual(parseSseLine('data: [DONE]'), { done: true })
  assert.deepEqual(parseSseLine('data: not json'), { skip: true })
  assert.deepEqual(sseDataEvent('data: {"type":"response.created"}'), { type: 'response.created' })
  assert.equal(sseDataEvent('data: 42'), null)
})

test('converters reuse the caller parsed event instead of parsing the line again', () => {
  // 行本身不是合法 JSON：只有使用调用方传入的事件，转换器才会有输出
  const broken = 'data: {unparsed'
  const created = { type: 'response.created', response: { id: 'resp_1', model: 'gpt-x' } }
  const delta = { type: 'response.output_text.delta', delta: 'hi' }
  const anthropic = createAnthropicSseState()
  responsesSseToAnthropicEvents(broken, anthropic, created)
  assert.match(responsesSseToAnthropicEvents(broken, anthropic, delta) || '', /hi/)
  assert.equal(responsesSseToAnthropicEvents(broken, createAnthropicSseState()), null)
  assert.match(responsesSseToChatChunk(broken, 'codex', null, delta) || '', /hi/)
  const name = createResponsesSseEventNamer()
  assert.equal(name(broken, delta), `event: response.output_text.delta\n${broken}\n`)
})

function slowRes() {
  const res = new EventEmitter()
  res.writableEnded = false
  res.destroyed = false
  res.written = []
  res.full = true
  res.write = (chunk) => {
    res.written.push(chunk)
    return !res.full
  }
  return res
}

test('a full write buffer waits for drain before the next upstream line is read', async () => {
  const res = slowRes()
  let resolved = false
  const pending = writeWithBackpressure(res, 'a').then(() => {
    resolved = true
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(resolved, false, 'still waiting for drain')
  res.emit('drain')
  await pending
  assert.equal(resolved, true)
  assert.equal(res.listenerCount('drain'), 0)
  assert.equal(res.listenerCount('close'), 0)
})

// 计时器 unref 后不挡住进程退出；生产里 HTTP 服务端保持事件循环，测试里用一个句柄代替
function keepAlive(t) {
  const handle = setInterval(() => {}, 1000)
  t.after(() => clearInterval(handle))
}

test('the drain wait is bounded and ends at once when the client closes', async (t) => {
  keepAlive(t)
  const res = slowRes()
  const started = Date.now()
  await writeWithBackpressure(res, 'a', { maxWaitMs: 30 })
  assert.ok(Date.now() - started >= 25, 'waits up to the bound')
  const closing = writeWithBackpressure(res, 'b', { maxWaitMs: 10_000 })
  res.emit('close')
  const t0 = Date.now()
  await closing
  assert.ok(Date.now() - t0 < 1000)
  res.full = false
  const quick = Date.now()
  await writeWithBackpressure(res, 'c', { maxWaitMs: 10_000 })
  assert.ok(Date.now() - quick < 100, 'no wait when the buffer accepts the chunk')
})

test('the WebSocket protocol response reports pressure from the socket buffer and drains', async (t) => {
  keepAlive(t)
  let buffered = WS_BUFFER_HIGH_WATER + 1
  const res = createProtocolRes({ pressure: () => buffered })
  assert.equal(res.write('x'), false)
  const drained = new Promise((resolve) => res.once('drain', resolve))
  buffered = 0
  await drained
  assert.equal(res.write('y'), true)
  assert.equal(createProtocolRes().write('z'), true, 'no pressure source means no backpressure')
})
