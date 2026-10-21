import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  applyCacheTtlToBody,
  applyCacheTtlToUsage,
  DEFAULT_CACHE_TTL,
  cacheTtlFromRouting,
  cacheTtlFromRoutingFile,
  enforceCacheTtlOrder,
  validateCacheBreakpoints,
  normalizeCacheTtl,
  stripIllegalCacheControlFields,
} from '../../src/lib/protocol/cache-ttl.mjs'
import { calculateCost } from '../../src/lib/admin/pricing.mjs'

test('cache ttl accepts only 1h or 5m output values', () => {
  assert.equal(normalizeCacheTtl(undefined), DEFAULT_CACHE_TTL)
  assert.equal(DEFAULT_CACHE_TTL, '1h')
  assert.equal(normalizeCacheTtl('5m'), '5m')
  assert.equal(normalizeCacheTtl('1h'), '1h')
  assert.equal(normalizeCacheTtl('bogus'), '1h')
})

test('the settings panel selects cache TTL and invalid or missing values use one hour', () => {
  assert.equal(cacheTtlFromRouting({ compatibility: { cache_ttl: '5m' } }), '5m')
  assert.equal(cacheTtlFromRouting({ compatibility: { cache_ttl: '1h' } }), '1h')
  assert.equal(cacheTtlFromRouting({ compatibility: { cache_ttl: 'bad' } }), '1h')
  assert.equal(cacheTtlFromRouting({}), '1h')
})

test('routing-file TTL changes apply immediately without a conversation pin', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tapmodels-ttl-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const file = path.join(root, 'routing.json')
  assert.equal(cacheTtlFromRoutingFile(file), '1h')
  for (const ttl of ['5m', '1h', '5m']) {
    fs.writeFileSync(file, JSON.stringify({ compatibility: { cache_ttl: ttl } }))
    assert.equal(cacheTtlFromRoutingFile(file), ttl)
  }
  fs.writeFileSync(file, '{')
  assert.equal(cacheTtlFromRoutingFile(file), '1h')
})

test('native validation counts automatic caching against the explicit marker budget', () => {
  const input = {
    system: Array.from({ length: 4 }, (_, index) => ({
      type: 'text',
      text: String(index),
      cache_control: { type: 'ephemeral', ttl: '1h' },
    })),
    cache_control: { type: 'ephemeral' },
  }
  assert.throws(() => validateCacheBreakpoints(input), /four breakpoints/)
})

test('stripIllegalCacheControlFields drops scope on system and tools', () => {
  const out = stripIllegalCacheControlFields({
    system: [
      {
        type: 'text',
        text: 'expansion',
        cache_control: { type: 'ephemeral', ttl: '1h', scope: 'global' },
      },
    ],
    tools: [{ name: 'Read', cache_control: { type: 'ephemeral', ttl: '1h', scope: 'global' } }],
  })
  assert.deepEqual(out.system[0].cache_control, { type: 'ephemeral', ttl: '1h' })
  assert.deepEqual(out.tools[0].cache_control, { type: 'ephemeral', ttl: '1h' })
})

test('applyCacheTtlToBody default 5m overwrites leftover system 1h', () => {
  const out = applyCacheTtlToBody(
    {
      system: [{ type: 'text', text: 'x', cache_control: { type: 'ephemeral', ttl: '1h', scope: 'global' } }],
    },
    '5m',
  )
  assert.deepEqual(out.system[0].cache_control, { type: 'ephemeral', ttl: '5m' })
})

test('tool 5m then system 1h is downgraded so Anthropic order stays legal', () => {
  const live = {
    tools: [
      { name: 'search' },
      { name: 'google_maps', cache_control: { type: 'ephemeral', ttl: '5m' } },
      { name: 'web_search' },
    ],
    system: [
      { type: 'text', text: 'billing' },
      { type: 'text', text: 'identity' },
      { type: 'text', text: 'expansion', cache_control: { type: 'ephemeral', ttl: '1h', scope: 'global' } },
      { type: 'text', text: 'env', cache_control: { type: 'ephemeral', ttl: '5m' } },
    ],
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral', ttl: '5m' } }],
      },
    ],
  }
  const out = enforceCacheTtlOrder(live)
  assert.equal(out.tools[1].cache_control.ttl, '5m')
  assert.deepEqual(out.system[2].cache_control, { type: 'ephemeral', ttl: '5m' })
  assert.deepEqual(out.system[3].cache_control, { type: 'ephemeral', ttl: '5m' })
})

