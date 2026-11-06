import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  customerUsage,
  customerUsageInSseLine,
  customerUsageOnMessage,
} from '../../src/lib/protocol/customer-usage.mjs'
import { customerCacheIntent, fillMissingCacheTtl } from '../../src/lib/protocol/cache-ttl.mjs'
import { calculateCost } from '../../src/lib/admin/pricing.mjs'
import { callerPromptTokenFloor } from '../../src/lib/identity/crs-persona-usage.mjs'

test('the injected estimate never deducts below the caller prompt floor', () => {
  const caller = {
    system: 'Answer briefly.',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Describe this picture in one short sentence please.' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(40_000) } },
        ],
      },
    ],
  }
  const floor = callerPromptTokenFloor(caller)
  // 图片 base64 不计入下限，只按文字 chars/4
  assert.equal(floor, Math.floor(('Answer briefly.'.length + 51) / 4))
  // 估算 910 大于上游真实注入：只扣到剩下客户自己的下限
  const billed = customerUsage(
    { input_tokens: 40, ...{ cache_creation_input_tokens: 600 }, output_tokens: 3 },
    { injectedTokens: 910, callerTokens: floor },
  )
  assert.equal(billed.input_tokens + billed.cache_creation_input_tokens, floor)
  assert.ok(billed.input_tokens >= 0 && billed.cache_creation_input_tokens >= 0)
  // 长提示词：下限不挡住完整扣减
  const long = customerUsage({ input_tokens: 5000, output_tokens: 3 }, { injectedTokens: 640, callerTokens: 4000 })
  assert.equal(long.input_tokens, 4360)
})

const model = 'claude-sonnet-4-5'
const hourWrite = (tokens) => ({
  cache_creation_input_tokens: tokens,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: tokens },
})

test('cache intent is read from the caller body before the gateway fills TTLs', () => {
  assert.equal(customerCacheIntent({ messages: [{ role: 'user', content: 'hi' }] }), 'none')
  const noTtl = {
    system: [{ type: 'text', text: 'policy', cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: 'hi' }],
  }
  assert.equal(customerCacheIntent(noTtl), '5m')
  // 网关补成 1h 之后再读就会误判，所以必须在 fillMissingCacheTtl 之前取
  assert.equal(customerCacheIntent(fillMissingCacheTtl(noTtl, '1h')), '1h')
  assert.equal(customerCacheIntent({ cache_control: { type: 'ephemeral' }, messages: [] }), '5m')
  const hour = {
    tools: [{ name: 't', cache_control: { type: 'ephemeral', ttl: '1h' } }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'x', cache_control: { type: 'ephemeral', ttl: '1h' } }] },
    ],
  }
  assert.equal(customerCacheIntent(hour), '1h')
  const mixed = { ...hour, system: [{ type: 'text', text: 'p', cache_control: { type: 'ephemeral' } }] }
  assert.equal(customerCacheIntent(mixed), '5m')
  assert.equal(
    customerCacheIntent({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'x', cache_control: { type: 'ephemeral', ttl: '5m' } }] },
      ],
    }),
    '5m',
  )
  assert.equal(customerCacheIntent({ messages: [] }, { 'x-kin-cache-ttl': '1h' }), '1h')
})

test('no cache_control: cache read and write are billed as plain input', () => {
  const raw = { input_tokens: 12, cache_read_input_tokens: 300, ...hourWrite(500), output_tokens: 9 }
  const billed = customerUsage(raw, { cacheIntent: 'none' })
  assert.equal(billed.input_tokens, 812)
  assert.equal(billed.cache_read_input_tokens, 0)
  assert.equal(billed.cache_creation_input_tokens, 0)
  assert.deepEqual(billed.cache_creation, { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 })
  const price = calculateCost(billed, model)
  const plain = calculateCost({ input_tokens: 812, output_tokens: 9 }, model)
  assert.equal(price.total_cost, plain.total_cost)
  // 入参不被修改（日志保留上游真实值）
  assert.equal(raw.input_tokens, 12)
})

