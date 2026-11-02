import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequestFacts } from '../../src/lib/protocol/request-facts.mjs'

test('request facts normalize protocol boundary fields without mutating input', () => {
  const input = { method: 'post', route: '/v1/messages', model: ' claude-x ', stream: true }
  const facts = createRequestFacts(input, { now: '2026-11-01T00:00:00.000Z' })
  assert.equal(facts.method, 'POST')
  assert.equal(facts.path, '/v1/messages')
  assert.equal(facts.model, 'claude-x')
  assert.equal(facts.stream, true)
  assert.equal(input.method, 'post')
})
