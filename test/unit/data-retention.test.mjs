// 审计阶段 1 W5：数据生命周期与主线程减负（保留清单见 docs/data-retention.md）。
// - 使用记录、调试明细、请求尝试按保留期分批删除，批间让出事件循环；删完做 PASSIVE 检查点；
// - 保留期清理不扣减小时汇总（迁移 132 usage_prune_marker），人工删除仍扣减；迁移在已有数据上幂等；
// - 请求尝试与 Gateway Worker 历史挂在使用记录的 10 分钟清理周期上（RequestLogStore.cleanup）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applyMigrations, createDatabase } from '../../src/lib/db/database.mjs'
import { dbClient } from '../../src/lib/db/db-client.mjs'
import { UsageLogsRepo } from '../../src/lib/db/repos/usage-logs-repo.mjs'
import { RequestAttemptsRepo } from '../../src/lib/db/repos/request-attempts-repo.mjs'
import { RequestLogStore } from '../../src/lib/admin/request-log.mjs'
import { pruneGatewayWorkerHistory } from '../../src/lib/gateway-worker/repos/retention-repo.mjs'
import { auditAggregates } from '../../scripts/audit-money-micros.mjs'

const MIGRATIONS = 'src/lib/db/migrations'
const DAY = 86400_000
const iso = (msAgo, now = Date.now()) => new Date(now - msAgo).toISOString()

function tmpDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function freshDb(t) {
  const db = createDatabase({ dbPath: path.join(tmpDir(t, 'kin-retention-'), 'kin.db') })
  t.after(() => db.close())
  return db
}

// 批量写使用记录（触发器照常维护两张小时汇总）：n 行均匀分布在 [fromMsAgo, toMsAgo) 之间
function seedUsage(db, n, { fromMsAgo, toMsAgo, prefix = 'u', now = Date.now() }) {
  const insert = db.prepare(`INSERT INTO usage_logs (id, request_id, created_at, status, model, path, vm_id, account_id,
      user_id, api_key_id, input_tokens, output_tokens, duration_ms, total_cost_micros, total_cost, actual_cost_micros, actual_cost)
    VALUES (?, ?, ?, 200, 'claude-sonnet-4', '/v1/messages', 'vm-a', 'acc-1', 'u1', 'k1', ?, ?, 100, ?, ?, ?, ?)`)
  db.exec('BEGIN')
  for (let i = 0; i < n; i++) {
    const at = iso(fromMsAgo - ((fromMsAgo - toMsAgo) * i) / n, now)
    insert.run(
      `${prefix}${i}`,
      `${prefix}-req-${i}`,
      at,
      10 + (i % 7),
      3,
      1500 + i,
      0.0015 + i / 1e6,
      1000 + i,
      0.001 + i / 1e6,
    )
  }
  db.exec('COMMIT')
}

const rollups = (db) => ({
  cost: db.prepare('SELECT * FROM usage_cost_hourly ORDER BY hour, account_key, status_code, error_code').all(),
  stats: db.prepare('SELECT * FROM usage_stats_hourly ORDER BY hour, user_id, api_key_id, model').all(),
})

// 在 promise 结束前数一共让出了几次事件循环（setImmediate 回调跑了几次）
async function countYields(promise) {
  let yields = 0
  let done = false
  const spin = () => {
    if (done) return
    yields += 1
    setImmediate(spin)
  }
  setImmediate(spin)
  const value = await promise
  done = true
  return { value, yields }
}

