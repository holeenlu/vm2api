import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  buildUpdateStatus,
  clearReleaseCache,
  fetchLatestRelease,
  startHostUpgrade,
} from '../../src/lib/admin/release.mjs'

function fixture(t) {
  clearReleaseCache()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-errors-'))
  fs.writeFileSync(path.join(root, 'VERSION'), '1.3.179\n')
  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), '')
  t.after(() => {
    clearReleaseCache()
    fs.rmSync(root, { recursive: true, force: true })
  })
  return root
}

const goodFetch = async () => ({ ok: true, json: async () => ({ tag_name: 'v1.3.180' }) })

test('manual release check bypasses a warm cache and HTTP caches immediately', async (t) => {
  const root = fixture(t)
  await buildUpdateStatus({ projectRoot: root, fetchImpl: goodFetch, now: () => 1000 })
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url, options })
    return { ok: true, json: async () => ({ tag_name: 'v1.3.181' }) }
  }
  const cached = await buildUpdateStatus({ projectRoot: root, fetchImpl, now: () => 1001 })
  assert.equal(cached.latest_tag, 'v1.3.180')
  assert.equal(calls.length, 0)
  const fresh = await buildUpdateStatus({ projectRoot: root, fetchImpl, now: () => 1002, force: true })
  assert.equal(fresh.latest_tag, 'v1.3.181')
  assert.equal(fresh.update_available, true)
  assert.equal(calls.length, 1)
  assert.equal(new URL(calls[0].url).pathname.endsWith('/releases/latest'), true)
  assert.ok(new URL(calls[0].url).searchParams.get('_check'))
  assert.equal(calls[0].options.cache, 'no-store')
  assert.equal(calls[0].options.headers['Cache-Control'], 'no-cache')
  const updatedCache = await buildUpdateStatus({ projectRoot: root, fetchImpl, now: () => 1003 })
  assert.equal(updatedCache.latest_tag, 'v1.3.181')
  assert.equal(calls.length, 1)
})

test('manual check retries a cached failure without waiting for cache expiration', async (t) => {
  const root = fixture(t)
  await buildUpdateStatus({ projectRoot: root, fetchImpl: goodFetch, now: () => 1000 })
  const failed = await buildUpdateStatus({
    projectRoot: root,
    force: true,
    now: () => 1001,
    fetchImpl: async () => ({ ok: false, status: 503 }),
  })
  assert.equal(failed.check_status, 'failed')
  assert.equal(failed.latest_tag, null)
  const recovered = await buildUpdateStatus({ projectRoot: root, force: true, fetchImpl: goodFetch, now: () => 1002 })
  assert.equal(recovered.check_status, 'ok')
  assert.equal(recovered.source_error, null)
})

test('slower earlier checks cannot overwrite the result of a newer manual check', async (t) => {
  fixture(t)
  let finishOld
  const old = fetchLatestRelease({
    fetchImpl: () =>
      new Promise((resolve) => {
        finishOld = resolve
      }),
    now: () => 1000,
  })
  await fetchLatestRelease({ force: true, fetchImpl: goodFetch, now: () => 1001 })
  finishOld({ ok: true, json: async () => ({ tag_name: 'v1.3.179' }) })
  await old
  const cached = await fetchLatestRelease({ now: () => 1002, fetchImpl: () => assert.fail('must use refreshed cache') })
  assert.equal(cached.release.tag, 'v1.3.180')
})

test('upgrade target resolution refreshes a cached up-to-date result', async (t) => {
  const root = fixture(t)
  await buildUpdateStatus({
    projectRoot: root,
    fetchImpl: async () => ({ ok: true, json: async () => ({ tag_name: 'v1.3.179' }) }),
    now: () => 1000,
  })
  const result = await startHostUpgrade({ projectRoot: root, confirm: false, fetchImpl: goodFetch, now: () => 1001 })
  assert.equal(result.status, 200)
  assert.equal(result.data.target, 'v1.3.180')
  assert.equal(result.data.update_available, true)
  assert.equal(result.data.started, false)
})

