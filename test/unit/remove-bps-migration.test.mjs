import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase, applyMigrations } from '../../src/lib/db/database.mjs'

// 迁移 133：BPS（Excel Basispoints）通道停止运营后删除其数据。造一个迁移到 132、带完整 BPS 数据的库再跑 133：
// BPS 凭据、配置、绑定运行态、探测记录、Codex 设置、Key 通道策略与 probe.recorded 事件被删除；原生凭据、其他配置、
// usage_logs.authorization_mode 与 request_attempts.route 的历史标记保留；事实视图去掉 BPS 列，读取契约版本 1 → 2
test('migration 133 removes BPS data and keeps native credentials, other settings and history', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remove-bps-migration-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const file of fs.readdirSync('src/lib/db/migrations'))
    if (file.endsWith('.sql') && file < '133')
      fs.copyFileSync(path.join('src/lib/db/migrations', file), path.join(root, file))
  const db = createDatabase({ dbPath: ':memory:', migrationsDir: root })
  t.after(() => db.close())
  const at = '2026-11-07T00:00:00.000Z'
  const columns = (table) =>
    db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => row.name)
  assert.equal(db.prepare('SELECT version FROM gateway_fact_contract WHERE id=1').get().version, 1)
  assert.ok(columns('gateway_account_facts_v1').includes('bps_settings_json'), '132 still exposes the BPS columns')

  const config = {
    platform: 'openai',
    execution_kind: 'gateway_worker',
    runtime_account_id: 'gwacct_gw-01',
    max_concurrency: 4,
    model_access: { mode: 'all', models: [] },
    bps: { enabled: true, models: ['gpt-5.5'] },
    bps_grant: { revision: 2, authorized_at: at },
    bps_catalog: { allowed: true, models: [] },
    bps_verification: { ok: true },
    bps_moved: { blocked_at: at, group_id: null },
  }
  db.prepare(
    "INSERT INTO vendor_resources(id,vendor_id,resource_type,name,status,config_json,created_by,created_at,updated_at) VALUES('gw-01',NULL,'account','Codex','active',?,'t',?,?)",
  ).run(JSON.stringify(config), at, at)
  db.prepare(
    `INSERT INTO gateway_worker_account_bindings(id,account_resource_id,runtime_account_id,credential_revision,projection_status,
       credential_state,bps_state,bps_error,bps_blocked_at,bps_recovery,bps_next_probe_at,bps_cooldown_until,created_at,updated_at)
     VALUES('b1','gw-01','gwacct_gw-01',3,'synced','expired','blocked','banned',?,'auto',?,?,?,?)`,
  ).run(at, at, at, at, at)
  const credential = db.prepare(
    "INSERT INTO executor_credentials(account_resource_id,grant_kind,revision,master_key_id,wrapped_key,ciphertext,token_fingerprint,source,updated_at) VALUES('gw-01',?,?,'mk_1',?,?,?,'t',?)",
  )
  credential.run('native', 3, 'wrapped-native', 'cipher-native', 'fp-native', at)
  credential.run('bps', 2, 'wrapped-bps', 'cipher-bps', 'fp-bps', at)
  db.prepare(
    "INSERT INTO gateway_bps_probes(account_resource_id,gateway_instance_id,runtime_account_id,probed_at,model,ok,status,created_at) VALUES('gw-01','gw-1','gwacct_gw-01',?,'gpt-5.5',0,403,?)",
  ).run(at, at)
  db.prepare(
    "INSERT INTO executor_settings(scope,values_json,revision,updated_at,updated_by) VALUES('codex',?,4,?,'t')",
  ).run(
    JSON.stringify({
      credit_overage: true,
      scheduling: { strategy: 'sticky' },
      bps_enabled: false,
      bps_images: { policy: 'warn' },
      bps_defaults: { models: ['gpt-5.5'] },
    }),
    at,
  )
  db.prepare("INSERT INTO api_keys(id,name,key,codex_route,created_at) VALUES('k1','key','sk-test','bps_only',?)").run(
    at,
  )
  const usage = db.prepare(
    "INSERT INTO usage_logs(request_id,created_at,model,status,execution_kind,account_resource_id,authorization_mode) VALUES(?,?,'gpt-5.5',200,'gateway_worker','gw-01',?)",
  )
  usage.run('req_bps', at, 'bps')
  usage.run('req_native', at, 'native')
  db.prepare(
    "INSERT INTO request_attempts(request_id,attempt_no,account_id,started_at,route) VALUES('req_bps',1,'gwacct_gw-01',?,'bps')",
  ).run(at)
  const inbox = db.prepare(
    "INSERT INTO executor_event_inbox(event_id,instance_id,stream_id,seq,type,occurred_at,payload_json,mode,status,received_at) VALUES(?,'gw-1','s1',?,?,?,'{}','primary','applied',?)",
  )
  inbox.run('evt_s1_1', 1, 'account.state', at, at)
  inbox.run('evt_s1_2', 2, 'probe.recorded', at, at)

  applyMigrations(db, { migrationsDir: 'src/lib/db/migrations' })

  // 账号配置：BPS 键删除，其余原样
  const after = JSON.parse(db.prepare("SELECT config_json FROM vendor_resources WHERE id='gw-01'").get().config_json)
  const {
    bps: _bps,
    bps_grant: _grant,
    bps_catalog: _catalog,
    bps_verification: _verification,
    bps_moved: _moved,
    ...kept
  } = config
  assert.deepEqual(after, kept)
  // 凭据库只剩原生凭据
  assert.deepEqual(
    db
      .prepare("SELECT grant_kind,revision,ciphertext FROM executor_credentials WHERE account_resource_id='gw-01'")
      .all()
      .map((row) => ({ ...row })),
    [{ grant_kind: 'native', revision: 3, ciphertext: 'cipher-native' }],
  )
  // 绑定的 BPS 运行态列与探测记录表删除，其他绑定字段保留
  assert.deepEqual(
    columns('gateway_worker_account_bindings').filter((name) => name.startsWith('bps_')),
    [],
  )
  assert.deepEqual(
    {
      ...db
        .prepare("SELECT credential_revision,credential_state FROM gateway_worker_account_bindings WHERE id='b1'")
        .get(),
    },
    { credential_revision: 3, credential_state: 'expired' },
  )
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='gateway_bps_probes'").get(), undefined)
  // Codex 设置删除 bps_* 键，其他设置与版本不变
  const settings = db.prepare("SELECT values_json,revision FROM executor_settings WHERE scope='codex'").get()
  assert.deepEqual(JSON.parse(settings.values_json), { credit_overage: true, scheduling: { strategy: 'sticky' } })
  assert.equal(settings.revision, 4)
  // API Key 的通道策略列删除，Key 本身保留
  assert.equal(columns('api_keys').includes('codex_route'), false)
  assert.equal(db.prepare("SELECT name FROM api_keys WHERE id='k1'").get().name, 'key')
  // 收件箱只删 probe.recorded
  assert.deepEqual(
    db
      .prepare('SELECT event_id FROM executor_event_inbox ORDER BY seq')
      .all()
      .map((row) => row.event_id),
    ['evt_s1_1'],
  )
  // 历史请求的授权方式与尝试通道保留（只读展示）
  assert.deepEqual(
    db
      .prepare('SELECT request_id,authorization_mode FROM usage_logs ORDER BY request_id')
      .all()
      .map((row) => [row.request_id, row.authorization_mode]),
    [
      ['req_bps', 'bps'],
      ['req_native', 'native'],
    ],
  )
  assert.equal(db.prepare("SELECT route FROM request_attempts WHERE request_id='req_bps'").get().route, 'bps')

  // 事实视图：没有 BPS 列，原生凭据照常关联，读取契约版本 2
  assert.equal(db.prepare('SELECT version FROM gateway_fact_contract WHERE id=1').get().version, 2)
  assert.deepEqual(
    columns('gateway_account_facts_v1').filter((name) => name.startsWith('bps_')),
    [],
  )
  const facts = db.prepare("SELECT * FROM gateway_account_facts_v1 WHERE account_resource_id='gw-01'").get()
  assert.equal(facts.runtime_account_id, 'gwacct_gw-01')
  assert.equal(facts.native_revision, 3)
  assert.equal(facts.native_ciphertext, 'cipher-native')
  assert.equal(facts.max_concurrency, 4)
  assert.ok(db.prepare('SELECT 1 FROM gateway_account_groups_v1 LIMIT 1').all())

  // 重建的触发器：Worker 读取的字段变化推进事实版本，config 里残留的 bps 键不再推进
  const revision = () =>
    db.prepare("SELECT revision FROM gateway_account_fact_revisions WHERE account_resource_id='gw-01'").get()
      ?.revision ?? 0
  const setConfig = (key, value) =>
    db
      .prepare("UPDATE vendor_resources SET config_json=json_set(config_json,?,json(?)) WHERE id='gw-01'")
      .run(`$.${key}`, JSON.stringify(value))
  const before = revision()
  setConfig('bps', { enabled: true })
  assert.equal(revision(), before, 'bps is no longer a Worker-read fact')
  setConfig('max_concurrency', 6)
  assert.ok(revision() > before, 'Worker-read fields still advance the revision')
})
