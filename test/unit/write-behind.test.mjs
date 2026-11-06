import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { RequestLogStore } from '../../src/lib/admin/request-log.mjs'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { dbClient } from '../../src/lib/db/db-client.mjs'
import { RequestAttemptsRepo } from '../../src/lib/db/repos/request-attempts-repo.mjs'
import {
  WRITE_KIND,
  armWriteBehind,
  discardPendingWrites,
  enqueueWrite,
  flushWrites,
  pendingWrites,
  setWriteBehindLimit,
  writeBehindArmed,
  writeBehindStats,
} from '../../src/lib/db/write-behind.mjs'

test('finish returns before the usage row is written, and flush commits it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-write-behind-'))
  const db = createDatabase({ dataDir: dir })
  const store = new RequestLogStore({ dataDir: dir, db, mode: 'normal' })
  armWriteBehind(db)
  try {
    const ctx = store.start({ headers: {}, socket: {} }, { protocol: 'anthropic.messages', pathName: '/v1/messages' })
    const summary = await store.finish(ctx, {
      status: 200,
      model: 'claude-haiku-4-5',
      input_tokens: 3,
      output_tokens: 1,
    })
    assert.equal(pendingWrites() > 0, true)
    assert.equal(await store.repo.getByRequestId(summary.request_id), null)
    await flushWrites()
    assert.equal(pendingWrites(), 0)
    assert.equal((await store.repo.getByRequestId(summary.request_id))?.status, 200)
    assert.equal(writeBehindArmed(), true)
  } finally {
    armWriteBehind(null)
    await flushWrites()
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// 技术债 M5：有界写回队列。观测写入（请求尝试）满了丢弃并计数；计费写入（使用记录）满了直接落库，不丢。
test('a full queue drops observation writes with a count and writes billing rows directly', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-write-behind-cap-'))
  const db = createDatabase({ dataDir: dir })
  const store = new RequestLogStore({ dataDir: dir, db, mode: 'normal' })
  const attempts = new RequestAttemptsRepo(db)
  armWriteBehind(db)
  setWriteBehindLimit(2)
  const before = writeBehindStats()
  try {
    let ran = 0
    assert.equal(
      enqueueWrite(async () => ran++),
      true,
    )
    assert.equal(
      enqueueWrite(async () => ran++, { kind: WRITE_KIND.OBSERVATION }),
      true,
    )
    // 队列已满：观测写入被丢弃
    assert.equal(
      enqueueWrite(async () => ran++, { kind: WRITE_KIND.OBSERVATION }),
      false,
    )
    await attempts.begin({ requestId: 'req-dropped', attemptNo: 1, vmId: 'vm-1', accountId: 'a', model: 'm' })
    // 计费写入不入队，由调用方直接写：finish 返回时行已落库
    assert.equal(
      enqueueWrite(async () => ran++, { kind: WRITE_KIND.BILLING }),
      false,
    )
    const ctx = store.start({ headers: {}, socket: {} }, { protocol: 'anthropic.messages', pathName: '/v1/messages' })
    const summary = await store.finish(ctx, {
      status: 200,
      model: 'claude-haiku-4-5',
      input_tokens: 3,
      output_tokens: 1,
    })
    assert.equal((await store.repo.getByRequestId(summary.request_id))?.status, 200)
    const stats = writeBehindStats()
    assert.equal(stats.queued, 2)
    assert.equal(stats.max_queue, 2)
    assert.equal(stats.dropped_observation - before.dropped_observation, 2)
    assert.equal(stats.billing_direct - before.billing_direct, 2)
    await flushWrites()
    assert.equal(ran, 2)
    assert.deepEqual(await attempts.list('req-dropped'), [])
    // 有空位后观测写入照常入队并落库
    await attempts.begin({ requestId: 'req-kept', attemptNo: 1, vmId: 'vm-1', accountId: 'a', model: 'm' })
    await flushWrites()
    assert.equal((await attempts.list('req-kept')).length, 1)
  } finally {
    setWriteBehindLimit(null)
    armWriteBehind(null)
    await flushWrites()
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// M3 复审 P1-1：批里某个闭包触发 SQLITE_FULL，SQLite 回滚整批；之前已执行的闭包随之撤销，之后的闭包不能以自动提交落库。
// 整批放回队首，恢复后全部写入；反复引发回滚的闭包丢弃前交给它的 spill
function fullBatchDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-write-behind-full-'))
  const db = createDatabase({ dataDir: dir })
  db.exec('CREATE TABLE t (name TEXT); CREATE TABLE big (b)')
  const pages = db.prepare('PRAGMA page_count').get().page_count
  db.exec(`PRAGMA max_page_count = ${pages + 1}`)
  return {
    db,
    unlimit: () => db.exec('PRAGMA max_page_count = 1073741823'),
    names: () =>
      db
        .prepare('SELECT name FROM t ORDER BY rowid')
        .all()
        .map((row) => row.name),
    close() {
      armWriteBehind(null)
      db.close()
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('a batch SQLite rolled back is put back whole and written after the database recovers', async () => {
  const f = fullBatchDb()
  const warn = console.warn
  console.warn = () => {}
  try {
    armWriteBehind(f.db)
    const c = dbClient(f.db)
    enqueueWrite(() => c.run("INSERT INTO t VALUES ('A-before')"))
    enqueueWrite(() => c.run('INSERT INTO big VALUES (randomblob(200000))'))
    enqueueWrite(() => c.run("INSERT INTO t VALUES ('C-after')"))
    await flushWrites()
    assert.equal(pendingWrites(), 3, 'nothing was committed and nothing was dropped')
    assert.deepEqual(f.names(), [], 'C was not autocommitted after the rollback')
    f.unlimit()
    await flushWrites()
    assert.equal(pendingWrites(), 0)
    assert.deepEqual(f.names(), ['A-before', 'C-after'])
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM big').get().n, 1)
  } finally {
    console.warn = warn
    f.close()
  }
})

test('a write that swallows the rollback error is still counted, dropped after three tries and spilled (M3 re-review P2-1)', async () => {
  const f = fullBatchDb()
  const { warn, error } = console
  console.warn = () => {}
  console.error = () => {}
  const spilled = []
  try {
    armWriteBehind(f.db)
    const c = dbClient(f.db)
    enqueueWrite(() => c.run("INSERT INTO t VALUES ('A')"))
    enqueueWrite(
      async () => {
        try {
          await c.run('INSERT INTO big VALUES (randomblob(200000))')
        } catch {}
      },
      { spill: () => spilled.push('swallow') },
    )
    enqueueWrite(() => c.run("INSERT INTO t VALUES ('C')"))
    for (let i = 0; i < 3; i++) await flushWrites()
    assert.deepEqual(spilled, ['swallow'])
    await flushWrites()
    assert.equal(pendingWrites(), 0)
    assert.deepEqual(f.names(), ['A', 'C'])
  } finally {
    console.warn = warn
    console.error = error
    f.close()
  }
})

test('a write that keeps rolling back its batch is dropped after three tries and spilled; the rest is written', async () => {
  const f = fullBatchDb()
  const { warn, error } = console
  console.warn = () => {}
  console.error = () => {}
  const spilled = []
  try {
    armWriteBehind(f.db)
    const c = dbClient(f.db)
    enqueueWrite(() => c.run("INSERT INTO t VALUES ('A')"))
    enqueueWrite(() => c.run('INSERT INTO big VALUES (randomblob(200000))'), { spill: () => spilled.push('big') })
    for (let i = 0; i < 3; i++) await flushWrites()
    assert.deepEqual(spilled, ['big'])
    assert.equal(pendingWrites(), 1)
    await flushWrites()
    assert.deepEqual(f.names(), ['A'])
  } finally {
    console.warn = warn
    console.error = error
    f.close()
  }
})

test('writes still queued when the database is closed are counted and spilled (M3 review P2-7)', () => {
  const { error } = console
  const lines = []
  console.error = (line) => lines.push(line)
  const spilled = []
  try {
    const before = writeBehindStats().discarded
    // 未登记连接：只入队、不排空
    enqueueWrite(async () => {}, { spill: () => spilled.push('usage') })
    enqueueWrite(async () => {}, { kind: WRITE_KIND.OBSERVATION })
    const report = discardPendingWrites('test close')
    assert.deepEqual(report, { total: 2, billing: 1, observation: 1, spilled: 1 })
    assert.deepEqual(spilled, ['usage'])
    assert.equal(pendingWrites(), 0)
    assert.equal(writeBehindStats().discarded, before + 2)
    assert.match(lines.join('\n'), /test close: 2 queued writes were not committed/)
  } finally {
    console.error = error
  }
})
