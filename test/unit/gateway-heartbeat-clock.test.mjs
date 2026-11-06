import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, openDatabase } from '../../src/lib/db/database.mjs'
import { buildGatewayHeaders } from '../../src/lib/gateway-worker/gateway-auth.mjs'
import { createGatewayInternalRegistrationRoute } from '../../src/lib/gateway-worker/gateway-routes.mjs'
import { GatewayWorkerRepo } from '../../src/lib/gateway-worker/gateway-repo.mjs'
import { GatewayWorkerClient } from '../../src/lib/gateway-worker/gateway-client.mjs'
import { createGatewayWorkerRoutes } from '../../src/lib/gateway-worker/gateway-routes.mjs'

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heartbeat-clock-'))
  const db = openDatabase({ dataDir: dir })
  const previous = process.env.KIN_CODEX_GATEWAY_INTERNAL_TOKEN
  process.env.KIN_CODEX_GATEWAY_INTERNAL_TOKEN = 'route-secret'
  t.after(() => {
    closeDatabase()
    if (previous === undefined) delete process.env.KIN_CODEX_GATEWAY_INTERNAL_TOKEN
    else process.env.KIN_CODEX_GATEWAY_INTERNAL_TOKEN = previous
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return { db, repo: new GatewayWorkerRepo(db) }
}

const near = (iso, ms = 5_000) => Math.abs(Date.parse(iso) - Date.now()) < ms

// 最终审计 I1：心跳时间记控制面收到的时刻，Worker 自报的时间（时钟偏差）不进入在线判定
test('heartbeats are stamped with the control-plane clock, not the Worker clock', async (t) => {
  const { repo } = setup(t)
  const handle = createGatewayInternalRegistrationRoute({
    json: (res, status, body) => Object.assign(res, { status, body }),
    readBody: async () => ({}),
    readRawBody: async (req) => Buffer.from(req.raw),
  })
  for (const reported of ['2020-01-01T00:00:00.000Z', '2999-01-01T00:00:00.000Z']) {
    const raw = JSON.stringify({
      id: 'gw-skew',
      base_url: 'http://127.0.0.1:1',
      health_state: 'healthy',
      last_heartbeat_at: reported,
    })
    const res = {}
    await handle(
      {
        method: 'POST',
        headers: {
          ...buildGatewayHeaders({ secret: 'route-secret', body: raw }),
          'x-kin-gateway-token': 'route-secret',
        },
        raw,
      },
      res,
      new URL('/internal/v1/gateway/workers/heartbeat', 'http://cp'),
    )
    assert.equal(res.status, 200, JSON.stringify(res.body))
    const stored = (await repo.getInstance('gw-skew')).last_heartbeat_at
    assert.ok(near(stored), `stored ${stored} for a Worker reporting ${reported}`)
  }
})

// 最终审计 I2：面板健康探测失败不刷新心跳时间；成功时记控制面时间，Worker 返回的字段不能覆盖
test('a failed health probe does not refresh the heartbeat; a successful one uses the control-plane clock', async (t) => {
  const { repo } = setup(t)
  let status = 503
  const worker = http.createServer((req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    // Worker 返回的 id、准入状态与心跳时间都不能写进库（复核 S6）
    res.end(
      JSON.stringify({
        ok: status === 200,
        id: 'gw-other',
        admission_state: 'admitted',
        version: 'v-probe',
        last_heartbeat_at: '2020-01-01T00:00:00.000Z',
      }),
    )
  })
  await new Promise((resolve) => worker.listen(0, '127.0.0.1', resolve))
  t.after(() => worker.close())
  const old = new Date(Date.now() - 120_000).toISOString()
  await repo.upsertInstance({
    id: 'gw-probe',
    base_url: `http://127.0.0.1:${worker.address().port}`,
    health_state: 'healthy',
    last_heartbeat_at: old,
  })
  const client = new GatewayWorkerClient({ repo, secret: 'route-secret' })
  const failed = await client.health('gw-probe')
  assert.equal(failed.ok, false)
  const afterFailure = await repo.getInstance('gw-probe')
  assert.equal(afterFailure.health_state, 'error')
  assert.equal(afterFailure.last_heartbeat_at, old, 'a failed probe keeps the last heartbeat time')
  status = 200
  assert.equal((await client.health('gw-probe')).ok, true)
  const probed = await repo.getInstance('gw-probe')
  assert.ok(near(probed.last_heartbeat_at))
  assert.equal(probed.version, 'v-probe')
  assert.equal(await repo.getInstance('gw-other'), null, 'the Worker cannot move the probe onto another instance row')
})

// 复核 S2：面板手动登记不接受请求里带的心跳时间
test('manual registration ignores a heartbeat time in the request', async (t) => {
  const { repo } = setup(t)
  let reply
  const handler = createGatewayWorkerRoutes({
    json: (_res, status, body) => {
      reply = { status, body }
    },
    readBody: async () => ({
      id: 'gw-manual',
      base_url: 'http://127.0.0.1:1',
      last_heartbeat_at: '2999-01-01T00:00:00.000Z',
    }),
  })
  await handler({ method: 'POST', panelRole: 'super_admin' }, {}, { pathname: '/api/panel/gateway-workers/register' })
  assert.equal(reply.status, 200, JSON.stringify(reply.body))
  assert.ok(near((await repo.getInstance('gw-manual')).last_heartbeat_at))
})