test('retention prune keeps hourly rollups, while a manual delete still subtracts', async (t) => {
  const db = freshDb(t)
  seedUsage(db, 40, { fromMsAgo: 10 * DAY, toMsAgo: 8 * DAY, prefix: 'old' })
  seedUsage(db, 20, { fromMsAgo: 2 * DAY, toMsAgo: DAY, prefix: 'new' })
  const before = rollups(db)
  assert.ok(before.cost.length > 0 && before.stats.length > 0)

  const repo = new UsageLogsRepo(db)
  const result = await repo.cleanup({ retainDays: 7 })
  assert.equal(result.usage_logs, 40)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM usage_logs').get().n, 20)
  // 被清理的小时汇总原样保留（修复前触发器把它们扣成 0 并删行）
  assert.deepEqual(rollups(db), before)
  // 标记只在清理事务里存在
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM usage_prune_marker').get().n, 0)

  // 人工删除没有标记：仍从汇总扣回
  const row = db.prepare("SELECT * FROM usage_logs WHERE id = 'new0'").get()
  const hour = row.created_at.slice(0, 13)
  const requestsAt = () =>
    db.prepare('SELECT COALESCE(SUM(requests), 0) AS n FROM usage_cost_hourly WHERE hour = ?').get(hour).n
  const statsAt = () =>
    db.prepare('SELECT COALESCE(SUM(requests), 0) AS n FROM usage_stats_hourly WHERE hour = ?').get(hour).n
  const [cost0, stats0] = [requestsAt(), statsAt()]
  db.prepare("DELETE FROM usage_logs WHERE id = 'new0'").run()
  assert.equal(requestsAt(), cost0 - 1)
  assert.equal(statsAt(), stats0 - 1)
})

test('usage, debug and attempt pruning run in batches and yield to the event loop between them', async (t) => {
  const db = freshDb(t)
  seedUsage(db, 1200, { fromMsAgo: 20 * DAY, toMsAgo: 10 * DAY })
  const debug = db.prepare('INSERT INTO request_log_debug (request_id, ts, record_json) VALUES (?, ?, ?)')
  const attempt = db.prepare(
    'INSERT INTO request_attempts (request_id, attempt_no, started_at, model) VALUES (?, 1, ?, ?)',
  )
  db.exec('BEGIN')
  for (let i = 0; i < 1100; i++) {
    debug.run(`dbg-${i}`, iso(20 * DAY - i * 1000), '{}')
    attempt.run(`att-${i}`, iso(20 * DAY - i * 1000), 'm')
  }
  for (let i = 0; i < 3; i++) attempt.run(`att-new-${i}`, iso(i * 1000), 'm')
  db.exec('COMMIT')

  const repo = new UsageLogsRepo(db)
  const seen = []
  const client = repo.client
  repo.client = { ...client, exec: (sql) => (seen.push(sql), client.exec(sql)) }
  const usage = await countYields(repo.cleanup({ retainDays: 7, debugRetainDays: 3 }))
  assert.equal(usage.value.usage_logs, 1200)
  assert.equal(usage.value.debug_by_age, 1100)
  // 1200 行使用记录至少 3 批、1100 行调试明细至少 3 批：修复前一条 DELETE 删完，期间一次也不让出
  assert.ok(usage.yields >= 4, `yields=${usage.yields}`)
  // 删完做 PASSIVE 检查点，不再在主线程上 TRUNCATE
  assert.ok(seen.includes('PRAGMA wal_checkpoint(PASSIVE)'), seen.join(' | '))
  assert.ok(!seen.some((sql) => /TRUNCATE/i.test(sql)), seen.join(' | '))

  const attempts = await countYields(new RequestAttemptsRepo(db).cleanup(7))
  assert.equal(attempts.value, 1100)
  assert.ok(attempts.yields >= 2, `yields=${attempts.yields}`)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM request_attempts').get().n, 3)
})