test('a leading 1h is removed when any later breakpoint is 5m', () => {
  const out = enforceCacheTtlOrder({
    system: [{ type: 'text', text: 'early', cache_control: { type: 'ephemeral', ttl: '1h' } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'later', cache_control: { type: 'ephemeral' } }] }],
  })
  assert.deepEqual(out.system[0].cache_control, { type: 'ephemeral', ttl: '5m' })
  assert.deepEqual(out.messages[0].content[0].cache_control, { type: 'ephemeral' })
})

test('applyCacheTtlToBody rewrites every cache marker to selected 5m', () => {
  const out = applyCacheTtlToBody(
    {
      cache_control: { type: 'ephemeral', ttl: '1h' },
      system: [{ type: 'text', text: 'x', cache_control: { type: 'ephemeral', ttl: '1h', scope: 'global' } }],
      tools: [{ name: 'Read', cache_control: { type: 'ephemeral', ttl: '1h' } }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral', ttl: '1h' } }] },
      ],
    },
    '5m',
  )
  assert.equal(out.cache_control.ttl, '5m')
  assert.equal(out.system[0].cache_control.ttl, '5m')
  assert.equal(out.tools[0].cache_control.ttl, '5m')
  assert.equal(out.messages[0].content[0].cache_control.ttl, '5m')
})

test('applyCacheTtlToBody rewrites every cache marker to selected 1h', () => {
  const out = applyCacheTtlToBody(
    {
      system: [{ type: 'text', text: 'x', cache_control: { type: 'ephemeral', ttl: '5m', scope: 'global' } }],
      tools: [{ name: 'Read', cache_control: { type: 'ephemeral' } }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral', ttl: '5m' } }] },
      ],
    },
    '1h',
  )
  assert.equal(out.system[0].cache_control.ttl, '1h')
  assert.equal(out.tools[0].cache_control.ttl, '1h')
  assert.equal(out.messages[0].content[0].cache_control.ttl, '1h')
})

test('stripIllegalCacheControlFields drops ephemeral.scope', () => {
  const out = stripIllegalCacheControlFields({
    system: [
      {
        type: 'text',
        text: 'agent',
        cache_control: { type: 'ephemeral', ttl: '5m', scope: 'global' },
      },
    ],
    tools: [{ name: 'Read', cache_control: { type: 'ephemeral', ttl: '5m', scope: 'global' } }],
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral', ttl: '5m', scope: 'global' } }],
      },
    ],
  })
  assert.deepEqual(out.system[0].cache_control, { type: 'ephemeral', ttl: '5m' })
  assert.deepEqual(out.tools[0].cache_control, { type: 'ephemeral', ttl: '5m' })
  assert.deepEqual(out.messages[0].content[0].cache_control, { type: 'ephemeral', ttl: '5m' })
})

test('unclassified cache_creation without ttl bills the 5m rate', () => {
  const asDefault = calculateCost({ cache_creation_tokens: 1_000_000 }, 'claude-sonnet-5')
  const as5m = calculateCost({ cache_creation_tokens: 1_000_000, cache_ttl: '5m' }, 'claude-sonnet-5')
  const as1h = calculateCost({ cache_creation_tokens: 1_000_000, cache_ttl: '1h' }, 'claude-sonnet-5')
  assert.equal(asDefault.cache_creation_cost, 2.5)
  assert.equal(as5m.cache_creation_cost, 2.5)
  assert.equal(as1h.cache_creation_cost, 4)
  assert.equal(as1h.total_cost - as5m.total_cost, 1.5)
})

test('applyCacheTtlToUsage reclassifies a 5m report after we sent 1h', () => {
  const out = applyCacheTtlToUsage(
    {
      cache_creation_input_tokens: 2000,
      cache_creation: { ephemeral_5m_input_tokens: 2000, ephemeral_1h_input_tokens: 0 },
    },
    '1h',
  )
  assert.equal(out.cache_creation_1h_tokens, 2000)
  assert.equal(out.cache_creation_5m_tokens, 0)
  assert.equal(out.cache_ttl, '1h')
})

test('default 5m usage stays in the 1.25x bucket', () => {
  const out = applyCacheTtlToUsage(
    {
      cache_creation_input_tokens: 2000,
      cache_creation: { ephemeral_5m_input_tokens: 2000, ephemeral_1h_input_tokens: 0 },
    },
    '5m',
  )
  assert.equal(out.cache_creation_5m_tokens, 2000)
  assert.equal(out.cache_creation_1h_tokens, 0)
  assert.equal(out.cache_ttl, '5m')
  const billed = calculateCost(out, 'claude-sonnet-5')
  assert.equal(billed.cache_creation_cost, 0.005)
})
