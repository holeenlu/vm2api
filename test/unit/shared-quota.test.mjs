import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { detectSharedQuota, sharedQuotaPeers } from '../../src/lib/usage/shared-quota.mjs'

const RESET = '2026-11-07T04:00:00.000Z'
const obs = (vm_id, minute, used_percent, reset_at = RESET) => ({
  vm_id,
  used_percent,
  reset_at,
  observed_at: new Date(Date.UTC(2026, 10, 5, 6, 0) + minute * 60e3).toISOString(),
})

test('two slots of one account: same reset and the same rising percent at near-simultaneous readings', async () => {
  // 生产 2026-11-05 的 vm-29 / vm-30：每次相隔几分钟内的读数完全一致，44 → 53
  const rows = [
    obs('vm-29', 14, 44),
    obs('vm-30', 16, 44),
    obs('vm-29', 85, 45),
    obs('vm-30', 91, 45),
    obs('vm-29', 106, 46),
    obs('vm-30', 107, 46),
    obs('vm-29', 128, 47),
    obs('vm-30', 131, 47),
    obs('vm-29', 520, 53),
    obs('vm-30', 520, 53),
  ]
  const peers = detectSharedQuota(rows)
  assert.deepEqual(peers.get('vm-29'), ['vm-30'])
  assert.deepEqual(peers.get('vm-30'), ['vm-29'])
})

test('independent accounts are not linked', async () => {
  // 同一小时开窗（重置时间相同）但用量各走各的
  const differentPercent = [
    obs('a', 0, 10),
    obs('b', 2, 30),
    obs('a', 60, 12),
    obs('b', 61, 33),
    obs('a', 120, 15),
    obs('b', 121, 35),
    obs('a', 180, 18),
    obs('b', 181, 38),
  ]
  assert.equal(detectSharedQuota(differentPercent).size, 0)
  // 都停在同一个值不变：没有变化就不能当证据
  const flat = [obs('a', 0, 0), obs('b', 1, 0), obs('a', 60, 0), obs('b', 61, 0), obs('a', 120, 0), obs('b', 121, 0)]
  assert.equal(detectSharedQuota(flat).size, 0)
  // 读数相同但重置时间不同
  const otherReset = [
    obs('a', 0, 20),
    obs('b', 1, 20, '2026-11-08T04:00:00.000Z'),
    obs('a', 60, 21),
    obs('b', 61, 21, '2026-11-08T04:00:00.000Z'),
    obs('a', 120, 22),
    obs('b', 121, 22, '2026-11-08T04:00:00.000Z'),
  ]
  assert.equal(detectSharedQuota(otherReset).size, 0)
  // 读数相隔太远，不能配对
  const farApart = [
    obs('a', 0, 20),
    obs('b', 30, 20),
    obs('a', 120, 21),
    obs('b', 150, 21),
    obs('a', 240, 22),
    obs('b', 270, 22),
  ]
  assert.equal(detectSharedQuota(farApart).size, 0)
  // 偶有一致、但也有明显不一致的读数
  const mixed = [
    obs('a', 0, 20),
    obs('b', 1, 20),
    obs('a', 60, 21),
    obs('b', 61, 21),
    obs('a', 120, 22),
    obs('b', 121, 22),
    obs('a', 180, 30),
    obs('b', 181, 24),
  ]
  assert.equal(detectSharedQuota(mixed).size, 0)
})

test('sharedQuotaPeers reads quota_observations and tolerates a missing table', async () => {
  const db = new DatabaseSync(':memory:')
  assert.equal((await sharedQuotaPeers(db)).size, 0)
  db.exec(
    'CREATE TABLE quota_observations(id INTEGER PRIMARY KEY, vm_id TEXT, quota_window TEXT, used_percent REAL, reset_at TEXT, window_seconds INTEGER, observed_at TEXT)',
  )
  const now = Date.now()
  const insert = db.prepare(
    'INSERT INTO quota_observations(vm_id, quota_window, used_percent, reset_at, window_seconds, observed_at) VALUES(?,?,?,?,?,?)',
  )
  for (const [i, pct] of [10, 11, 12].entries()) {
    const at = now - (3 - i) * 3600e3
    insert.run('vm-1', '7d', pct, RESET, 604800, new Date(at).toISOString())
    insert.run('vm-2', '7d', pct, RESET, 604800, new Date(at + 60e3).toISOString())
    insert.run('vm-3', '5h', pct, RESET, 18000, new Date(at).toISOString())
  }
  const fresh = new DatabaseSync(':memory:')
  fresh.exec(
    'CREATE TABLE quota_observations(id INTEGER PRIMARY KEY, vm_id TEXT, quota_window TEXT, used_percent REAL, reset_at TEXT, window_seconds INTEGER, observed_at TEXT)',
  )
  for (const row of db.prepare('SELECT * FROM quota_observations').all())
    fresh
      .prepare(
        'INSERT INTO quota_observations(vm_id, quota_window, used_percent, reset_at, window_seconds, observed_at) VALUES(?,?,?,?,?,?)',
      )
      .run(row.vm_id, row.quota_window, row.used_percent, row.reset_at, row.window_seconds, row.observed_at)
  const peers = await sharedQuotaPeers(fresh, now)
  assert.deepEqual(peers.get('vm-1'), ['vm-2'])
  assert.equal(peers.has('vm-3'), false)
})
