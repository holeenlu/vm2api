import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { prepareRuntimeSecrets } from '../../src/lib/core/runtime-secrets.mjs'
import { createWorkerSupervisor, supervisedWorkerEnv } from '../../src/lib/gateway-worker/worker-supervisor.mjs'

function fakeSpawn() {
  const calls = []
  const spawnImpl = (bin, args, options) => {
    const proc = new EventEmitter()
    proc.pid = 40_000 + calls.length
    proc.stdout = new EventEmitter()
    proc.stderr = new EventEmitter()
    proc.exitCode = null
    proc.signalCode = null
    proc.signals = []
    proc.kill = (signal) => {
      proc.signals.push(signal)
      proc.signalCode = signal
      proc.emit('exit', null, signal)
    }
    calls.push({ bin, args, env: options.env, proc })
    return proc
  }
  return { calls, spawnImpl }
}

// 默认不连真实端口：排空请求失败时托管器直接 SIGTERM
const unreachable = async () => {
  throw new Error('unreachable')
}

function setup({ env = {}, workerRequest = unreachable, now, drainPollMs } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-sup-'))
  const dataDir = path.join(root, 'data')
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true })
  fs.writeFileSync(path.join(root, 'bin', 'kin-codex-gateway'), '#!/bin/sh\n', { mode: 0o755 })
  fs.writeFileSync(path.join(root, 'VERSION'), '1.4.040\n')
  const fake = fakeSpawn()
  const lines = []
  const log = { log: (line) => lines.push(line), error: (line) => lines.push(line), warn: () => {} }
  const supervisor = createWorkerSupervisor({
    env: { PORT: '9001', KIN_CODEX_GATEWAY_INTERNAL_TOKEN: 'tok', ...env },
    root,
    dataDir,
    spawnImpl: fake.spawnImpl,
    log,
    reconcileMs: 60_000,
    workerRequest,
    sleep: async () => {},
    ...(now ? { now } : {}),
    ...(drainPollMs ? { drainPollMs } : {}),
  })
  return { root, dataDir, fake, lines, supervisor }
}

test('the supervisor starts the co-located Worker whenever the binary exists', async () => {
  const on = setup()
  on.supervisor.reconcile()
  assert.equal(on.fake.calls.length, 1)
  const { env } = on.fake.calls[0]
  assert.equal(env.KIN_CODEX_GATEWAY_LISTEN, '127.0.0.1:8790')
  assert.equal(env.KIN_CODEX_GATEWAY_CONTROL_PLANE_URL, 'http://127.0.0.1:9001/internal/v1/gateway/workers/register')
  // 结算只走事件：不再给 Worker 回执推送地址（2026-11-07 S2）
  assert.equal(env.KIN_CODEX_GATEWAY_RECEIPT_URL, undefined)
  assert.equal(env.KIN_CODEX_GATEWAY_DATA_DIR, path.join(on.dataDir, 'codex-gateway'))
  assert.equal(env.KIN_CODEX_GATEWAY_VERSION, '1.4.040')
  assert.equal(fs.statSync(env.KIN_CODEX_GATEWAY_DATA_DIR).mode & 0o777, 0o700)
  assert.equal(
    fs.readFileSync(path.join(on.dataDir, 'codex-gateway.pid'), 'utf8').trim(),
    String(on.fake.calls[0].proc.pid),
  )
  const status = on.supervisor.status()
  assert.equal(status.status, 'running')
  assert.equal(status.supervised, true)

  // Worker 输出并入控制面日志
  on.fake.calls[0].proc.stdout.emit('data', 'listening\npartial')
  assert.deepEqual(on.lines, ['[codex-gateway] listening'])

  on.supervisor.reconcile()
  assert.equal(on.fake.calls.length, 1, 'a running Worker is not spawned twice')

  // 控制面关停时停止托管进程（Worker 不可达时跳过排空直接 SIGTERM）
  await on.supervisor.stop()
  assert.deepEqual(on.fake.calls[0].proc.signals, ['SIGTERM'])
  assert.equal(on.supervisor.status().status, 'stopped')
})

