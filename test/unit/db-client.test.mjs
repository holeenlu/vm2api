import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
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
  assert.equal((await db.one('SELECT COUNT(*) AS n FROM t')).n, 2)
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

// 慢机器上，事务等待的定时器在事件循环到达 check 阶段前就已到期：只有 setImmediate 守卫时，定时器先恢复事务并提交
for (const [label, start] of [
  ['the main turn', (fn) => fn()],
  ['a setImmediate callback', (fn) => setImmediate(fn)],
]) {
  test(`a transaction whose timer is already due when the loop resumes is still rolled back (started in ${label})`, async (t) => {
    const { database, db } = setup(t)
    const spin = (ms) => {
      const end = Date.now() + ms
      while (Date.now() < end);
    }
    const outcome = await new Promise((resolve) =>
      start(() =>
        db
          .tx(async (tx) => {
            await tx.run('INSERT INTO t (v) VALUES (?)', 'before wait')
            const wait = new Promise((r) => setTimeout(r, 5))
            spin(20)
            await wait
            await tx.run('INSERT INTO t (v) VALUES (?)', 'after wait')
          })
          .then(
            () => 'committed',
            (error) => error.code,
          )
          .then(resolve),
      ),
    )
    assert.equal(outcome, 'db_tx_yielded')
    assert.equal(count(database), 0)
    assert.equal(database.isTransaction, false)
  })
}

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

// 同步事务只剩迁移与统计线程的只读事务（R6 B8 起主线程不再有 withTransaction）
test('an async transaction cannot start inside a synchronous one', async (t) => {
  const { database, db } = setup(t)
  database.exec('BEGIN')
  const pending = db.tx(async () => {})
  database.exec('ROLLBACK')
  await assert.rejects(pending, { code: 'db_tx_in_sync_transaction' })
  await db.tx(async (tx) => {
    await tx.run('INSERT INTO t (v) VALUES (?)', 'async')
  })
  assert.equal(count(database), 1)
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

test('statements outside an open transaction wait for it instead of joining it', async (t) => {
  const { database, db } = setup(t)
  const failing = db.tx(async (tx) => {
    await tx.run('INSERT INTO t (v) VALUES (?)', 'inside')
    await tx.one('SELECT 1')
    await tx.one('SELECT 1')
    throw new Error('boom')
  })
  // 同一轮里另一条调用链：不属于上面的事务
  const outsideRead = db.one('SELECT COUNT(*) AS n FROM t')
  const outsideWrite = db.run('INSERT INTO t (v) VALUES (?)', 'outside')
  await assert.rejects(failing, /boom/)
  assert.equal((await outsideRead).n, 0) // 没读到对方未提交、随后回滚的行
  assert.equal((await outsideWrite).changes, 1)
  assert.deepEqual(
    database
      .prepare('SELECT v FROM t')
      .all()
      .map((row) => row.v),
    ['outside'], // 没有随对方事务一起回滚
  )
})

test('statements inside the transaction do not wait for it', async (t) => {
  const { database, db } = setup(t)
  await db.tx(async (tx) => {
    await tx.run('INSERT INTO t (v) VALUES (?)', 'a')
    // 事务内经共享客户端发出的语句属于本事务，直接执行
    await db.run('INSERT INTO t (v) VALUES (?)', 'b')
    assert.equal((await db.one('SELECT COUNT(*) AS n FROM t')).n, 2)
  })
  assert.equal(count(database), 2)
})

test('a background write started inside a finished transaction does not join a later transaction', async (t) => {
  const { database, db } = setup(t)
  let release
  const gate = new Promise((resolve) => (release = resolve))
  let background
  await db.tx(async (tx) => {
    await tx.run('INSERT INTO t (v) VALUES (?)', 'first')
    // 事务体里发起、不等待的后台写入：第二条语句在提交之后才执行（R6 B7b）
    background = (async () => {
      await gate
      await db.run('INSERT INTO t (v) VALUES (?)', 'background')
    })()
  })
  const failing = db.tx(async (tx) => {
    await tx.run('INSERT INTO t (v) VALUES (?)', 'rolled-back')
    release()
    await tx.one('SELECT 1')
    await tx.one('SELECT 1')
    throw new Error('boom')
  })
  await assert.rejects(failing, /boom/)
  await background
  assert.deepEqual(
    database
      .prepare('SELECT v FROM t ORDER BY id')
      .all()
      .map((row) => row.v),
    ['first', 'background'], // 后台写入等对方事务结束再执行，没有随它回滚
  )
  assert.equal(db.inTransaction(), false)
})

test('a statement waiting for one transaction does not join the next queued one (R6 B7 review P1)', async (t) => {
  const { database, db } = setup(t)
  const a = db.tx(async (tx) => {
    await tx.run('INSERT INTO t (v) VALUES (?)', 'a')
  })
  const x = db.run('INSERT INTO t (v) VALUES (?)', 'x')
  const y = db
    .tx(async (tx) => {
      await tx.run('INSERT INTO t (v) VALUES (?)', 'y')
      await tx.one('SELECT 1')
      await tx.one('SELECT 1')
      throw new Error('y fails')
    })
    .catch(() => 'rolled back')
  assert.equal((await x).changes, 1)
  await a
  assert.equal(await y, 'rolled back')
  assert.deepEqual(
    database
      .prepare('SELECT v FROM t ORDER BY id')
      .all()
      .map((row) => row.v),
    ['a', 'x'],
  )
})

test('a transaction rolled back by the yield guard releases the connection at once (R6 review P1-1)', async (t) => {
  const { database, db } = setup(t)
  let release
  const pending = db.tx(async (tx) => {
    await tx.run('INSERT INTO t (v) VALUES (?)', 'rolled back')
    await new Promise((resolve) => {
      release = resolve
    })
    await tx.run('INSERT INTO t (v) VALUES (?)', 'never')
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
  // 事务体仍在等待，但守卫已回滚：其他调用链的语句与新事务不再排队
  const started = Date.now()
  await db.run('INSERT INTO t (v) VALUES (?)', 'outside')
  await db.tx(async (tx) => tx.run('INSERT INTO t (v) VALUES (?)', 'next tx'))
  assert.ok(Date.now() - started < 200)
  release()
  await assert.rejects(pending, { code: 'db_tx_yielded' })
  assert.deepEqual(
    database
      .prepare('SELECT v FROM t ORDER BY id')
      .all()
      .map((row) => row.v),
    ['outside', 'next tx'],
  )
})

test('a transaction awaiting a statement queued behind it fails instead of hanging (R6 review P1-1)', async (t) => {
  const { db } = setup(t)
  let queued
  const pending = db.tx(async () => {
    queued = db.detached(() => db.one('SELECT 1 AS n'))
    await queued
  })
  await assert.rejects(pending, { code: 'db_tx_yielded' })
  assert.equal((await queued).n, 1)
  assert.equal((await db.one('SELECT 2 AS n')).n, 2)
})