test('cache_control without ttl is billed at the 5m write price even when 1h went upstream', () => {
  const raw = { input_tokens: 12, ...hourWrite(1000), output_tokens: 9, cache_ttl: '1h' }
  const billed = customerUsage(raw, { cacheIntent: '5m' })
  assert.deepEqual(billed.cache_creation, { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 0 })
  assert.equal(billed.cache_ttl, '5m')
  const price = calculateCost(billed, model)
  assert.equal(price.cache_creation_1h_cost, 0)
  assert.ok(price.cache_creation_5m_cost > 0)
  assert.ok(price.total_cost < calculateCost(raw, model).total_cost)
})

test('explicit 1h ttl is billed as upstream reported', () => {
  const raw = { input_tokens: 12, ...hourWrite(1000), output_tokens: 9 }
  assert.equal(customerUsage(raw, { cacheIntent: '1h' }), raw)
  assert.equal(
    calculateCost(customerUsage(raw, { cacheIntent: '1h' }), model).total_cost,
    calculateCost(raw, model).total_cost,
  )
})

test('injected tokens come off cache read, then 1h, then 5m write, then input; never negative', () => {
  const raw = {
    input_tokens: 50,
    cache_read_input_tokens: 100,
    cache_creation_input_tokens: 300,
    cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 },
    output_tokens: 7,
    total_tokens: 657,
  }
  const out = customerUsage(raw, { injectedTokens: 380 })
  assert.equal(out.cache_read_input_tokens, 0)
  assert.equal(out.cache_creation.ephemeral_1h_input_tokens, 0)
  assert.equal(out.cache_creation.ephemeral_5m_input_tokens, 20)
  assert.equal(out.cache_creation_input_tokens, 20)
  assert.equal(out.input_tokens, 50)
  assert.equal(out.total_tokens, 657 - 380)
  const all = customerUsage(raw, { injectedTokens: 10_000 })
  for (const key of ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'])
    assert.equal(all[key], 0, key)
  assert.equal(all.output_tokens, 7)
})

test('production shape: persona in a 1h write, caller sent no cache_control', () => {
  // TonyTest：客户自己约 12 token，网关注入约 640 token 落在 1h 缓存写入
  const raw = { input_tokens: 12, ...hourWrite(640), output_tokens: 20 }
  const billed = customerUsage(raw, { injectedTokens: 640, cacheIntent: 'none' })
  assert.equal(billed.input_tokens, 12)
  assert.equal(billed.cache_creation_input_tokens, 0)
  assert.equal(
    calculateCost(billed, model).total_cost,
    calculateCost({ input_tokens: 12, output_tokens: 20 }, model).total_cost,
  )
})

test('neutral view returns the same object; SSE and message helpers share the transform', () => {
  const raw = { input_tokens: 5, output_tokens: 1 }
  assert.equal(customerUsage(raw, null), raw)
  assert.equal(customerUsage(raw, { injectedTokens: 0, cacheIntent: '1h' }), raw)
  const view = { injectedTokens: 100, cacheIntent: 'none' }
  const usage = { input_tokens: 20, cache_read_input_tokens: 534, output_tokens: 0 }
  const line = `data: ${JSON.stringify({ type: 'message_start', message: { usage } })}`
  const evt = JSON.parse(customerUsageInSseLine(line, view).slice(6))
  assert.deepEqual(evt.message.usage, customerUsage(usage, view))
  assert.equal(evt.message.usage.input_tokens, 454)
  assert.equal(evt.message.usage.cache_read_input_tokens, 0)
  // 只带 output 的 message_delta 原样透传字段
  const delta = `data: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: 9 } })}`
  assert.deepEqual(JSON.parse(customerUsageInSseLine(delta, view).slice(6)).usage, { output_tokens: 9 })
  assert.equal(customerUsageInSseLine('data: [DONE]', view), 'data: [DONE]')
  const body = { content: [], usage }
  assert.deepEqual(customerUsageOnMessage(body, view).usage, customerUsage(usage, view))
  assert.equal(body.usage, usage)
})
