import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase, withTransaction } from '../../src/lib/db/database.mjs'
import { DB_CLIENT_STATEMENT_CACHE_SIZE, createDbClient, dbClient } from '../../src/lib/db/db-client.mjs'

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-client-'))
  const database = createDatabase({ dbPath: path.join(dir, 'kin.db') })
  database.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
  t.after(() => {
    database.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return { database, db: createDbClient(database, { log: { warn() {} } }) }
}

const count = (database) => database.prepare('SELECT COUNT(*) AS n FROM t').get().n

test('reads and writes resolve with the statement results', async (t) => {
  const { db } = setup(t)
  assert.deepEqual(await db.run('INSERT INTO t (v) VALUES (?)', 'a'), { changes: 1, lastInsertRowid: 1 })
  await db.run('INSERT INTO t (v) VALUES (?)', 'b')
  assert.equal((await db.one('SELECT v FROM t WHERE id = ?', 2)).v, 'b')
  assert.deepEqual(
    (await db.many('SELECT v FROM t ORDER BY id')).map((row) => row.v),
    ['a', 'b'],
  )
  assert.equal(await db.one('SELECT v FROM t WHERE id = ?', 99), undefined)
  assert.equal(db.oneSync('SELECT COUNT(*) AS n FROM t').n, 2)
})

test('a transaction commits, and rolls back when its body throws', async (t) => {
  const { database, db } = setup(t)
  const out = await db.tx(async (tx) => {
    await tx.run('INSERT INTO t (v) VALUES (?)', 'kept')
    return 'ok'
  })
  assert.equal(out, 'ok')
  await assert.rejects(
    db.tx(async (tx) => {
      await tx.run('INSERT INTO t (v) VALUES (?)', 'dropped')
      throw new Error('boom')
    }),
    /boom/,
  )
  assert.equal(count(database), 1)
  assert.equal(database.isTransaction, false)
})

test('nested transactions are savepoints', async (t) => {
  const { database, db } = setup(t)
  await db.tx(async (tx) => {
    await tx.run('INSERT INTO t (v) VALUES (?)', 'outer')
    await assert.rejects(
      tx.tx(async (inner) => {
        await inner.run('INSERT INTO t (v) VALUES (?)', 'inner')
        throw new Error('inner failed')
      }),
      /inner failed/,
    )
    await tx.tx(async (inner) => inner.run('INSERT INTO t (v) VALUES (?)', 'inner ok'))
  })
  assert.deepEqual(
    database
      .prepare('SELECT v FROM t ORDER BY id')
      .all()
      .map((row) => row.v),
    ['outer', 'inner ok'],
  )
})

test('statements from another client on the same database join the open transaction', async (t) => {
  const { database, db } = setup(t)
  const other = createDbClient(database)
  await assert.rejects(
    db.tx(async () => {
      await other.run('INSERT INTO t (v) VALUES (?)', 'via other')
      assert.equal(other.inTransaction(), true)
      throw new Error('rollback')
    }),
    /rollback/,
  )
  assert.equal(count(database), 0)
})

test('a transaction that waits for real I/O is rolled back and cannot commit', async (t) => {
  const { database, db } = setup(t)
  await assert.rejects(
    db.tx(async (tx) => {
      await tx.run('INSERT INTO t (v) VALUES (?)', 'before wait')
      await new Promise((resolve) => setTimeout(resolve, 5))
      await tx.run('INSERT INTO t (v) VALUES (?)', 'after wait')
    }),
    { code: 'db_tx_yielded' },
  )
  assert.equal(count(database), 0)
  assert.equal(database.isTransaction, false)
  // 之后的事务照常工作
  await db.tx(async (tx) => tx.run('INSERT INTO t (v) VALUES (?)', 'next'))
  assert.equal(count(database), 1)
})

test('transactions opened in the same tick run one after another', async (t) => {
  const { database, db } = setup(t)
  const order = []
  await Promise.all([
    db.tx(async (tx) => {
      order.push('a:start')
      await tx.run('INSERT INTO t (v) VALUES (?)', 'a')
      await tx.run('INSERT INTO t (v) VALUES (?)', 'a2')
      order.push('a:end')
    }),
    db.tx(async (tx) => {
      order.push('b:start')
      await tx.run('INSERT INTO t (v) VALUES (?)', 'b')
      order.push('b:end')
    }),
  ])
  assert.deepEqual(order, ['a:start', 'a:end', 'b:start', 'b:end'])
  assert.equal(count(database), 3)
})

test('a transaction waiting behind one that yielded starts after it is rolled back', async (t) => {
  const { database, db } = setup(t)
  let release
  const first = db.tx(async (tx) => {
    await tx.run('INSERT INTO t (v) VALUES (?)', 'first')
    await new Promise((resolve) => {
      release = resolve
    })
  })
  await new Promise((resolve) => setImmediate(resolve))
  const second = db.tx(async (tx) => tx.run('INSERT INTO t (v) VALUES (?)', 'second'))
  release()
  await assert.rejects(first, { code: 'db_tx_yielded' })
  await second
  assert.deepEqual(
    database
      .prepare('SELECT v FROM t')
      .all()
      .map((row) => row.v),
    ['second'],
  )
})

test('an async transaction cannot start inside a synchronous one; the reverse nests', async (t) => {
  const { database, db } = setup(t)
  let pending
  withTransaction(database, () => {
    pending = db.tx(async () => {})
  })
  await assert.rejects(pending, { code: 'db_tx_in_sync_transaction' })
  await db.tx(async (tx) => {
    withTransaction(database, () => database.prepare('INSERT INTO t (v) VALUES (?)').run('sync inside'))
    await tx.run('INSERT INTO t (v) VALUES (?)', 'async')
  })
  assert.equal(count(database), 2)
})

test('dbClient reuses one client per database', (t) => {
  const { database } = setup(t)
  assert.equal(dbClient(database), dbClient(database))
})

test('the statement cache keeps the most recently used statements up to its limit', async (t) => {
  const { database, db } = setup(t)
  let prepared = 0
  const prepare = database.prepare.bind(database)
  database.prepare = (sql) => {
    prepared += 1
    return prepare(sql)
  }
  t.after(() => {
    database.prepare = prepare
  })
  const sql = (n) => `SELECT ${n} AS n`
  await db.one(sql(0))
  for (let n = 1; n < DB_CLIENT_STATEMENT_CACHE_SIZE; n += 1) await db.one(sql(n))
  await db.one(sql(0)) // 0 最近使用，保留
  await db.one(sql(DB_CLIENT_STATEMENT_CACHE_SIZE)) // 淘汰最久未用的 1
  const before = prepared
  assert.equal((await db.one(sql(0))).n, 0)
  assert.equal(prepared, before)
  assert.equal((await db.one(sql(1))).n, 1)
  assert.equal(prepared, before + 1)
})
