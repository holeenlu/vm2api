import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, openDatabase } from '../../src/lib/db/database.mjs'
import { buildGatewayHeaders } from '../../src/lib/gateway-worker/gateway-auth.mjs'
import { createGatewayInternalRegistrationRoute } from '../../src/lib/gateway-worker/gateway-routes.mjs'
import { GatewayWorkerRepo } from '../../src/lib/gateway-worker/gateway-repo.mjs'

// 租约接口与心跳同样要求内部令牌、HMAC 签名与防重放（R3 审查 P1-6 ④）
test('refresh lease endpoints reject unsigned, forged, replayed and unknown-instance requests', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-route-'))
  const db = openDatabase({ dataDir: dir })
  const previous = process.env.KIN_CODEX_GATEWAY_INTERNAL_TOKEN
  process.env.KIN_CODEX_GATEWAY_INTERNAL_TOKEN = 'route-secret'
  t.after(async () => {
    await closeDatabase()
    if (previous === undefined) delete process.env.KIN_CODEX_GATEWAY_INTERNAL_TOKEN
    else process.env.KIN_CODEX_GATEWAY_INTERNAL_TOKEN = previous
    fs.rmSync(dir, { recursive: true, force: true })
  })
  db.exec('PRAGMA foreign_keys=OFF')
  const repo = new GatewayWorkerRepo(db)
  await repo.upsertInstance({ id: 'gw-1', base_url: 'http://127.0.0.1:1', health_state: 'healthy' })
  db.prepare(
    "INSERT INTO vendor_resources(id,vendor_id,resource_type,name,status,config_json,created_by,created_at,updated_at) VALUES('acct_1','v','account','A','active','{}','t','x','x')",
  ).run()
  db.prepare(
    "INSERT INTO gateway_worker_account_bindings(account_resource_id,gateway_instance_id,runtime_account_id,credential_revision,projection_status,created_at,updated_at) VALUES('acct_1','gw-1','rt_1',1,'synced','x','x')",
  ).run()
  const handle = createGatewayInternalRegistrationRoute({
    json: (res, status, body) => Object.assign(res, { status, body }),
    readBody: async () => ({}),
    readRawBody: async (req) => Buffer.from(req.raw),
  })
  const call = async (body, { secret = 'route-secret', token = 'route-secret', nonce, path: url } = {}) => {
    const raw = JSON.stringify(body)
    const headers = {
      ...buildGatewayHeaders({ secret, body: raw, ...(nonce ? { nonce } : {}) }),
      'x-kin-gateway-token': token,
    }
    const res = {}
    await handle(
      { method: 'POST', headers, raw },
      res,
      new URL(url || '/internal/v1/gateway/workers/credentials/lease', 'http://cp'),
    )
    return res
  }
  const acquire = { instance_id: 'gw-1', runtime_account_id: 'rt_1', grant: 'native', credential_revision: 1 }
  assert.equal((await call(acquire, { token: 'wrong' })).status, 401, 'wrong internal token')
  assert.equal((await call(acquire, { secret: 'forged' })).status, 401, 'forged signature')
  const granted = await call(acquire, { nonce: 'n-1' })
  assert.equal(granted.status, 200, JSON.stringify(granted.body))
  assert.equal((await call(acquire, { nonce: 'n-1' })).status, 409, 'replayed nonce')
  assert.equal((await call({ ...acquire, instance_id: 'gw-unknown' })).status, 404, 'unknown instance')
  assert.equal((await call({ ...acquire, runtime_account_id: 'rt_other' })).status, 404, 'unknown account binding')
  // 请求已发出却没拿到响应：报告 ambiguous 后任何实例都拿不到租约
  const ambiguous = await call(
    { ...acquire, lease_token: granted.body.lease_token, outcome: 'ambiguous' },
    { path: '/internal/v1/gateway/workers/credentials/release' },
  )
  assert.equal(ambiguous.status, 200, JSON.stringify(ambiguous.body))
  const blocked = await call(acquire)
  assert.deepEqual([blocked.status, blocked.body.reason], [409, 'outcome_unknown'])
})
