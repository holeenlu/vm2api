import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startGateway, api, REPO_ROOT, pickFreePort } from '../harness.mjs'
import { buildGatewayHeaders } from '../../src/lib/gateway-worker/gateway-auth.mjs'

// 统一控制面重构 P5.5：两个真实 Worker 经 Redis 共享运行态；Redis 停止时退回本地状态并照常接单，恢复后回到共享。
// 测试环境用 miniredis 起的真实 TCP 服务（worker/internal/testutil/miniredis-server），生产部署使用真实 Redis。

function goBuild(pkg, name) {
  const go = spawnSync('go', ['version'], { encoding: 'utf8' })
  if (go.status !== 0) return { skip: 'go toolchain not available' }
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), `kin-${name}-`)), name)
  const build = spawnSync('go', ['build', '-o', out, pkg], {
    cwd: path.join(REPO_ROOT, 'worker'),
    encoding: 'utf8',
    env: { ...process.env, CGO_ENABLED: '0' },
  })
  if (build.status !== 0) throw new Error(`go build ${pkg} failed: ${build.stderr}`)
  return { bin: out }
}

async function waitFor(fn, { timeoutMs = 30_000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await fn()
    if (last) return last
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(`timed out waiting: ${JSON.stringify(last)}`)
}

const worker = process.env.KIN_CODEX_GATEWAY_BIN
  ? { bin: process.env.KIN_CODEX_GATEWAY_BIN }
  : goBuild('./cmd/kin-codex-gateway', 'kin-codex-gateway')
const redisServer = worker.skip ? worker : goBuild('./internal/testutil/miniredis-server', 'kin-test-redis')

function startRedis(addr) {
  const child = spawn(redisServer.bin, ['-addr', addr], { stdio: ['ignore', 'pipe', 'pipe'] })
  return new Promise((resolve, reject) => {
    let out = ''
    child.stdout.on('data', (chunk) => {
      out += chunk
      const match = /ready (\S+)/.exec(out)
      if (match) resolve({ child, addr: match[1] })
    })
    child.once('exit', (code) => reject(new Error(`redis helper exited ${code}`)))
  })
}

async function stop(child) {
  if (!child || child.exitCode != null) return
  const exited = new Promise((resolve) => child.once('exit', resolve))
  child.kill('SIGTERM')
  await exited
}

test('two Workers share runtime state through Redis and fall back to local state while it is down', {
  skip: worker.skip,
}, async (t) => {
  const secret = crypto.randomUUID()
  const bundleKey = crypto.randomBytes(32).toString('hex')
  let redis = await startRedis(`127.0.0.1:${await pickFreePort()}`)
  const redisUrl = `redis://${redis.addr}`
  const gw = await startGateway({
    disableWatchdog: true,
    env: {
      KIN_CODEX_GATEWAY_INTERNAL_TOKEN: secret,
      KIN_CODEX_GATEWAY_CREDENTIAL_BUNDLE_KEY: bundleKey,
      KIN_CODEX_GATEWAY_MULTI_WORKER: '1',
      KIN_CODEX_GATEWAY_SUPERVISE: '0',
    },
  })
  const workers = []
  t.after(async () => {
    for (const w of workers) await stop(w.child)
    await stop(redis.child)
    await gw.stop()
    for (const w of workers) fs.rmSync(w.dataDir, { recursive: true, force: true })
    fs.rmSync(gw.project, { recursive: true, force: true })
  })
  for (const id of ['gw_r1', 'gw_r2']) {
    const port = await pickFreePort()
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `kin-gw-${id}-`))
    let log = ''
    const child = spawn(worker.bin, [], {
      env: {
        ...process.env,
        KIN_CODEX_GATEWAY_LISTEN: `127.0.0.1:${port}`,
        KIN_CODEX_GATEWAY_ADVERTISE_URL: `http://127.0.0.1:${port}`,
        KIN_CODEX_GATEWAY_INSTANCE_ID: id,
        KIN_CODEX_GATEWAY_DATA_DIR: dataDir,
        KIN_CODEX_GATEWAY_INTERNAL_TOKEN: secret,
        KIN_CODEX_GATEWAY_RECEIPT_TOKEN: secret,
        KIN_CODEX_GATEWAY_CREDENTIAL_BUNDLE_KEY: bundleKey,
        KIN_CODEX_GATEWAY_CONTROL_PLANE_URL: `http://127.0.0.1:${gw.port}/internal/v1/gateway/workers/register`,
        KIN_CODEX_GATEWAY_RECEIPT_URL: `http://127.0.0.1:${gw.port}/internal/v1/gateway/receipts`,
        KIN_CODEX_GATEWAY_REQUIRE_MTLS: '0',
        KIN_REDIS_URL: redisUrl,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', (chunk) => (log += chunk))
    child.stderr.on('data', (chunk) => (log += chunk))
    workers.push({ id, port, dataDir, child, log: () => log })
  }
  const logs = () => workers.map((w) => `--- ${w.id}\n${w.log()}`).join('\n')
  const instances = async () => {
    const response = await api(gw, 'GET', '/api/panel/gateway-workers')
    return (response.json?.data ?? response.json)?.items || []
  }
  const health = async (w) => {
    const response = await fetch(`http://127.0.0.1:${w.port}/internal/v1/health`, {
      headers: buildGatewayHeaders({ secret, body: '' }),
    })
    return response.json().catch(() => null)
  }
  // 两个实例都接上 Redis，并经心跳把共享运行态报给控制面
  await waitFor(
    async () => {
      const items = await instances()
      return ['gw_r1', 'gw_r2'].every((id) => {
        const item = items.find((entry) => entry.id === id)
        return item?.health_state === 'healthy' && item.shared_state?.backend === 'redis' && item.shared_state.healthy
      })
    },
    { timeoutMs: 45_000 },
  ).catch((error) => {
    throw new Error(`${error.message}\n${logs()}`)
  })
  for (const w of workers) {
    const body = await health(w)
    assert.equal(body?.shared_state?.backend, 'redis')
    assert.equal(body?.shared_state?.encrypted, true, 'protocol content is encrypted with the bundle key')
  }
  // 故障演练：Redis 停止，Worker 退回本地状态、照常健康接单；控制面显示降级
  const addr = redis.addr
  await stop(redis.child)
  await waitFor(
    async () => {
      const bodies = await Promise.all(workers.map(health))
      return bodies.every((body) => body?.shared_state?.healthy === false && body.health_state === 'healthy') && bodies
    },
    { timeoutMs: 20_000 },
  )
  await waitFor(
    async () => {
      const items = await instances()
      return ['gw_r1', 'gw_r2'].every((id) => {
        const item = items.find((entry) => entry.id === id)
        return item?.health_state === 'healthy' && item.shared_state?.healthy === false
      })
    },
    { timeoutMs: 45_000 },
  )
  // 恢复：同一地址重新启动后自动回到共享
  redis = await startRedis(addr)
  await waitFor(
    async () => {
      const bodies = await Promise.all(workers.map(health))
      return bodies.every((body) => body?.shared_state?.healthy === true) && bodies
    },
    { timeoutMs: 20_000 },
  )
  assert.ok(
    workers.every((w) => w.log().includes('shared state (redis) unavailable')),
    'each Worker logs the fallback',
  )
})
