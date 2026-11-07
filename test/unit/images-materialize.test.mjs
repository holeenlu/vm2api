import test from 'node:test'
import assert from 'node:assert/strict'
import { isBlockedImageAddress, materializeRemoteImageSources } from '../../src/lib/protocol/images.mjs'

const publicLookup = async () => [{ address: '93.184.215.14', family: 4 }]

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

test('materializeRemoteImageSources fetches url images to base64', async () => {
  const fetchImpl = async (url) => {
    assert.match(url, /^https:\/\/example.com\/a.png$/)
    return {
      ok: true,
      headers: { get: (k) => (k === 'content-type' ? 'image/png' : null) },
      arrayBuffer: async () => PNG,
    }
  }
  const out = await materializeRemoteImageSources(
    {
      model: 'claude-opus-4-6',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '这是什么?' },
            { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
          ],
        },
      ],
    },
    { fetchImpl, lookup: publicLookup },
  )
  assert.equal(out.messages[0].content[1].source.type, 'base64')
  assert.equal(out.messages[0].content[1].source.media_type, 'image/png')
  assert.equal(out.messages[0].content[1].source.data, PNG.toString('base64'))
})

test('materializeRemoteImageSources keeps url when fetch fails', async () => {
  const out = await materializeRemoteImageSources(
    {
      messages: [
        {
          role: 'user',
          content: [{ type: 'image', source: { type: 'url', url: 'https://example.com/missing.png' } }],
        },
      ],
    },
    {
      fetchImpl: async () => ({ ok: false, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) }),
      lookup: publicLookup,
    },
  )
  assert.equal(out.messages[0].content[0].source.type, 'url')
})

const imageBody = (url) => ({
  messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url } }] }],
})

test('remote images never reach private, loopback or metadata addresses (audit P1-S1)', async () => {
  for (const address of [
    '127.0.0.1',
    '10.1.2.3',
    '169.254.169.254',
    '192.168.0.1',
    '100.64.0.1',
    '::1',
    'fd00::1',
    '::ffff:127.0.0.1',
  ])
    assert.equal(isBlockedImageAddress(address), true, address)
  assert.equal(isBlockedImageAddress('93.184.215.14'), false)
  let fetched = 0
  const fetchImpl = async () => {
    fetched++
    return { ok: true, status: 200, headers: { get: () => 'image/png' }, arrayBuffer: async () => PNG }
  }
  for (const url of [
    'http://169.254.169.254/latest/meta-data/',
    'http://127.0.0.1:8787/api/panel/site',
    'http://[::1]/x.png',
  ]) {
    const out = await materializeRemoteImageSources(imageBody(url), { fetchImpl, lookup: publicLookup })
    assert.equal(out.messages[0].content[0].source.type, 'url', url)
  }
  const out = await materializeRemoteImageSources(imageBody('https://internal.example/a.png'), {
    fetchImpl,
    lookup: async () => [{ address: '10.0.0.5', family: 4 }],
  })
  assert.equal(out.messages[0].content[0].source.type, 'url')
  assert.equal(fetched, 0)
})

test('a redirect to a private address is not followed and oversized bodies are refused', async () => {
  const redirecting = async () => ({
    ok: false,
    status: 302,
    headers: { get: (k) => (k === 'location' ? 'http://127.0.0.1/a.png' : null) },
  })
  let out = await materializeRemoteImageSources(imageBody('https://example.com/a.png'), {
    fetchImpl: redirecting,
    lookup: publicLookup,
  })
  assert.equal(out.messages[0].content[0].source.type, 'url')
  const huge = async () => ({
    ok: true,
    status: 200,
    headers: { get: (k) => (k === 'content-length' ? String(64 * 1024 * 1024) : 'image/png') },
    arrayBuffer: async () => {
      throw new Error('must not buffer an oversized body')
    },
  })
  out = await materializeRemoteImageSources(imageBody('https://example.com/a.png'), {
    fetchImpl: huge,
    lookup: publicLookup,
  })
  assert.equal(out.messages[0].content[0].source.type, 'url')
})