test('crashes restart with backoff and explicit settings win over defaults', async (t) => {
  // 退避定时器与时钟都用模拟时钟（U11：不再按真实时间轮询等待 1 秒退避）
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-11-06T00:00:00Z') })
  const { fake, supervisor } = setup({
    env: {
      KIN_CODEX_GATEWAY_LISTEN: '127.0.0.1:9900',
      KIN_CODEX_GATEWAY_INSTANCE_ID: 'gw-x',
    },
  })
  supervisor.reconcile()
  assert.equal(fake.calls[0].env.KIN_CODEX_GATEWAY_ADVERTISE_URL, 'http://127.0.0.1:9900')
  assert.equal(fake.calls[0].env.KIN_CODEX_GATEWAY_INSTANCE_ID, 'gw-x')
  fake.calls[0].proc.emit('exit', 1, null)
  const status = supervisor.status()
  assert.equal(status.status, 'backoff')
  assert.equal(status.restarts, 1)
  assert.deepEqual(status.last_exit.code, 1)
  supervisor.reconcile()
  assert.equal(fake.calls.length, 1, 'no restart before the backoff elapses')
  // 首次退避 1 秒：差 1 毫秒时不重启，到点由退避定时器重启
  t.mock.timers.tick(999)
  assert.equal(fake.calls.length, 1)
  t.mock.timers.tick(1)
  assert.equal(fake.calls.length, 2, 'the backoff timer restarts the Worker')
  supervisor.stop()
})

test('external mode and missing binaries never spawn a Worker', () => {
  const external = setup({ env: { KIN_CODEX_GATEWAY_SUPERVISE: '0' } })
  external.supervisor.reconcile()
  assert.equal(external.fake.calls.length, 0)
  assert.equal(external.supervisor.status().status, 'external')
  const missing = setup({
    env: { KIN_CODEX_GATEWAY_BIN: '/nonexistent/kin-codex-gateway' },
  })
  missing.supervisor.reconcile()
  assert.equal(missing.supervisor.status().status, 'missing_binary')
  assert.equal(
    supervisedWorkerEnv({ env: { KIN_CODEX_GATEWAY_LISTEN: '0.0.0.0:1' }, root: '/x', dataDir: '/d' })
      .KIN_CODEX_GATEWAY_ADVERTISE_URL,
    'http://0.0.0.0:1',
  )
})

test('runtime secrets provision the Gateway token and bundle key once', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-sec-'))
  const env = { KIN_DATA_DIR: path.join(root, 'data') }
  prepareRuntimeSecrets({ root, env })
  assert.match(env.KIN_CODEX_GATEWAY_INTERNAL_TOKEN, /^[0-9a-f]{64}$/)
  assert.match(env.KIN_CODEX_GATEWAY_CREDENTIAL_BUNDLE_KEY, /^[0-9a-f]{64}$/)
  assert.notEqual(env.KIN_CODEX_GATEWAY_INTERNAL_TOKEN, env.KIN_CODEX_GATEWAY_CREDENTIAL_BUNDLE_KEY)
  const again = { KIN_DATA_DIR: env.KIN_DATA_DIR }
  prepareRuntimeSecrets({ root, env: again })
  assert.equal(
    again.KIN_CODEX_GATEWAY_INTERNAL_TOKEN,
    env.KIN_CODEX_GATEWAY_INTERNAL_TOKEN,
    'restarts keep the same token',
  )
  fs.writeFileSync(path.join(root, '.env'), 'KIN_CODEX_GATEWAY_INTERNAL_TOKEN=from-dotenv\n')
  const explicit = { KIN_DATA_DIR: env.KIN_DATA_DIR }
  prepareRuntimeSecrets({ root, env: explicit })
  assert.equal(
    explicit.KIN_CODEX_GATEWAY_INTERNAL_TOKEN,
    'from-dotenv',
    '.env configuration wins over the generated value',
  )
  const saved = JSON.parse(fs.readFileSync(path.join(env.KIN_DATA_DIR, 'runtime-secrets.json'), 'utf8'))
  assert.equal(
    saved.KIN_CODEX_GATEWAY_INTERNAL_TOKEN,
    env.KIN_CODEX_GATEWAY_INTERNAL_TOKEN,
    'explicit values are not persisted',
  )
})

