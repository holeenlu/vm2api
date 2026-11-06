import test from 'node:test'
import assert from 'node:assert/strict'
import { validateOfficialMessagesShape } from '../../src/lib/protocol/anthropic-official-shape.mjs'

const ok = { model: 'claude-sonnet-5-5', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }
const message = (body) => validateOfficialMessagesShape(body).errorResult?.body?.error?.message

test('valid official requests pass, including a final empty assistant prefill and Claude Code mid-conversation system', () => {
  assert.equal(
    validateOfficialMessagesShape({ ...ok, messages: [...ok.messages, { role: 'system', content: 'reminder' }] }).ok,
    true,
  )
  assert.equal(validateOfficialMessagesShape(ok).ok, true)
  assert.equal(
    validateOfficialMessagesShape({
      ...ok,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { role: 'assistant', content: '' },
      ],
    }).ok,
    true,
  )
})

test('requests the official API rejects return 400 instead of being repaired and billed', () => {
  const { max_tokens: _omit, ...noMax } = ok
  assert.equal(message(noMax), 'max_tokens: Field required')
  assert.equal(validateOfficialMessagesShape(noMax).errorResult.status, 400)
  assert.equal(message({ ...ok, max_tokens: 0 }), 'max_tokens: Input should be greater than or equal to 1')
  assert.equal(message({ ...ok, max_tokens: 2.5 }), 'max_tokens: Input should be a valid integer')
  assert.equal(message({ ...ok, messages: [] }), 'messages: at least one message is required')
  assert.equal(
    message({ ...ok, messages: [{ role: 'tool', content: 'x' }, ...ok.messages] }),
    "messages.0.role: Input should be 'user' or 'assistant'",
  )
  assert.equal(
    message({ ...ok, messages: [{ content: 'x' }] }),
    "messages.0.role: Input should be 'user' or 'assistant'",
  )
  assert.match(
    message({
      ...ok,
      messages: [
        { role: 'user', content: '' },
        { role: 'assistant', content: 'a' },
      ],
    }),
    /^messages\.0: all messages must have non-empty content/,
  )
  assert.match(message({ ...ok, messages: [{ role: 'user', content: [] }] }), /^messages\.0: /)
})
