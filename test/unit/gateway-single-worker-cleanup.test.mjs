import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase, applyMigrations } from '../../src/lib/db/database.mjs'

// 同机单 Worker 收尾简化 S5（迁移 130）：绑定与授权会话不再记实例；实例密钥、引导授权、回执偏移与刷新租约表删除；
// 实例表的 approval_state、shared_state_json 列删除。其余数据原样保留
test('migration 130 drops the instance from bindings and OAuth sessions and removes retired tables and columns', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-single-worker-cleanup-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const file of fs.readdirSync('src/lib/db/migrations'))
    if (file.endsWith('.sql') && file < '130')
      fs.copyFileSync(path.join('src/lib/db/migrations', file), path.join(root, file))
  const db = createDatabase({ dbPath: ':memory:', migrationsDir: root })
  t.after(() => db.close())
  const at = (minutes) => new Date(Date.UTC(2026, 10, 7, 12, minutes)).toISOString()
  for (const id of ['gw-old', 'gw-01'])
    db.prepare(
      "INSERT INTO gateway_worker_instances(id,name,base_url,health_state,created_at,updated_at,approval_state,shared_state_json) VALUES(?,?,'http://127.0.0.1:1','healthy',?,?,NULL,'{}')",
    ).run(id, id, at(0), at(0))
  for (const id of ['gw-a', 'gw-b'])
    db.prepare(
      "INSERT INTO vendor_resources(id,vendor_id,resource_type,name,status,config_json,created_by,created_at,updated_at) VALUES(?,NULL,'account',?,'active',?,'t',?,?)",
    ).run(id, id, JSON.stringify({ platform: 'openai', execution_kind: 'gateway_worker' }), at(0), at(0))
  const binding = db.prepare(
    'INSERT INTO gateway_worker_account_bindings(id,account_resource_id,gateway_instance_id,runtime_account_id,credential_revision,projection_status,quota_json,inflight,credential_state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
  )
  binding.run('b1', 'gw-a', 'gw-01', 'gwacct_gw-a', 7, 'synced', '{"q":1}', 2, 'expired', at(1), at(5))
  // 投影时期的 blocked 状态没有写入方：改为 pending，由下一次心跳重新标记
  binding.run('b2', 'gw-b', 'gw-old', 'gwacct_gw-b', 1, 'blocked', null, 0, null, at(1), at(2))
  const session = db.prepare(
    "INSERT INTO gateway_worker_oauth_sessions(session_id,account_resource_id,actor_user_id,gateway_instance_id,state_hash,status,idempotency_key,expires_at,created_at,updated_at,session_json) VALUES(?,?,'operator',?,'hash','pending',?,?,?,?,'sealed')",
  )
  // 同一幂等键在两个实例下各有一行：保留最近更新的一行；没有幂等键的会话都保留
  session.run('s-old', null, 'gw-old', 'draft-1', at(30), at(1), at(1))
  session.run('s-new', null, 'gw-01', 'draft-1', at(30), at(2), at(3))
  session.run('s-free1', 'gw-a', 'gw-01', null, at(30), at(1), at(1))
  session.run('s-free2', 'gw-a', 'gw-old', null, at(30), at(1), at(1))
  db.prepare(
    "INSERT INTO gateway_worker_instance_keys(key_id,instance_id,sealed_secret,fingerprint,state,created_at) VALUES('k1','gw-01','x','fp','active',?)",
  ).run(at(0))

  applyMigrations(db, { migrationsDir: 'src/lib/db/migrations' })

  const columns = (table) =>
    db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => row.name)
  assert.equal(columns('gateway_worker_account_bindings').includes('gateway_instance_id'), false)
  assert.equal(columns('gateway_worker_oauth_sessions').includes('gateway_instance_id'), false)
  assert.equal(columns('gateway_worker_instances').includes('approval_state'), false)
  assert.equal(columns('gateway_worker_instances').includes('shared_state_json'), false)
  assert.deepEqual(
    db
      .prepare(
        'SELECT id,account_resource_id,runtime_account_id,credential_revision,projection_status,quota_json,inflight,credential_state FROM gateway_worker_account_bindings ORDER BY id',
      )
      .all()
      .map((row) => ({ ...row })),
    [
      {
        id: 'b1',
        account_resource_id: 'gw-a',
        runtime_account_id: 'gwacct_gw-a',
        credential_revision: 7,
        projection_status: 'synced',
        quota_json: '{"q":1}',
        inflight: 2,
        credential_state: 'expired',
      },
      {
        id: 'b2',
        account_resource_id: 'gw-b',
        runtime_account_id: 'gwacct_gw-b',
        credential_revision: 1,
        projection_status: 'pending',
        quota_json: null,
        inflight: 0,
        credential_state: null,
      },
    ],
  )
  assert.deepEqual(
    db
      .prepare('SELECT session_id FROM gateway_worker_oauth_sessions ORDER BY session_id')
      .all()
      .map((row) => row.session_id),
    ['s-free1', 's-free2', 's-new'],
  )
  const tables = new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((row) => row.name),
  )
  for (const name of [
    'gateway_worker_instance_keys',
    'gateway_worker_bootstrap_grants',
    'gateway_worker_receipt_offsets',
    'credential_refresh_leases',
  ])
    assert.equal(tables.has(name), false, name)
  // 收紧后的状态约束与唯一约束
  assert.throws(
    () => db.prepare("UPDATE gateway_worker_account_bindings SET projection_status='blocked' WHERE id='b1'").run(),
    /CHECK constraint failed/,
  )
  assert.throws(
    () =>
      db
        .prepare(
          "INSERT INTO gateway_worker_oauth_sessions(session_id,state_hash,idempotency_key,expires_at,created_at,updated_at) VALUES('s-dup','h','draft-1',?,?,?)",
        )
        .run(at(30), at(4), at(4)),
    /UNIQUE constraint failed: gateway_worker_oauth_sessions.idempotency_key/,
  )
  // 事实视图照常可读
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM gateway_account_facts_v1').get().n >= 2, true)
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
})
