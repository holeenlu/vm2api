import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { snapshotDatabaseMetrics } from '../../src/lib/db/database-metrics.mjs'

function fakeDb(values = {}, failures = new Set()) {
  const statements = []
  return {
    statements,
    prepare(sql) {
      statements.push(sql)
      if (failures.has(sql)) throw new Error('read failed')
      return {
        get() {
          if (failures.has(`${sql}:get`)) throw new Error('read failed')
          if (sql === 'SELECT 1 AS ok') return { ok: 1 }
          if (sql.startsWith('SELECT COUNT(*)')) return { count: values.migration_count ?? 0 }
          if (sql.startsWith('SELECT version')) return values.latest ?? undefined
          return { value: values[sql] }
        },
      }
    },
  }
}

test('snapshot reports the live SQLite/WAL state without exposing its path', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-db-metrics-'))
  const dbPath = path.join(tmp, 'private-name.db')
  const db = createDatabase({ dbPath })
  try {
    const snapshot = await snapshotDatabaseMetrics({
      db,
      dbPath,
      usageCache: { stats: () => ({ requests: 0, hit_rate: null }) },
      now: () => Date.parse('2026-08-31T00:00:00.000Z'),
      clock: (() => {
        const samples = [10, 10.375]
        return () => samples.shift()
      })(),
    })

    assert.equal(snapshot.sampled_at, '2026-08-31T00:00:00.000Z')
    assert.equal(snapshot.database.ok, true)
    assert.equal(snapshot.database.engine, 'sqlite')
    assert.equal(snapshot.database.probe_latency_ms, 0.375)
    assert.equal(snapshot.database.journal_mode, 'wal')
    assert.equal(snapshot.database.synchronous, 1)
    assert.equal(snapshot.database.foreign_keys, true)
    assert.equal(snapshot.database.busy_timeout_ms, 5000)
    assert.ok(snapshot.database.file_size_bytes > 0)
    assert.ok(snapshot.database.page_size_bytes > 0)
    assert.ok(snapshot.database.page_count > 0)
    assert.ok(snapshot.database.migration_count > 0)
    assert.match(snapshot.database.latest_migration, /^\d+$/)
    assert.equal(snapshot.usage_cache.requests, 0)
    assert.equal(JSON.stringify(snapshot).includes(tmp), false)
    assert.equal(JSON.stringify(snapshot).includes('private-name.db'), false)
  } finally {
    db.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('snapshot derives page usage and treats absent database files as real zeroes', async () => {
  const db = fakeDb({
    'PRAGMA journal_mode': 'wal',
    'PRAGMA synchronous': 1,
    'PRAGMA foreign_keys': 1,
    'PRAGMA busy_timeout': 5000,
    'PRAGMA page_size': 4096,
    'PRAGMA page_count': 10,
    'PRAGMA freelist_count': 3,
    migration_count: 2,
    latest: { version: '002', applied_at: '2026-08-30T00:00:00.000Z' },
  })
  const missing = path.join(os.tmpdir(), `missing-kin-${process.pid}-${Date.now()}.db`)
  const snapshot = await snapshotDatabaseMetrics({ db, dbPath: missing, usageCache: null, clock: () => 1 })

  assert.equal(snapshot.database.used_pages, 7)
  assert.equal(snapshot.database.used_bytes, 28_672)
  assert.equal(snapshot.database.free_ratio, 0.3)
  assert.equal(snapshot.database.file_size_bytes, 0)
  assert.equal(snapshot.database.wal_size_bytes, 0)
  assert.equal(snapshot.database.shm_size_bytes, 0)
  assert.equal(snapshot.usage_cache, null)
  assert.ok(db.statements.every((sql) => /^(SELECT 1|SELECT (COUNT|version)|PRAGMA )/.test(sql)))
  assert.ok(db.statements.every((sql) => !/(checkpoint|vacuum|optimize|integrity|quick_check)/i.test(sql)))
})

test('snapshot preserves partial results when the probe or a metric read fails', async () => {
  const db = fakeDb(
    {
      'PRAGMA journal_mode': 'wal',
      'PRAGMA synchronous': 1,
      'PRAGMA foreign_keys': 1,
      'PRAGMA busy_timeout': 5000,
      'PRAGMA page_size': 4096,
      'PRAGMA page_count': 0,
      'PRAGMA freelist_count': 0,
    },
    new Set(['SELECT 1 AS ok', 'PRAGMA synchronous']),
  )
  const snapshot = await snapshotDatabaseMetrics({ db, dbPath: null, usageCache: { stats: () => null } })

  assert.equal(snapshot.database.ok, false)
  assert.equal(snapshot.database.probe_latency_ms, null)
  assert.equal(snapshot.database.journal_mode, 'wal')
  assert.equal(snapshot.database.synchronous, null)
  assert.equal(snapshot.database.page_count, 0)
  assert.equal(snapshot.database.used_pages, 0)
  assert.equal(snapshot.database.used_bytes, 0)
  assert.equal(snapshot.database.free_ratio, null)
  assert.equal(snapshot.database.file_size_bytes, null)
})

test('snapshot returns null for unavailable page inputs and cache stats failures', async () => {
  const db = new DatabaseSync(':memory:')
  try {
    const snapshot = await snapshotDatabaseMetrics({
      db,
      dbPath: null,
      usageCache: {
        stats() {
          throw new Error('cache unavailable')
        },
      },
    })
    assert.equal(snapshot.database.migration_count, null)
    assert.equal(snapshot.database.latest_migration, null)
    assert.equal(snapshot.usage_cache, null)
  } finally {
    db.close()
  }
})
