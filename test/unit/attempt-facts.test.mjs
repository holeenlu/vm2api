import test from 'node:test'
import assert from 'node:assert/strict'
import { advanceAttemptFacts, createAttemptFacts } from '../../src/lib/protocol/attempt-facts.mjs'

test('attempt facts never downgrade send state or downstream commit', () => {
  const current = createAttemptFacts({ send_state: 'sent', downstream_committed: true })
  const next = advanceAttemptFacts(current, { send_state: 'not_sent', downstream_committed: false })
  assert.equal(next.send_state, 'sent')
  assert.equal(next.downstream_committed, true)
})
