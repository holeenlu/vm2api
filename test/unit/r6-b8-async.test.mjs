// R6 B8 收尾的行为回归：写回队列 async 批事务与失败语义、关库等待延后写入、VM 文件异步镜像、
// 代理池合并写回（含事务回滚）、集群节点平台内存表、Codex 设置未预热时的读取。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, createDatabase, getDb, openDatabase } from '../../src/lib/db/database.mjs'
import { dbClient, transactionOutcome } from '../../src/lib/db/db-client.mjs'
import {
  armWriteBehind,
  enqueueWrite,
  flushWrites,
  pendingWrites,
  trackBackgroundWrite,
  writesIdle,
} from '../../src/lib/db/write-behind.mjs'
import { VmsRepo } from '../../src/lib/db/repos/vms-repo.mjs'
import { ClusterNodesRepo } from '../../src/lib/db/repos/cluster-nodes-repo.mjs'
import { flushVmMirror, initVmDbSync, removeVmFromDb, stopVmWatch } from '../../src/lib/vm/vm-db-sync.mjs'
import { atomicWriteJson, setVmWriteHook } from '../../src/lib/vm/vm-file.mjs'
import { ProxyPool } from '../../src/lib/vm/proxy-pool.mjs'
import { SettingsRepo } from '../../src/lib/db/repos/settings-repo.mjs'
import { hasCredentialRecords } from '../../src/lib/executor/repos/vault-repo.mjs'
import { ClusterManager } from '../../src/lib/cluster/cluster-manager.mjs'
import { readCodexSettings, warmCodexSettings } from '../../src/lib/executor/settings-store.mjs'

function tmp(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function memoryDb(t) {
  const db = createDatabase({ dbPath: ':memory:' })
  db.exec('CREATE TABLE wb (v TEXT NOT NULL)')
  t.after(() => db.close())
  return db
}

const rows = (db) =>
  db
    .prepare('SELECT v FROM wb ORDER BY rowid')
    .all()
    .map((r) => r.v)

test('write-behind runs async closures in order inside one batch transaction', async (t) => {
  const db = memoryDb(t)
  armWriteBehind(db)
  t.after(() => armWriteBehind(null))
  const client = dbClient(db)
  const seen = []
  for (const v of ['a', 'b', 'c'])
    enqueueWrite(async () => {
      seen.push(client.transaction() && transactionOutcome(client.transaction()))
      await client.run('INSERT INTO wb (v) VALUES (?)', v)
      // 闭包里的嵌套事务落在批事务里，成为保存点
      await client.tx(async (tx) => tx.run('INSERT INTO wb (v) VALUES (?)', `${v}2`))
    })
  assert.equal(pendingWrites(), 3)
  assert.deepEqual(rows(db), [], 'nothing is written synchronously')
  await flushWrites()
  assert.deepEqual(rows(db), ['a', 'a2', 'b', 'b2', 'c', 'c2'])
  assert.deepEqual(seen, ['open', 'open', 'open'], 'every closure ran inside the open batch transaction')
  assert.equal(writesIdle(), true)
})

test('a failing closure is rolled back to its own savepoint; the rest of the batch commits (review P2-8)', async (t) => {
  const db = memoryDb(t)
  armWriteBehind(db)
  t.after(() => armWriteBehind(null))
  const client = dbClient(db)
  const warn = t.mock.method(console, 'warn', () => {})
  enqueueWrite(async () => client.run('INSERT INTO wb (v) VALUES (?)', 'before'))
  enqueueWrite(async () => {
    await client.run('INSERT INTO wb (v) VALUES (?)', 'partial')
    throw new Error('closure failed')
  })
  enqueueWrite(async () => client.run('INSERT INTO wb (v) VALUES (?)', 'after'))
  await flushWrites()
  // 每个闭包一个保存点：失败的闭包只撤销它自己写入的 partial，整批其余照常提交
  assert.deepEqual(rows(db), ['before', 'after'])
  assert.ok(warn.mock.calls.some((call) => String(call.arguments[1]).includes('closure failed')))
})

test('a closure that awaits real I/O is dropped; the rest of its batch is written again (review P2-8)', async (t) => {
  const db = memoryDb(t)
  armWriteBehind(db)
  t.after(() => armWriteBehind(null))
  const client = dbClient(db)
  t.mock.method(console, 'warn', () => {})
  enqueueWrite(async () => client.run('INSERT INTO wb (v) VALUES (?)', 'kept'))
  enqueueWrite(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5))
    await client.run('INSERT INTO wb (v) VALUES (?)', 'late')
  })
  enqueueWrite(async () => client.run('INSERT INTO wb (v) VALUES (?)', 'after'))
  await flushWrites()
  // 批事务不能跨事件循环：等待 I/O 的闭包被丢弃；同批其余闭包随回滚撤销后放回队首重写，不整批丢失
  assert.deepEqual(rows(db), ['kept', 'after'])
  assert.equal(pendingWrites(), 0)
})

