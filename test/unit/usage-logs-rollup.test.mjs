import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { UsageLogsView } from '../../src/lib/db/repos/usage-logs-view.mjs'
import { rollupSource } from '../../src/lib/db/repos/usage-log-rollup.mjs'
import { StatisticsRepo } from '../../src/lib/db/repos/statistics-repo.mjs'
import { RollupStatisticsRepo } from '../../src/lib/db/repos/usage-stats-rollup.mjs'
import { dbTime } from '../../src/shared/system-time.mjs'

// 技术债 M5：使用记录页的 summary / ranking / overview 读小时汇总表（usage_stats_hourly，迁移 115、123），
// 结果必须与逐行扫描 usage_logs 逐项一致。对照路径是 useRollup: false 的同一个视图。
// 费用是浮点和，求和顺序不同可能有 1e-12 量级差异：数值按 1e-6 比较，排行顺序按 1e-9 取整后的金额决定（见 compareRanking）。

const NOW = Date.parse('2026-11-05T09:37:21.512Z')
const HOUR = 3_600_000

function rng(seed) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-logs-rollup-'))
  const db = createDatabase({ dbPath: path.join(dir, 'kin.db') })
  t.after(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
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

const INSERT = `INSERT INTO usage_logs
  (id, request_id, created_at, user_id, api_key_id, model, vm_id, billing_group_id, path, status, error_code,
   input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cache_creation_5m_tokens,
   cache_creation_1h_tokens, actual_cost, duration_ms, first_token_ms, outbound_session_id)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`

function seed(db, count, seedValue) {
  const random = rng(seedValue)
  const insert = db.prepare(INSERT)
  for (let i = 0; i < count; i++) {
    // 最近 3 天为主（覆盖今日、昨日与 5 分钟窗口），少量更早
    const span = random() < 0.8 ? 3 * 86_400_000 : 30 * 86_400_000
    const at = NOW - Math.floor(random() * span)
    // 入站鉴权失败（无槽位的 401 / invalid_api_key）属于默认屏蔽的 auth 类
    const ingress = random() < 0.08
    insert.run(
      `log_${seedValue}_${i}`,
      `req_${seedValue}_${i}`,
      dbTime(at),
      pick(random, ['u1', 'u2', 'u3', null, '']),
      pick(random, ['k1', 'k2', 'k3', null, '']),
      pick(random, ['claude-sonnet-4', 'gpt-5.5', '', null]),
      ingress ? null : pick(random, ['vm-01', 'vm-02', null]),
      pick(random, [1, 2, null]),
      pick(random, ['/v1/messages', '/v1/responses', null]),
      ingress ? 401 : pick(random, [200, 200, 200, 204, 400, 429, 500, null]),
      ingress
        ? pick(random, ['invalid_api_key', null])
        : pick(random, [null, null, '', 'client_disconnected', 'upstream_error', 'rate_limited']),
      pick(random, [0, 10, 1234, null]),
      pick(random, [0, 5, 777, null]),
      pick(random, [0, 100, null]),
      pick(random, [0, 50, null]),
      pick(random, [0, 20, null]),
      pick(random, [0, 30, null]),
      // 连续取值：固定的几个取值会让两个系列恰好相等，浮点求和顺序不同时先后可能互换（R5 的坑）
      random() < 0.2 ? null : Math.round(random() * 3_000_000) / 1_000_000,
      pick(random, [null, 120, 3401, 77]),
      pick(random, [null, 80, 901]),
      pick(random, ['s1', 's2', 's3', null]),
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

const iso = (ms) => new Date(ms).toISOString()
const WINDOWS = [
  {},
  // 两端都不在整点
  { start_time: iso(NOW - 26 * HOUR - 17 * 60_000), end_time: iso(NOW - 3 * HOUR + 41_123) },
  // 两端都在整点
  { start_time: '2026-11-04T02:00:00.000Z', end_time: '2026-11-05T08:00:00.000Z' },
  // 只有开始 / 只有结束
  { start_time: iso(NOW - 30 * HOUR - 1234) },
  { end_time: iso(NOW - 40 * HOUR + 777) },
  // 落在同一个小时内（全部读明细）
  { start_time: '2026-11-05T07:05:00.000Z', end_time: '2026-11-05T07:55:00.000Z' },
  // 起点晚于终点
  { start_time: iso(NOW - HOUR), end_time: iso(NOW - 3 * HOUR) },
]

// 汇总表能回答的筛选
const ROLLUP_FILTERS = [
  {},
  { user_id: 'u1' },
  { key_id: 'k2' },
  { vm_id: 'vm-01' },
  { status_code: '500' },
  { exclude_status_200: true },
  { errors_only: true },
  { include_muted: true },
  { exclude_error_class: 'auth' },
  { key_id: 'k1', errors_only: true, include_muted: true },
]

// 回落到逐行扫描的筛选（SQL 可表达，或按行判定错误类别）
const FALLBACK_FILTERS = [
  { model: 'gpt-5.5' },
  { group_id: '1' },
  { session_id: 's1' },
  { q: 'upstream' },
  { error_class: 'auth' },
  { exclude_error_class: 'auth,quota' },
]

async function assertSame(db, filterSets, label) {
  const rollup = new UsageLogsView(db)
  const raw = new UsageLogsView(db, { useRollup: false })
  for (const owner of OWNERS)
    for (const window of WINDOWS)
      for (const extra of filterSets) {
        const filters = { ...window, ...extra, owner_user_id: owner }
        const tag = `${label} ${JSON.stringify(filters)}`
        assert.deepEqual(round(await rollup.summary(filters)), round(await raw.summary(filters)), `summary ${tag}`)
        for (const scope of ['key', 'user'])
          assert.deepEqual(
            round(await rollup.ranking(filters, scope)),
            round(await raw.ranking(filters, scope)),
            `ranking/${scope} ${tag}`,
          )
      }
}

test('usage-log summary and ranking from the hourly rollup match a usage_logs scan', async (t) => {
  const db = fixture(t)
  seed(db, 2500, 5)
  await assertSame(db, ROLLUP_FILTERS, 'rollup')
  await assertSame(db, FALLBACK_FILTERS, 'fallback')
})

test('the rollup stays exact for the usage-log page under updates and retention deletes', async (t) => {
  const db = fixture(t)
  seed(db, 1500, 13)
  db.exec(`UPDATE usage_logs SET actual_cost = IFNULL(actual_cost, 0) * 2 + 0.5, status = 500, error_code = 'upstream_error',
    cache_creation_5m_tokens = 7, cache_creation_1h_tokens = NULL WHERE rowid % 7 = 0`)
  db.exec(
    "UPDATE usage_logs SET created_at = strftime('%Y-%m-%dT%H:%M:%f', created_at, '+90 minutes', '+8 hours') || '+08:00' WHERE rowid % 11 = 0",
  )
  db.exec("UPDATE usage_logs SET api_key_id = 'k3', user_id = 'u3', actual_cost = NULL WHERE rowid % 13 = 0")
  db.exec('DELETE FROM usage_logs WHERE rowid % 5 = 0')
  await assertSame(db, ROLLUP_FILTERS, 'after changes')
})

test('overview today / yesterday from the rollup match the usage_logs scan', async (t) => {
  const db = fixture(t)
  seed(db, 2500, 21)
  const rollup = new UsageLogsView(db)
  const raw = new UsageLogsView(db, { useRollup: false })
  // 系统时区 Asia/Shanghai：今日从 UTC 16:00 起；含今日第一个小时内（整段读明细）与整点时刻
  const moments = [NOW, Date.parse('2026-11-04T16:20:00.000Z'), Date.parse('2026-11-05T05:00:00.000Z'), NOW - 7 * HOUR]
  for (const now of moments)
    for (const owner of OWNERS) {
      const args = { owner_user_id: owner, now }
      assert.deepEqual(
        round(await rollup.overview(args)),
        round(await raw.overview(args)),
        `overview ${iso(now)} ${JSON.stringify(owner)}`,
      )
    }
})

test('rollup-eligible filters read usage_stats_hourly; the others scan usage_logs', async (t) => {
  const db = fixture(t)
  seed(db, 600, 3)
  const view = new UsageLogsView(db)
  const before = {
    rollup: await view.summary({}),
    model: await view.summary({ model: 'gpt-5.5' }),
    muted: await view.summary({ exclude_error_class: 'auth,quota' }),
  }
  // 只改汇总表（usage_logs 不变）：读汇总表的路径结果随之变化，回落路径不变
  db.exec('UPDATE usage_stats_hourly SET requests = requests + 1000')
  assert.ok((await view.summary({})).totalRequests > before.rollup.totalRequests)
  assert.deepEqual(await view.summary({ model: 'gpt-5.5' }), before.model)
  assert.deepEqual(await view.summary({ exclude_error_class: 'auth,quota' }), before.muted)
})

test('ranking ties are ordered by requests then id, independent of float summation order', async (t) => {
  const db = fixture(t)
  const insert = db.prepare(INSERT)
  // k1 与 k2 的金额相同（0.1+0.2+0.3 与 0.3+0.2+0.1 的浮点和相差 1 ulp），分在三个整小时与一个不完整小时
  const rows = [
    ['k1', 0.1, dbTime('2026-11-05T01:10:00.000Z')],
    ['k1', 0.2, dbTime('2026-11-05T02:10:00.000Z')],
    ['k1', 0.3, dbTime('2026-11-05T03:10:00.000Z')],
    ['k2', 0.3, dbTime('2026-11-05T01:20:00.000Z')],
    ['k2', 0.2, dbTime('2026-11-05T02:20:00.000Z')],
    ['k2', 0.1, dbTime('2026-11-05T03:20:00.000Z')],
    ['k3', 0.3, dbTime('2026-11-05T01:30:00.000Z')],
    ['k3', 0.3, dbTime('2026-11-05T02:30:00.000Z')],
  ]
  rows.forEach(([key, cost, at], i) =>
    insert.run(
      `t${i}`,
      `rt${i}`,
      at,
      'u1',
      key,
      'm',
      'vm-01',
      1,
      '/v1/messages',
      200,
      null,
      1,
      1,
      0,
      0,
      0,
      0,
      cost,
      10,
      5,
      null,
    ),
  )
  const filters = { start_time: '2026-11-05T01:05:00.000Z', end_time: '2026-11-05T03:15:00.000Z' }
  for (const view of [new UsageLogsView(db), new UsageLogsView(db, { useRollup: false })]) {
    const { entries } = await view.ranking(filters, 'key')
    // 窗口截掉 k2 的最后一行：k1 0.6（3 次）> k3 0.6（2 次）> k2 0.5
    assert.deepEqual(
      entries.map((e) => [e.id, e.requests]),
      [
        ['k1', 3],
        ['k3', 2],
        ['k2', 2],
      ],
    )
    const all = (await view.ranking({}, 'key')).entries
    // 全量：k1、k2 金额与次数都相同，按 ID 升序
    assert.deepEqual(
      all.map((e) => e.id),
      ['k1', 'k2', 'k3'],
    )
    assert.equal(all[0].name, 'alice-key')
    assert.equal(all[0].owner, 'alice')
  }
  // 没有任何计价行的 Key 金额为空（前端显示“—”），两条路径一致
  db.prepare(INSERT).run(
    'n1',
    'rn1',
    dbTime('2026-11-05T04:10:00.000Z'),
    'u2',
    'k9',
    'm',
    null,
    null,
    null,
    200,
    null,
    1,
    1,
    0,
    0,
    0,
    0,
    null,
    null,
    null,
    null,
  )
  for (const view of [new UsageLogsView(db), new UsageLogsView(db, { useRollup: false })])
    assert.equal((await view.ranking({}, 'key')).entries.find((e) => e.id === 'k9').cost, null)
})

test('open-ended windows read whole rollup hours and only one raw edge', () => {
  const since = Date.parse('2026-11-05T01:20:00Z')
  const until = Date.parse('2026-11-05T04:10:00Z')
  const startOnly = rollupSource({ since })
  assert.deepEqual(startOnly.params, ['2026-11-05T01:20:00.000Z', '2026-11-05T02:00:00.000Z', '2026-11-05T02'])
  assert.match(startOnly.sql, /FROM usage_stats_hourly WHERE hour >= \?\)/)
  const endOnly = rollupSource({ until, where: ['user_id = ?'], params: ['u1'] })
  assert.deepEqual(endOnly.params, ['2026-11-05T04', '2026-11-05T04:00:00.000Z', '2026-11-05T04:10:00.000Z', 'u1'])
  assert.match(endOnly.sql, /WHERE user_id = \?\)$/)
  const all = rollupSource()
  assert.deepEqual(all.params, [])
  assert.doesNotMatch(all.sql, /FROM usage_logs/)
})

test('averages inside a single partial hour are not truncated by integer division (statistics page too)', async (t) => {
  const db = fixture(t)
  const insert = db.prepare(INSERT)
  insert.run(
    'a1',
    'ra1',
    dbTime('2026-11-05T07:10:00.000Z'),
    'u1',
    'k1',
    'm',
    null,
    null,
    null,
    200,
    null,
    1,
    1,
    0,
    0,
    0,
    0,
    0.1,
    100,
    10,
    null,
  )
  insert.run(
    'a2',
    'ra2',
    dbTime('2026-11-05T07:20:00.000Z'),
    'u1',
    'k1',
    'm',
    null,
    null,
    null,
    200,
    null,
    1,
    1,
    0,
    0,
    0,
    0,
    0.1,
    101,
    11,
    null,
  )
  const since = Date.parse('2026-11-05T07:00:30.000Z')
  const until = Date.parse('2026-11-05T07:59:00.000Z')
  const rollup = await new RollupStatisticsRepo(db)._totalsRow(since, until, null)
  const raw = await new StatisticsRepo(db)._totalsRow(since, until, null)
  assert.equal(rollup.avg_duration_ms, 100.5)
  assert.equal(rollup.avg_duration_ms, raw.avg_duration_ms)
  assert.equal(rollup.avg_ttft_ms, raw.avg_ttft_ms)
})
