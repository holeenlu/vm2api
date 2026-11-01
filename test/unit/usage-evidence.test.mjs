import test from 'node:test'
import assert from 'node:assert/strict'
import { createUsageEvidence } from '../../src/lib/protocol/usage-evidence.mjs'

const start = {
  type: 'message_start',
  message: { usage: { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 50 } },
}
test('initial usage and message_stop never turn unknown output into a zero bill', () => {
  const evidence = createUsageEvidence()
  evidence.observe(start)
  evidence.observe({ type: 'message_stop' })
  assert.equal(evidence.snapshot().usageComplete, false)
  evidence.observe({ type: 'message_delta', usage: { output_tokens: 5 } })
  assert.equal(evidence.snapshot().usageComplete, false)
})
test('terminal delta completes raw usage including cache counters and genuine zero output', () => {
  const evidence = createUsageEvidence()
  evidence.observe(start)
  evidence.observe({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } })
  evidence.observe({ type: 'error', error: { code: 'interrupted_after_usage' } })
  assert.deepEqual(evidence.snapshot(), { usage: start.message.usage, usageComplete: true })
})
test('Responses failed/incomplete terminal usage remains billable; created usage is provisional', () => {
  for (const type of ['completed', 'done', 'failed', 'incomplete']) {
    const evidence = createUsageEvidence()
    const usage = { input_tokens: 100, output_tokens: 25, input_tokens_details: { cached_tokens: 50 } }
    evidence.line('data: ' + JSON.stringify({ type: 'response.created', response: { usage } }))
    assert.equal(evidence.snapshot().usageComplete, false)
    evidence.line('data: ' + JSON.stringify({ type: 'response.' + type, response: { usage } }))
    assert.deepEqual(evidence.snapshot(), { usage, usageComplete: true })
  }
})
test('missing, negative and malformed counters are not settlement evidence', () => {
  for (const output_tokens of [undefined, null, -1, '0', 1.2]) {
    const evidence = createUsageEvidence()
    evidence.observe({ type: 'response.completed', response: { usage: { input_tokens: 100, output_tokens } } })
    assert.equal(evidence.snapshot().usageComplete, false)
  }
})
