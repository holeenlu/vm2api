import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { createDatabase, assertWritableConnection } from '../../src/lib/db/database.mjs'
import { dbClient } from '../../src/lib/db/db-client.mjs'
import { armWriteBehind, enqueueWrite, flushWrites, pendingWrites } from '../../src/lib/db/write-behind.mjs'
import {
  DATABASE_RETRY_AFTER_SECONDS,
  DEGRADED_BUSY_TIMEOUT_MS,
  NORMAL_BUSY_TIMEOUT_MS,
  RECOVERY_PROBES,
  armWriteHealth,
  assertBillingWritable,
  databaseUnavailableCode,
  databaseWritable,
  isDatabaseUnavailableError,
  noteWriteFailure,
  onWriteRecovered,
  probeOnce,
  writeHealthStats,
} from '../../src/lib/db/write-health.mjs'
import { commitRetryStats, retryCommit } from '../../src/lib/db/commit-retry.mjs'

// 恢复要连续 RECOVERY_PROBES 次写探测成功
async function probeUntilRecovered() {
  for (let i = 0; i < RECOVERY_PROBES; i++) assert.equal(await probeOnce(), true)
}

// 降级演练 M3：控制面数据库写不进去（其他进程长时间持有写锁、只读、磁盘满）时的写入健康与恢复

function withDb(fn) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-write-health-'))
    const db = createDatabase({ dataDir: dir })
    db.exec('CREATE TABLE IF NOT EXISTS drill (x INTEGER)')
    // 单测里别的连接持有写锁：不等满 5 秒
    db.exec('PRAGMA busy_timeout = 50')
    const holder = new DatabaseSync(path.join(dir, 'kin.db'))
    try {
      await fn({ db, holder, dir })
    } finally {
      armWriteBehind(null)
      armWriteHealth(null)
      try {
        holder.exec('ROLLBACK')
      } catch {}
      holder.close()
      db.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
}

const busyTimeout = (db) => db.prepare('PRAGMA busy_timeout').get().timeout

test('only write-path outage codes degrade, and only on the armed connection', async () => {
  for (const code of [5, 8, 10, 13, 14]) assert.ok(databaseUnavailableCode({ errcode: code }), `code ${code} degrades`)
  assert.equal(isDatabaseUnavailableError({ errcode: 5 }), true)
  assert.equal(isDatabaseUnavailableError({ errcode: 8 | (5 << 8) }), true, 'extended codes use the primary code')
  assert.equal(isDatabaseUnavailableError({ errcode: 19 }), false, 'a constraint violation is not an outage')
  assert.equal(isDatabaseUnavailableError(new Error('x')), false)
  // M3 复审 P2-6：LOCKED 可重试但不触发降级；CORRUPT、NOTADB 不可恢复，不算“不可用”（事件照常可判毒）
  assert.equal(isDatabaseUnavailableError({ errcode: 6 }), true)
  assert.equal(databaseUnavailableCode({ errcode: 6 }), null)
  assert.equal(isDatabaseUnavailableError({ errcode: 11 }), false)
  assert.equal(isDatabaseUnavailableError({ errcode: 26 }), false)
  const other = {}
  noteWriteFailure(other, { errcode: 5, message: 'database is locked' })
  assert.equal(databaseWritable(), true, 'an unarmed connection is ignored')
})

test(
  'LOCKED, CORRUPT and failing reads do not degrade',
  withDb(async ({ db }) => {
    armWriteHealth(db)
    noteWriteFailure(db, { errcode: 6, message: 'database table is locked' })
    noteWriteFailure(db, { errcode: 11, message: 'database disk image is malformed' })
    assert.equal(databaseWritable(), true)
    await assert.rejects(dbClient(db).one('SELECT * FROM missing_table'))
    assert.equal(databaseWritable(), true)
  }),
)

