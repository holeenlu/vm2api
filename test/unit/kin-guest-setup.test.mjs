import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

const GUEST = path.resolve(import.meta.dirname, '../../docker/kin-kvm/guest')
const SETUP = path.join(GUEST, 'kin-guest-setup')

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex')
const script = (version) => `#!/bin/sh\necho "${version}"\n`

function harness(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-guest-setup-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const payload = path.join(root, 'payload')
  const bindir = path.join(payload, 'usr', 'local', 'bin')
  const localBin = path.join(root, 'local-bin')
  const cache = path.join(root, 'var', 'lib', 'kin-payload', 'bin')
  const drop = path.join(root, 'drop_caches')
  fs.mkdirSync(bindir, { recursive: true })
  fs.mkdirSync(localBin)
  fs.writeFileSync(drop, '')
  // The host stages a binary by renaming a new file over the old one (ensureSlotGuestBinDir).
  const stage = (name, body) => {
    const tmp = path.join(bindir, `.${name}.tmp`)
    fs.writeFileSync(tmp, body, { mode: 0o755 })
    fs.renameSync(tmp, path.join(bindir, name))
  }
  const env = { KIN_PAYLOAD_ROOT: payload, KIN_PAYLOAD_CACHE: cache, KIN_LOCAL_BIN: localBin, KIN_DROP_CACHES: drop }
  const run = (extra = {}) =>
    spawnSync('sh', [SETUP, 'payload'], { env: { ...process.env, ...env, ...extra }, encoding: 'utf8' })
  const exec = (name) => spawnSync(path.join(localBin, name), { encoding: 'utf8' }).stdout.trim()
  return { root, bindir, localBin, cache, drop, stage, run, exec }
}

test('#681 payload binaries run from guest-local copies named by content hash', (t) => {
  const h = harness(t)
  h.stage('kin-worker', script('worker v1'))
  h.stage('kin-kernel', script('kernel v1'))
  const r = h.run()
  assert.equal(r.status, 0, r.stderr)
  for (const [name, version] of [
    ['kin-worker', 'worker v1'],
    ['kin-kernel', 'kernel v1'],
  ]) {
    const target = fs.readlinkSync(path.join(h.localBin, name))
    // Local disk, not the 9p share.
    assert.equal(target, path.join(h.cache, `${name}-${sha(script(version))}`))
    assert.equal(fs.statSync(target).mode & 0o777, 0o755)
    assert.equal(h.exec(name), version)
  }
  // The loose 9p cache is dropped before the share is read.
  assert.equal(fs.readFileSync(h.drop, 'utf8').trim(), '3')
})

test('#681 a host upgrade gets a fresh copy; a running old copy is never rewritten', (t) => {
  const h = harness(t)
  h.stage('kin-worker', script('worker v1'))
  assert.equal(h.run().status, 0)
  const v1 = fs.readlinkSync(path.join(h.localBin, 'kin-worker'))
  // A process that started v1 keeps its open file while the upgrade lands.
  const held = fs.openSync(v1, 'r')
  t.after(() => fs.closeSync(held))
  h.stage('kin-worker', script('worker v2'))
  const r = h.run()
  assert.equal(r.status, 0, r.stderr)
  const v2 = fs.readlinkSync(path.join(h.localBin, 'kin-worker'))
  assert.notEqual(v2, v1)
  assert.equal(path.basename(v2), `kin-worker-${sha(script('worker v2'))}`)
  assert.equal(h.exec('kin-worker'), 'worker v2')
  // The old copy left the directory but its content was never touched in place.
  assert.equal(fs.existsSync(v1), false)
  const buf = Buffer.alloc(64)
  const n = fs.readSync(held, buf, 0, 64, 0)
  assert.equal(buf.subarray(0, n).toString(), script('worker v1'))
  assert.deepEqual(fs.readdirSync(h.cache), [path.basename(v2)])
  // An unchanged payload keeps the same copy (no rewrite under a running kernel).
  const ino = fs.statSync(v2).ino
  assert.equal(h.run().status, 0)
  assert.equal(fs.statSync(v2).ino, ino)
})

test('#681 a corrupted local copy is replaced; an unusable cache falls back to the share', (t) => {
  const h = harness(t)
  h.stage('kin-worker', script('worker v1'))
  assert.equal(h.run().status, 0)
  const copy = fs.readlinkSync(path.join(h.localBin, 'kin-worker'))
  fs.writeFileSync(copy, script('torn'), { mode: 0o755 })
  assert.equal(h.run().status, 0)
  assert.equal(h.exec('kin-worker'), 'worker v1')

  const blocked = path.join(h.root, 'not-a-dir')
  fs.writeFileSync(blocked, '')
  const r = h.run({ KIN_PAYLOAD_CACHE: path.join(blocked, 'bin') })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stderr, /payload kin-worker not cached; linking the 9p copy/)
  assert.equal(fs.readlinkSync(path.join(h.localBin, 'kin-worker')), path.join(h.bindir, 'kin-worker'))
})

test('#681 kin-kernel.service refreshes the copies as root before every start, without blocking it', () => {
  const unit = fs.readFileSync(path.join(GUEST, 'kin-kernel.service'), 'utf8')
  assert.match(unit, /^ExecStartPre=-\+\/usr\/local\/sbin\/kin-guest-setup payload$/m)
  const setup = fs.readFileSync(SETUP, 'utf8')
  // Boot links through the cache too; the share stays cache=loose for /opt/kin.
  assert.match(setup, /^link_payload\(\) \{\n {2}cache_payload_bins$/m)
  assert.match(setup, /^mount_9p kinpayload \/opt\/kin-payload loose$/m)
  // Existing overlays pick up changed guest scripts from the seed on boot.
  assert.match(setup, /^sync_guest_assets "\$@"$/m)
  for (const asset of ['kin-guest-setup', 'kin-kernel-start', 'kin-kernel.service', 'kin-guest-setup.service']) {
    assert.ok(setup.includes(`    ${asset}:`), asset)
  }
})