// 2026-11-07 S4：托管器每次拉起 Worker 给一把随机会话密钥作为子进程的内部令牌（不落盘、不等于共用令牌）；
// 托管的实例只接受会话密钥，共用令牌不能冒充它，外部实例照常用共用令牌；子进程退出后会话密钥作废
test('the supervised Worker authenticates with a per-process session key the shared token cannot impersonate', async (t) => {
  const { openDatabase, closeDatabase } = await import('../../src/lib/db/database.mjs')
  const { buildGatewayHeaders } = await import('../../src/lib/gateway-worker/gateway-auth.mjs')
  const { createGatewayInternalRegistrationRoute } = await import('../../src/lib/gateway-worker/gateway-routes.mjs')
  const { supervisedSession } = await import('../../src/lib/gateway-worker/worker-supervisor.mjs')
  const on = setup()
  openDatabase({ dataDir: on.dataDir })
  t.after(async () => {
    on.supervisor.stop()
    await closeDatabase()
    fs.rmSync(on.root, { recursive: true, force: true })
  })
  on.supervisor.reconcile()
  const { env, proc } = on.fake.calls[0]
  const session = supervisedSession()
  assert.match(env.KIN_CODEX_GATEWAY_INTERNAL_TOKEN, /^[0-9a-f]{64}$/)
  assert.notEqual(env.KIN_CODEX_GATEWAY_INTERNAL_TOKEN, 'tok')
  assert.deepEqual(session, {
    instanceId: env.KIN_CODEX_GATEWAY_INSTANCE_ID,
    key: env.KIN_CODEX_GATEWAY_INTERNAL_TOKEN,
  })
  const route = createGatewayInternalRegistrationRoute({
    json: (res, status, body) => Object.assign(res, { status, body }),
    readBody: async () => ({}),
    readRawBody: async (req) => Buffer.from(req.raw),
    env: { KIN_CODEX_GATEWAY_INTERNAL_TOKEN: 'tok' },
  })
  const register = async (id, secret) => {
    const raw = JSON.stringify({ id, base_url: 'http://127.0.0.1:8790', health_state: 'healthy' })
    const res = { headers: {} }
    res.setHeader = (name, value) => {
      res.headers[name] = value
    }
    await route(
      {
        method: 'POST',
        headers: { ...buildGatewayHeaders({ secret, body: raw }), 'x-kin-gateway-token': secret },
        raw,
      },
      res,
      new URL('/internal/v1/gateway/workers/register', 'http://cp'),
    )
    return res
  }
  const supervised = session.instanceId
  const ok = await register(supervised, session.key)
  assert.equal(ok.status, 200, JSON.stringify(ok.body))
  assert.equal(ok.headers['x-kin-gateway-response-key'], 'session')
  const impersonated = await register(supervised, 'tok')
  assert.deepEqual([impersonated.status, impersonated.body.error.code], [401, 'session_key_required'])
  const crossed = await register('gw-other', session.key)
  assert.deepEqual([crossed.status, crossed.body.error.code], [403, 'instance_mismatch'])
  assert.equal((await register(supervised, 'wrong')).status, 401)
  // 子进程退出：会话密钥作废，外部实例用共用令牌（单 Worker：原实例已不在线后才能接替，这里只看认证）
  proc.emit('exit', 0, null)
  assert.equal(supervisedSession(), null)
  assert.equal((await register(supervised, session.key)).status, 401)
})