test(
  'a held write lock degrades writes, rejects billing admission, pauses write-behind and recovers without a restart',
  withDb(async ({ db, holder }) => {
    armWriteHealth(db)
    armWriteBehind(db)
    let recovered = 0
    const off = onWriteRecovered(() => recovered++)
    try {
      holder.exec('BEGIN IMMEDIATE')
      await assert.rejects(
        dbClient(db).tx(async (tx) => tx.run('INSERT INTO drill VALUES (1)')),
        /locked|busy/i,
      )
      const stats = writeHealthStats()
      assert.equal(stats.writable, false)
      assert.equal(stats.last_error_code, 'SQLITE_BUSY')
      assert.equal(busyTimeout(db), DEGRADED_BUSY_TIMEOUT_MS, 'writes fail fast instead of freezing the event loop')
      const headers = {}
      assert.throws(
        () => assertBillingWritable({ headersSent: false, setHeader: (name, value) => (headers[name] = value) }),
        (error) => error.code === 'database_unavailable' && error.status === 503,
      )
      assert.equal(headers['Retry-After'], String(DATABASE_RETRY_AFTER_SECONDS), '503 carries Retry-After')
      // 写回队列：入队不丢，失败中不排空
      enqueueWrite(async () => dbClient(db).run('INSERT INTO drill VALUES (2)'))
      await new Promise((resolve) => setTimeout(resolve, 30))
      assert.equal(pendingWrites(), 1)
      assert.equal(await probeOnce(), false)
      // 写锁还在：空操作的 exec 与只读语句成功不算恢复（M3 复审 P2-1）
      await dbClient(db).exec('CREATE TABLE IF NOT EXISTS drill (x INTEGER)')
      await dbClient(db).one('SELECT COUNT(*) AS n FROM drill')
      assert.equal(databaseWritable(), false)
      // 释放写锁：连续两次写探测（真正提交）才恢复，busy_timeout 复原，写回队列自动排空
      holder.exec('ROLLBACK')
      assert.equal(await probeOnce(), true)
      assert.equal(databaseWritable(), false, 'one successful probe is not enough')
      assert.equal(await probeOnce(), true)
      assert.equal(databaseWritable(), true)
      assert.equal(recovered, 1)
      assert.equal(busyTimeout(db), NORMAL_BUSY_TIMEOUT_MS)
      await flushWrites()
      assert.deepEqual(
        db
          .prepare('SELECT x FROM drill ORDER BY x')
          .all()
          .map((row) => row.x),
        [2],
      )
      // 探测写在专用单行表里（不经迁移）
      assert.deepEqual({ ...db.prepare('SELECT id, seq FROM _kin_write_probe').get() }, { id: 1, seq: RECOVERY_PROBES })
      assert.equal(writeHealthStats().recoveries, 1)
    } finally {
      off()
    }
  }),
)

test(
  'a failed settlement commit is retried after the database recovers, once',
  withDb(async ({ db, holder }) => {
    armWriteHealth(db)
    holder.exec('BEGIN IMMEDIATE')
    let calls = 0
    const replay = (entry) => {
      calls++
      return dbClient(db).tx(async (tx) => tx.run('INSERT INTO drill VALUES (?)', entry.value))
    }
    const before = commitRetryStats()
    const entry = { request_id: 'req-1', value: 11 }
    await assert.rejects(replay(entry), /locked|busy/i)
    assert.equal(retryCommit(entry, { replay }), true)
    assert.equal(retryCommit(entry, { replay }), false, 'one retry per request')
    assert.equal(commitRetryStats().pending, before.pending + 1)
    holder.exec('ROLLBACK')
    // 恢复（连续探测成功）时立即重试
    await probeUntilRecovered()
    for (let i = 0; i < 50 && commitRetryStats().pending > before.pending; i++)
      await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(commitRetryStats().pending, before.pending)
    assert.equal(commitRetryStats().recovered, before.recovered + 1)
    assert.equal(calls, 2)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM drill').get().n, 1)
  }),
)

test(
  'a probe skipped because a transaction is open does not count as success',
  withDb(async ({ db, holder }) => {
    armWriteHealth(db)
    holder.exec('BEGIN IMMEDIATE')
    await assert.rejects(dbClient(db).run('INSERT INTO drill VALUES (1)'))
    holder.exec('ROLLBACK')
    assert.equal(databaseWritable(), false)
    // M3 复审 P2-5：事务里调用时没有探测，返回 false，也不推进恢复计数
    for (let i = 0; i < RECOVERY_PROBES + 1; i++)
      await dbClient(db).tx(async () => assert.equal(await probeOnce(), false))
    assert.equal(databaseWritable(), false)
    await probeUntilRecovered()
    assert.equal(databaseWritable(), true)
  }),
)

test(
  'degrade and recover transitions are logged at most once a minute',
  withDb(async ({ db }) => {
    armWriteHealth(db)
    const lines = []
    const { error, warn } = console
    console.error = (line) => lines.push(['error', line])
    console.warn = (line) => lines.push(['warn', line])
    try {
      for (let i = 0; i < 3; i++) {
        noteWriteFailure(db, { errcode: 5, message: 'database is locked' })
        await probeUntilRecovered()
      }
    } finally {
      console.error = error
      console.warn = warn
    }
    assert.equal(writeHealthStats().recoveries, 3)
    assert.equal(lines.filter(([, line]) => /^\[db\] database writes/.test(line)).length, 1)
  }),
)

test('a read-only connection is refused at open; a read-only file owned by the process is repaired before opening', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-write-health-ro-'))
  try {
    const file = path.join(dir, 'kin.db')
    createDatabase({ dataDir: dir }).close()
    const readOnly = new DatabaseSync(file, { readOnly: true })
    try {
      // M3 复审 P2-9：报错写明 -wal / -shm 与所在目录
      assert.throws(() => assertWritableConnection(readOnly, file), /opened read-only.*-wal.*-shm.*directory/s)
    } finally {
      readOnly.close()
    }
    // 文件被改成只读：控制面先改回 0600 再打开，连接可写
    fs.chmodSync(file, 0o444)
    const db = createDatabase({ dataDir: dir })
    try {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600)
      db.exec('CREATE TABLE after_repair (x)')
    } finally {
      db.close()
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
