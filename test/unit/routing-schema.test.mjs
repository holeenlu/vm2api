import '../fixtures/local-docker-absent.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { createRoutingRuntime } from '../../src/lib/admin/routing-runtime.mjs'
import {
  ROUTING_POOL_SCHEMA,
  RoutingConfigError,
  sanitizeRoutingPoolSections,
  validateRoutingPoolPatch,
} from '../../src/lib/admin/routing-schema.mjs'
import { DEFAULT_POOL_CONFIG, normalizePoolConfig } from '../../src/lib/pool/pool-routing-policy.mjs'
import { PoolScheduler } from '../../src/lib/pool/pool-scheduler.mjs'

const shipped = JSON.parse(fs.readFileSync(new URL('../../src/config/routing.json', import.meta.url), 'utf8'))
const sectionsOf = (doc) => Object.fromEntries(ROUTING_POOL_SCHEMA.sections.map((name) => [name, doc[name]]))

function errorsOf(body) {
  try {
    validateRoutingPoolPatch(body)
  } catch (error) {
    assert.ok(error instanceof RoutingConfigError)
    assert.ok(error instanceof TypeError, 'existing routes map TypeError to 400')
    assert.equal(error.code, 'invalid_routing_config')
    assert.equal(error.status, 400)
    return error.errors
  }
  return []
}

function persistHarness(root, routingFile, routingConfig) {
  return createRoutingRuntime({
    cfg: { paths: { project: root } },
    routingConfigPath: routingFile,
    routingConfig,
    stickyRouter: { reloadConfig() {} },
    accountQuota: { reloadConfig() {}, applyTierConcurrency() {}, applyTierRpm() {}, repo: { get: () => null } },
    requestLog: { setConfig() {} },
  })
}

function captureWarnings(fn) {
  const original = console.warn
  const lines = []
  console.warn = (line) => lines.push(JSON.parse(line))
  try {
    return { result: fn(), lines }
  } finally {
    console.warn = original
  }
}

test('shipped routing sections and every schema default pass validation unchanged', () => {
  assert.deepEqual(errorsOf(sectionsOf(shipped)), [])
  const defaults = {}
  for (const field of ROUTING_POOL_SCHEMA.fields) {
    if (!Object.hasOwn(field, 'default')) continue
    const parts = field.key.split('.')
    let node = defaults
    for (const part of parts.slice(0, -1)) node = node[part] ??= {}
    node[parts.at(-1)] = field.default
  }
  assert.deepEqual(errorsOf(defaults), [])
  const { result, lines } = captureWarnings(() => sanitizeRoutingPoolSections(structuredClone(sectionsOf(shipped))))
  assert.deepEqual(result, sectionsOf(shipped))
  assert.deepEqual(lines, [])
})

test('pool defaults in the schema match the scheduler defaults', () => {
  for (const [key, value] of Object.entries(DEFAULT_POOL_CONFIG)) {
    const field = ROUTING_POOL_SCHEMA.fields.find((item) => item.key === `pool.${key}`)
    if (!field) continue
    assert.equal(field.default, value, key)
  }
})

test('save rejects unknown keys, misspelled enums, out-of-range and non-numeric values', () => {
  assert.deepEqual(errorsOf({ failover: { max_total_attempt: 3 } }), [
    { field: 'failover.max_total_attempt', reason: 'unknown setting' },
  ])
  assert.deepEqual(errorsOf({ pool: { strategy: 'balance' } }), [
    { field: 'pool.strategy', reason: 'must be one of balanced, fill' },
  ])
  assert.deepEqual(
    errorsOf({
      pool: { worker_health_ttl_ms: 'abc', queue_max: 1000 },
      sticky: { mode: 'device', ttl_seconds: 1.5 },
      quota: { weekly_split: { fable_share: 2 } },
      concurrency: { default_max_per_account: -1 },
    }).map((item) => item.field),
    [
      'pool.worker_health_ttl_ms',
      'pool.queue_max',
      'sticky.mode',
      'sticky.ttl_seconds',
      'quota.weekly_split.fable_share',
      'concurrency.default_max_per_account',
    ],
  )
  assert.deepEqual(errorsOf({ sticky: 'on' }), [{ field: 'sticky', reason: 'must be an object' }])
  // Sections outside the schema keep their own validators.
  assert.deepEqual(errorsOf({ logging: { anything: true }, sticky: null }), [])
})

