// 金额整数化（技术债 M6）：舍入规则、大额与小额边界、回填一致性、触发器读整数列、写入方同步写镜像、一致性脚本。
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  MAX_MONEY_MICROS,
  allocateMicros,
  applyRate,
  fromMicros,
  mulDivRound,
  ratePpm,
  roundDiv,
  rowMicros,
  sqlRound,
  toMicros,
  tokenPicos,
} from '../../src/lib/core/money.mjs'
import { moneyMicros } from '../../src/lib/admin/relay-common.mjs'
import { groupMediaPolicy, mediaCharge } from '../../src/lib/admin/media-pricing.mjs'
import { ApiKeyStore } from '../../src/lib/admin/api-keys.mjs'
import { applyMigrations, createDatabase } from '../../src/lib/db/database.mjs'
import { calculateCost, costColumnsFromUsage } from '../../src/lib/admin/pricing.mjs'
import { UsageLogsRepo } from '../../src/lib/db/repos/usage-logs-repo.mjs'
import { ApiKeysRepo } from '../../src/lib/db/repos/api-keys-repo.mjs'
import { GroupsRepo } from '../../src/lib/db/repos/groups-repo.mjs'
import { UsersRepo } from '../../src/lib/db/repos/users-repo.mjs'
import { repair, runAudit } from '../../scripts/audit-money-micros.mjs'

const ROOT = path.resolve(import.meta.dirname, '../..')
const MIGRATIONS = path.join(ROOT, 'src/lib/db/migrations')
const AUDIT = path.join(ROOT, 'scripts/audit-money-micros.mjs')

