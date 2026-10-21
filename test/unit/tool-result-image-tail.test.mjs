import test from 'node:test'
import assert from 'node:assert/strict'
import {
  toolResultImageTailRequested,
  moveToolResultImagesToTail,
} from '../../src/lib/protocol/tool-result-image-tail.mjs'
import { prepareCliHopBody } from '../../src/lib/protocol/outbound-attempt.mjs'
import { assembleOfficialPromptBody } from '../../src/lib/protocol/anthropic-messages.mjs'
import { validateCacheBreakpoints } from '../../src/lib/protocol/cache-ttl.mjs'
import { trackCachePrefix, clearCachePrefixSessions } from '../../src/lib/protocol/cache-prefix.mjs'

const image = (data) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } })
const request = (parts) => ({
  model: 'claude-opus-5-5',
  system: [{ type: 'text', text: 'caller instructions' }],
  messages: [
    { role: 'user', content: 'read the file' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'Read', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', is_error: true, content: parts }] },
  ],
})
const prepare = (body) =>
  assembleOfficialPromptBody(prepareCliHopBody(body, { cacheTtl: '5m', toolResultImageTail: true }), {
    ttl: '5m',
    preserveMessageMarker: true,
  })

test('tool image tail mode is explicitly opt-in and leaves default requests in place', () => {
  assert.equal(toolResultImageTailRequested({}), false)
  assert.equal(toolResultImageTailRequested({ 'x-kin-tool-result-images': 'inline' }), false)
  assert.equal(toolResultImageTailRequested({ 'x-kin-tool-result-images': ' TAIL ' }), true)
  const out = prepareCliHopBody(request([image('tool')]))
  assert.equal(out.messages[2].content[0].content[0].type, 'image')
})

test('final assembly preserves tool linkage, errors and direct uploads with the cache anchor before tool images', () => {
  const input = request([
    { type: 'text', text: 'result', cache_control: { type: 'ephemeral', ttl: '1h' } },
    image('tool'),
  ])
  input.messages[2].content.push(image('direct'), { type: 'text', text: 'question' })
  const before = structuredClone(input)
  const out = prepare(input)
  const content = out.messages[2].content
  assert.deepEqual(out.messages[1], input.messages[1])
  assert.deepEqual(content[0], {
    type: 'tool_result',
    tool_use_id: 'call-1',
    is_error: true,
    content: [{ type: 'text', text: 'result' }],
  })
  assert.deepEqual(content[1], image('direct'))
  assert.deepEqual(content[2].cache_control, { type: 'ephemeral', ttl: '5m' })
  assert.equal(content[3].text, 'Images from tool result "call-1":')
  assert.deepEqual(content[4], image('tool'))
  assert.equal(content[3].cache_control, undefined)
  assert.equal(content[4].cache_control, undefined)
  assert.doesNotThrow(() => validateCacheBreakpoints(out))
  assert.deepEqual(input, before)
})

test('evicting uncached tool images preserves cache continuity but changing tool text breaks it', () => {
  clearCachePrefixSessions()
  const first = prepare(request([{ type: 'text', text: 'stable' }, image('tool')]))
  const omitted = prepare(
    request([
      { type: 'text', text: 'stable' },
      { type: 'text', text: '[image omitted: provider image limit]' },
    ]),
  )
  const changed = prepare(request([{ type: 'text', text: 'changed' }]))
  trackCachePrefix('image-tail', first, 1000, { cacheOnly: true })
  const second = trackCachePrefix('image-tail', omitted, 1100, { cacheOnly: true })
  assert.equal(second.scope, 'cached_prefix')
  assert.equal(Boolean(second.break), false)
  assert.ok(trackCachePrefix('image-tail', changed, 1200, { cacheOnly: true }).break)
  const onlyImage = prepare(request([image('tool')]))
  const onlyOmission = prepare(request([{ type: 'text', text: '[image omitted: provider image limit]' }]))
  assert.equal(onlyImage.messages[2].content[0].content, '')
  assert.equal(onlyOmission.messages[2].content[0].content, '')
  clearCachePrefixSessions()
})

test('signed thinking requires explicit drop_block permission before image movement', () => {
  for (const type of ['thinking', 'redacted_thinking']) {
    const input = request([image('tool')])
    input.messages[1].content.unshift(
      type === 'thinking'
        ? { type, thinking: 'private', signature: 'sig_real_1234567890abcdef' }
        : { type, data: 'opaque' },
    )
    const before = structuredClone(input)
    assert.throws(
      () => moveToolResultImagesToTail(input),
      (error) => error.status === 400 && error.body.error.code === 'tool_result_image_tail_binding',
    )
    assert.deepEqual(input, before)
    input.thinking = { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } }
    const out = prepare(input)
    assert.equal(out.thinking.block_binding.prefix_mismatch_behavior, 'drop_block')
    assert.equal(out.messages[2].content.at(-1).type, 'image')
  }
})
