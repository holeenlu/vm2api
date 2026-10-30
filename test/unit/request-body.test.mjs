import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { Readable } from 'node:stream'
import { brotliCompressSync, constants, deflateSync, gzipSync, zstdCompressSync } from 'node:zlib'
import { createRespond, readBody, readRawBody } from '../../src/lib/http/respond.mjs'

const body = {
  model: 'gpt-5',
  input: [
    {
      role: 'user',
      content: [
        { type: 'input_text', text: '查看图片' },
        { type: 'input_image', image_url: 'data:image/png;base64,aGVsbG8=' },
      ],
    },
  ],
  stream: true,
}
const raw = Buffer.from(JSON.stringify(body))
const codecs = { zstd: zstdCompressSync, gzip: gzipSync, deflate: deflateSync, br: brotliCompressSync }

function request(bytes, encoding) {
  const req = Readable.from([bytes.subarray(0, 3), bytes.subarray(3)])
  req.headers = encoding == null ? {} : { 'content-encoding': encoding }
  return req
}

function errorIs(status, code) {
  return (error) => {
    assert.equal(error.status, status)
    assert.equal(error.body.error.code, code)
    return true
  }
}

test('plain and identity JSON bodies retain existing behavior', async () => {
  for (const encoding of [undefined, 'identity']) {
    assert.deepEqual(await readBody(request(raw, encoding), raw.length), body)
    assert.deepEqual(await readBody(request(Buffer.alloc(0), encoding), 1024), {})
  }
  await assert.rejects(readBody(request(Buffer.from('{')), 1024), errorIs(400, 'invalid_json'))
})

for (const [encoding, compress] of Object.entries(codecs)) {
  test(`${encoding} JSON preserves multimodal input and accepts an exact decoded limit`, async () => {
    assert.deepEqual(await readBody(request(compress(raw), encoding), raw.length), body)
  })

  test(`${encoding} enforces the decoded size limit`, async () => {
    const bytes = compress(Buffer.from(JSON.stringify({ input: 'x'.repeat(10000) })))
    assert.ok(bytes.length < 512)
    await assert.rejects(readBody(request(bytes, encoding), 512), errorIs(413, 'body_too_large'))
  })

  test(`${encoding} reports corrupt and truncated input as a compression error`, async () => {
    for (const bytes of [Buffer.from('broken'), compress(raw).subarray(0, 6), Buffer.alloc(0)]) {
      await assert.rejects(readBody(request(bytes, encoding), 1024), errorIs(400, 'invalid_content_encoding'))
    }
  })

  test(`${encoding} still rejects malformed decoded JSON`, async () => {
    await assert.rejects(readBody(request(compress(Buffer.from('{')), encoding), 1024), errorIs(400, 'invalid_json'))
  })
}

test('encoded bytes also remain bounded', async () => {
  const bytes = gzipSync(raw)
  await assert.rejects(readBody(request(bytes, 'gzip'), bytes.length - 1), errorIs(413, 'body_too_large'))
})

test('zstd rejects every truncated prefix, including missing checksums and trailing frames', async () => {
  const frame = zstdCompressSync(raw, { params: { [constants.ZSTD_c_checksumFlag]: 1 } })
  for (let end = 0; end < frame.length; end++) {
    await assert.rejects(
      readBody(request(frame.subarray(0, end), 'zstd'), 1024),
      errorIs(400, 'invalid_content_encoding'),
    )
  }
  const valid = zstdCompressSync(Buffer.from('{}'))
  await assert.rejects(
    readBody(request(Buffer.concat([valid, frame.subarray(0, 6)]), 'zstd'), 1024),
    errorIs(400, 'invalid_content_encoding'),
  )
  assert.deepEqual(await readBody(request(frame, 'zstd'), 1024), body)
})

test('zstd accepts complete empty, concatenated and skippable frames', async () => {
  const skip = Buffer.from('502a4d1803000000616263', 'hex')
  const frames = Buffer.concat([skip, zstdCompressSync(Buffer.from('{')), zstdCompressSync(Buffer.from('}')), skip])
  assert.deepEqual(await readBody(request(frames, 'zstd'), 1024), {})
  assert.deepEqual(await readBody(request(zstdCompressSync(Buffer.alloc(0)), 'zstd'), 1024), {})
  await assert.rejects(readBody(request(skip.subarray(0, -1), 'zstd'), 1024), errorIs(400, 'invalid_content_encoding'))
})

test('content codings are case-insensitive and decoded in reverse order', async () => {
  assert.deepEqual(await readBody(request(gzipSync(zstdCompressSync(raw)), ' ZSTD, identity, GZip '), 1024), body)
})

test('unknown or malformed content codings return 415', async () => {
  for (const encoding of ['snappy', 'gzip,', 'gzip,,br', 'constructor']) {
    await assert.rejects(readBody(request(raw, encoding), 1024), errorIs(415, 'unsupported_content_encoding'))
  }
})

test('raw body reader preserves bytes for multipart callers', async () => {
  const bytes = zstdCompressSync(raw)
  assert.deepEqual(await readRawBody(request(bytes, 'zstd'), 1024), bytes)
})

test('HTTP Responses ingress parses Codex zstd bodies and returns structured 413/415 errors', async (t) => {
  const respond = createRespond({ rewrite: { enabled: false } })
  const server = http.createServer(async (req, res) => {
    try {
      respond.json(res, 200, await respond.readBody(req, 512))
    } catch (error) {
      respond.json(res, error.status || 500, error.body || {})
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise((resolve) => server.close(resolve)))
  async function post(bytes, encoding) {
    const req = http.request({
      hostname: '127.0.0.1',
      port: server.address().port,
      path: '/v1/responses',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-encoding': encoding, connection: 'close' },
    })
    const response = once(req, 'response')
    req.end(bytes)
    const [res] = await response
    const chunks = []
    for await (const chunk of res) chunks.push(chunk)
    return { status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)) }
  }
  const bytes = zstdCompressSync(raw)
  assert.equal(bytes.subarray(0, 4).toString('hex'), '28b52ffd')
  assert.deepEqual(await post(bytes, 'zstd'), { status: 200, body })
  const large = await post(zstdCompressSync(Buffer.from(JSON.stringify({ input: 'x'.repeat(10000) }))), 'zstd')
  assert.equal(large.status, 413)
  assert.equal(large.body.error.code, 'body_too_large')
  const unsupported = await post(raw, 'snappy')
  assert.equal(unsupported.status, 415)
  assert.equal(unsupported.body.error.code, 'unsupported_content_encoding')
})