test('request attempts and gateway history are pruned on the request-log cleanup cycle', async (t) => {
  const dataDir = tmpDir(t, 'kin-retention-store-')
  const db = createDatabase({ dbPath: path.join(dataDir, 'kin.db') })
  t.after(() => db.close())
  const store = new RequestLogStore({ dataDir, db, retainDays: 7 })
  db.prepare(
    "INSERT INTO request_attempts (request_id, attempt_no, started_at, model) VALUES ('r-old', 1, ?, 'm'), ('r-new', 1, ?, 'm')",
  ).run(iso(9 * DAY), iso(DAY))
  db.prepare(
    "INSERT INTO gateway_worker_dead_letters (id, kind, reference_id, payload_json, created_at) VALUES ('dl-old', 'receipt', 'x', '{}', ?), ('dl-new', 'receipt', 'y', '{}', ?)",
  ).run(iso(31 * DAY), iso(DAY))

  // 两次调用重叠时共用同一轮清理，不叠加
  const [first, second] = [store.cleanup(), store.cleanup()]
  assert.equal(first, second)
  await first
  assert.deepEqual(
    db
      .prepare('SELECT request_id FROM request_attempts ORDER BY request_id')
      .all()
      .map((r) => r.request_id),
    ['r-new'],
  )
  assert.deepEqual(
    db
      .prepare('SELECT id FROM gateway_worker_dead_letters')
      .all()
      .map((r) => r.id),
    ['dl-new'],
  )
})