function tmp(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function freshDb(t) {
  const db = createDatabase({ dataDir: tmp(t, 'money-') })
  t.after(() => db.close())
  return db
}

/** 只应用到 `before`（不含）为止的迁移，模拟升级前的库。 */
function dbBefore(t, before) {
  const dir = tmp(t, 'money-upgrade-')
  const old = path.join(dir, 'migrations')
  fs.mkdirSync(old)
  for (const file of fs.readdirSync(MIGRATIONS))
    if (file < before) fs.copyFileSync(path.join(MIGRATIONS, file), path.join(old, file))
  const db = new DatabaseSync(path.join(dir, 'kin.db'))
  t.after(() => db.close())
  applyMigrations(db, { migrationsDir: old })
  return { db, file: path.join(dir, 'kin.db') }
}

test('舍入：十进制金额换整数微单位四舍五入、远离零，与 SQLite ROUND 逐位一致', () => {
  assert.equal(toMicros(0.0000005), 1, '0.0000005 × 1e6 = 0.49999999999999994，按十进制应得 1')
  assert.equal(toMicros(-0.0000005), -1)
  assert.equal(toMicros(0.0000004999), 0)
  assert.equal(toMicros(0.1 + 0.2), 300000)
  assert.equal(toMicros(1.0000015), 1000002)
  assert.equal(toMicros(123456789.123456), 123456789123456)
  assert.equal(toMicros(null), null)
  assert.equal(toMicros(''), null)
  assert.equal(toMicros('abc'), null)
  assert.equal(Object.is(toMicros(-0.0000001), 0), true, '不产生 -0')
  assert.equal(fromMicros(1), 0.000001)
  assert.equal(fromMicros(null), null)
  assert.equal(rowMicros({ total_cost_micros: 7, total_cost: 99 }, 'total_cost'), 7, '整数列优先')
  assert.equal(
    rowMicros({ total_cost_micros: null, total_cost: 0.25 }, 'total_cost'),
    250000,
    '整数列为 NULL 时按 REAL 派生',
  )
  assert.equal(rowMicros({ total_cost_micros: null, total_cost: null }, 'total_cost'), null)
})

test('舍入：整数除法、倍率与大额乘法', () => {
  assert.equal(roundDiv(15, 10), 2)
  assert.equal(roundDiv(14, 10), 1)
  assert.equal(roundDiv(-15, 10), -2)
  assert.equal(roundDiv(15n, 10n), 2n)
  assert.equal(roundDiv(-25n, 10n), -3n)
  assert.equal(ratePpm(0.8), 800000)
  assert.equal(ratePpm(1.0000005), 1000001)
  assert.equal(ratePpm('1.5'), 1500000)
  assert.equal(applyRate(3, 0.5), 2, '1.5 微单位五入为 2')
  assert.equal(applyRate(1, 0.5), 1, '0.5 微单位五入为 1')
  assert.equal(applyRate(1, 0.4), 0)
  assert.equal(applyRate(1_000_000, 0), 0)
  assert.equal(applyRate(null, 1), null)
  assert.equal(applyRate(123_456_789, 1.15), 141_975_307, '141975307.35 舍为 141975307')
  // 乘积超出 2^53 时改用 BigInt：90 亿美元 × 2.5 倍
  assert.equal(mulDivRound(3_000_000_000_000_000, 2_500_000, 1_000_000), 7_500_000_000_000_000)
  assert.equal(mulDivRound(3_000_000_000_000_001, 500_000, 1_000_000), 1_500_000_000_000_001, '0.5 五入')
  assert.equal(applyRate(4_000_000_000_000_000, 2), 8_000_000_000_000_000)
  assert.throws(() => applyRate(9_000_000_000_000_000, 3), RangeError)
})

test('舍入：总额从精确和四舍五入一次，各部分按最大余数法分摊且之和等于总额', () => {
  // 精确值 350 / 150 / 10 / 62.5 微单位 → 总额 572.5 → 573；多出的 1 分给余数最大的缓存写入
  const a = allocateMicros([350_000_000n, 150_000_000n, 10_000_000n, 62_500_000n])
  assert.deepEqual(a, { total: 573, parts: [350, 150, 10, 63] })
  // 三个 0.4：总额 1.2 → 1，第一个（同余数按顺序）得 1
  assert.deepEqual(allocateMicros([400_000n, 400_000n, 400_000n]), { total: 1, parts: [1, 0, 0] })
  // 三个 0.6：总额 1.8 → 2
  assert.deepEqual(allocateMicros([600_000n, 600_000n, 600_000n]), { total: 2, parts: [1, 1, 0] })
  for (let seed = 1; seed < 500; seed++) {
    const parts = Array.from({ length: 1 + (seed % 7) }, (_, i) => BigInt((seed * 7919 + i * 104729) % 9_999_999))
    const out = allocateMicros(parts)
    const exact = parts.reduce((s, p) => s + p, 0n)
    assert.equal(
      out.parts.reduce((s, p) => s + p, 0),
      out.total,
    )
    assert.ok(Math.abs(out.total * 1e6 - Number(exact)) <= 500_000, '总额只舍入一次，误差不超过 0.5 微单位')
    out.parts.forEach((p, i) => assert.ok(Math.abs(p * 1e6 - Number(parts[i])) < 1e6, '每个部分误差小于 1 微单位'))
  }
})

test('价格 × token：精确值在皮美元上计算，最终金额处舍入；与改造前的浮点结果相差不超过 1 微单位', () => {
  const model = 'claude-sonnet-5'
  for (let i = 0; i < 400; i++) {
    const usage = {
      input_tokens: (i * 7919) % 200_000,
      output_tokens: (i * 104729) % 30_000,
      cache_read_input_tokens: (i * 1299709) % 500_000,
      cache_creation_input_tokens: (i * 15485863) % 40_000,
    }
    const c = calculateCost(usage, model)
    assert.equal(c.known, true)
    const parts = ['input', 'output', 'cache_read', 'cache_creation', 'web_search'].map((k) => c[`${k}_cost_micros`])
    assert.equal(
      parts.reduce((s, p) => s + p, 0),
      c.total_cost_micros,
      '组成部分之和等于总额',
    )
    assert.equal(c.total_cost, c.total_cost_micros / 1e6, 'REAL 是整数的镜像')
    // 改造前：各部分浮点相乘后按 1e-8 舍入
    const r = c.rates
    const old =
      (usage.input_tokens / 1e6) * r.input +
      (usage.output_tokens / 1e6) * r.output +
      (usage.cache_read_input_tokens / 1e6) * r.cache_read +
      (usage.cache_creation_input_tokens / 1e6) * r.cache_5m
    assert.ok(Math.abs(c.total_cost_micros - old * 1e6) <= 0.5 + 1e-6, `${i}: ${c.total_cost_micros} vs ${old * 1e6}`)
  }
})

test('大额与小额边界：BigInt 精确乘法、1e-7 美元级别的小额', () => {
  // 20 亿 token × $75/MTok：皮美元乘积 1.5e17 超出 2^53，仍精确
  assert.equal(tokenPicos(2_000_000_000, 75_000_000), 150_000_000_000_000_000n)
  const big = calculateCost({ input_tokens: 0, output_tokens: 2_000_000_000 }, 'claude-opus-5')
  assert.equal(big.output_cost_micros, Number(tokenPicos(2_000_000_000, toMicros(big.rates.output)) / 1_000_000n))
  // 1 个 token 的缓存读取（$0.2/MTok = 0.2 微单位）舍为 0；5 个 token 为 1 微单位
  const one = costColumnsFromUsage({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1 }, 'claude-sonnet-5')
  assert.equal(one.total_cost_micros, 0)
  const five = costColumnsFromUsage(
    { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 5 },
    'claude-sonnet-5',
  )
  assert.equal(five.total_cost_micros, 1)
})

test('小额累加：整数汇总没有浮点漂移；单行低于 0.5 微单位的金额舍为 0（约定的误差上界）', (t) => {
  const db = freshDb(t)
  const insert = db.prepare(`INSERT INTO usage_logs (id, request_id, created_at, status, user_id, api_key_id,
    actual_cost_micros, actual_cost) VALUES (?, ?, '2026-11-06T01:00:00.000Z', 200, 'u', 'k', ?, ?)`)
  db.exec('BEGIN')
  for (let i = 0; i < 1000; i++) insert.run(`s${i}`, `s${i}`, 1, fromMicros(1))
  db.exec('COMMIT')
  const rollup = db.prepare('SELECT cost_micros, cost FROM usage_stats_hourly').get()
  assert.equal(rollup.cost_micros, 1000)
  assert.equal(rollup.cost, 0.001, 'REAL 镜像由整数派生，精确等于 0.001')
  let floatSum = 0
  for (let i = 0; i < 1000; i++) floatSum += 0.000001
  assert.notEqual(floatSum, 0.001, '改造前的浮点累加会漂移')
  // 1e-7 美元：toMicros 舍为 0，一百万次也是 0（上界：每行 0.5 微单位）
  assert.equal(toMicros(1e-7), 0)
  assert.equal(toMicros(4.9e-7), 0)
  assert.equal(toMicros(5e-7), 1)
})

test('回填（126）：x_micros = ROUND(x × 1e6)，NULL 保持 NULL，REAL 不变；汇总表（127）按整数重建并与触发器结果相同', (t) => {
  const { db } = dbBefore(t, '126')
  const insert =
    db.prepare(`INSERT INTO usage_logs (id, request_id, created_at, status, user_id, api_key_id, vm_id, account_id,
    model, pricing_model, input_tokens, output_tokens, input_cost, output_cost, total_cost, actual_cost)
    VALUES (?, ?, ?, ?, 'u1', ?, 'vm-1', 'acc-1', 'claude-sonnet-5', 'claude-sonnet-5', 10, 5, ?, ?, ?, ?)`)
  const costs = [
    [0.00000005, 0.0000004, 0.00000045, 0.0000009],
    [1.23456789, 0, 1.23456789, 1.4197530735],
    [null, null, null, null],
    [123456.7890125, 0.0000005, 123456.789013, 0.5],
  ]
  costs.forEach((c, i) =>
    insert.run(`b${i}`, `b${i}`, `2026-11-0${1 + i}T0${i}:15:00.000Z`, i === 2 ? 500 : 200, `k${i % 2}`, ...c),
  )
  db.prepare(
    "INSERT INTO api_keys (id, name, key, quota, quota_used, usage_5h) VALUES ('kq', 'q', 'sk-q', 10.5, 0.0000025, 1.0000005)",
  ).run()
  db.prepare("INSERT INTO groups (id, name, image_price_1k) VALUES (99, 'img', 0.134)").run()
  const before = db.prepare('SELECT * FROM usage_logs ORDER BY id').all()
  applyMigrations(db, { migrationsDir: MIGRATIONS })
  const after = db.prepare('SELECT * FROM usage_logs ORDER BY id').all()
  for (const [i, row] of after.entries()) {
    for (const c of ['input_cost', 'output_cost', 'total_cost', 'actual_cost']) {
      assert.equal(row[c], before[i][c], `${row.id}.${c} REAL 不变`)
      assert.equal(row[`${c}_micros`], toMicros(row[c]), `${row.id}.${c}`)
    }
  }
  assert.equal(after[0].input_cost_micros, 0)
  assert.equal(after[0].actual_cost_micros, 1)
  assert.equal(after[3].output_cost_micros, 1)
  assert.equal(after[3].total_cost_micros, 123_456_789_013)
  const key = db.prepare("SELECT * FROM api_keys WHERE id='kq'").get()
  assert.deepEqual(
    [key.quota_micros, key.quota_used_micros, key.usage_5h_micros, key.usage_1d_micros],
    [10_500_000, 3, 1_000_001, 0],
  )
  assert.equal(db.prepare('SELECT image_price_1k_micros AS m FROM groups WHERE id=99').get().m, 134_000)
  assert.equal(db.prepare('SELECT image_price_2k_micros AS m FROM groups WHERE id=99').get().m, null)
  // 127 的重建结果 = 按触发器逐行写入的结果
  const snapshot = () => ({
    stats: db.prepare('SELECT * FROM usage_stats_hourly ORDER BY hour, api_key_id, status_code').all(),
    cost: db.prepare('SELECT * FROM usage_cost_hourly ORDER BY hour, account_key, status_code').all(),
  })
  const rebuilt = snapshot()
  db.exec('DELETE FROM usage_stats_hourly; DELETE FROM usage_cost_hourly')
  const rows = db.prepare('SELECT * FROM usage_logs').all()
  db.exec('DELETE FROM usage_logs')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM usage_stats_hourly').get().n, 0)
  db.exec('DELETE FROM usage_stats_hourly; DELETE FROM usage_cost_hourly')
  const cols = Object.keys(rows[0])
  const ins = db.prepare(`INSERT INTO usage_logs (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
  for (const r of rows) ins.run(...cols.map((c) => r[c]))
  assert.deepEqual(snapshot(), rebuilt)
  assert.equal(
    rebuilt.stats.reduce((s, r) => s + r.cost_micros, 0),
    1 + 1_419_753 + 500_000,
  )
  assert.ok(runAudit(db).ok, JSON.stringify(runAudit(db)))
})

test('触发器累加整数列：整数列为权威值；整数列为 NULL（旧写入方）时按 REAL 派生', (t) => {
  const db = freshDb(t)
  const insert =
    db.prepare(`INSERT INTO usage_logs (id, request_id, created_at, status, user_id, api_key_id, account_id,
    total_cost_micros, total_cost, actual_cost_micros, actual_cost) VALUES (?, ?, '2026-11-06T02:10:00.000Z', 200, 'u', 'k', 'a', ?, ?, ?, ?)`)
  // 故意让 REAL 与整数不一致：汇总只认整数
  insert.run('t1', 't1', 2_000_000, 999, 1_234_567, 999)
  let stats = db.prepare('SELECT cost_micros, cost, cost_n FROM usage_stats_hourly').get()
  assert.deepEqual({ ...stats }, { cost_micros: 1_234_567, cost: 1.234567, cost_n: 1 })
  assert.equal(db.prepare('SELECT total_cost_micros AS m FROM usage_cost_hourly').get().m, 2_000_000)
  // 只写 REAL 的旧写入方：整数列为 NULL，按 ROUND(x × 1e6) 计入
  db.prepare(`INSERT INTO usage_logs (id, request_id, created_at, status, user_id, api_key_id, account_id, total_cost, actual_cost)
    VALUES ('t2', 't2', '2026-11-06T02:20:00.000Z', 200, 'u', 'k', 'a', 0.5, 0.25)`).run()
  stats = db.prepare('SELECT cost_micros, cost, cost_n FROM usage_stats_hourly').get()
  assert.deepEqual({ ...stats }, { cost_micros: 1_484_567, cost: 1.484567, cost_n: 2 })
  // 改整数列触发更新；改到 NULL 后不再计入 cost_n
  db.prepare("UPDATE usage_logs SET actual_cost_micros = 34_567, actual_cost = 0.034567 WHERE id = 't1'").run()
  assert.equal(db.prepare('SELECT cost_micros FROM usage_stats_hourly').get().cost_micros, 284_567)
  db.prepare("UPDATE usage_logs SET actual_cost_micros = NULL, actual_cost = NULL WHERE id = 't1'").run()
  stats = db.prepare('SELECT cost_micros, cost_n FROM usage_stats_hourly').get()
  assert.deepEqual({ ...stats }, { cost_micros: 250_000, cost_n: 1 })
  db.prepare("UPDATE usage_logs SET total_cost_micros = 7 WHERE id = 't1'").run()
  assert.equal(db.prepare('SELECT total_cost_micros AS m, total_cost AS c FROM usage_cost_hourly').get().m, 500_007)
  db.prepare("DELETE FROM usage_logs WHERE id = 't2'").run()
  assert.deepEqual(
    { ...db.prepare('SELECT total_cost_micros AS m, total_cost AS c FROM usage_cost_hourly').get() },
    { m: 7, c: 0.000007 },
  )
})

test('写入方同时写整数列与 REAL 镜像：使用记录、重新定价、Key 额度、分组单价', async (t) => {
  const db = freshDb(t)
  const logs = new UsageLogsRepo(db, { billingMaintenance: false })
  // 只给美元值的写入方（旧写法）：在仓储边界换算一次
  await logs.insertSummary({
    id: 'w1',
    request_id: 'w1',
    created_at: '2026-11-06T03:00:00.000Z',
    status: 200,
    total_cost: 0.0000125,
    actual_cost: 0.00001875,
  })
  // 给了整数值的写入方：整数为准，REAL 由整数派生（与传入的 REAL 无关）
  await logs.insertSummary({
    id: 'w2',
    request_id: 'w2',
    created_at: '2026-11-06T03:00:00.000Z',
    status: 200,
    total_cost_micros: 42,
    total_cost: 1,
    actual_cost_micros: 21,
  })
  const w1 = db.prepare("SELECT * FROM usage_logs WHERE id='w1'").get()
  assert.deepEqual(
    [w1.total_cost_micros, w1.total_cost, w1.actual_cost_micros, w1.actual_cost],
    [13, 0.000013, 19, 0.000019],
  )
  const w2 = db.prepare("SELECT * FROM usage_logs WHERE id='w2'").get()
  assert.deepEqual(
    [w2.total_cost_micros, w2.total_cost, w2.actual_cost_micros, w2.actual_cost],
    [42, 0.000042, 21, 0.000021],
  )
  // 补算缺失成本：按存储的倍率在整数上相乘
  db.prepare(`INSERT INTO usage_logs (id, request_id, created_at, status, model, input_tokens, output_tokens, rate_multiplier)
    VALUES ('w3', 'w3', '2026-11-06T03:00:00.000Z', 200, 'claude-sonnet-5', 1000, 100, 1.5)`).run()
  await logs.backfillMissingCosts()
  const w3 = db.prepare("SELECT * FROM usage_logs WHERE id='w3'").get()
  const priced = costColumnsFromUsage({ input_tokens: 1000, output_tokens: 100 }, 'claude-sonnet-5')
  assert.equal(w3.total_cost_micros, priced.total_cost_micros)
  assert.equal(w3.actual_cost_micros, applyRate(priced.total_cost_micros, 1.5))
  assert.equal(w3.actual_cost, w3.actual_cost_micros / 1e6)

  const keys = new ApiKeysRepo(db)
  await keys.insert({ id: 'k1', name: 'k', key: 'sk-k1', status: 'active', quota: 1.5, rate_limit_5h: 0.25 })
  await keys.recordUsage('k1', { cost_micros: 333_333 })
  await keys.recordUsage('k1', { cost_micros: 333_333 })
  const k1 = await keys.getById('k1')
  assert.deepEqual([k1.quota_micros, k1.quota_used_micros, k1.usage_5h_micros], [1_500_000, 666_666, 666_666])
  assert.equal(k1.quota_used, 0.666666)

  const groups = new GroupsRepo(db)
  const g = await groups.create({
    name: 'media',
    platform: 'openai',
    image_price_1k: 0.1234567,
    web_search_price_per_call: 0.02,
  })
  assert.equal(g.image_price_1k_micros, 123_457)
  assert.equal(g.image_price_1k, 0.123457)
  assert.equal(g.web_search_price_per_call_micros, 20_000)
  const report = runAudit(db)
  assert.ok(
    report.rows.every((r) => r.status === 'ok'),
    JSON.stringify(report.rows.filter((r) => r.status !== 'ok')),
  )
})

test('一致性脚本：默认只读，能发现缺失与不一致，--backfill 只补 NULL，--sync-from-real 按 REAL 改写', (t) => {
  const dir = tmp(t, 'money-audit-')
  const db = createDatabase({ dataDir: dir })
  const file = path.join(dir, 'kin.db')
  db.prepare(`INSERT INTO usage_logs (id, request_id, created_at, status, user_id, api_key_id, actual_cost_micros, actual_cost)
    VALUES ('a1', 'a1', '2026-11-06T04:00:00.000Z', 200, 'u', 'k', 5, 0.000005)`).run()
  db.close()
  const ok = spawnSync(process.execPath, [AUDIT, file, '--json'], { encoding: 'utf8' })
  assert.equal(ok.status, 0, ok.stderr)
  const okReport = JSON.parse(ok.stdout)
  assert.equal(okReport.ok, true)
  assert.equal(okReport.mode, 'read')
  const statsAgg = okReport.aggregates.find((a) => a.name.startsWith('usage_stats_hourly'))
  assert.deepEqual(statsAgg.micros, { detail: 5, rollup: 5, equal: true })

  // 旧版本（回滚期间）只写 REAL：整数列为 NULL；另一行 REAL 被改写，整数列过期
  const raw = new DatabaseSync(file)
  raw
    .prepare(`INSERT INTO usage_logs (id, request_id, created_at, status, user_id, api_key_id, actual_cost)
    VALUES ('a2', 'a2', '2026-11-06T04:10:00.000Z', 200, 'u', 'k', 0.25)`)
    .run()
  raw.prepare("UPDATE usage_logs SET actual_cost = 0.000009 WHERE id = 'a1'").run()
  raw.close()
  const mtime = fs.statSync(file).mtimeMs
  const bad = spawnSync(process.execPath, [AUDIT, file, '--json'], { encoding: 'utf8' })
  assert.equal(bad.status, 1)
  assert.equal(fs.statSync(file).mtimeMs, mtime, '只读模式不改库')
  const actual = JSON.parse(bad.stdout).rows.find((r) => r.table === 'usage_logs' && r.column === 'actual_cost')
  assert.equal(actual.missing_micros, 1)
  assert.equal(actual.mismatched, 1)
  assert.equal(actual.max_diff_micros, 4)

  const rw = new DatabaseSync(file)
  t.after(() => rw.close())
  assert.deepEqual(repair(rw, 'backfill'), [{ table: 'usage_logs', column: 'actual_cost', rows: 1 }])
  let report = runAudit(rw)
  assert.equal(report.rows.find((r) => r.column === 'actual_cost' && r.table === 'usage_logs').mismatched, 1)
  assert.equal(report.rows.find((r) => r.column === 'actual_cost' && r.table === 'usage_logs').missing_micros, 0)
  assert.deepEqual(repair(rw, 'sync-from-real'), [{ table: 'usage_logs', column: 'actual_cost', rows: 1 }])
  report = runAudit(rw)
  assert.equal(report.ok, true, JSON.stringify(report))
  assert.equal(rw.prepare('SELECT cost_micros FROM usage_stats_hourly').get().cost_micros, 250_009, '汇总经触发器同步')
  const text = execFileSync(process.execPath, [AUDIT, file], { encoding: 'utf8' })
  assert.match(text, /结论：一致/)
})

test('舍入：JS 回退与 SQLite ROUND 在全部范围内一致；有效范围（|x| < 2^51）内镜像往返精确；管理面输入同一口径', () => {
  const db = new DatabaseSync(':memory:')
  const q = db.prepare(
    'SELECT CAST(ROUND(? * 1000000) AS INTEGER) AS s, CAST(ROUND(? / 1000000.0 * 1000000) AS INTEGER) AS r',
  )
  let seed = 7
  const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647
  const values = [0.0000025, 0.0000005, -0.0000025, 1.0000015, 123456.7890125]
  for (let e = -7; e <= 9; e += 0.25)
    for (let i = 0; i < 300; i++) {
      const v = rnd() * 10 ** e * (rnd() < 0.2 ? -1 : 1)
      values.push(v, Number(v.toFixed(8)), (Math.floor(v * 1e6) + 0.5) / 1e6)
    }
  for (const v of values) {
    const m = toMicros(v)
    if (m == null) continue
    const row = q.get(v, m)
    assert.equal(m, row.s, `toMicros(${v})`)
    assert.equal(row.r, m, `SQL 往返 ${m}`)
    assert.equal(toMicros(fromMicros(m)), m, `JS 往返 ${m}`)
    assert.equal(rowMicros({ x: v }, 'x'), row.s)
  }
  for (const m of [MAX_MONEY_MICROS, -MAX_MONEY_MICROS, 2_251_799_813_685_000, 9_007_199_254]) {
    assert.equal(toMicros(fromMicros(m)), m)
    assert.equal(q.get(fromMicros(m), m).r, m)
  }
  // 上限附近抽样（2^50 到 2^51）：镜像往返仍精确
  for (let k = 0; k < 20000; k++) {
    const m = MAX_MONEY_MICROS - k * 56_294_995_342
    assert.equal(toMicros(fromMicros(m)), m, `JS 往返 ${m}`)
    assert.equal(q.get(fromMicros(m), m).r, m, `SQL 往返 ${m}`)
  }
  // 2^52 附近往返会多出 1（复审 P2-1 的反例），因此不在有效范围内
  assert.equal(toMicros(fromMicros(4_294_967_830_671_125)), null)
  assert.equal(toMicros(fromMicros(MAX_MONEY_MICROS) * 2), null, '超出有效范围')
  assert.equal(sqlRound(1000002.4999999999), 1000002)
  assert.equal(toMicros(1.0000025), 1000002, '1.0000025 × 1e6 = 1000002.4999999999，与 SQLite ROUND 相同计 1000002')
  // 管理面输入（充值、扣款、额度）与 toMicros 同一口径，.5 处不再有差异
  for (const v of [0.0000025, 1.0000015, 2.5, 0.1 + 0.2]) assert.equal(moneyMicros(v), toMicros(v))
  assert.equal(moneyMicros(-0.0000025, { negative: true }), toMicros(-0.0000025))
  assert.throws(() => moneyMicros(1e10), { code: 'invalid_amount' })
})

test('生图与文本一起分摊：已定价时各部分之和等于总额', () => {
  const imageUsage = {
    input_tokens: 101,
    output_tokens: 1337,
    total_tokens: 1438,
    input_tokens_details: { text_tokens: 77, image_tokens: 24, cached_tokens: 0 },
    output_tokens_details: { image_tokens: 1337, text_tokens: 0 },
  }
  for (const only of [false, true]) {
    const usage = { input_tokens: 333, output_tokens: 7, image_generation: { usage: imageUsage, model: null, only } }
    const c = calculateCost(usage, 'gpt-5.5')
    assert.equal(c.known, true)
    const parts = ['input', 'output', 'cache_read', 'cache_creation', 'web_search', 'image'].map(
      (k) => c[`${k}_cost_micros`] || 0,
    )
    assert.equal(
      parts.reduce((a, b) => a + b, 0),
      c.total_cost_micros,
      `only=${only}`,
    )
    const columns = costColumnsFromUsage(usage, 'gpt-5.5')
    assert.equal(columns.total_cost_micros, c.total_cost_micros)
    assert.equal(columns.image_cost_micros, c.image_cost_micros)
  }
})

test('媒体策略：新旧两种键都写；只有旧键（上一版本冻结在对账任务里）的策略照常计价', () => {
  const policy = groupMediaPolicy({
    image_count_billing: true,
    image_price_1k_micros: 50_000,
    web_search_price_per_call: 0.003,
  })
  assert.equal(policy.image_price_1k_micros, 50_000)
  assert.equal(policy.image_price_1k, 0.05)
  assert.equal(policy.web_search_price_per_call_micros, 3000)
  assert.equal(policy.web_search_price_per_call, 0.003)
  const legacy = JSON.parse(
    JSON.stringify({
      image_count_billing: true,
      image_rate_independent: false,
      image_price_1k: 0.08,
      web_search_price_per_call: 0.004,
    }),
  )
  const image = mediaCharge({ image_endpoint: true, image_count: 10, image_size: '1024x1024' }, legacy)
  assert.equal(image.total_cost_micros, 800_000)
  assert.equal(mediaCharge({ web_search_calls: 10 }, legacy).total_cost_micros, 40_000)
})

test('回滚兼容：上一版本只改 REAL 的 Key 用量与限额，升级回来后立刻计入，不被下一次记账抹掉', async (t) => {
  const db = freshDb(t)
  const store = new ApiKeyStore({ db, hashSecret: 'x'.repeat(32) })
  const created = await store.create({ name: 'k', quota: 10, rate_limit_5h: 5 })
  const id = created.id
  await store.recordUsage(await store.repo.getById(id), {}, { actualCostMicros: 2_000_000 })
  // 上一版本（M5）的记账与改限额：只改 REAL
  const now = new Date().toISOString()
  db.prepare(
    'UPDATE api_keys SET requests=requests+1, quota_used = quota_used + ?, usage_5h = usage_5h + ?, updated_at=? WHERE id=?',
  ).run(9, 9, now, id)
  db.prepare('UPDATE api_keys SET rate_limit_1d = 3.5 WHERE id=?').run(id)
  db.prepare(
    "INSERT INTO api_keys (id, name, key, key_hash, status, created_at, updated_at, quota, quota_used) VALUES ('old', 'o', 'hmac:o', 'o', 'active', 'x', 'x', 7.25, 1.5)",
  ).run()
  const rec = await store.repo.getById(id)
  assert.deepEqual(
    [rec.quota_used_micros, rec.usage_5h_micros, rec.rate_limit_1d_micros],
    [11_000_000, 11_000_000, 3_500_000],
  )
  const admitted = await store._admitStored(rec, Date.now())
  assert.equal(admitted.ok, false, 'USD 额度已用尽')
  await store.recordUsage(rec, {}, { actualCostMicros: 500_000 })
  const after = db.prepare('SELECT quota_used, quota_used_micros, usage_5h_micros FROM api_keys WHERE id=?').get(id)
  assert.deepEqual({ ...after }, { quota_used: 11.5, quota_used_micros: 11_500_000, usage_5h_micros: 11_500_000 })
  const old = await store.repo.getById('old')
  assert.deepEqual([old.quota_micros, old.quota_used_micros], [7_250_000, 1_500_000])
  // 新代码两列同写：触发器不改写整数值
  db.prepare("UPDATE api_keys SET quota_used_micros = 1, quota_used = 0.000001 WHERE id='old'").run()
  assert.equal(db.prepare("SELECT quota_used_micros m FROM api_keys WHERE id='old'").get().m, 1)
  assert.ok(
    runAudit(db)
      .rows.filter((r) => r.table === 'api_keys')
      .every((r) => r.status === 'ok'),
  )
})

test('回滚兼容：上一版本改的分组按张、按次单价与新建的分组，升级回来后照常生效', async (t) => {
  const db = freshDb(t)
  const groups = new GroupsRepo(db)
  const g = await groups.create({
    name: 'img',
    image_count_billing: true,
    image_price_1k: 0.05,
    web_search_price_per_call: 0.002,
  })
  const usage = { image_endpoint: true, image_count: 10, image_size: '1024x1024' }
  const charge = async () => {
    const policy = groupMediaPolicy(await groups.getById(g.id))
    return [
      mediaCharge(usage, policy).total_cost_micros,
      mediaCharge({ web_search_calls: 10 }, policy).total_cost_micros,
    ]
  }
  assert.deepEqual(await charge(), [500_000, 20_000])
  db.prepare('UPDATE groups SET image_price_1k=0.08, web_search_price_per_call=0.003 WHERE id=?').run(g.id)
  assert.deepEqual(await charge(), [800_000, 30_000], '旧写入方触发器同步了整数列')
  // 整数列为 NULL（触发器建立前就存在的旧行）：present() 按 REAL 回退，编辑时不把 NULL 写回 REAL
  db.exec('DROP TRIGGER groups_money_legacy_update')
  db.prepare('UPDATE groups SET image_price_1k_micros=NULL, web_search_price_per_call_micros=NULL WHERE id=?').run(g.id)
  assert.deepEqual(await charge(), [800_000, 30_000])
  const edited = await groups.update(g.id, { description: 'x' })
  assert.equal(edited.image_price_1k, 0.08)
  const row = db.prepare('SELECT image_price_1k, image_price_1k_micros FROM groups WHERE id=?').get(g.id)
  assert.deepEqual({ ...row }, { image_price_1k: 0.08, image_price_1k_micros: 80_000 })
})

test('回滚兼容：usage_logs 里上一版本写入或改写的行在启动补齐，汇总随之一致', async (t) => {
  const db = freshDb(t)
  const repo = new UsageLogsRepo(db, { billingMaintenance: false })
  db.prepare(`INSERT INTO usage_logs (id, request_id, created_at, status, user_id, api_key_id, account_id,
    total_cost_micros, total_cost, actual_cost_micros, actual_cost)
    VALUES ('n1', 'n1', '2026-11-06T05:00:00.000Z', 200, 'u', 'k', 'a', 1500000, 1.5, 1500000, 1.5)`).run()
  assert.equal(await repo.syncLegacyMoneyRows(), 0, '正常数据：漂移索引为空')
  const plan = db
    .prepare(`EXPLAIN QUERY PLAN SELECT rowid FROM usage_logs INDEXED BY idx_usage_logs_money_drift
      WHERE ${MONEY_DRIFT_FOR_TEST} LIMIT 1`)
    .all()
    .map((r) => r.detail)
    .join(' ')
  assert.match(plan, /idx_usage_logs_money_drift/)
  // 上一版本：插入只写 REAL；改写已有行的 REAL（重新定价、回执结算）
  db.prepare(`INSERT INTO usage_logs (id, request_id, created_at, status, user_id, api_key_id, account_id, total_cost, actual_cost)
    VALUES ('o1', 'o1', '2026-11-06T05:10:00.000Z', 200, 'u', 'k', 'a', 0.25, 0.25)`).run()
  db.prepare("UPDATE usage_logs SET actual_cost = 3.75, total_cost = 3.75 WHERE id = 'n1'").run()
  for (let i = 0; i < 5; i++)
    db.prepare(`INSERT INTO usage_logs (id, request_id, created_at, status, user_id, api_key_id, account_id, actual_cost)
      VALUES (?, ?, '2026-11-06T05:20:00.000Z', 200, 'u', 'k', 'a', 0.000001)`).run(`b${i}`, `b${i}`)
  const progress = []
  assert.equal(await repo.syncLegacyMoneyRows({ batch: 2, progressEvery: 4, onProgress: (n) => progress.push(n) }), 7)
  assert.deepEqual(progress, [4], '分批进度按阈值报告')
  const rows = db.prepare('SELECT id, total_cost_micros t, actual_cost_micros a FROM usage_logs ORDER BY id').all()
  assert.deepEqual({ ...rows.find((r) => r.id === 'n1') }, { id: 'n1', t: 3_750_000, a: 3_750_000 })
  assert.deepEqual({ ...rows.find((r) => r.id === 'o1') }, { id: 'o1', t: 250_000, a: 250_000 })
  const detail = db.prepare('SELECT SUM(actual_cost_micros) v FROM usage_logs').get().v
  assert.equal(db.prepare('SELECT SUM(cost_micros) v FROM usage_stats_hourly').get().v, detail)
  assert.equal(db.prepare('SELECT SUM(total_cost_micros) v FROM usage_cost_hourly').get().v, 4_000_000)
  assert.equal(await repo.syncLegacyMoneyRows(), 0)
  const audit = runAudit(db)
  assert.equal(audit.ok, true, JSON.stringify(audit.rows.filter((r) => r.status !== 'ok')))
})

const MONEY_DRIFT_FOR_TEST = [
  'input_cost',
  'output_cost',
  'cache_read_cost',
  'cache_creation_cost',
  'web_search_cost',
  'image_cost',
  'total_cost',
  'actual_cost',
]
  .map(
    (c) =>
      `(${c}_micros IS NOT CAST(ROUND(${c} * 1000000) AS INTEGER) AND (${c} IS NULL OR ABS(${c}) < 2251799813.685248))`,
  )
  .join(' OR ')

test('超大历史值：Key 限额按“不限”存 0；其余金额让迁移明确失败；读取越界整数不拖垮认证', async (t) => {
  const { db } = dbBefore(t, '126')
  db.prepare(`INSERT INTO api_keys (id, name, key, key_hash, status, created_at, updated_at, quota, quota_used, rate_limit_5h)
    VALUES ('big', 'k', 'hmac:h', 'h', 'active', 'x', 'x', 999999999999, 0, 1e15)`).run()
  applyMigrations(db, { migrationsDir: MIGRATIONS })
  const row = db
    .prepare("SELECT quota, quota_micros, rate_limit_5h, rate_limit_5h_micros FROM api_keys WHERE id='big'")
    .get()
  assert.deepEqual({ ...row }, { quota: 0, quota_micros: 0, rate_limit_5h: 0, rate_limit_5h_micros: 0 })
  // 回滚期上一版本再写超大限额：触发器同样按 0；直接写入的越界整数读出时按 NULL，认证不抛错
  db.prepare("UPDATE api_keys SET quota = 1e13 WHERE id='big'").run()
  assert.equal(db.prepare("SELECT quota_micros m FROM api_keys WHERE id='big'").get().m, 0)
  db.prepare("UPDATE api_keys SET usage_5h_micros = 9223372036854775807 WHERE id='big'").run()
  const repo = new ApiKeysRepo(db)
  const rec = await repo.getByHash('h')
  assert.equal(rec.usage_5h_micros, 0)
  assert.equal((await repo.list()).length, 1)
  assert.equal((await repo.getById('big')).quota_micros, 0)

  const amounts = dbBefore(t, '126').db
  amounts
    .prepare(
      `INSERT INTO usage_logs (id, created_at, status, total_cost, actual_cost) VALUES ('a', '2026-11-01T00:00:00Z', 200, 1e13, 1e13)`,
    )
    .run()
  assert.throws(() => applyMigrations(amounts, { migrationsDir: MIGRATIONS }), /m6_money_out_of_range__fix_rows_first/)
  assert.equal(
    amounts.prepare("SELECT COUNT(*) n FROM schema_migrations WHERE name='126_money_micros.sql'").get().n,
    0,
    '迁移整体回滚',
  )
})

test('一致性脚本写模式：汇总表不改；users 余额以整数为准只反向修 REAL；分批执行', (t) => {
  const db = freshDb(t)
  const now = new Date().toISOString()
  db.prepare(`INSERT INTO users (id, username, email, password_hash, role, status, created_at, updated_at, balance, balance_micros)
    VALUES ('u1', 'u1', 'u1@x', 'x', 'user', 'active', ?, ?, 4.0, 5000000)`).run(now, now)
  db.exec('PRAGMA foreign_keys = OFF')
  for (let i = 0; i < 7; i++)
    db.prepare(
      "INSERT INTO vendor_payments (id, settlement_id, idempotency_key, amount_usdt, action, reason, actor_user_id, created_at) VALUES (?, 's', ?, 1.25, 'payment', 'r', 'a', 'x')",
    ).run(`p${i}`, `k${i}`)
  db.exec('DROP TRIGGER vendor_payments_money_legacy_update')
  db.prepare('UPDATE vendor_payments SET amount_usdt_micros = NULL').run()
  assert.deepEqual(repair(db, 'backfill', { batch: 3 }), [{ table: 'vendor_payments', column: 'amount_usdt', rows: 7 }])
  assert.equal(db.prepare("SELECT balance_micros FROM users WHERE id='u1'").get().balance_micros, 5_000_000, '不碰余额')
  assert.deepEqual(repair(db, 'sync-from-real'), [
    { table: 'users', column: 'balance', rows: 1, direction: 'real_from_micros' },
  ])
  assert.deepEqual(
    { ...db.prepare("SELECT balance, balance_micros FROM users WHERE id='u1'").get() },
    { balance: 5, balance_micros: 5_000_000 },
  )
  db.prepare('UPDATE usage_stats_hourly SET cost = 99').run()
  assert.deepEqual(repair(db, 'sync-from-real'), [], '汇总表不改')
})

test('新建管理员：初始余额按整数口径记入管理域，用户行两列都清零（复审 P2-2）', async () => {
  const db = createDatabase({ dbPath: ':memory:' })
  try {
    const repo = new UsersRepo(db)
    const now = new Date().toISOString()
    const base = { password_hash: 'x', role: 'admin', created_at: now, updated_at: now }
    const a = await repo.insert({ ...base, id: 'adm1', username: 'adm1', balance_micros: 1_500_000, balance: 9 })
    assert.equal(a.balance_micros, 0)
    assert.equal(a.balance, 0)
    assert.equal(
      db.prepare('SELECT balance_micros FROM admin_domains WHERE id=?').get('adm1').balance_micros,
      1_500_000,
    )
    // 只给 REAL：与 SQLite ROUND 同口径（负的半值远离零）
    await repo.insert({ ...base, id: 'adm2', username: 'adm2', balance: -0.0000025 })
    assert.equal(
      db.prepare('SELECT balance_micros FROM admin_domains WHERE id=?').get('adm2').balance_micros,
      toMicros(-0.0000025),
    )
  } finally {
    db.close()
  }
})
