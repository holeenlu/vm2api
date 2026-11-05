import test, { beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { Readable, Writable } from 'node:stream'
import { handleApiImages } from '../../src/lib/pool/api-images.mjs'
import { ApiScheduler } from '../../src/lib/pool/api-scheduler.mjs'
import { openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'
import { loadGptModelPolicy, saveGptModelPolicy } from '../../src/lib/protocol/gpt-model-policy.mjs'

const model = 'gpt-image-2.5-flare'
const usage = { input_tokens: 3, input_tokens_details: { text_tokens: 1, image_tokens: 2 }, output_tokens: 4 }
const endpoint = (id = 'openai', protocol = 'openai') => ({
  id,
  kind: protocol === 'openai' ? 'openai' : 'claude',
  protocol,
  api_key_entries: [{ id: 'key-' + id, api_key: 'sk-upstream', proxy_url: 'socks5://proxy:1080' }],
  models: [
    { name: model, alias: 'art' },
    { name: model, alias: model },
  ],
})
function upstream(status, payload, headers = {}) {
  return Object.assign(Readable.from([Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload))]), {
    statusCode: status,
    headers,
  })
}
async function run({
  body = { model, prompt: 'a cat' },
  endpoints = [endpoint()],
  response,
  forward,
  kind = 'generations',
} = {}) {
  const calls = [],
    cooldowns = [],
    chunks = []
  const scheduler = new ApiScheduler()
  scheduler.reload(endpoints)
  const res = new Writable({
    write(chunk, _encoding, cb) {
      chunks.push(chunk.toString())
      cb()
    },
  })
  res.setHeader = () => {}
  const logBag = {},
    stats = { requests: 0, errors: 0, by_route: {} }
  await handleApiImages({
    req: { apiKeyKind: 'master', headers: { authorization: 'Bearer client-secret' } },
    res,
    kind,
    body,
    cfg: { limits: { upstream_timeout_ms: 1000 } },
    scheduler,
    store: { setKeyCooldown: (...args) => cooldowns.push(args), listRaw: () => endpoints },
    logBag,
    stats,
    json: (r, status, payload) => {
      r.statusCode = status
      r.body = payload
    },
    forward: async (args) => {
      calls.push(args)
      return forward ? forward(args) : response || upstream(200, { data: [{ b64_json: 'aGk=' }], usage })
    },
  })
  return { calls, cooldowns, res, logBag, stats, stream: chunks.join('') }
}
beforeEach(() => {
  openDatabase({ dbPath: ':memory:' })
  loadGptModelPolicy({ force: true })
})
afterEach(() => {
  closeDatabase()
  loadGptModelPolicy({ force: true })
})

test('API Images selects OpenAI in a mixed pool, maps aliases, uses upstream credentials and proxy', async () => {
  const ep = endpoint()
  ep.headers = { Authorization: 'wrong', 'x-api-key': 'wrong', 'Content-Type': 'wrong', 'X-Project': 'project' }
  const result = await run({
    endpoints: [endpoint('claude', 'anthropic'), ep],
    body: { model: 'art', prompt: 'a cat' },
  })
  assert.equal(result.calls[0].url, 'https://api.openai.com/v1/images/generations')
  assert.deepEqual(result.calls[0].body, { model, prompt: 'a cat' })
  assert.equal(result.calls[0].headers.authorization, 'Bearer sk-upstream')
  assert.equal(result.calls[0].headers.Authorization, undefined)
  assert.equal(result.calls[0].headers['x-api-key'], undefined)
  assert.equal(result.calls[0].headers['X-Project'], 'project')
  assert.equal(result.calls[0].proxyUrl, 'socks5://proxy:1080')
  assert.equal(result.logBag.image_model, model)
  assert.deepEqual(result.logBag.image_usage, usage)
  assert.equal(result.logBag.final_state, 'verified')
  assert.equal(result.logBag.account_id, 'key-openai')
})
test('API edits preserve JSON references and masks', async () => {
  const body = {
    model,
    prompt: 'edit',
    images: [{ image_url: 'data:image/png;base64,AA==' }],
    mask: { file_id: 'file-mask' },
  }
  const result = await run({ kind: 'edits', body })
  assert.equal(result.calls[0].url, 'https://api.openai.com/v1/images/edits')
  assert.deepEqual(result.calls[0].body, body)
})
test('disabled image models cannot be reached through an alias', async () => {
  saveGptModelPolicy({ image_tools: { [model]: { enabled: false } } })
  for (const name of [model, 'art']) {
    const result = await run({ body: { model: name } })
    assert.equal(result.res.statusCode, 400)
    assert.equal(result.calls.length, 0)
  }
})
test('Anthropic-only pools and exhausted keys never dispatch images', async () => {
  assert.equal((await run({ endpoints: [endpoint('claude', 'anthropic')] })).res.statusCode, 404)
  const ep = endpoint()
  ep.api_key_entries[0].disabled = true
  assert.equal((await run({ endpoints: [ep] })).res.statusCode, 503)
})
test('429 applies cooldown without duplicate image generation; upstream errors stay errors', async () => {
  const result = await run({
    response: upstream(429, { error: { code: 'rate_limit', message: 'later' } }, { 'retry-after': '5' }),
  })
  assert.equal(result.res.statusCode, 429)
  assert.equal(result.calls.length, 1)
  assert.equal(result.cooldowns[0][0], 'key-openai')
  assert.equal(result.logBag.final_state, 'upstream_error')
})
test('transport and malformed success responses cannot be marked verified', async () => {
  for (const options of [
    { response: upstream(200, '<html>') },
    { response: upstream(200, {}) },
    {
      forward: () => {
        throw new Error('private upstream error')
      },
    },
  ]) {
    const result = await run(options)
    assert.equal(result.res.statusCode, 502)
    assert.notEqual(result.logBag.final_state, 'verified')
    assert.doesNotMatch(JSON.stringify(result.res.body), /private/)
  }
})
test('image streams preserve bytes and only completed events supply usage', async () => {
  const raw = `event: image_generation.completed\r\ndata: ${JSON.stringify({ type: 'image_generation.completed', b64_json: 'aGk=', usage })}\r\n\r\n`
  const result = await run({
    body: { model, stream: true },
    response: upstream(200, raw, { 'content-type': 'text/event-stream' }),
  })
  assert.equal(result.stream, raw)
  assert.equal(result.logBag.final_state, 'verified')
  assert.deepEqual(result.logBag.image_usage, usage)
  const partial = await run({
    response: upstream(200, 'data: {"type":"image_generation.partial_image"}\n\n', {
      'content-type': 'text/event-stream',
    }),
  })
  assert.equal(partial.logBag.final_state, 'incomplete')
  assert.match(partial.stream, /upstream_incomplete/)
})
