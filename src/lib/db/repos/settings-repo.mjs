/**
 * settings repository — key → JSON value store.
 * Used for: legacy_import_done, backup_schedule, proxy_pool_config, active_vm …
 */

import { getDb } from '../database.mjs'
import { dbClient, transactionOutcome } from '../db-client.mjs'

/*
 * 热路径只读快照（数据访问分层 R6 B1）：每个数据库连接把 settings 整表（原始 JSON 文本）载入内存，get/has 不再查库。
 * - 连接打开时（createDatabase，迁移之后）同步载入一次（primeSettingsSnapshot）；不经 createDatabase 打开的连接
 *   （测试夹具）在第一次构造仓储时载入。这是本文件唯一的同步读取，属打开连接的步骤（守卫测试豁免清单），运行期不再同步查库。
 * - 经本仓储的 set/remove 更新快照。事务内的写入先记在该键的待定列表里（按事务句柄），事务内与事务进行中读到的是
 *   最新一条未回滚的写入（单连接上事务外的语句也看得到未提交的数据，与原来的“读穿透”一致）；事务提交后并入快照，
 *   回滚后丢弃（DbClient transactionOutcome 判定，含 SAVEPOINT 回滚）。读取时与下一轮事件循环各结算一次。
 * - 其他连接（脚本、其他进程）的写入：每秒经 DbClient 检查 PRAGMA data_version，变化时整表重载（异步，排在打开的事务之后）。
 * - 每次 get 重新 JSON.parse，调用方改返回的对象不会影响快照。
 *
 * 写入与其余读取经 DbClient 异步执行（R6 B6b）：set/remove/all/getConfigRevision/advanceConfigRevision 返回 Promise；
 * get/has 仍同步读内存快照。同步出口 setSync / removeSync 已在 R6 B8 删除。
 */
const SET_SQL = `
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `
const DELETE_SQL = 'DELETE FROM settings WHERE key = ?'
const ALL_SQL = 'SELECT key, value, updated_at FROM settings ORDER BY key'
const LOAD_ALL_SQL = 'SELECT key, value FROM settings'
const DATA_VERSION_SQL = 'PRAGMA data_version'
const CONFIG_REVISION_SQL = 'SELECT revision FROM runtime_config WHERE id = 1'
const ADVANCE_CONFIG_REVISION_SQL =
  'UPDATE runtime_config SET revision = revision + 1, updated_at = ? WHERE id = 1 AND revision = ?'
const snapshots = new WeakMap()
const WATCH_INTERVAL_MS = 1000

const toMap = (rows) => new Map(rows.map((row) => [row.key, row.value]))

/**
 * 连接打开时同步载入 settings 快照（createDatabase 在迁移之后调用；已载入时不重复）。表不存在（只跑了部分迁移的夹具）时
 * 不载入，第一次构造仓储时再试。
 */
export function primeSettingsSnapshot(db) {
  if (snapshots.has(db)) return snapshots.get(db)
  let values
  try {
    values = toMap(db.prepare(LOAD_ALL_SQL).all())
  } catch (error) {
    if (/no such table/.test(String(error?.message))) return null
    throw error
  }
  let version = null
  try {
    version = db.prepare(DATA_VERSION_SQL).get()?.data_version
  } catch {}
  const snap = { values, pending: new Map(), settling: false, version, timer: null, watching: false }
  snapshots.set(db, snap)
  snap.timer = setInterval(() => void watch(db, snap), WATCH_INTERVAL_MS)
  snap.timer.unref?.()
  return snap
}

async function watch(db, snap) {
  if (snap.watching) return
  snap.watching = true
  try {
    const client = dbClient(db)
    const version = (await client.one(DATA_VERSION_SQL))?.data_version
    if (version !== snap.version) {
      const rows = await client.many(LOAD_ALL_SQL)
      snap.version = version
      snap.values = toMap(rows)
    }
  } catch {
    // 连接已关闭：停止检查，快照随连接对象一起回收
    clearInterval(snap.timer)
    snapshots.delete(db)
  } finally {
    snap.watching = false
  }
}

