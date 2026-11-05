import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { STATS_DIMENSIONS, STATS_RANGES, StatisticsRepo } from '../../src/lib/db/repos/statistics-repo.mjs'
import { RollupStatisticsRepo, splitWindow, statsSource } from '../../src/lib/db/repos/usage-stats-rollup.mjs'

// 数据访问分层 R5：统计页读汇总表的结果必须与直接扫 usage_logs 逐项一致（费用为浮点和，按 1e-6 比较）。

const NOW = Date.parse('2026-11-05T09:37:21.512Z')

function rng(seed) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-stats-rollup-'))
  const db = createDatabase({ dbPath: path.join(dir, 'kin.db') })
  t.after(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  // 随机样本里有不存在的分组、空字符串的用户等，关闭外键只为构造数据
  db.exec('PRAGMA foreign_keys=OFF')
  db.exec(`
    INSERT INTO users (id, email, username, password_hash, role, admin_domain_id) VALUES
      ('admin1','ad@x','admin1','x','admin',NULL),
      ('u1','a@x','alice','x','user','admin1'),
      ('u2','b@x','bob','x','user','admin1'),
      ('u3','c@x','carol','x','user',NULL);
    INSERT INTO api_keys (id, name, key, user_id, created_by_user_id) VALUES
      ('k1','alice-key','sk-1','u1','admin1'), ('k2','bob-key','sk-2','u2','admin1'), ('k3','carol-key','sk-3','u3',NULL);
  `)
  return db
}

const pick = (random, values) => values[Math.floor(random() * values.length)]

