import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'
import {
  ensureRedaction,
  maskJson,
  publishRedactionForTests,
  restoreJsonValue,
} from '../../src/lib/redaction/runtime.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-redact-runtime-'))
const bin = path.join(root, 'kin-redact')

let helper = null

afterEach(() => {
  helper?.kill()
  helper = null
  publishRedactionForTests(null)
})

test('redaction runtime stays out of the request path when the switch is off', async () => {
  const state = await ensureRedaction({}, { projectRoot: root, binPath: bin })
  assert.equal(state.enabled, false)
  assert.equal(state.ready, true)
  const body = { messages: [{ role: 'user', content: 'sk-proj-Aa1Bb2Cc3Dd4Ee5Ff6Gg' }] }
  assert.deepEqual(await maskJson(body, { principal: 'key-a' }), body)
})

test('redaction runtime masks and restores through the real helper when enabled', { timeout: 60_000 }, async () => {
  execFileSync('go', ['build', '-o', bin, './cmd/kin-redact'], {
    cwd: path.join(process.cwd(), 'redact'),
    stdio: 'inherit',
  })
  const policy = { enabled: true, secrets: true, personal: false, words: [], rules: [] }
  const state = await ensureRedaction({ redaction: policy }, { projectRoot: root, binPath: bin })
  assert.equal(state.ready, true)
  helper = state.child
  const secret = 'sk-' + 'proj-' + 'Aa1Bb2Cc3Dd4Ee5Ff6Gg'
  const masked = await maskJson(
    { messages: [{ role: 'user', content: `token ${secret}` }] },
    { principal: 'key-a', session: 's1' },
  )
  const text = JSON.stringify(masked)
  assert.ok(!text.includes(secret))
  assert.ok(text.includes('{{R_API_KEY_'))
  const restored = await restoreJsonValue(masked, { principal: 'key-a', session: 's1' })
  assert.ok(JSON.stringify(restored).includes(secret))
  const other = await restoreJsonValue(masked, { principal: 'key-b', session: 's1' })
  assert.ok(!JSON.stringify(other).includes(secret))
  state.child?.kill()
})
