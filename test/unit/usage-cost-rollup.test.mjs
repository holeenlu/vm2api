import { moneySql } from '../../src/lib/db/repos/money-sql.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { UsageLogsRepo } from '../../src/lib/db/repos/usage-logs-repo.mjs'
import { SLA_ERROR_PRED, SLA_SUCCESS_PRED, PROMPT_TOKENS_SQL } from '../../src/lib/db/repos/usage-log-preds.mjs'
import { BILLING_ACCOUNT_KEY_SQL } from '../../src/lib/db/repos/usage-cost-rollup.mjs'

const HOUR = 3_600_000
const NOW = Date.parse('2026-11-04T12:34:56.789Z')

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-rollup-'))
  const db = createDatabase({ dataDir: dir })
  t.after(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return { db, repo: new UsageLogsRepo(db) }
}

// Deterministic pseudo-random rows over 9 days, several accounts / slots, Fable models,
// success / error / SLA-ok statuses and unpriced rows.
function seed(db) {
  let x = 7
  const rand = () => (x = (x * 1103515245 + 12345) % 2 ** 31) / 2 ** 31
  const pick = (list) => list[Math.floor(rand() * list.length)]
  const insert =
    db.prepare(`INSERT INTO usage_logs(id, request_id, created_at, model, upstream_model, pricing_model, status, error_code,
    account_id, final_account_id, vm_id, execution_kind, account_resource_id,
    input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
    input_cost, output_cost, cache_read_cost, cache_creation_cost, total_cost)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  for (let i = 0; i < 1500; i++) {
    const at = new Date(NOW - Math.floor(rand() * 9 * 24 * HOUR)).toISOString()
    const account = pick(['acc-a', 'acc-b', 'acc-c', ''])
    const vm = pick(['vm-1', 'vm-2', null])
    const model = pick(['claude-opus-5', 'claude-fable-5', 'gpt-5-codex'])
    const status = pick([200, 200, 200, 429, 500, 400])
    const error =
      status === 200 ? pick([null, null, '']) : pick(['rate_limited', 'upstream_error', 'pool_overloaded', null])
    const tokens = [1, 2, 3, 4].map(() => Math.floor(rand() * 1000))
    const costs = [1, 2, 3, 4].map(() => Math.round(rand() * 1e6) / 1e8)
    insert.run(
      `r${i}`,
      `r${i}`,
      at,
      model,
      pick([null, '', model]),
      pick(['claude-opus-5', 'unpriced']),
      status,
      error,
      account,
      pick([null, '', account]),
      vm,
      pick(['', 'gateway_worker']),
      pick(['', 'res-1']),
      ...tokens,
      ...costs,
      costs.reduce((a, b) => a + b, 0),
    )
  }
}

// Reference: one direct scan of usage_logs per span, exactly what the readers replaced.
function reference(db, { since, fable = false }) {
  const rows = db
    .prepare(`SELECT ${BILLING_ACCOUNT_KEY_SQL} AS account_id, NULLIF(vm_id, '') AS vm_id,
      COUNT(*) AS requests,
      SUM(CASE WHEN ${SLA_SUCCESS_PRED} THEN 1 ELSE 0 END) AS success,
      SUM(CASE WHEN ${SLA_ERROR_PRED} THEN 1 ELSE 0 END) AS errors,
      SUM(IFNULL(input_tokens,0)) AS input_tokens, SUM(IFNULL(output_tokens,0)) AS output_tokens,
      SUM(${PROMPT_TOKENS_SQL}) AS prompt_tokens, SUM(IFNULL(${moneySql('total_cost')},0)) / 1000000.0 AS total_cost,
      SUM(CASE WHEN pricing_model='unpriced' AND IFNULL(input_tokens,0)+IFNULL(output_tokens,0)+IFNULL(cache_read_tokens,0)+IFNULL(cache_creation_tokens,0) > 0 THEN 1 ELSE 0 END) AS unpriced
      FROM usage_logs WHERE created_at >= ? ${fable ? "AND instr(lower(COALESCE(NULLIF(trim(upstream_model),''), trim(model), '')), 'fable') > 0" : ''}
      GROUP BY 1, 2`)
    .all(new Date(since).toISOString())
  return new Map(rows.map((r) => [`${r.account_id}\0${r.vm_id || ''}`, r]))
}

function assertBucket(actual, expected, label) {
  for (const field of ['requests', 'success', 'errors', 'input_tokens', 'output_tokens', 'prompt_tokens', 'unpriced']) {
    assert.equal(Number(actual?.[field] || 0), Number(expected?.[field] || 0), `${label} ${field}`)
  }
  assert.ok(Math.abs(Number(actual?.total_cost || 0) - Number(expected?.total_cost || 0)) < 1e-7, `${label} total_cost`)
}

async function assertMatchesScan(db, repo) {
  const windows = [
    { account_id: 'acc-a', vm_id: 'vm-1', reset_5h: new Date(NOW + 2 * HOUR + 17 * 60_000).toISOString() },
    {
      account_id: 'acc-b',
      vm_id: 'vm-2',
      reset_7d: new Date(NOW + 3 * 24 * HOUR + 41 * 60_000).toISOString(),
      reset_7d_oi: new Date(NOW - 26 * 60_000).toISOString(),
    },
    { account_id: 'acc-c', vm_id: null, reset_5h: new Date(NOW - 3 * HOUR).toISOString() },
  ]
  const aligned = await repo.billingStats({ accountWindows: windows, now: NOW })
  const rolling = await repo.billingStats({ now: NOW })
  const total = reference(db, { since: 0 })
  for (const stats of [aligned, rolling]) {
    assert.equal(stats.accounts.length, total.size)
    for (const a of stats.accounts)
      assertBucket(a, total.get(`${a.account_id}\0${a.vm_id || ''}`), `total ${a.account_id}`)
  }
  for (const a of aligned.accounts) {
    const key = `${a.account_id}\0${a.vm_id || ''}`
    assertBucket(a.window_5h, reference(db, { since: Date.parse(a.window_5h_start) }).get(key), `5h ${key}`)
    assertBucket(a.window_7d, reference(db, { since: Date.parse(a.window_7d_start) }).get(key), `7d ${key}`)
    if (a.window_fable) {
      const fable = reference(db, { since: Date.parse(a.window_fable.start), fable: true }).get(key)
      assert.equal(a.window_fable.requests, Number(fable?.requests || 0), `fable ${key}`)
      assert.ok(Math.abs(a.window_fable.cost - Number(fable?.total_cost || 0)) < 1e-7, `fable cost ${key}`)
    }
  }
  const five = reference(db, { since: NOW - 5 * HOUR })
  const seven = reference(db, { since: NOW - 7 * 24 * HOUR })
  for (const a of rolling.accounts) {
    const key = `${a.account_id}\0${a.vm_id || ''}`
    assertBucket(a.window_5h, five.get(key), `rolling 5h ${key}`)
    assertBucket(a.window_7d, seven.get(key), `rolling 7d ${key}`)
  }
  const sum = (map) => [...map.values()].reduce((n, r) => n + Number(r.requests), 0)
  assert.equal(rolling.window_5h.requests, sum(five))
  assert.equal(rolling.window_7d.requests, sum(seven))
  // The rollup itself equals a fresh rebuild of usage_logs.
  // M6：金额按整数微单位比较（明细逐行 x_micros，未写整数列的行按 ROUND(x * 1e6) 派生），逐项相等
  const rebuilt = db
    .prepare(`SELECT COUNT(*) AS n, SUM(IFNULL(${moneySql('total_cost')},0)) AS c FROM usage_logs`)
    .get()
  const rolled = db.prepare('SELECT SUM(requests) AS n, SUM(total_cost_micros) AS c FROM usage_cost_hourly').get()
  assert.equal(Number(rolled.n || 0), Number(rebuilt.n || 0))
  assert.equal(Number(rolled.c || 0), Number(rebuilt.c || 0))
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM usage_cost_hourly WHERE requests <= 0').get().n, 0)
}

test('hourly rollup readers equal a direct usage_logs scan through inserts, repricing, slot rewrites and pruning', async (t) => {
  const { db, repo } = fixture(t)
  seed(db)
  await assertMatchesScan(db, repo)

  db.prepare(
    "UPDATE usage_logs SET total_cost = total_cost * 3, input_tokens = input_tokens + 7 WHERE id LIKE 'r1%'",
  ).run()
  db.prepare("UPDATE usage_logs SET vm_id = 'gateway:res-1' WHERE vm_id IS NULL AND id LIKE 'r2%'").run()
  db.prepare("UPDATE usage_logs SET upstream_model = 'claude-fable-5', status = 500 WHERE id LIKE 'r3%'").run()
  db.prepare("UPDATE usage_logs SET billing_status = 'settled', actual_cost = 1 WHERE id LIKE 'r4%'").run()
  await assertMatchesScan(db, repo)

  db.prepare('DELETE FROM usage_logs WHERE created_at < ?').run(new Date(NOW - 8 * 24 * HOUR).toISOString())
  db.prepare("DELETE FROM usage_logs WHERE id LIKE 'r5%'").run()
  await assertMatchesScan(db, repo)
})

test('migration backfills the rollup from existing usage rows', (t) => {
  const { db } = fixture(t)
  seed(db)
  const before = db
    .prepare('SELECT hour, account_key, SUM(requests) AS n FROM usage_cost_hourly GROUP BY 1, 2 ORDER BY 1, 2')
    .all()
  db.exec('DELETE FROM usage_cost_hourly')
  const migration = fs.readFileSync('src/lib/db/migrations/093_usage_cost_rollup.sql', 'utf8')
  const backfill = migration.slice(
    migration.indexOf('INSERT INTO usage_cost_hourly'),
    migration.indexOf('CREATE TRIGGER'),
  )
  db.exec(backfill)
  assert.deepEqual(
    db.prepare('SELECT hour, account_key, SUM(requests) AS n FROM usage_cost_hourly GROUP BY 1, 2 ORDER BY 1, 2').all(),
    before,
  )
})
