import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { GatewayWorkerRepo } from '../../src/lib/gateway-worker/gateway-repo.mjs'
import { GatewayWorkerService } from '../../src/lib/gateway-worker/gateway-execution.mjs'

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
  `INSERT INTO gateway_worker_account_bindings(account_resource_id,gateway_instance_id,runtime_account_id,credential_revision,projection_status,created_at,updated_at) VALUES('${id}','gw-1','rt-${id}',1,'${status}','x','x')`

test('credential capture exports only from the source instance and records it in the vault', () =>
  withDb(async (db) => {
    const repo = new GatewayWorkerRepo(db)
    await repo.upsertInstance({ id: 'gw-1', base_url: 'http://127.0.0.1:1', health_state: 'healthy' })
    db.exec(account('gw-01'))
    db.exec(binding('gw-01'))
    const calls = []
    const service = new GatewayWorkerService({ repo, secret: 's' })
    service.client = new Proxy(
      {},
      {
        get:
          (_target, name) =>
          async (...args) => {
            calls.push(name)
            if (name === 'exportAccount')
              return { ok: true, data: { account: { id: args[1], credential_revision: 1 } } }
            return { ok: true, data: {} }
          },
      },
    )
    const captured = []
    service.captureCredentials = async (input) => captured.push(input.accountResourceId)
    const result = await service.captureFromWorker({ id: 'rt-gw-01', account_resource_id: 'gw-01' }, 'gw-1')
    assert.equal(result.ok, true)
    assert.deepEqual(calls, ['exportAccount'])
    assert.deepEqual(captured, ['gw-01'])
    // 没有来源实例：什么都不发
    calls.length = 0
    const missing = await service.captureFromWorker({ id: 'rt-gw-01', account_resource_id: 'gw-01' }, null)
    assert.equal(missing.ok, false)
    assert.deepEqual(calls, [])
  }))

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

// 迁移 128：绑定每个账号一行。替换实例（新实例 ID）读到当前事实后接管绑定；Drain 中的旧实例不会抢回；
// 旧实例的回执仍按运行账号记到同一账号
test('a replacement instance takes over the per-account bindings once it caught up', () =>
  withDb(async (db) => {
    const repo = new GatewayWorkerRepo(db)
    await repo.upsertInstance({ id: 'gw-1', base_url: 'http://127.0.0.1:1', health_state: 'healthy' })
    await repo.upsertInstance({ id: 'gw-2', base_url: 'http://127.0.0.1:2', health_state: 'healthy' })
    db.exec(account('gw-01'))
    db.exec(binding('gw-01', 'synced'))
    db.prepare("UPDATE gateway_worker_instances SET drain_state='draining' WHERE id='gw-1'").run()
    const seq = db.prepare('SELECT value FROM gateway_fact_seq').get().value
    const holder = () =>
      db
        .prepare("SELECT gateway_instance_id FROM gateway_worker_account_bindings WHERE account_resource_id='gw-01'")
        .get().gateway_instance_id
    // 还没读到当前事实：不接管
    await repo.markFactsSynced('gw-2', { status: { seq: seq - 1 } })
    assert.equal(holder(), 'gw-1')
    await repo.markFactsSynced('gw-2', { status: { seq } })
    assert.equal(holder(), 'gw-2')
    // Drain 中的旧实例的心跳不抢回
    await repo.markFactsSynced('gw-1', { status: { seq } })
    assert.equal(holder(), 'gw-2')
    assert.equal((await repo.findAccountByRuntime('gw-1', 'rt-gw-01'))?.account_resource_id, 'gw-01')
  }))