// 审计 P2-11：停止前先让 Worker 排空（POST /internal/v1/drain，截止时间 = 控制面停机排空的默认 120 秒），
// 等在途请求结束（drain_state=drained 或在途为 0）后才 SIGTERM；请求用子进程的会话密钥签名、发往它的监听地址
test('stop drains the Worker before SIGTERM', async () => {
  const calls = []
  let proc = null
  const states = [
    { drain_state: 'draining', active_concurrency: 1 },
    { drain_state: 'drained', active_concurrency: 0 },
  ]
  const workerRequest = async (request) => {
    calls.push({ ...request, signals: [...proc.signals] })
    if (request.path === '/internal/v1/drain')
      return { ok: true, status: 200, data: { drain_state: 'draining', active_concurrency: 2 } }
    return { ok: true, status: 200, data: states.shift() }
  }
  const clock = Date.parse('2026-11-07T00:00:00Z')
  const on = setup({ workerRequest, now: () => clock })
  on.supervisor.reconcile()
  ;({ proc } = on.fake.calls[0])
  const { env } = on.fake.calls[0]
  await on.supervisor.stop()
  assert.deepEqual(
    calls.map((call) => [call.method, call.path]),
    [
      ['POST', '/internal/v1/drain'],
      ['GET', '/internal/v1/health'],
      ['GET', '/internal/v1/health'],
    ],
  )
  assert.ok(
    calls.every((call) => call.signals.length === 0),
    'no signal before the drain completes',
  )
  assert.equal(calls[0].listen, env.KIN_CODEX_GATEWAY_LISTEN)
  assert.equal(calls[0].key, env.KIN_CODEX_GATEWAY_INTERNAL_TOKEN)
  assert.equal(calls[0].body.deadline, new Date(clock + 120_000).toISOString())
  assert.deepEqual(proc.signals, ['SIGTERM'])
  assert.equal(on.supervisor.status().status, 'stopped')
})

test('the drain wait is bounded and a stuck Worker still gets SIGTERM', async () => {
  let clock = Date.parse('2026-11-07T00:00:00Z')
  let polls = 0
  const workerRequest = async (request) => {
    if (request.path === '/internal/v1/health') {
      polls += 1
      clock += 30_000
    }
    return { ok: true, status: 200, data: { drain_state: 'draining', active_concurrency: 3 } }
  }
  const on = setup({ workerRequest, now: () => clock, env: { KIN_SHUTDOWN_DRAIN_TIMEOUT_MS: '60000' } })
  on.supervisor.reconcile()
  await on.supervisor.stop()
  // 60 秒上限 + 5 秒收尾：每次轮询推进 30 秒，第 3 次之后超过上限
  assert.equal(polls, 3)
  assert.deepEqual(on.fake.calls[0].proc.signals, ['SIGTERM'])
})

// 恢复备份后重启：先排空、停止旧进程，再立即拉起新进程（不走崩溃退避，换新的会话密钥）
test('restart drains, stops and immediately respawns the Worker', async () => {
  const paths = []
  const workerRequest = async (request) => {
    paths.push(request.path)
    return { ok: true, status: 200, data: { drain_state: 'drained', active_concurrency: 0 } }
  }
  const on = setup({ workerRequest })
  on.supervisor.reconcile()
  const first = on.fake.calls[0]
  await on.supervisor.restart()
  assert.deepEqual(paths, ['/internal/v1/drain'])
  assert.deepEqual(first.proc.signals, ['SIGTERM'])
  assert.equal(on.fake.calls.length, 2)
  assert.equal(on.supervisor.status().status, 'running')
  assert.equal(on.supervisor.status().restarts, 0, 'a requested restart is not counted as a crash')
  assert.notEqual(on.fake.calls[1].env.KIN_CODEX_GATEWAY_INTERNAL_TOKEN, first.env.KIN_CODEX_GATEWAY_INTERNAL_TOKEN)
  await on.supervisor.stop()
})

test('the control plane restarts the Worker after a restore and waits for its drain on shutdown', () => {
  const source = fs.readFileSync(new URL('../../src/server.mjs', import.meta.url), 'utf8')
  const restored = source.slice(
    source.indexOf('backupService.onRestored('),
    source.indexOf('backupService.startScheduler()'),
  )
  assert.match(restored, /gatewayWorkerSupervisor\.restart\(\)/)
  const afterDrain = source.slice(
    source.indexOf('afterDrain: async'),
    source.indexOf('stopVmWatch()', source.indexOf('afterDrain: async')),
  )
  assert.match(afterDrain, /await gatewayWorkerSupervisor\.stop\(\)/)
})
