import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeUsageFacts, usageFactsFromLog } from '../../src/lib/usage/usage-facts.mjs'

test('usage facts preserve unknown values and normalize aliases', () => {
  const facts = normalizeUsageFacts({ prompt_tokens: 10, completion_tokens: 4, cost_usd: null })
  assert.equal(facts.input_tokens, 10)
  assert.equal(facts.output_tokens, 4)
  assert.equal(facts.total_tokens, 14)
  assert.equal(facts.cost_usd, null)
  assert.equal(facts.priced, null)
  assert.equal(facts.request_count, 1)
})

test('usage facts from logs retain actual cost and completion state', () => {
  const facts = usageFactsFromLog({ id: 'r1', input_tokens: 1, output_tokens: 2, actual_cost_usd: 0.03 })
  assert.equal(facts.request_id, 'r1')
  assert.equal(facts.cost_usd, 0.03)
  assert.equal(facts.priced, true)
  assert.equal(facts.usage_complete, true)
})
