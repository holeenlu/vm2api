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

function setup({ env = {} } = {}) {
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
  })
  return { root, dataDir, fake, lines, supervisor }
}

test('the supervisor starts the co-located Worker whenever the binary exists', () => {
  const on = setup()
  on.supervisor.reconcile()
  assert.equal(on.fake.calls.length, 1)
  const { env } = on.fake.calls[0]
  assert.equal(env.KIN_CODEX_GATEWAY_LISTEN, '127.0.0.1:8790')
  assert.equal(env.KIN_CODEX_GATEWAY_CONTROL_PLANE_URL, 'http://127.0.0.1:9001/internal/v1/gateway/workers/register')
  assert.equal(env.KIN_CODEX_GATEWAY_RECEIPT_URL, 'http://127.0.0.1:9001/internal/v1/gateway/receipts')
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

  // 控制面关停时停止托管进程
  on.supervisor.stop()
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
