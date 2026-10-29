import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'
import { ProxyPool } from '../../src/lib/vm/proxy-pool.mjs'
import {
  QUALITY_TARGETS,
  checkProxyQuality,
  classifyQualityResponse,
  summarizeQuality,
} from '../../src/lib/vm/proxy-quality.mjs'

test('quality distinguishes expected unauthenticated reachability, 429 and challenges', () => {
  const headers = new Headers()
  assert.equal(classifyQualityResponse(QUALITY_TARGETS[0], 401, headers).status, 'pass')
  assert.equal(classifyQualityResponse(QUALITY_TARGETS[1], 405, headers).status, 'pass')
  assert.equal(classifyQualityResponse(QUALITY_TARGETS[0], 429, headers).status, 'warn')
  assert.equal(
    classifyQualityResponse(QUALITY_TARGETS[0], 403, new Headers({ 'cf-mitigated': 'challenge', 'cf-ray': 'example' }))
      .status,
    'challenge',
  )
  assert.equal(classifyQualityResponse(QUALITY_TARGETS[0], 302, headers).status, 'fail')
  assert.equal(summarizeQuality([{ status: 'fail' }]).score, 0)
  assert.equal(summarizeQuality([{ status: 'pass' }, { status: 'warn' }, { status: 'fail' }]).score, 68)
})

test('quality uses one selected proxy for all targets and carries no provider auth', async () => {
  const urls = []
  const result = await checkProxyQuality({
    proxyId: 'px-test',
    proxyUrl: 'socks5h://probe:secret@127.0.0.1:1080',
    geoLookup: async (url) => {
      assert.ok(url.includes('1080'))
      return { ok: true, geo: { ip: '192.0.2.1', country: 'TW' } }
    },
    fetchImpl: async (url, options) => {
      urls.push(url)
      assert.ok(options.agent)
      assert.equal(options.headers.authorization, undefined)
      assert.equal(options.headers['x-api-key'], undefined)
      assert.equal(options.headers.cookie, undefined)
      assert.equal(options.method, 'GET')
      assert.equal(options.body, undefined)
      assert.equal(options.redirect, 'manual')
      const status = QUALITY_TARGETS.find((t) => t.url === url).allowed[0]
      return { status, headers: new Headers(), body: Readable.from(['{}']) }
    },
  })
  assert.equal(result.items.length, 5)
  assert.equal(result.score, 100)
  assert.equal(result.exit_ip, '192.0.2.1')
  assert.equal(urls.length, 4)
  assert.doesNotMatch(JSON.stringify(result), /secret/)
})

test('failed base connectivity skips targets; cancellation propagates', async () => {
  let calls = 0
  const report = await checkProxyQuality({
    proxyId: 'x',
    proxyUrl: '',
    geoLookup: async () => ({ ok: false }),
    fetchImpl: async () => {
      calls++
    },
  })
  assert.equal(report.score, 0)
  assert.equal(calls, 0)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    checkProxyQuality({ proxyId: 'x', proxyUrl: '', geoLookup: async () => ({}), signal: controller.signal }),
    { name: 'AbortError' },
  )
})

test('quality snapshot persists, rejects stale results, and local edits never change endpoint', async (t) => {
  const db = openDatabase({ dbPath: ':memory:' })
  t.after(closeDatabase)
  const pool = new ProxyPool({ db })
  pool.ensureLocal()
  assert.equal(pool.update('px-local', { label: '本机测试' }).ok, true)
  assert.equal(pool.update('px-local', { host: 'other' }).error, 'local_endpoint_readonly')
  const report = { score: 100, grade: 'A', items: [], checked_at: 1 }
  assert.equal((await pool.qualityById('px-local', { check: async () => report })).ok, true)
  pool.reload()
  assert.equal(pool.snapshot().proxies.find((p) => p.id === 'px-local').quality.score, 100)
  let release
  const running = pool.qualityById('px-local', {
    check: () =>
      new Promise((resolve) => {
        release = resolve
      }),
  })
  assert.equal((await pool.qualityById('px-local')).error, 'quality_check_busy')
  pool.state.proxies.find((p) => p.id === 'px-local').quality_version++
  release(report)
  assert.equal((await running).error, 'proxy_changed_during_check')
})
