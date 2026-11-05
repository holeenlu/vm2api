/**
 * settings repository — key → JSON value store.
 * Used for: legacy_import_done, backup_schedule, proxy_pool_config, active_vm …
 */

import { getDb } from '../database.mjs'

/*
 * 热路径只读快照（数据访问分层 R6 B1）：每个数据库连接把 settings 整表（原始 JSON 文本）载入内存，get/has 不再查库。
 * - 经本仓储的 set/remove 同步更新快照；事务内的写入先把该键标为“读穿透”（直接查库，能看到事务内的值与回滚后的值），
 *   下一轮事件循环再从库里重读，提交或回滚都精确。
 * - 其他连接（脚本、其他进程）的写入：每秒检查 PRAGMA data_version，变化时整表重载。
 * - 每次 get 重新 JSON.parse，调用方改返回的对象不会影响快照。
 */
const snapshots = new WeakMap()
const WATCH_INTERVAL_MS = 1000

function loadAll(db) {
  return new Map(
    db
      .prepare('SELECT key, value FROM settings')
      .all()
      .map((row) => [row.key, row.value]),
  )
}

function snapshotOf(db) {
  let snap = snapshots.get(db)
  if (snap) return snap
  snap = { values: loadAll(db), dirty: new Set(), settling: false, version: dataVersion(db), timer: null }
  snapshots.set(db, snap)
  snap.timer = setInterval(() => {
    try {
      const version = dataVersion(db)
      if (version !== snap.version) {
        snap.version = version
        snap.values = loadAll(db)
      }
    } catch {
      // 连接已关闭：停止检查，快照随连接对象一起回收
      clearInterval(snap.timer)
      snapshots.delete(db)
    }
  }, WATCH_INTERVAL_MS)
  snap.timer.unref?.()
  return snap
}

function dataVersion(db) {
  return db.prepare('PRAGMA data_version').get()?.data_version
}

function settleLater(db, snap) {
  if (snap.settling) return
  snap.settling = true
  setImmediate(() => {
    snap.settling = false
    try {
      for (const key of snap.dirty) {
        const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key)
        if (row) snap.values.set(key, row.value)
        else snap.values.delete(key)
      }
      snap.dirty.clear()
    } catch {}
  })
}

/** 重新载入快照（测试或绕过本仓储直接写 settings 表之后调用）。 */
export function refreshSettingsSnapshot(db = getDb()) {
  const snap = snapshots.get(db)
  if (snap) {
    snap.values = loadAll(db)
    snap.dirty.clear()
  }
}

export class SettingsRepo {
  constructor(db = getDb()) {
    this.db = db
    this._get = db.prepare('SELECT value FROM settings WHERE key = ?')
    this._set = db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `)
    this._del = db.prepare('DELETE FROM settings WHERE key = ?')
    this._all = db.prepare('SELECT key, value, updated_at FROM settings ORDER BY key')
    this._snap = snapshotOf(db)
  }

  _raw(key) {
    if (this._snap.dirty.has(key)) return this._get.get(key)?.value
    return this._snap.values.get(key)
  }

  _written(key, value) {
    if (this.db.isTransaction) {
      this._snap.dirty.add(key)
      settleLater(this.db, this._snap)
    } else if (value === undefined) this._snap.values.delete(key)
    else this._snap.values.set(key, value)
  }

  get(key, fallback = null) {
    const raw = this._raw(key)
    if (raw === undefined) return fallback
    try {
      return JSON.parse(raw)
    } catch {
      return fallback
    }
  }

  set(key, value) {
    const json = JSON.stringify(value)
    this._set.run(key, json, new Date().toISOString())
    this._written(key, json)
    return value
  }

  has(key) {
    return this._raw(key) !== undefined
  }

  remove(key) {
    this._del.run(key)
    this._written(key, undefined)
  }

  all() {
    const out = {}
    for (const row of this._all.all()) {
      try {
        out[row.key] = JSON.parse(row.value)
      } catch {
        out[row.key] = null
      }
    }
    return out
  }

  getConfigRevision(fallback = 1) {
    try {
      const row = this.db.prepare('SELECT revision FROM runtime_config WHERE id = 1').get()
      const revision = Number(row?.revision)
      return Number.isSafeInteger(revision) && revision > 0 ? revision : fallback
    } catch {
      return fallback
    }
  }

  /** Atomically advance the routing revision; null means the expected value was stale. */
  advanceConfigRevision(expectedRevision) {
    const expected = Number(expectedRevision)
    if (!Number.isSafeInteger(expected) || expected < 1) return null
    try {
      const result = this.db
        .prepare('UPDATE runtime_config SET revision = revision + 1, updated_at = ? WHERE id = 1 AND revision = ?')
        .run(new Date().toISOString(), expected)
      return Number(result?.changes) === 1 ? expected + 1 : null
    } catch {
      return null
    }
  }
}
