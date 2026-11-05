import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createDatabase, withTransaction } from '../../src/lib/db/database.mjs'
import { SettingsRepo, refreshSettingsSnapshot } from '../../src/lib/db/repos/settings-repo.mjs'

// 数据访问分层 R6 B1：settings 读快照，不再每次查库；写入、事务回滚、其他连接的修改都能及时反映

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-snapshot-'))
  const dbPath = path.join(dir, 'kin.db')
  const db = createDatabase({ dbPath })
  t.after(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return { db, dbPath }
}

function countQueries(db) {
  let reads = 0
  const prepare = db.prepare.bind(db)
  db.prepare = (sql) => {
    const statement = prepare(sql)
    if (/FROM settings WHERE key/.test(sql)) {
      const get = statement.get.bind(statement)
      statement.get = (...args) => {
        reads++
        return get(...args)
      }
    }
    return statement
  }
  return () => reads
}

test('reads come from the snapshot and follow this repository’s writes', (t) => {
  const { db } = setup(t)
  const repo = new SettingsRepo(db)
  repo.set('feature', { on: true })
  const reads = countQueries(db)
  const again = new SettingsRepo(db)
  for (let i = 0; i < 50; i++) assert.deepEqual(again.get('feature'), { on: true })
  assert.equal(reads(), 0)
  again.set('feature', { on: false })
  assert.deepEqual(repo.get('feature'), { on: false })
  repo.remove('feature')
  assert.equal(again.has('feature'), false)
  assert.equal(again.get('feature', 'fallback'), 'fallback')
})

test('callers cannot change the snapshot through a returned object', (t) => {
  const { db } = setup(t)
  const repo = new SettingsRepo(db)
  repo.set('policy', { models: ['a'] })
  repo.get('policy').models.push('b')
  assert.deepEqual(repo.get('policy'), { models: ['a'] })
})

test('writes inside a transaction are exact after commit and after rollback', async (t) => {
  const { db } = setup(t)
  const repo = new SettingsRepo(db)
  repo.set('k', 1)
  withTransaction(db, () => {
    repo.set('k', 2)
    assert.equal(repo.get('k'), 2, 'reads inside the transaction see its own write')
  })
  assert.equal(repo.get('k'), 2)
  assert.throws(() =>
    withTransaction(db, () => {
      repo.set('k', 3)
      repo.set('added', true)
      throw new Error('rollback')
    }),
  )
  assert.equal(repo.get('k'), 2, 'a rolled back write is not visible')
  assert.equal(repo.has('added'), false)
  await new Promise((resolve) => setImmediate(resolve))
  const reads = countQueries(db)
  assert.equal(repo.get('k'), 2)
  assert.equal(reads(), 0, 'after settling, reads come from the snapshot again')
})

test('changes from another connection are picked up within about a second', async (t) => {
  const { db, dbPath } = setup(t)
  const repo = new SettingsRepo(db)
  repo.set('remote', 'old')
  const other = new DatabaseSync(dbPath)
  other.prepare('UPDATE settings SET value = ? WHERE key = ?').run(JSON.stringify('new'), 'remote')
  other.close()
  await new Promise((resolve) => setTimeout(resolve, 1300))
  assert.equal(repo.get('remote'), 'new')
})

test('refreshSettingsSnapshot reloads after direct writes on the same connection', (t) => {
  const { db } = setup(t)
  const repo = new SettingsRepo(db)
  db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('direct', '7', 'x')").run()
  refreshSettingsSnapshot(db)
  assert.equal(repo.get('direct'), 7)
})
