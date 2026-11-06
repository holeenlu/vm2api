/**
 * Permanent ban of an inbound client device_id after a refusal-guard hit.
 * Empty ids are never stored. This is not the slot's outbound device.
 */
import { getDb } from '../database.mjs'
import { dbClient } from '../db-client.mjs'

function rowToRec(row) {
  if (!row) return null
  return {
    device_id: row.device_id,
    first_seen_at: row.first_seen_at,
    last_seen_at: row.last_seen_at,
    hit_count: Number(row.hit_count) || 0,
    source_request_id: row.source_request_id,
    fingerprint: row.fingerprint,
    reason: row.reason,
  }
}

// 管理面读写（list/count/remove/clear）经 DbClient 异步执行（R6 B6b）；推理热路径的 get/block/hit 仍同步（B7）
const LIST_SQL = 'SELECT * FROM refusal_device_blocks ORDER BY last_seen_at DESC, device_id LIMIT ?'
const COUNT_SQL = 'SELECT COUNT(*) AS n FROM refusal_device_blocks'
const REMOVE_SQL = 'DELETE FROM refusal_device_blocks WHERE device_id = ?'
const CLEAR_SQL = 'DELETE FROM refusal_device_blocks'

export class RefusalDeviceBlocksRepo {
  constructor(db = getDb()) {
    this.db = db
    this.client = dbClient(db)
    this._get = db.prepare('SELECT * FROM refusal_device_blocks WHERE device_id = ?')
    this._insert = db.prepare(`
      INSERT INTO refusal_device_blocks (
        device_id, first_seen_at, last_seen_at, hit_count,
        source_request_id, fingerprint, reason
      ) VALUES (?, ?, ?, 0, ?, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET
        last_seen_at = excluded.last_seen_at,
        source_request_id = COALESCE(refusal_device_blocks.source_request_id, excluded.source_request_id),
        fingerprint = COALESCE(refusal_device_blocks.fingerprint, excluded.fingerprint),
        reason = COALESCE(refusal_device_blocks.reason, excluded.reason)
    `)
    this._hit = db.prepare(`
      UPDATE refusal_device_blocks SET hit_count = hit_count + 1, last_seen_at = ?
      WHERE device_id = ?
    `)
  }

  get(deviceId) {
    const id = String(deviceId || '').trim()
    if (!id) return null
    return rowToRec(this._get.get(id))
  }

  block({ deviceId, requestId = null, fingerprint = null, reason = 'refusal_guard' } = {}) {
    const id = String(deviceId || '').trim()
    if (!id) return null
    const now = new Date().toISOString()
    this._insert.run(id, now, now, requestId, fingerprint, reason ? String(reason).slice(0, 80) : null)
    return this.get(id)
  }

  hit(deviceId) {
    const id = String(deviceId || '').trim()
    if (!id) return null
    this._hit.run(new Date().toISOString(), id)
    return this.get(id)
  }

  async list(limit = 200) {
    const n = Math.min(500, Math.max(1, Number(limit) || 200))
    return (await this.client.many(LIST_SQL, n)).map(rowToRec)
  }

  async count() {
    return Number((await this.client.one(COUNT_SQL))?.n) || 0
  }

  async remove(deviceId) {
    const id = String(deviceId || '').trim()
    if (!id) return false
    return (await this.client.run(REMOVE_SQL, id)).changes > 0
  }

  async clear() {
    return (await this.client.run(CLEAR_SQL)).changes
  }
}
