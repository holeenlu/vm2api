import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createDatabase, pendingMigrations } from '../../src/lib/db/database.mjs'

test('pending migrations are applied only after a verified snapshot of the existing database (audit P1-S7)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-premigrate-'))
  const migrations = path.join(root, 'migrations')
  const dataDir = path.join(root, 'data')
  const autoDir = path.join(dataDir, 'backups', 'auto')
  const snapshots = () =>
    fs.existsSync(autoDir) ? fs.readdirSync(autoDir).filter((name) => name.startsWith('kin-pre-migrate-')) : []
  fs.mkdirSync(migrations)
  fs.writeFileSync(path.join(migrations, '001_first.sql'), 'CREATE TABLE first_table (id INTEGER PRIMARY KEY);')
  try {
    // 全新库没有迁移台账：不做快照
    let db = createDatabase({ dataDir, migrationsDir: migrations })
    db.prepare('INSERT INTO first_table (id) VALUES (7)').run()
    assert.deepEqual(pendingMigrations(db, { migrationsDir: migrations }), [])
    db.close()
    assert.deepEqual(snapshots(), [])

    // 有待执行迁移：先快照（含迁移前数据），再迁移
    fs.writeFileSync(path.join(migrations, '002_second.sql'), 'DROP TABLE first_table;')
    db = createDatabase({ dataDir, migrationsDir: migrations })
    assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name = 'first_table'").get().n, 0)
    db.close()
    const [snapshot] = snapshots()
    assert.ok(snapshot, 'snapshot written before migrating')
    const copy = new DatabaseSync(path.join(autoDir, snapshot), { readOnly: true })
    assert.equal(copy.prepare('SELECT id FROM first_table').get().id, 7)
    assert.equal(copy.prepare("SELECT COUNT(*) n FROM schema_migrations WHERE name = '002_second.sql'").get().n, 0)
    copy.close()

    // 没有新迁移：不再快照
    createDatabase({ dataDir, migrationsDir: migrations }).close()
    assert.equal(snapshots().length, 1)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
