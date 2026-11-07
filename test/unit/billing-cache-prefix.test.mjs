import test from 'node:test'
import assert from 'node:assert/strict'

// 生产 2026-11-05：同一槽位上相隔 5 秒的两次相同请求各自整段重写 1h 缓存（cache_read 为 0、token ±1 漂移）。
// 计费头里的 cch 按整个请求体封装、cc_prompt_id 跟出站会话走，每轮都会变；它排在缓存断点之前时，
// 缓存前缀每次都不同。official_full 模板必须把它放到最后一个 system 缓存断点（以及 CLI 拆分点）之后。
const BILLING = /^\s*x-anthropic-billing-header:/i
const BOUNDARY = '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'

async function render(callerSystem) {
  const { applyCrsUnofficialPersona } = await import('../../src/lib/identity/crs-persona.mjs')
  const { prepareCliHopBody } = await import('../../src/lib/protocol/outbound-attempt.mjs')
  const model = 'claude-sonnet-5-5'
  const rendered = applyCrsUnofficialPersona(
    {
      model,
      max_tokens: 64,
      system: callerSystem,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with one word.' }] }],
    },
    { forceConfigured: true, mode: 'official_full', model },
  )
  return { rendered, wire: prepareCliHopBody(rendered, { stream: true, personaPreset: 'official_full' }) }
}

function systemBlocks(body) {
  return Array.isArray(body.system) ? body.system : []
}

test('official_full parks the billing header after the last system cache breakpoint', async () => {
  for (const stage of ['rendered', 'wire']) {
    const body = (await render('You are a terse bot.'))[stage]
    const system = systemBlocks(body)
    const billingAt = system.findIndex((b) => BILLING.test(String(b?.text || '')))
    if (billingAt < 0) continue
    let anchorAt = -1
    system.forEach((b, i) => {
      if (i !== billingAt && (b?.cache_control || String(b?.text || '').trim() === BOUNDARY)) anchorAt = i
    })
    assert.ok(anchorAt >= 0, `${stage}: template keeps a cache breakpoint`)
    assert.ok(
      billingAt > anchorAt,
      `${stage}: billing (index ${billingAt}) sits after the last breakpoint (${anchorAt})`,
    )
  }
})

test('a per-request billing value no longer changes the cacheable system prefix', async () => {
  const a = (await render('You are a terse bot.')).wire
  const b = structuredClone(a)
  // 模拟下一次请求：cch / cc_prompt_id 取新值，其余完全相同。
  for (const block of systemBlocks(b))
    if (BILLING.test(String(block?.text || '')))
      block.text = block.text.replace(/cch=[^;]*;/, 'cch=9f3a1;').replace(/cc_prompt_id=[^;]*;/, 'cc_prompt_id=other;')
  const prefix = (body) => {
    const system = systemBlocks(body)
    let last = -1
    system.forEach((block, i) => {
      if (block?.cache_control) last = i
    })
    return JSON.stringify({ tools: body.tools || [], system: system.slice(0, last + 1) })
  }
  assert.ok(prefix(a).length > 2, 'prefix is not empty')
  assert.equal(prefix(b), prefix(a))
})
