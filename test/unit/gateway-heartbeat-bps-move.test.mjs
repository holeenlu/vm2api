import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, openDatabase } from '../../src/lib/db/database.mjs'
import { GroupsRepo } from '../../src/lib/db/repos/groups-repo.mjs'
import { buildGatewayHeaders } from '../../src/lib/gateway-worker/gateway-auth.mjs'
import { createGatewayInternalRegistrationRoute } from '../../src/lib/gateway-worker/gateway-routes.mjs'
import { GatewayWorkerRepo } from '../../src/lib/gateway-worker/gateway-repo.mjs'

// 事件不是主来源时（KIN_EXECUTOR_EVENTS 默认 off），BPS 403 停用后的自动移组由心跳触发
test('a heartbeat reporting a BPS 403 block moves the account out of its groups', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heartbeat-bps-'))
  const db = openDatabase({ dataDir: dir })
  const previous = { token: process.env.KIN_CODEX_GATEWAY_INTERNAL_TOKEN, events: process.env.KIN_EXECUTOR_EVENTS }
  process.env.KIN_CODEX_GATEWAY_INTERNAL_TOKEN = 'route-secret'
  delete process.env.KIN_EXECUTOR_EVENTS
  t.after(() => {
    closeDatabase()
    for (const [key, value] of [
      ['KIN_CODEX_GATEWAY_INTERNAL_TOKEN', previous.token],
      ['KIN_EXECUTOR_EVENTS', previous.events],
    ])
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const repo = new GatewayWorkerRepo(db)
  const groups = new GroupsRepo(db)
  const group = groups.create({ name: 'codex', platform: 'openai' })
  repo.upsertInstance({ id: 'gw-1', base_url: 'http://127.0.0.1:1', health_state: 'healthy' })
  const config = {
    platform: 'openai',
    execution_kind: 'gateway_worker',
    group_ids: [group.id],
    bps: { auto_move_on_403: true, target_group_id: 0 },
  }
  db.prepare(
    "INSERT INTO vendor_resources(id,vendor_id,resource_type,name,status,config_json,created_by,created_at,updated_at) VALUES('gw-01',NULL,'account','A','active',?,'t','x','x')",
  ).run(JSON.stringify(config))
  groups.assignResource('gateway_worker_account', 'gw-01', [group.id], 0)
  db.prepare(
    "INSERT INTO gateway_worker_account_bindings(account_resource_id,gateway_instance_id,runtime_account_id,credential_revision,projection_status,created_at,updated_at) VALUES('gw-01','gw-1','gwacct_gw-01',1,'synced','x','x')",
  ).run()
  const handle = createGatewayInternalRegistrationRoute({
    json: (res, status, body) => Object.assign(res, { status, body }),
    readBody: async () => ({}),
    readRawBody: async (req) => Buffer.from(req.raw),
  })
  const raw = JSON.stringify({
    id: 'gw-1',
    base_url: 'http://127.0.0.1:1',
    health_state: 'healthy',
    account_credentials: [
      { account_id: 'gwacct_gw-01', bps_state: 'blocked', bps_error: 'banned', bps_blocked_at: '2026-11-05T10:00:00Z' },
    ],
  })
  const res = {}
  await handle(
    {
      method: 'POST',
      headers: { ...buildGatewayHeaders({ secret: 'route-secret', body: raw }), 'x-kin-gateway-token': 'route-secret' },
      raw,
    },
    res,
    new URL('/internal/v1/gateway/workers/heartbeat', 'http://cp'),
  )
  assert.equal(res.status, 200, JSON.stringify(res.body))
  const stored = JSON.parse(db.prepare("SELECT config_json FROM vendor_resources WHERE id='gw-01'").get().config_json)
  assert.equal(stored.bps_moved?.blocked_at, '2026-11-05T10:00:00Z')
  assert.deepEqual(stored.group_ids, [])
  assert.deepEqual(groups.resources(group.id), [])
})
