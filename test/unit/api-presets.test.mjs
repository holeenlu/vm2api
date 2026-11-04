import test from 'node:test'
import assert from 'node:assert/strict'
import {
  mergeModelLists,
  parseUpstreamModels,
  resolvePreset,
  messagesUrl,
  chatCompletionsUrl,
  responsesUrl,
} from '../../src/lib/pool/api-presets.mjs'

test('official presets lock url; custom keeps typed url', () => {
  assert.equal(resolvePreset('claude', {}).base_url, 'https://api.anthropic.com')
  assert.equal(resolvePreset('openai', { base_url: 'https://ignore.example' }).base_url, 'https://api.openai.com')
  assert.equal(resolvePreset('custom', { base_url: 'https://or.example/v1/' }).base_url, 'https://or.example')
})

test('parse anthropic and openai model lists', () => {
  const a = parseUpstreamModels({ data: [{ id: 'claude-sonnet-4-6', display_name: 'Sonnet' }] }, 'anthropic')
  assert.deepEqual(
    a.map((m) => m.name),
    ['claude-sonnet-4-6'],
  )
  const o = parseUpstreamModels(
    {
      data: [{ id: 'gpt-4o' }, { id: 'whisper-1' }, { id: 'text-embedding-3-small' }],
    },
    'openai',
  )
  assert.deepEqual(
    o.map((m) => m.name),
    ['gpt-4o'],
  )
})

test('merge keeps existing alias', () => {
  const merged = mergeModelLists([{ name: 'gpt-4o', alias: 'gpt' }], [{ name: 'gpt-4o' }, { name: 'gpt-4.1' }])
  assert.equal(merged.find((m) => m.name === 'gpt-4o').alias, 'gpt')
  assert.ok(merged.find((m) => m.name === 'gpt-4.1'))
})

test('official outbound paths', () => {
  assert.equal(messagesUrl('https://api.anthropic.com/'), 'https://api.anthropic.com/v1/messages?beta=true')
  assert.equal(chatCompletionsUrl('https://api.openai.com'), 'https://api.openai.com/v1/chat/completions')
  assert.equal(responsesUrl('https://api.openai.com/'), 'https://api.openai.com/v1/responses')
})

test('OpenAI discovery retains GPT Image models and marks their image capability', () => {
  const models = parseUpstreamModels(
    {
      data: [
        { id: 'gpt-image-2.5-flare' },
        { id: 'gpt-image-2.5-sunburst-2026-09-08' },
        { id: 'GPT-IMAGE-2.5-FLARE' },
        { id: 'tts-1' },
        { id: 'text-embedding-3-small' },
      ],
    },
    'openai',
  )
  assert.deepEqual(
    models.map(({ name, image }) => ({ name, image })),
    [
      { name: 'gpt-image-2.5-flare', image: true },
      { name: 'gpt-image-2.5-sunburst-2026-09-08', image: true },
    ],
  )
})