test('persistRoutingPatch rejects an invalid scheduling patch before writing routing.json', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-routing-schema-persist-'))
  const routingFile = path.join(root, 'routing.json')
  const routingConfig = { concurrency: {}, tiers: {}, pool: { strategy: 'fill' } }
  fs.writeFileSync(routingFile, JSON.stringify(routingConfig))
  try {
    const runtime = persistHarness(root, routingFile, routingConfig)
    const before = fs.readFileSync(routingFile, 'utf8')
    await assert.rejects(
      () => runtime.persistRoutingPatch({ pool: { strategy: 'round_robin' }, failover: { bogus: 1 } }),
      (error) =>
        error.code === 'invalid_routing_config' &&
        error.errors.map((item) => item.field).join() === 'pool.strategy,failover.bogus',
    )
    assert.equal(fs.readFileSync(routingFile, 'utf8'), before)
    assert.equal(routingConfig.pool.strategy, 'fill')
    await runtime.persistRoutingPatch({ pool: { strategy: 'balanced' }, failover: { delivery_mode: 'verified' } })
    const saved = JSON.parse(fs.readFileSync(routingFile, 'utf8'))
    assert.equal(saved.pool.strategy, 'balanced')
    assert.equal(saved.failover.delivery_mode, 'verified')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('PUT /api/panel/routing answers 400 with field errors and never persists', async () => {
  const response = {}
  const handlePanel = createPanelHandler({
    cfg: { paths: { project: os.tmpdir() }, limits: { max_body_bytes: 4096 } },
    routingConfig: {},
    stickyRouter: { stats: () => ({}) },
    persistRoutingPatch() {
      throw new Error('must not persist an invalid routing patch')
    },
    requireAuth(req) {
      req.apiKeyKind = 'master'
      req.panelRole = 'super_admin'
      return true
    },
    json(_res, status, payload) {
      response.status = status
      response.body = payload
      return true
    },
    readBody: async () => ({ pool: { strategy: 'balance' }, quota: { surprise: true } }),
  })
  await handlePanel({ method: 'PUT' }, {}, new URL('http://localhost/api/panel/routing'))
  assert.equal(response.status, 400)
  assert.equal(response.body?.error?.code, 'invalid_routing_config')
  assert.deepEqual(response.body?.error?.errors, [
    { field: 'pool.strategy', reason: 'must be one of balanced, fill' },
    { field: 'quota.surprise', reason: 'unknown setting' },
  ])
})

test('loadRoutingConfig repairs invalid scheduling values and warns once per problem', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-routing-schema-load-'))
  const file = path.join(root, 'routing.json')
  fs.writeFileSync(
    file,
    JSON.stringify({
      codex: { quota: { max_concurrency: 2 } },
      pool: { strategy: 'round_robin', worker_health_ttl_ms: 'abc', circuit_open_ms: 1e9, legacy_knob: 1 },
      sticky: { enabled: 'yes', ttl_seconds: '3600', header_keys: 'x-session-id' },
      quota: { block_on_5h: 'no', weekly_split: { fable_share: 3, extra: 1 } },
      concurrency: { fable_max_per_account: 'many' },
      failover: { max_total_attempts: 12.6, stream_keepalive_ms: 'fast', delivery_mode: 'buffered' },
    }),
  )
  try {
    const runtime = createRoutingRuntime({ routingConfigPath: file })
    const { result: doc, lines } = captureWarnings(() => runtime.loadRoutingConfig())
    assert.equal(doc.pool.strategy, 'balanced')
    assert.equal(doc.pool.worker_health_ttl_ms, 5000)
    assert.equal(doc.pool.circuit_open_ms, 3600000)
    assert.equal(Object.hasOwn(doc.pool, 'legacy_knob'), false)
    assert.deepEqual(doc.sticky, { enabled: true, ttl_seconds: 3600 })
    assert.deepEqual(doc.quota, { block_on_5h: true, weekly_split: { fable_share: 1 } })
    assert.equal(doc.concurrency.fable_max_per_account, 4)
    assert.deepEqual(doc.failover, { max_total_attempts: 13, delivery_mode: 'realtime' })
    assert.deepEqual(
      lines.map((line) => `${line.event} ${line.field} ${line.action}`),
      [
        'routing_config_invalid pool.strategy default',
        'routing_config_invalid pool.worker_health_ttl_ms default',
        'routing_config_invalid pool.circuit_open_ms clamped',
        'routing_config_invalid pool.legacy_knob removed',
        'routing_config_invalid sticky.enabled default',
        'routing_config_invalid sticky.ttl_seconds clamped',
        'routing_config_invalid sticky.header_keys removed',
        'routing_config_invalid quota.block_on_5h default',
        'routing_config_invalid quota.weekly_split.fable_share clamped',
        'routing_config_invalid quota.weekly_split.extra removed',
        'routing_config_invalid concurrency.fable_max_per_account default',
        'routing_config_invalid failover.max_total_attempts clamped',
        'routing_config_invalid failover.stream_keepalive_ms removed',
        'routing_config_invalid failover.delivery_mode default',
      ],
    )
    // The same file loaded again (restore, restart in-process) does not repeat the warnings.
    assert.deepEqual(captureWarnings(() => runtime.loadRoutingConfig()).lines, [])
    // A repaired document is valid for the save path, so the panel can send it back as-is.
    assert.doesNotThrow(() => validateRoutingPoolPatch(sectionsOf(doc)))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('non-numeric worker_health_ttl_ms no longer turns maintenance into a 1ms loop', () => {
  assert.equal(normalizePoolConfig({ worker_health_ttl_ms: 'abc' }).worker_health_ttl_ms, 5000)
  assert.equal(normalizePoolConfig({ worker_health_ttl_ms: 10 }).worker_health_ttl_ms, 1000)
  assert.equal(normalizePoolConfig({}).worker_health_ttl_ms, 5000)
  const pool = new PoolScheduler({ config: { worker_health_ttl_ms: 'abc' } })
  pool.maintain = async () => {}
  const original = globalThis.setInterval
  let interval = null
  globalThis.setInterval = (fn, ms) => {
    interval = ms
    return original(fn, 3_600_000)
  }
  try {
    pool.startMaintenance()
  } finally {
    globalThis.setInterval = original
    pool.stopMaintenance()
  }
  assert.equal(interval, 5000)
  pool.reloadConfig({ worker_health_ttl_ms: Number.NaN })
  assert.equal(pool.config.worker_health_ttl_ms, 5000)
})
