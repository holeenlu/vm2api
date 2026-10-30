import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const script = new URL('../../scripts/fetch-payload.mjs', import.meta.url).pathname

test('payload release override retains checksums, fails closed, and resets on repin', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'payload-source-'))
  const bytes = Buffer.from('fixed payload bytes')
  const digest = crypto.createHash('sha256').update(bytes).digest('hex')
  const hits = []
  let corrupt = false
  const server = http.createServer((req, res) => {
    hits.push(req.url)
    res.end(corrupt ? Buffer.from('corrupted payload!!') : bytes)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const manifest = path.join(dir, 'manifest.json')
  const file = { path: 'bin/cli', asset: 'cli', release: 'v1.3.201', size: bytes.length, sha256: digest }
  fs.writeFileSync(manifest, JSON.stringify({ release: 'payload-old', files: [file] }))
  const run = (...extra) =>
    exec(process.execPath, [script, '--manifest', manifest, '--dest', dir, ...extra], {
      env: { ...process.env, TAPMODELS_PAYLOAD_BASE_URL: `http://127.0.0.1:${server.address().port}` },
    })
  try {
    await run()
    assert.deepEqual(hits, ['/v1.3.201/cli'])
    assert.deepEqual(fs.readFileSync(path.join(dir, file.path)), bytes)
    await run('--check')
    fs.unlinkSync(path.join(dir, file.path))
    corrupt = true
    await assert.rejects(run(), /does not match/)
    assert.equal(fs.existsSync(path.join(dir, file.path)), false)
    corrupt = false
    await run()
    await run('--pin', 'new-payload')
    const pinned = JSON.parse(fs.readFileSync(manifest, 'utf8'))
    assert.equal(pinned.release, 'new-payload')
    assert.equal(pinned.files[0].release, undefined)
    assert.equal(pinned.files[0].sha256, digest)
    fs.unlinkSync(path.join(dir, file.path))
    await run()
    assert.equal(hits.at(-1), '/new-payload/cli')
  } finally {
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
