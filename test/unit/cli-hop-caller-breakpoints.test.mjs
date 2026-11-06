import test from 'node:test'
import assert from 'node:assert/strict'
import { prepareCliHopBody } from '../../src/lib/protocol/outbound-attempt.mjs'
import { validateCacheBreakpoints } from '../../src/lib/protocol/cache-ttl.mjs'

// #524: the rewrite (non-zero, official template) path used to clear every caller
// message breakpoint and re-stamp only the tail and the previous user turn.

function conversation(length, { system = 'Caller system prompt.' } = {}) {
  return {
    model: 'claude-opus-5-5',
    max_tokens: 32,
    ...(system ? { system } : {}),
    messages: Array.from({ length }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user',
      content: [{ type: 'text', text: `stable-${i}` }],
    })),
  }
}

const mark = (body, i, ttl = '5m') => {
  body.messages[i].content[0].cache_control = { type: 'ephemeral', ttl }
}
const messageMarkers = (body) =>
  body.messages.flatMap((message, i) =>
    Array.isArray(message.content) && message.content.some((block) => block.cache_control) ? [i] : [],
  )
const systemMarkers = (body) => (body.system || []).filter((block) => block.cache_control).length

test('#524 a stable caller anchor survives the rewrite and the next turn after an account switch', () => {
  const first = conversation(915)
  mark(first, 910)
  const out = prepareCliHopBody(structuredClone(first), { cacheTtl: '1h' })
  assert.equal(systemMarkers(out), 2)
  // Caller anchor + our tail; our previous-turn marker has no slot left.
  assert.deepEqual(messageMarkers(out), [910, 914])
  // Kept markers take the request TTL so the 1h-before-5m order stays legal.
  assert.deepEqual(out.messages[910].content[0].cache_control, { type: 'ephemeral', ttl: '1h' })
  validateCacheBreakpoints(out)
  // The next turn edits history after the anchor: the anchor is still sent at 910.
  const second = structuredClone(first)
  second.messages[912].content[0].text = 'changed-historical-block'
  assert.deepEqual(messageMarkers(prepareCliHopBody(second, { cacheTtl: '1h' })), [910, 914])
})

test('#524 a caller marker on the tail costs nothing extra and keeps both of ours', () => {
  const body = conversation(9)
  mark(body, 8)
  const out = prepareCliHopBody(body, { cacheTtl: '1h' })
  assert.deepEqual(messageMarkers(out), [6, 8])
  validateCacheBreakpoints(out)
})

test('#524 without a caller system body the freed slot keeps the caller anchor and both of ours', () => {
  const body = conversation(9, { system: null })
  mark(body, 2)
  const out = prepareCliHopBody(body, { cacheTtl: '5m' })
  assert.equal(systemMarkers(out), 1)
  assert.deepEqual(messageMarkers(out), [2, 6, 8])
  assert.deepEqual(out.messages[2].content[0].cache_control, { type: 'ephemeral', ttl: '5m' })
  validateCacheBreakpoints(out)
})

test('#524 over budget the caller markers are dropped and the request stays within four', () => {
  const body = conversation(915)
  mark(body, 900)
  mark(body, 910)
  const out = prepareCliHopBody(body, { cacheTtl: '1h' })
  assert.deepEqual(messageMarkers(out), [912, 914])
  assert.equal(systemMarkers(out) + messageMarkers(out).length, 4)
  validateCacheBreakpoints(out)
})

test('#524 a caller marker on a thinking block is never carried over', () => {
  const body = conversation(5)
  body.messages[1].content = [
    { type: 'thinking', thinking: 'x', signature: 'sig', cache_control: { type: 'ephemeral' } },
    { type: 'text', text: 'answer' },
  ]
  const out = prepareCliHopBody(body, { cacheTtl: '1h', preserveThinkingBlocks: true })
  assert.equal(out.messages[1].content[0].cache_control, undefined)
  assert.deepEqual(messageMarkers(out), [2, 4])
})
