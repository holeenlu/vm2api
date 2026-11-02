import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  clearCodexSessionOverload,
  codexSessionOverloadBlocked,
  codexSessionRecoveryDue,
  markCodexSessionRecovery,
  noteCodexSessionOverload,
  resetCodexSessionOverload,
  tripCodexSessionOverload,
} from '../../src/lib/pool/codex-session-overload.mjs'
import { codexContextFallback } from '../../src/lib/protocol/handle-codex.mjs'

const overload = {
  status: 502,
  committed: false,
  body: { error: { code: 'server_is_overloaded', message: 'servers are currently overloaded' } },
}

test('session overload guard waits for repeated failures, then allows one recovery', () => {
  resetCodexSessionOverload()
  assert.equal(noteCodexSessionOverload('s', 'gpt-6.1-sol', 1000).recoveryDue, false)
  assert.equal(noteCodexSessionOverload('s', 'gpt-6.1-sol', 1100).recoveryDue, true)
  assert.equal(codexSessionRecoveryDue('s', 'gpt-6.1-sol', 1100), true)
  assert.equal(markCodexSessionRecovery('s', 'gpt-6.1-sol', 1100), true)
  assert.equal(codexSessionRecoveryDue('s', 'gpt-6.1-sol', 1100), false)
  const tripped = tripCodexSessionOverload('s', 'gpt-6.1-sol', 1200)
  assert.equal(tripped.retryAfterMs, 60_000)
  assert.equal(noteCodexSessionOverload('s', 'gpt-6.1-sol', 1201).stop, true)
  assert.equal(codexSessionOverloadBlocked('s', 'gpt-6.1-sol', 1201), true)
  clearCodexSessionOverload('s', 'gpt-6.1-sol')
  assert.equal(codexSessionRecoveryDue('s', 'gpt-6.1-sol', 1201), false)
})

test('context fallback removes old reasoning and tool history while retaining recent input', () => {
  const input = []
  for (let i = 0; i < 16; i++) {
    input.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: `u${i}` }] })
    input.push({ type: 'reasoning', encrypted_content: 'x'.repeat(20_000), summary: [] })
    input.push({ type: 'function_call_output', output: `tool${i}` })
  }
  const args = { body: { model: 'gpt-6.1-sol', input }, envelope: { body: { model: 'gpt-6.1-sol', input } } }
  const fallback = codexContextFallback(args, overload)
  assert.ok(fallback)
  assert.ok(fallback.info.removed_items > 0)
  assert.ok(fallback.args.body.input.length < input.length)
  assert.equal(args.body.input.length, input.length)
  assert.equal(fallback.args.body.input.at(-1).type, 'function_call_output')
})