function snapshotOf(db) {
  const snap = snapshots.get(db) || primeSettingsSnapshot(db)
  if (!snap) throw new Error('settings table is missing')
  return snap
}

// 结算一个键的待定写入：丢弃已回滚的；最近一条已提交的并入快照（更早的被它覆盖）；剩下的都还在进行中
function settleKey(snap, key) {
  const list = snap.pending.get(key)
  if (!list) return
  let committed = -1
  for (let i = list.length - 1; i >= 0; i--) {
    const outcome = transactionOutcome(list[i].tx)
    if (outcome === 'rolledback') list.splice(i, 1)
    else if (outcome === 'committed' && committed < 0) committed = i
  }
  if (committed >= 0) {
    const raw = list[committed].raw
    if (raw === undefined) snap.values.delete(key)
    else snap.values.set(key, raw)
    list.splice(0, committed + 1)
  }
  if (!list.length) snap.pending.delete(key)
}

function settleLater(snap) {
  if (snap.settling) return
  snap.settling = true
  setImmediate(() => {
    snap.settling = false
    for (const key of [...snap.pending.keys()]) settleKey(snap, key)
    // 事务仍未结束（理论上不会：事务不跨事件循环）：下一轮再结算
    if (snap.pending.size) settleLater(snap)
  })
}

/** 重新载入快照（测试或绕过本仓储直接写 settings 表之后调用）。 */
export async function refreshSettingsSnapshot(db = getDb()) {
  const snap = snapshots.get(db)
  if (snap) {
    snap.values = toMap(await dbClient(db).many(LOAD_ALL_SQL))
    snap.pending.clear()
  }
}

export class SettingsRepo {
  constructor(db = getDb()) {
    this.db = db
    this.client = dbClient(db)
    this._snap = snapshotOf(db)
  }

  _raw(key) {
    settleKey(this._snap, key)
    const list = this._snap.pending.get(key)
    return list ? list.at(-1).raw : this._snap.values.get(key)
  }

  _written(key, value) {
    const tx = this.client.transaction()
    if (tx) {
      const list = this._snap.pending.get(key) || []
      list.push({ tx, raw: value })
      this._snap.pending.set(key, list)
      settleLater(this._snap)
    } else {
      // 先并入该键已结束事务里的写入，再记这次事务外写入：否则下一次读取会用更早提交的值覆盖它（B8 复审 P2-3）
      settleKey(this._snap, key)
      if (value === undefined) this._snap.values.delete(key)
      else this._snap.values.set(key, value)
    }
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

  async set(key, value) {
    const json = JSON.stringify(value)
    await this.client.run(SET_SQL, key, json, new Date().toISOString())
    this._written(key, json)
    return value
  }

  has(key) {
    return this._raw(key) !== undefined
  }

  async remove(key) {
    await this.client.run(DELETE_SQL, key)
    this._written(key, undefined)
  }

  async all() {
    const out = {}
    for (const row of await this.client.many(ALL_SQL)) {
      try {
        out[row.key] = JSON.parse(row.value)
      } catch {
        out[row.key] = null
      }
    }
    return out
  }

  async getConfigRevision(fallback = 1) {
    try {
      const row = await this.client.one(CONFIG_REVISION_SQL)
      const revision = Number(row?.revision)
      return Number.isSafeInteger(revision) && revision > 0 ? revision : fallback
    } catch {
      return fallback
    }
  }

  /** Atomically advance the routing revision; null means the expected value was stale. */
  async advanceConfigRevision(expectedRevision) {
    const expected = Number(expectedRevision)
    if (!Number.isSafeInteger(expected) || expected < 1) return null
    try {
      const result = await this.client.run(ADVANCE_CONFIG_REVISION_SQL, new Date().toISOString(), expected)
      return Number(result?.changes) === 1 ? expected + 1 : null
    } catch {
      return null
    }
  }
}
