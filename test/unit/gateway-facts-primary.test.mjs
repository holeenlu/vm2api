import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { GatewayWorkerRepo } from '../../src/lib/gateway-worker/gateway-repo.mjs'

// Gateway 事实直读（设计第 19 节）：Worker 自己从库里读账号，控制面不推送账号，只从持有新凭据的实例收录凭据

function withDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-facts-primary-'))
  const db = createDatabase({ dataDir: dir })
  db.exec('PRAGMA foreign_keys=OFF')
  return Promise.resolve(fn(db)).finally(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
}

const account = (id, extra = '') =>
  `INSERT INTO vendor_resources(id,vendor_id,resource_type,name,status,config_json,created_by,created_at,updated_at${extra ? ',deleted_at' : ''}) VALUES('${id}',NULL,'account','${id}','${extra ? 'archived' : 'active'}','{"platform":"openai","execution_kind":"gateway_worker","runtime_account_id":"rt-${id}"}','t','x','x'${extra ? `,'${extra}'` : ''})`
const binding = (id, status = 'pending') =>
  `INSERT INTO gateway_worker_account_bindings(account_resource_id,runtime_account_id,credential_revision,projection_status,created_at,updated_at) VALUES('${id}','rt-${id}',1,'${status}','x','x')`

test('heartbeat facts mark bindings synced once the Worker caught up, and drop tombstoned bindings', () =>
  withDb(async (db) => {
    const repo = new GatewayWorkerRepo(db)
    await repo.upsertInstance({ id: 'gw-1', base_url: 'http://127.0.0.1:1', health_state: 'healthy' })
    db.exec(account('gw-01'))
    db.exec(account('gw-02'))
    db.exec(account('gw-03', '2026-11-06T00:00:00Z'))
    for (const id of ['gw-01', 'gw-02', 'gw-03']) db.exec(binding(id, id === 'gw-03' ? 'drifted' : 'pending'))
    const seq = db.prepare('SELECT value FROM gateway_fact_seq').get().value
    const statuses = () =>
      Object.fromEntries(
        db
          .prepare('SELECT account_resource_id, projection_status FROM gateway_worker_account_bindings ORDER BY 1')
          .all()
          .map((row) => [row.account_resource_id, row.projection_status]),
      )
    // 读取进度落后于库里的事实序列：不改
    await repo.markFactsSynced('gw-1', { status: { seq: seq - 1 } })
    assert.deepEqual(statuses(), { 'gw-01': 'pending', 'gw-02': 'pending', 'gw-03': 'drifted' })
    // 读取出错：不改
    await repo.markFactsSynced('gw-1', { status: { seq, last_error: 'database is locked' } })
    assert.equal(statuses()['gw-01'], 'pending')
    await repo.markFactsSynced('gw-1', {
      status: { seq },
      fact_errors: [{ account: 'gw-02', fields: ['native_master_key_missing'] }],
    })
    assert.deepEqual(statuses(), { 'gw-01': 'synced', 'gw-02': 'drifted' })
    // 出错列表被截断（with_errors 多于列出的条数）：只标列出的账号，其余账号保持原状态
    db.prepare("UPDATE gateway_worker_account_bindings SET projection_status='pending'").run()
    await repo.markFactsSynced('gw-1', {
      status: { seq, with_errors: 2 },
      fact_errors: [{ account: 'gw-02', fields: ['native_master_key_missing'] }],
    })
    assert.deepEqual(statuses(), { 'gw-01': 'pending', 'gw-02': 'drifted' })
  }))

// 分组与资源管理重整 P3：供应商授权分组为空时的口径统一（子供应商继承父级，根供应商为空即无分组，子级不超出父级）
test('vendor group scope: children inherit an empty list, roots without groups allow none', async () => {
  const { vendorAllowsGroup } = await import('../../src/lib/vendor/vendor-groups.mjs')
  const group = { id: 5, name: 'Codex' }
  const root = (groups) => ({ groups_json: JSON.stringify(groups) })
  assert.equal(vendorAllowsGroup(root(['5']), null, group), true)
  assert.equal(vendorAllowsGroup(root(['Codex']), null, group), true, 'groups may be listed by name')
  assert.equal(vendorAllowsGroup(root([]), null, group), false, 'a root supplier without groups gets none')
  assert.equal(vendorAllowsGroup(root([]), root(['5']), group), true, 'an empty child inherits its parent')
  assert.equal(vendorAllowsGroup(root(['5']), root(['6']), group), false, 'a child never exceeds its parent')
  assert.equal(vendorAllowsGroup({ groups: ['5'] }, null, group), true, 'projected suppliers carry groups')
})

// 迁移 130：绑定每个账号一行、不记实例。心跳里的运行态（事实同步状态、凭据终态、在途）只采信健康、接单中的实例：
// 替换实例的接替窗口里 Drain 或不健康的旧实例不能覆盖；旧实例的回执仍按运行账号记到同一账号
test('only the healthy accepting instance writes per-account runtime state', () =>
  withDb(async (db) => {
    const repo = new GatewayWorkerRepo(db)
    await repo.upsertInstance({ id: 'gw-1', base_url: 'http://127.0.0.1:1', health_state: 'healthy' })
    await repo.upsertInstance({ id: 'gw-2', base_url: 'http://127.0.0.1:2', health_state: 'healthy' })
    db.exec(account('gw-01'))
    db.exec(binding('gw-01', 'pending'))
    db.prepare("UPDATE gateway_worker_instances SET drain_state='draining' WHERE id='gw-1'").run()
    const seq = db.prepare('SELECT value FROM gateway_fact_seq').get().value
    const row = () =>
      db
        .prepare(
          "SELECT projection_status, credential_state, inflight FROM gateway_worker_account_bindings WHERE account_resource_id='gw-01'",
        )
        .get()
    // Drain 中的旧实例：读到当前事实也不标记，凭据终态与在途不采信
    await repo.markFactsSynced('gw-1', { status: { seq } })
    await repo.recordRuntimeCredentials('gw-1', [{ account_id: 'rt-gw-01', credential_state: 'expired' }])
    await repo.recordRuntimeLoad('gw-1', { account_inflight: [{ account_id: 'rt-gw-01', in_flight: 3 }] })
    assert.deepEqual({ ...row() }, { projection_status: 'pending', credential_state: null, inflight: 0 })
    // 新实例还没读到当前事实：不标记；读到后标记
    await repo.markFactsSynced('gw-2', { status: { seq: seq - 1 } })
    assert.equal(row().projection_status, 'pending')
    await repo.markFactsSynced('gw-2', { status: { seq } })
    await repo.recordRuntimeCredentials('gw-2', [{ account_id: 'rt-gw-01', credential_state: 'expired' }])
    await repo.recordRuntimeLoad('gw-2', { account_inflight: [{ account_id: 'rt-gw-01', in_flight: 2 }] })
    assert.deepEqual({ ...row() }, { projection_status: 'synced', credential_state: 'expired', inflight: 2 })
    // 不健康却自报接单的实例同样不采信
    db.prepare("UPDATE gateway_worker_instances SET drain_state='accepting',health_state='error' WHERE id='gw-1'").run()
    await repo.recordRuntimeCredentials('gw-1', [])
    await repo.recordRuntimeLoad('gw-1', { account_inflight: [] })
    assert.deepEqual({ ...row() }, { projection_status: 'synced', credential_state: 'expired', inflight: 2 })
    assert.equal((await repo.findAccountByRuntime('gw-1', 'rt-gw-01'))?.account_resource_id, 'gw-01')
  }))