test('waiting for background writes inside a transaction fails fast instead of hanging (review P2-5)', async (t) => {
  const db = memoryDb(t)
  armWriteBehind(db)
  t.after(() => armWriteBehind(null))
  await assert.rejects(
    dbClient(db).tx(async () => flushWrites()),
    /flushWrites\(\) cannot be awaited inside a database transaction/,
  )
  // 连接没有被挂住：事务外语句照常执行
  await dbClient(db).run('INSERT INTO wb (v) VALUES (?)', 'ok')
  assert.deepEqual(rows(db), ['ok'])
})

test('BEGIN failure puts the batch back and stops draining until the next flush', async (t) => {
  const db = memoryDb(t)
  armWriteBehind(db)
  t.after(() => armWriteBehind(null))
  const client = dbClient(db)
  t.mock.method(console, 'warn', () => {})
  enqueueWrite(async () => client.run('INSERT INTO wb (v) VALUES (?)', 'kept'))
  db.exec('BEGIN') // 连接上已有同步事务：批事务无法开始
  await flushWrites()
  db.exec('ROLLBACK')
  assert.equal(pendingWrites(), 1)
  await flushWrites()
  assert.deepEqual(rows(db), ['kept'])
})

test('flushWrites waits for tracked background writes; closeDatabase flushes before closing', async (t) => {
  const dir = tmp(t, 'r6-b8-close-')
  openDatabase({ dataDir: dir })
  const db = getDb()
  db.exec('CREATE TABLE wb (v TEXT NOT NULL)')
  armWriteBehind(db)
  let release
  const gate = new Promise((resolve) => (release = resolve))
  trackBackgroundWrite(gate.then(() => dbClient(db).run('INSERT INTO wb (v) VALUES (?)', 'background')))
  enqueueWrite(async () => dbClient(db).run('INSERT INTO wb (v) VALUES (?)', 'queued'))
  assert.equal(writesIdle(), false)
  const closing = closeDatabase()
  setImmediate(release)
  await closing
  const reopened = createDatabase({ dataDir: dir })
  t.after(() => reopened.close())
  assert.deepEqual(rows(reopened).sort(), ['background', 'queued'])
})

test('the vm.json hook mirrors asynchronously: latest file content, outside the writer transaction', async (t) => {
  const project = tmp(t, 'r6-b8-mirror-')
  openDatabase({ dataDir: path.join(project, 'data') })
  t.after(async () => {
    stopVmWatch()
    setVmWriteHook(null)
    await closeDatabase()
  })
  fs.mkdirSync(path.join(project, 'vms'), { recursive: true })
  await initVmDbSync(project, { watch: false })
  const repo = new VmsRepo(getDb())
  const file = path.join(project, 'vms', 'vm-m1.json')
  const upserts = t.mock.method(VmsRepo.prototype, 'upsertFromVmJson')
  // 文件写入仍同步；同一步里写两次只镜像最后一次
  atomicWriteJson(file, { id: 'vm-m1', name: 'first' })
  atomicWriteJson(file, { id: 'vm-m1', name: 'second' })
  assert.equal(await repo.get('vm-m1'), null, 'the hook does not touch the database synchronously')
  await flushVmMirror()
  assert.equal((await repo.get('vm-m1')).name, 'second')
  assert.equal(upserts.mock.callCount(), 1)
  // 写文件的事务回滚：镜像不随之回滚，行跟随文件（文件本身不是事务性的）
  await assert.rejects(
    dbClient(getDb()).tx(async () => {
      atomicWriteJson(file, { id: 'vm-m1', name: 'in-tx' })
      throw new Error('rollback')
    }),
    /rollback/,
  )
  await flushVmMirror()
  assert.equal((await repo.get('vm-m1')).name, 'in-tx')
  // 已排队、尚未镜像的写入不会在删除后把行写回
  atomicWriteJson(file, { id: 'vm-m1', name: 'queued-before-delete' })
  assert.equal(await removeVmFromDb('vm-m1'), true)
  await flushVmMirror()
  assert.equal(await repo.get('vm-m1'), null)
  // 文件已删除时跳过
  atomicWriteJson(file, { id: 'vm-m1', name: 'gone' })
  fs.rmSync(file)
  await flushVmMirror()
  assert.equal(await repo.get('vm-m1'), null)
})

