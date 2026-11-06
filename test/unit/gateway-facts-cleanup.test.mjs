import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase, applyMigrations } from '../../src/lib/db/database.mjs'

// Gateway 事实直读 G5（迁移 128）：投影时期留下的表、列与配置键删除，账号绑定改为每个账号一行
test('migration 128 collapses bindings per account and drops projection-era tables, columns and config keys', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-facts-cleanup-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const file of fs.readdirSync('src/lib/db/migrations'))
    if (file.endsWith('.sql') && file < '128')
      fs.copyFileSync(path.join('src/lib/db/migrations', file), path.join(root, file))
  const db = createDatabase({ dbPath: ':memory:', migrationsDir: root })
  t.after(() => db.close())
  const at = (minutes) => new Date(Date.UTC(2026, 10, 6, 12, minutes)).toISOString()
  for (const id of ['gw-old', 'gw-01'])
    db.prepare(
      "INSERT INTO gateway_worker_instances(id,name,base_url,health_state,created_at,updated_at,custody_public_key,tls_fingerprint) VALUES(?,?,'http://127.0.0.1:1','healthy',?,?,'pk','fp')",
    ).run(id, id, at(0), at(0))
  const account = (id, config) =>
    db
      .prepare(
        "INSERT INTO vendor_resources(id,vendor_id,resource_type,name,status,config_json,created_by,created_at,updated_at) VALUES(?,NULL,'account',?,'active',?,'t',?,?)",
      )
      .run(id, id, JSON.stringify(config), at(0), at(0))
  account('gw-a', {
    platform: 'openai',
    execution_kind: 'gateway_worker',
    runtime_account_id: 'gwacct_gw-a',
    group_ids: [1],
    projection_revision: 4,
    config_fingerprint: 'fp',
    max_concurrency: 3,
  })
  account('gw-b', { platform: 'openai', execution_kind: 'gateway_worker', runtime_account_id: 'gwacct_gw-b' })
  // VM 账号的 group_ids 不动
  db.prepare(
    "INSERT INTO vendors(id,name,external_code,email,tier,root_id,created_by,created_at,updated_at) VALUES('v1','V','v1','v@example.test',1,'v1','t',?,?)",
  ).run(at(0), at(0))
  db.prepare(
    "INSERT INTO vendor_resources(id,vendor_id,resource_type,name,status,config_json,created_by,created_at,updated_at) VALUES('vm-a','v1','account','vm-a','active',?,'t',?,?)",
  ).run(JSON.stringify({ platform: 'openai', execution_kind: 'vm', group_ids: [2] }), at(0), at(0))
  const binding = db.prepare(
    'INSERT INTO gateway_worker_account_bindings(id,account_resource_id,gateway_instance_id,runtime_account_id,credential_revision,projection_status,projection_revision,quota_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
  )
  // gw-a 在两个实例上各有一行：保留已同步的一行，凭据代次取最高
  binding.run('b1', 'gw-a', 'gw-old', 'gwacct_gw-a', 7, 'drifted', 3, '{"old":true}', at(1), at(9))
  binding.run('b2', 'gw-a', 'gw-01', 'gwacct_gw-a', 5, 'synced', 4, '{"new":true}', at(1), at(5))
  binding.run('b3', 'gw-b', 'gw-01', 'gwacct_gw-b', 1, 'pending', 1, null, at(1), at(2))
  db.prepare(
    "INSERT INTO gateway_worker_projection_jobs(id,account_resource_id,gateway_instance_id,projection_revision,created_at,updated_at) VALUES('j1','gw-a','gw-01',1,?,?)",
  ).run(at(0), at(0))

  applyMigrations(db, { migrationsDir: 'src/lib/db/migrations' })

  const rows = db
    .prepare(
      'SELECT id,account_resource_id,gateway_instance_id,credential_revision,projection_status,quota_json FROM gateway_worker_account_bindings ORDER BY account_resource_id',
    )
    .all()
    .map((row) => ({ ...row }))
  assert.deepEqual(rows, [
    {
      id: 'b2',
      account_resource_id: 'gw-a',
      gateway_instance_id: 'gw-01',
      credential_revision: 7,
      projection_status: 'synced',
      quota_json: '{"new":true}',
    },
    {
      id: 'b3',
      account_resource_id: 'gw-b',
      gateway_instance_id: 'gw-01',
      credential_revision: 1,
      projection_status: 'pending',
      quota_json: null,
    },
  ])
  const tables = new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((row) => row.name),
  )
  assert.equal(tables.has('gateway_worker_projection_jobs'), false)
  assert.equal(tables.has('gateway_worker_scopes'), false)
  const columns = (table) =>
    db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => row.name)
  for (const name of ['custody_public_key', 'custody_key_pending', 'tls_fingerprint', 'certificate_expires_at'])
    assert.equal(columns('gateway_worker_instances').includes(name), false, name)
  assert.equal(columns('gateway_worker_receipts').includes('projection_revision'), false)
  assert.equal(columns('gateway_worker_account_bindings').includes('projection_revision'), false)
  const config = (id) =>
    JSON.parse(db.prepare('SELECT config_json FROM vendor_resources WHERE id=?').get(id).config_json)
  assert.deepEqual(config('gw-a'), {
    platform: 'openai',
    execution_kind: 'gateway_worker',
    runtime_account_id: 'gwacct_gw-a',
    max_concurrency: 3,
  })
  assert.deepEqual(config('vm-a').group_ids, [2])
  // 每个账号一行：同一账号在另一个实例上再登记会冲突
  assert.throws(
    () =>
      db
        .prepare(
          "INSERT INTO gateway_worker_account_bindings(id,account_resource_id,gateway_instance_id,runtime_account_id,created_at,updated_at) VALUES('b4','gw-a','gw-old','gwacct_gw-a2',?,?)",
        )
        .run(at(3), at(3)),
    /UNIQUE constraint failed: gateway_worker_account_bindings.account_resource_id/,
  )
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
})
