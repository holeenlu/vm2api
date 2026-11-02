import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  codexContextBudget,
  codexContextCompactionRequired,
  compactCodexInput,
  estimateCodexInputTokens,
} from '../../src/lib/protocol/codex-context-budget.mjs'

test('Astra follows the synced upstream context by default', () => {
  const budget = codexContextBudget('gpt-6-astra', { max_output_tokens: 16_384 })
  assert.equal(budget.contextWindow, 272_000)
  assert.ok(budget.inputTriggerTokens > 220_000)
})

test('an OpenAI policy override changes the gateway budget', async () => {
  const { openDatabase, closeDatabase } = await import('../../src/lib/db/database.mjs')
  const { saveGptModelPolicy, loadGptModelPolicy, resetGptModelPolicy } = await import(
    '../../src/lib/protocol/gpt-model-policy.mjs'
  )
  openDatabase({ dbPath: ':memory:' })
  try {
    loadGptModelPolicy({ force: true })
    saveGptModelPolicy({ models: { 'gpt-6-astra': { context_window_override: 500000 } } })
    assert.equal(codexContextBudget('gpt-6-astra').contextWindow, 500000)
  } finally {
    resetGptModelPolicy()
    closeDatabase()
  }
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

test('incremental size accounting matches a full re-serialization', () => {
  // 压缩循环按「各项字节数之和 + 括号 + 逗号」增量推算剩余 token，不再每删
  // 一项就把剩余历史整个 JSON.stringify。这里钉住该推算与全量序列化等价：
  // 一旦两者分叉，删除条数和 info 里的 token 数都会悄悄算错。
  const input = []
  for (let i = 0; i < 80; i += 1) {
    input.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: `问题${i}“引号”\\转义` }] })
    input.push({ type: 'reasoning', encrypted_content: 'x'.repeat(12_000), summary: [] })
    input.push({ type: 'function_call_output', call_id: `c${i}`, output: '工具结果'.repeat(200) })
  }
  const original = structuredClone(input)
  for (const force of [false, true]) {
    const compacted = compactCodexInput({ model: 'gpt-6-astra', input: structuredClone(original) }, { force })
    assert.ok(compacted, `force=${force} 应触发压缩`)
    assert.equal(compacted.info.original_tokens, estimateCodexInputTokens(original))
    assert.equal(compacted.info.retained_tokens, estimateCodexInputTokens(compacted.body.input))
    assert.equal(compacted.info.retained_items, compacted.body.input.length)
    assert.equal(compacted.info.removed_items, original.length - compacted.body.input.length)
    assert.deepEqual(compacted.body.input.slice(-18), original.slice(-18))
  }

  // token 数按 4 字节向上取整，单字节偏差只有约 1/4 的概率改变结果，
  // 所以要跨多种长度和内容反复比对，才能稳定抓到括号/逗号项算错。
  for (let extra = 0; extra < 40; extra += 1) {
    const varied = []
    for (let i = 0; i < 20 + extra; i += 1) {
      varied.push({ type: 'reasoning', encrypted_content: 'y'.repeat(5_000 + extra * 7 + i), summary: [] })
      varied.push({
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: `q${i}`.repeat(1 + (i % 3)) }],
      })
    }
    const got = compactCodexInput({ model: 'gpt-6-astra', input: structuredClone(varied) }, { force: true })
    assert.ok(got, `extra=${extra} 应触发压缩`)
    assert.equal(got.info.retained_tokens, estimateCodexInputTokens(got.body.input), `extra=${extra} token 数不一致`)
  }
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