test('proxy pool saves coalesce into one write-back; a save inside a rolled back transaction is not written', async (t) => {
  const db = createDatabase({ dbPath: ':memory:' })
  t.after(() => db.close())
  const pool = await ProxyPool.create({ db })
  pool.stopScheduler()
  const writes = t.mock.method(pool.repo, 'replaceAll')
  pool.importLines('203.0.113.10:1080\n203.0.113.11:1080')
  pool.updateConfig({ bind_limit: 3 })
  assert.equal(writes.mock.callCount(), 0, 'save() returns before writing')
  await pool.flush()
  assert.equal(writes.mock.callCount(), 1, 'saves in one synchronous step are written once')
  assert.equal((await pool.repo.loadAll()).length, 2)
  // 事务失败：原来同步写回随事务回滚，调用方再 reload；现在写回在事务结束后跳过，reload 读到原状态
  const [first] = pool.state.proxies
  await assert.rejects(
    dbClient(db).tx(async () => {
      assert.equal(pool.setEnabled(first.id, false).ok, true)
      throw new Error('rollback')
    }),
    /rollback/,
  )
  await pool.reload()
  assert.equal(pool.state.proxies.find((p) => p.id === first.id).enabled, true)
  assert.equal(writes.mock.callCount(), 1)
  // 事务提交：写回在提交之后执行
  await dbClient(db).tx(async () => {
    pool.setEnabled(first.id, false)
  })
  await pool.flush()
  assert.equal((await pool.repo.loadAll()).find((p) => p.id === first.id).enabled, false)
})

test('cluster node platform is read from memory, loaded at start and kept current', async (t) => {
  const db = createDatabase({ dbPath: ':memory:' })
  t.after(() => db.close())
  const repo = new ClusterNodesRepo(db)
  await repo.insert({
    id: 'node-mac',
    label: 'mac',
    host: 'mac.example.test',
    port: 22,
    username: 'kin',
    auth_type: 'key',
    private_key: 'k',
    host_key_alg: 'ssh-ed25519',
    host_key_sha256: 'SHA256:x',
  })
  await repo.setPlatform('node-mac', 'darwin')
  const manager = new ClusterManager({ repo, dataDir: tmp(t, 'r6-b8-cluster-'), logger: { log() {}, warn() {} } })
  assert.equal(manager.nodePlatform('node-mac'), 'linux', 'nothing loaded before start: the Linux default')
  await manager.loadPlatforms()
  const reads = t.mock.method(repo, 'platforms')
  assert.equal(manager.nodePlatform('node-mac'), 'darwin')
  assert.equal(manager.nodePlatform('node-unknown'), 'linux')
  assert.equal(reads.mock.callCount(), 0, 'nodePlatform does not query the database')
  await manager.stop()
})

test('codex settings read before warm-up return the unreadable placeholder and warm in the background', async (t) => {
  const cold = createDatabase({ dbPath: ':memory:' })
  t.after(() => cold.close())
  const warn = t.mock.method(console, 'warn', () => {})
  let prepared = 0
  const prepare = cold.prepare.bind(cold)
  cold.prepare = (sql) => {
    prepared += 1
    return prepare(sql)
  }
  const first = readCodexSettings(cold)
  assert.equal(prepared, 0, 'no synchronous query on the request path')
  assert.equal(first.unreadable, true)
  assert.equal(first.stored, false)
  assert.ok(warn.mock.calls.some((call) => /before warmCodexSettings/.test(String(call.arguments[0]))))
  await warmCodexSettings(cold)
  assert.equal(readCodexSettings(cold).unreadable, undefined)
})