function seed(db, count, seedValue) {
  const random = rng(seedValue)
  const insert = db.prepare(`INSERT INTO usage_logs
    (id, request_id, created_at, user_id, api_key_id, model, vm_id, billing_group_id, path, status, error_code,
     input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, actual_cost, duration_ms, first_token_ms)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  for (let i = 0; i < count; i++) {
    // 覆盖 30 天，含整点、半点与毫秒边界
    const at = NOW - Math.floor(random() * 40 * 86_400_000)
    insert.run(
      `log_${seedValue}_${i}`,
      `req_${seedValue}_${i}`,
      new Date(at).toISOString(),
      pick(random, ['u1', 'u2', 'u3', null, '']),
      pick(random, ['k1', 'k2', 'k3', null]),
      pick(random, ['claude-sonnet-4', 'gpt-5.5', '', null]),
      pick(random, ['vm-01', 'vm-02', null]),
      pick(random, [1, 2, null]),
      pick(random, ['/v1/messages', '/v1/responses', null]),
      pick(random, [200, 200, 200, 400, 429, 500, null]),
      pick(random, [null, null, '', 'client_disconnected', 'upstream_error', 'rate_limited']),
      pick(random, [0, 10, 1234, null]),
      pick(random, [0, 5, 777, null]),
      pick(random, [0, 100, null]),
      pick(random, [0, 50, null]),
      // 费用取连续值：固定的几个取值会让两个系列的费用恰好相等，浮点求和顺序不同时排名先后会互换
      random() < 0.2 ? null : Math.round(random() * 3_000_000) / 1_000_000,
      pick(random, [null, 120, 3400]),
      pick(random, [null, 80, 900]),
    )
  }
}

function round(value) {
  if (typeof value === 'number') return Math.round(value * 1e6) / 1e6
  if (Array.isArray(value)) return value.map(round)
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, round(v)]))
  return value
}

const OWNERS = [
  null,
  'u1',
  { type: 'panel_key_creator', creatorId: 'admin1' },
  { type: 'panel_admin_scope', adminId: 'admin1', scopeRootId: 'admin1' },
  { type: 'panel_users', scopeRootId: 'admin1' },
  { type: 'panel_users', scopeRootId: 'admin1', userId: 'u2' },
]

function assertSame(db, label) {
  const raw = new StatisticsRepo(db)
  const rollup = new RollupStatisticsRepo(db)
  for (const range of STATS_RANGES)
    for (const owner of OWNERS) {
      for (const dimension of STATS_DIMENSIONS) {
        const args = { range, dimension, owner_user_id: owner, now: NOW }
        assert.deepEqual(
          round(rollup.statistics(args)),
          round(raw.statistics(args)),
          `${label} statistics ${range}/${dimension}/${JSON.stringify(owner)}`,
        )
        const board = { range, scope: dimension, owner_user_id: owner, now: NOW, limit: 100 }
        assert.deepEqual(
          round(rollup.leaderboard(board)),
          round(raw.leaderboard(board)),
          `${label} leaderboard ${range}/${dimension}/${JSON.stringify(owner)}`,
        )
      }
    }
}

test('statistics from the hourly rollup match a direct usage_logs scan', (t) => {
  const db = fixture(t)
  seed(db, 3000, 7)
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM usage_stats_hourly').get().n > 0)
  assertSame(db, 'insert')
})

test('the rollup stays exact under updates and retention deletes', (t) => {
  const db = fixture(t)
  seed(db, 1500, 11)
  db.exec(`UPDATE usage_logs SET actual_cost = IFNULL(actual_cost, 0) * 2 + 0.5, status = 500, error_code = 'upstream_error'
    WHERE rowid % 7 = 0`)
  db.exec(
    "UPDATE usage_logs SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+90 minutes') WHERE rowid % 11 = 0",
  )
  db.exec("UPDATE usage_logs SET api_key_id = 'k3', user_id = 'u3', model = 'gpt-5.5' WHERE rowid % 13 = 0")
  db.exec('DELETE FROM usage_logs WHERE rowid % 5 = 0')
  assertSame(db, 'after changes')
  // 汇总表与按同样口径重新聚合的结果逐行相同（没有残留的 0 行）
  const fresh = db
    .prepare(`SELECT substr(created_at, 1, 13) AS hour, COALESCE(user_id, '') AS user_id, COUNT(*) AS requests
      FROM usage_logs GROUP BY hour, COALESCE(user_id, ''), COALESCE(api_key_id, ''), COALESCE(model, ''),
        COALESCE(vm_id, ''), COALESCE(billing_group_id, -1), COALESCE(path, ''), COALESCE(status, -1),
        COALESCE(error_code, '')`)
    .all()
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM usage_stats_hourly').get().n, fresh.length)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM usage_stats_hourly WHERE requests <= 0').get().n, 0)
})

test('windows split into raw edges and whole rollup hours', () => {
  const h = (iso) => Date.parse(iso)
  assert.deepEqual(splitWindow(h('2026-11-05T01:20:00Z'), h('2026-11-05T04:10:00Z')), {
    raw: [
      [h('2026-11-05T01:20:00Z'), h('2026-11-05T02:00:00Z')],
      [h('2026-11-05T04:00:00Z'), h('2026-11-05T04:10:00Z')],
    ],
    hours: [h('2026-11-05T02:00:00Z'), h('2026-11-05T04:00:00Z')],
  })
  assert.deepEqual(splitWindow(h('2026-11-05T02:00:00Z'), h('2026-11-05T03:00:00Z')), {
    raw: [],
    hours: [h('2026-11-05T02:00:00Z'), h('2026-11-05T03:00:00Z')],
  })
  assert.deepEqual(splitWindow(h('2026-11-05T02:10:00Z'), h('2026-11-05T02:50:00Z')), {
    raw: [[h('2026-11-05T02:10:00Z'), h('2026-11-05T02:50:00Z')]],
    hours: null,
  })
  // 归属谓词套在合并后的数据上，参数在各段参数之后
  const source = statsSource(h('2026-11-05T01:20:00Z'), h('2026-11-05T04:10:00Z'), 'u1')
  assert.match(source.sql, /WHERE user_id = \?\)$/)
  assert.equal(source.params.at(-1), 'u1')
})

test('series fall back to the raw scan when buckets are not on whole hours', (t) => {
  const db = fixture(t)
  seed(db, 200, 3)
  const rollup = new RollupStatisticsRepo(db)
  let fallback = 0
  const base = StatisticsRepo.prototype._seriesRows
  StatisticsRepo.prototype._seriesRows = function (...args) {
    fallback++
    return base.apply(this, args)
  }
  t.after(() => {
    StatisticsRepo.prototype._seriesRows = base
  })
  rollup._seriesRows('model', NOW - 3_600_000, NOW, null, [Date.parse('2026-11-05T08:30:00Z')])
  assert.equal(fallback, 1)
  rollup._seriesRows('model', NOW - 3_600_000, NOW, null, [Date.parse('2026-11-05T08:00:00Z')])
  assert.equal(fallback, 1)
})

test('the migration backfill builds the same rollup as the triggers', (t) => {
  const db = fixture(t)
  seed(db, 1200, 19)
  const rows = () =>
    db
      .prepare(
        'SELECT * FROM usage_stats_hourly ORDER BY hour, user_id, api_key_id, model, vm_id, billing_group_id, path, status_code, error_code',
      )
      .all()
      .map((row) => round({ ...row }))
  const byTriggers = rows()
  const migration = fs.readFileSync(
    path.join(import.meta.dirname, '../../src/lib/db/migrations/115_usage_stats_hourly.sql'),
    'utf8',
  )
  const backfill = migration.slice(
    migration.indexOf('INSERT INTO usage_stats_hourly'),
    migration.indexOf('CREATE TRIGGER'),
  )
  db.exec('DELETE FROM usage_stats_hourly')
  db.exec(backfill)
  assert.deepEqual(rows(), byTriggers)
})
