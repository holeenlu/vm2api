import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  codexContextBudget,
  codexContextCompactionRequired,
  compactCodexInput,
  estimateCodexInputTokens,
} from '../../src/lib/protocol/codex-context-budget.mjs'

test('Astra uses the gateway 500k context override even when policy metadata is stale', () => {
  const budget = codexContextBudget('gpt-6-astra', { max_output_tokens: 16_384 })
  assert.equal(budget.contextWindow, 500_000)
  assert.ok(budget.inputTriggerTokens > 400_000)
})

test('large full-history requests are compacted before the first upstream hop', () => {
  const input = []
  for (let i = 0; i < 60; i += 1) {
    input.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: `u${i}` }] })
    input.push({ type: 'reasoning', encrypted_content: 'x'.repeat(30_000), summary: [] })
  }
  const body = { model: 'gpt-6-astra', input }
  assert.ok(estimateCodexInputTokens(input) > 400_000)
  const compacted = compactCodexInput(body)
  assert.ok(compacted)
  assert.equal(compacted.info.preflight, true)
  assert.ok(compacted.body.input.length < input.length)
  assert.deepEqual(compacted.body.input.slice(-18), input.slice(-18))
})

test('previous_response_id is left intact for an explicit client compaction recovery', () => {
  const body = { model: 'gpt-6-astra', previous_response_id: 'resp_1', input: [{ type: 'message' }] }
  assert.equal(compactCodexInput(body), null)
  const error = codexContextCompactionRequired(body.model, body)
  assert.equal(error.status, 409)
  assert.equal(error.body.error.code, 'codex_context_compaction_required')
  assert.equal(error.body.error.details.action, 'resend_compacted_history')
  assert.equal(error.body.error.details.remove, 'previous_response_id')
})