test('a save in the microtasks after a write-back ends still reaches the database (review P0)', async (t) => {
  for (let extra = 0; extra < 16; extra++) {
    const pool = await ProxyPool.create({ dataDir: tmp(t, 'r6-b8-pp-gap-') })
    pool.importLines('socks5://1.1.1.1:1080')
    await pool.flush()
    await dbClient(pool.db).tx(async () => {
      pool.updateConfig({ probe_timeout_ms: 1111 })
    })
    for (let i = 0; i < extra; i++) await null
    pool.updateConfig({ probe_timeout_ms: 2222 })
    assert.equal(await pool.flush(), true)
    const stored = JSON.parse(
      pool.db.prepare("SELECT value FROM settings WHERE key='proxy_pool_config'").get().value,
    ).probe_timeout_ms
    assert.equal(stored, 2222, `second save lost after ${extra} microtasks`)
    pool.db.close()
  }
})

test('a failed proxy pool write-back stays pending and is retried (review P2-6)', async (t) => {
  const pool = await ProxyPool.create({ dataDir: tmp(t, 'r6-b8-pp-retry-') })
  t.after(() => pool.db.close())
  t.mock.method(console, 'warn', () => {})
  const setConfig = pool.repo.setConfig.bind(pool.repo)
  let fail = true
  pool.repo.setConfig = async (...args) => {
    if (fail) throw new Error('disk full')
    return setConfig(...args)
  }
  pool.updateConfig({ probe_timeout_ms: 3333 })
  assert.equal(await pool.flush(), false, 'flush reports the unsaved change')
  assert.equal(pool._persistDirty, true)
  fail = false
  clearTimeout(pool._persistRetry)
  pool._persistRetry = null
  pool._startPersist()
  assert.equal(await pool.flush(), true)
  const stored = JSON.parse(
    pool.db.prepare("SELECT value FROM settings WHERE key='proxy_pool_config'").get().value,
  ).probe_timeout_ms
  assert.equal(stored, 3333)
})

test('cluster platforms survive a failed reload and follow a rebind to the new connection (review P1)', async (t) => {
  const db1 = createDatabase({ dbPath: path.join(tmp(t, 'r6-b8-cl1-'), 'kin.db') })
  const db2 = createDatabase({ dbPath: path.join(tmp(t, 'r6-b8-cl2-'), 'kin.db') })
  t.after(() => db2.close())
  const repo1 = new ClusterNodesRepo(db1)
  const manager = new ClusterManager({ repo: repo1, dataDir: tmp(t, 'r6-b8-cl-dir-'), logger: { log() {}, warn() {} } })
  manager.platforms = new Map([['node-mac', 'darwin']])
  t.mock.method(console, 'warn', () => {})
  db1.close()
  await manager.loadPlatforms() // 旧连接已关闭：保留已载入的表，不清空
  assert.equal(manager.platforms.get('node-mac'), 'darwin')
  await manager.rebind(new ClusterNodesRepo(db2))
  assert.equal(manager.repo.db, db2)
  assert.equal(manager.platforms.get('node-mac'), undefined, 'the restored database has no such node')
})

test('a write outside a transaction is not overwritten by an earlier committed in-transaction write (review P2-3)', async (t) => {
  const db = createDatabase({ dbPath: path.join(tmp(t, 'r6-b8-set-'), 'kin.db') })
  t.after(() => db.close())
  const settings = new SettingsRepo(db)
  await dbClient(db).tx(async () => {
    await settings.set('k', 'A')
  })
  await settings.set('k', 'B')
  assert.equal(settings.get('k'), 'B')
})

test('a transaction rolled back by the yield guard is reported rolled back at once (review P2-4)', async (t) => {
  const db = memoryDb(t)
  const client = dbClient(db)
  t.mock.method(console, 'warn', () => {})
  let handle
  let outcomeWhileBodyRuns
  await assert.rejects(
    client.tx(async (tx) => {
      handle = client.transaction()
      await tx.run('INSERT INTO wb (v) VALUES (?)', 'x')
      await new Promise((resolve) => setTimeout(resolve, 5))
      outcomeWhileBodyRuns = transactionOutcome(handle)
    }),
    { code: 'db_tx_yielded' },
  )
  assert.equal(outcomeWhileBodyRuns, 'rolledback')
})

test('hasCredentialRecords is false only for a missing table; other errors propagate (review P2-7)', async (t) => {
  const db = memoryDb(t)
  assert.equal(await hasCredentialRecords(db), false)
  const closed = createDatabase({ dbPath: ':memory:' })
  closed.close()
  await assert.rejects(hasCredentialRecords(closed))
})
