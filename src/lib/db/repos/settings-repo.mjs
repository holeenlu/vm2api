/**
 * settings repository — key → JSON value store.
 * Used for: legacy_import_done, backup_schedule, proxy_pool_config, active_vm …
 */

import { getDb } from '../database.mjs'

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
  }

  get(key, fallback = null) {
    const row = this._get.get(key)
    if (!row) return fallback
    try {
      return JSON.parse(row.value)
    } catch {
      return fallback
    }
  }

  set(key, value) {
    this._set.run(key, JSON.stringify(value), new Date().toISOString())
    return value
  }

  has(key) {
    return !!this._get.get(key)
  }

  remove(key) {
    this._del.run(key)
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