test('gateway worker history keeps 30 days, open reconciliation jobs, and OAuth sessions until 7 days past expiry', async (t) => {
  const db = freshDb(t)
  const now = Date.parse('2026-11-07T12:00:00.000Z')
  const at = (days) => iso(days * DAY, now)
  db.prepare(
    "INSERT INTO gateway_worker_instances (id, name, base_url, health_state, created_at, updated_at) VALUES ('gw-01', 'gw-01', 'http://127.0.0.1:1', 'healthy', ?, ?)",
  ).run(at(60), at(60))
  const dispatch = db.prepare(
    "INSERT INTO gateway_worker_dispatches (dispatch_id, request_id, gateway_instance_id, nonce_hash, expires_at, created_at) VALUES (?, ?, 'gw-01', ?, ?, ?)",
  )
  const receipt = db.prepare(
    "INSERT INTO gateway_worker_receipts (receipt_id, dispatch_id, request_id, gateway_instance_id, payload_hash, created_at) VALUES (?, ?, ?, 'gw-01', 'h', ?)",
  )
  const job = db.prepare(
    "INSERT INTO gateway_worker_reconciliation_jobs (id, gateway_instance_id, dispatch_id, request_id, status, created_at, updated_at) VALUES (?, 'gw-01', ?, ?, ?, ?, ?)",
  )
  const letter = db.prepare(
    "INSERT INTO gateway_worker_dead_letters (id, kind, reference_id, payload_json, created_at) VALUES (?, 'receipt', ?, '{}', ?)",
  )
  const session = db.prepare(
    'INSERT INTO gateway_worker_oauth_sessions (session_id, state_hash, status, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
  db.exec('BEGIN')
  // 600 行超期，覆盖多批（表头取 500 行再按时间过滤）
  for (let i = 0; i < 600; i++) {
    dispatch.run(`d-old-${i}`, `r-${i}`, `n-${i}`, at(40), at(40))
    receipt.run(`rc-old-${i}`, `d-old-${i}`, `r-${i}`, at(40))
    letter.run(`dl-old-${i}`, `r-${i}`, at(40))
  }
  dispatch.run('d-new', 'r-new', 'n-new', at(1), at(1))
  receipt.run('rc-new', 'd-new', 'r-new', at(1))
  letter.run('dl-new', 'r-new', at(1))
  job.run('j-settled-old', 'd-old-0', 'r-0', 'settled', at(40), at(40))
  job.run('j-dead-old', 'd-old-1', 'r-1', 'dead_letter', at(40), at(35))
  job.run('j-pending-old', 'd-old-2', 'r-2', 'pending', at(40), at(40))
  job.run('j-settled-new', 'd-old-3', 'r-3', 'settled', at(40), at(10))
  session.run('s-expired-old', 'h1', 'expired', at(8), at(9), at(9))
  session.run('s-pending-old', 'h2', 'pending', at(8), at(9), at(9))
  session.run('s-completed-recent', 'h3', 'completed', at(6), at(7), at(7))
  session.run('s-pending-live', 'h4', 'pending', at(-1), at(0), at(0))
  db.exec('COMMIT')

  const { value: result, yields } = await countYields(pruneGatewayWorkerHistory(db, { now }))
  assert.deepEqual(result, {
    gateway_worker_receipts: 600,
    gateway_worker_dispatches: 600,
    gateway_worker_reconciliation_jobs: 2,
    gateway_worker_dead_letters: 600,
    gateway_worker_oauth_sessions: 2,
  })
  assert.ok(yields >= 3, `yields=${yields}`)
  const ids = (sql) =>
    db
      .prepare(sql)
      .all()
      .map((r) => Object.values(r)[0])
  assert.deepEqual(ids('SELECT receipt_id FROM gateway_worker_receipts'), ['rc-new'])
  assert.deepEqual(ids('SELECT dispatch_id FROM gateway_worker_dispatches'), ['d-new'])
  assert.deepEqual(ids('SELECT id FROM gateway_worker_dead_letters'), ['dl-new'])
  assert.deepEqual(ids('SELECT id FROM gateway_worker_reconciliation_jobs ORDER BY id'), [
    'j-pending-old',
    'j-settled-new',
  ])
  assert.deepEqual(ids('SELECT session_id FROM gateway_worker_oauth_sessions ORDER BY session_id'), [
    's-completed-recent',
    's-pending-live',
  ])
  // 第二轮没有可删的行
  assert.deepEqual(Object.values(await pruneGatewayWorkerHistory(db, { now })), [0, 0, 0, 0, 0])
})

test('migration 132 applies on existing data without touching rollups and can run again', (t) => {
  const root = tmpDir(t, 'kin-retention-mig-')
  for (const file of fs.readdirSync(MIGRATIONS))
    if (file.endsWith('.sql') && file < '132') fs.copyFileSync(path.join(MIGRATIONS, file), path.join(root, file))
  const db = createDatabase({ dbPath: path.join(root, 'kin.db'), migrationsDir: root })
  t.after(() => db.close())
  seedUsage(db, 30, { fromMsAgo: 3 * DAY, toMsAgo: DAY })
  const before = rollups(db)

  const file = '132_usage_prune_keeps_rollups.sql'
  fs.copyFileSync(path.join(MIGRATIONS, file), path.join(root, file))
  assert.deepEqual(applyMigrations(db, { migrationsDir: root }), [file])
  assert.deepEqual(rollups(db), before)
  // 再执行一遍迁移 SQL：不报错、汇总不变、每个触发器只有一个
  db.exec(fs.readFileSync(path.join(MIGRATIONS, file), 'utf8'))
  assert.deepEqual(rollups(db), before)
  const triggers = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN ('usage_cost_hourly_delete', 'usage_stats_hourly_delete') ORDER BY name",
    )
    .all()
    .map((r) => r.name)
  assert.deepEqual(triggers, ['usage_cost_hourly_delete', 'usage_stats_hourly_delete'])
})

test('money audit compares rollups with details only after the prune boundary', async (t) => {
  const db = freshDb(t)
  seedUsage(db, 20, { fromMsAgo: 10 * DAY, toMsAgo: 9 * DAY, prefix: 'old' })
  seedUsage(db, 20, { fromMsAgo: 2 * DAY, toMsAgo: DAY, prefix: 'new' })
  await new UsageLogsRepo(db).cleanup({ retainDays: 7 })
  for (const item of auditAggregates(db).filter((a) => /hourly/.test(a.name)))
    assert.equal(item.micros.equal, true, `${item.name}: ${JSON.stringify(item.micros)}`)
})

test('the prune marker never leaks: a failing batch rolls back with it', async (t) => {
  const db = freshDb(t)
  seedUsage(db, 5, { fromMsAgo: 10 * DAY, toMsAgo: 9 * DAY })
  const repo = new UsageLogsRepo(db)
  const client = dbClient(db)
  repo.client = {
    ...client,
    tx: (fn) =>
      client.tx(async (tx) => {
        await fn(tx)
        throw new Error('boom')
      }),
  }
  await assert.rejects(repo._pruneUsage(iso(7 * DAY)), /boom/)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM usage_prune_marker').get().n, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM usage_logs').get().n, 5)
})
