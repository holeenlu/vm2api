// 数据库运行指标（面板）：经 DbClient 读取（R6 B8，不在主线程同步查库）；PRAGMA 与小查询排在打开的事务之后。
import fs from 'node:fs'
import { dbClient } from './db-client.mjs'

function numberOrNull(value) {
  if (value == null || value === '') return null
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

async function scalar(db, sql) {
  try {
    const row = await dbClient(db).one(sql)
    if (!row || typeof row !== 'object') return null
    return Object.values(row)[0] ?? null
  } catch {
    return null
  }
}

async function probe(db, clock) {
  try {
    const startedAt = clock()
    await dbClient(db).one('SELECT 1 AS ok')
    const elapsed = numberOrNull(clock() - startedAt)
    return {
      ok: true,
      latencyMs: elapsed == null ? null : Math.round(Math.max(elapsed, 0) * 1000) / 1000,
    }
  } catch {
    return { ok: false, latencyMs: null }
  }
}

function fileSize(dbPath, suffix = '') {
  if (typeof dbPath !== 'string' || !dbPath) return null
  try {
    return fs.statSync(`${dbPath}${suffix}`).size
  } catch (error) {
    return error?.code === 'ENOENT' ? 0 : null
  }
}

async function migrationMetrics(db) {
  const count = numberOrNull(await scalar(db, 'SELECT COUNT(*) AS count FROM schema_migrations'))
  let latest = null
  try {
    latest = await dbClient(db).one(
      'SELECT version, applied_at FROM schema_migrations ORDER BY applied_at DESC, version DESC LIMIT 1',
    )
  } catch {}
  return {
    migration_count: count,
    latest_migration: latest?.version == null ? null : String(latest.version),
    latest_migration_at: latest?.applied_at == null ? null : String(latest.applied_at),
  }
}

function pageMetrics(pageSize, pageCount, freelistPages) {
  if (pageCount == null || freelistPages == null) {
    return { used_pages: null, used_bytes: null, free_ratio: null }
  }
  const usedPages = Math.max(pageCount - freelistPages, 0)
  return {
    used_pages: usedPages,
    used_bytes: pageSize == null ? null : usedPages * pageSize,
    free_ratio: pageCount > 0 ? freelistPages / pageCount : null,
  }
}

function safeUsageStats(usageCache) {
  try {
    return typeof usageCache?.stats === 'function' ? usageCache.stats() : null
  } catch {
    return null
  }
}

function sampledAt(now) {
  try {
    return new Date(now()).toISOString()
  } catch {
    return null
  }
}

export async function snapshotDatabaseMetrics({
  db,
  dbPath,
  usageCache,
  now = () => Date.now(),
  clock = () => performance.now(),
}) {
  const health = await probe(db, clock)
  const journalMode = await scalar(db, 'PRAGMA journal_mode')
  const foreignKeys = numberOrNull(await scalar(db, 'PRAGMA foreign_keys'))
  const pageSize = numberOrNull(await scalar(db, 'PRAGMA page_size'))
  const pageCount = numberOrNull(await scalar(db, 'PRAGMA page_count'))
  const freelistPages = numberOrNull(await scalar(db, 'PRAGMA freelist_count'))
  const synchronous = numberOrNull(await scalar(db, 'PRAGMA synchronous'))
  const busyTimeout = numberOrNull(await scalar(db, 'PRAGMA busy_timeout'))
  const migrations = await migrationMetrics(db)

  return {
    sampled_at: sampledAt(now),
    database: {
      ok: health.ok,
      engine: 'sqlite',
      probe_latency_ms: health.latencyMs,
      journal_mode: journalMode == null ? null : String(journalMode).toLowerCase(),
      synchronous,
      foreign_keys: foreignKeys == null ? null : foreignKeys !== 0,
      busy_timeout_ms: busyTimeout,
      file_size_bytes: fileSize(dbPath),
      wal_size_bytes: fileSize(dbPath, '-wal'),
      shm_size_bytes: fileSize(dbPath, '-shm'),
      page_size_bytes: pageSize,
      page_count: pageCount,
      freelist_pages: freelistPages,
      ...pageMetrics(pageSize, pageCount, freelistPages),
      ...migrations,
    },
    usage_cache: safeUsageStats(usageCache),
  }
}