for (const [label, fetchImpl] of [
  [
    'network error',
    async () => {
      throw new Error('network unavailable')
    },
  ],
  ['HTTP failure', async () => ({ ok: false, status: 503 })],
  ['missing tag', async () => ({ ok: true, json: async () => ({}) })],
]) {
  test(`failed release lookup is unknown, not up to date: ${label}`, async (t) => {
    const root = fixture(t)
    const status = await buildUpdateStatus({ projectRoot: root, fetchImpl, cacheMs: 0 })
    assert.equal(status.check_status, 'failed')
    assert.equal(status.latest, null)
    assert.equal(status.latest_tag, null)
    assert.equal(status.update_available, null)
    assert.ok(status.source_error)
  })
}

test('cached stale release preserves refresh failure until a successful retry', async (t) => {
  const root = fixture(t)
  await buildUpdateStatus({ projectRoot: root, fetchImpl: goodFetch, now: () => 1000, cacheMs: 0 })
  const failed = await buildUpdateStatus({
    projectRoot: root,
    fetchImpl: async () => {
      throw new Error('offline')
    },
    now: () => 2000,
    cacheMs: 0,
  })
  let fetched = false
  const cached = await buildUpdateStatus({
    projectRoot: root,
    now: () => 2001,
    fetchImpl: async () => {
      fetched = true
      return goodFetch()
    },
  })
  for (const status of [failed, cached]) {
    assert.equal(status.check_status, 'failed')
    assert.equal(status.latest_tag, null)
    assert.equal(status.update_available, null)
    assert.equal(status.source_error, 'offline')
  }
  assert.equal(fetched, false)
  const recovered = await buildUpdateStatus({ projectRoot: root, fetchImpl: goodFetch, now: () => 2002, cacheMs: 0 })
  assert.equal(recovered.check_status, 'ok')
  assert.equal(recovered.source_error, null)
  assert.equal(recovered.latest_tag, 'v1.3.180')
  assert.equal(recovered.update_available, true)
})

test('successful same-version lookup is explicitly up to date', async (t) => {
  const status = await buildUpdateStatus({
    projectRoot: fixture(t),
    fetchImpl: async () => ({ ok: true, json: async () => ({ tag_name: 'v1.3.179' }) }),
    cacheMs: 0,
  })
  assert.equal(status.check_status, 'ok')
  assert.equal(status.update_available, false)
})

test('automatic upgrade reports lookup failure without executing host commands', async (t) => {
  const root = fixture(t)
  let executed = false
  const result = await startHostUpgrade({
    projectRoot: root,
    confirm: true,
    fetchImpl: async () => {
      throw new Error('offline')
    },
    execFileImpl: async () => {
      executed = true
      throw new Error('unexpected host command')
    },
  })
  assert.equal(result.status, 502)
  assert.equal(result.error.code, 'release_check_failed')
  assert.equal(executed, false)
})

test('explicit upgrade target remains available during lookup failure', async (t) => {
  const root = fixture(t)
  const result = await startHostUpgrade({
    projectRoot: root,
    version: 'v1.3.180',
    confirm: false,
    fetchImpl: async () => {
      throw new Error('offline')
    },
  })
  assert.equal(result.status, 200)
  assert.equal(result.data.target, 'v1.3.180')
  assert.equal(result.data.started, false)
  assert.equal(result.data.source_error, 'offline')
})

test('fetch-unavailable error is preserved when a stale release enters the cache', async (t) => {
  const root = fixture(t)
  await buildUpdateStatus({ projectRoot: root, fetchImpl: goodFetch, now: () => 1000, cacheMs: 0 })
  const failed = await fetchLatestRelease({ fetchImpl: null, now: () => 2000, cacheMs: 0 })
  const cached = await fetchLatestRelease({ fetchImpl: goodFetch, now: () => 2001 })
  assert.equal(failed.error, 'fetch_unavailable')
  assert.equal(cached.error, 'fetch_unavailable')
  assert.equal(cached.cached, true)
})
