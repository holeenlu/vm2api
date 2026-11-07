import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { UsageLogsRepo } from '../../src/lib/db/repos/usage-logs-repo.mjs'
import { recordQuotaObservations } from '../../src/lib/usage/quota-observations.mjs'
import { vmWindowForecast } from '../../src/lib/usage/vm-quota-forecast.mjs'
import { dbTime } from '../../src/shared/system-time.mjs'

const HOUR = 3_600_000
const NOW = Date.parse('2026-11-04T12:00:00.000Z')
const RESET = NOW + 72 * HOUR
const START = RESET - 7 * 24 * HOUR

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-forecast-'))
  const db = createDatabase({ dataDir: dir })
  t.after(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  db.prepare("UPDATE schema_migrations SET applied_at = ? WHERE version = '001'").run(
    new Date(START - 86400_000).toISOString(),
  )
  const insert = db.prepare(
    "INSERT INTO usage_logs(id, request_id, created_at, model, status, account_id, vm_id, input_tokens, output_tokens, total_cost, pricing_model) VALUES(?,?,?,'gpt-5-codex',200,'acc','vm-1',?,0,?,'gpt-5-codex')",
  )
  let n = 0
  const use = (at, tokens, cost) => insert.run(`u${++n}`, `u${n}`, dbTime(at), tokens, cost)
  const observe = async (at, percent, reset = RESET) =>
    await recordQuotaObservations(
      'vm-1',
      { '7d': { utilization: percent / 100, reset: new Date(reset).toISOString() } },
      { db, now: at },
    )
  return { db, use, observe, repo: new UsageLogsRepo(db) }
}

const forecast = async (db, opts = {}) =>
  await vmWindowForecast(db, { vmId: 'vm-1', window: '7d', coveredSince: START - 86400_000, now: NOW, ...opts })

test('observations are written only when used% or the reset actually changes', async (t) => {
  const { db, observe } = fixture(t)
  assert.equal(await observe(START + HOUR, 10), 1)
  assert.equal(await observe(START + 2 * HOUR, 10), 0)
  // reset-after-seconds jitter is the same window
  assert.equal(await observe(START + 3 * HOUR, 10, RESET + 30_000), 0)
  assert.equal(await observe(START + 4 * HOUR, 11), 1)
  assert.equal(await observe(START + 5 * HOUR, 11, RESET + 5 * HOUR), 1)
  assert.equal(await recordQuotaObservations('vm-1', { '7d': { utilization: 0.5, reset: null } }, { db }), 0)
  assert.equal(await recordQuotaObservations('vm-1', { '7d': { utilization: null, reset: RESET } }, { db }), 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM quota_observations').get().n, 3)
})

test('without paired history the capacity is cycle spend divided by used%', async (t) => {
  const { db, use, observe } = fixture(t)
  use(START + HOUR, 1000, 4)
  use(START + 2 * HOUR, 1000, 8)
  await observe(START + 3 * HOUR, 40)
  const result = await forecast(db)
  assert.equal(result.status, 'ok')
  assert.ok(Math.abs(result.capacity_usd - 30) < 1e-9)
  assert.equal(result.capacity_tokens, 5000)
})

test('paired history samples the latest blocks instead of the whole cycle', async (t) => {
  const { db, use, observe } = fixture(t)
  // The first 10% burned fast and cheap; afterwards each 1% costs $0.1 and 1000 tokens.
  use(START + HOUR, 100, 0.01)
  await observe(START + HOUR + 1000, 10)
  for (let p = 11; p <= 40; p++) {
    const at = START + p * HOUR
    use(at, 1000, 0.1)
    await observe(at + 1000, p)
  }
  const result = await forecast(db)
  assert.equal(result.status, 'ok')
  // capacity = cycle spend + recent $/pp × remaining 60pp = 3.01 + 6
  assert.ok(Math.abs(result.capacity_usd - 9.01) < 1e-6, String(result.capacity_usd))
  assert.equal(Math.round(result.capacity_tokens), 30100 + 60000)
  assert.equal(result.low_sample, false)
})

test('a used% drop restarts sampling and the cycle window must still be open', async (t) => {
  const { db, use, observe } = fixture(t)
  for (let p = 1; p <= 20; p++) {
    use(START + p * HOUR, 1000, 0.1)
    await observe(START + p * HOUR + 1000, p)
  }
  await observe(START + 21 * HOUR, 12)
  assert.equal((await forecast(db)).status, 'resampling')
  assert.equal((await forecast(db, { now: RESET + 1 })).status, 'no_reset')
  assert.equal((await vmWindowForecast(db, { vmId: 'vm-2', window: '7d', now: NOW })).status, 'no_data')
})

test('billing statistics attach slot window forecasts to aligned account rows', async (t) => {
  const { db, use, observe, repo } = fixture(t)
  use(START + HOUR, 1000, 4)
  await observe(START + 2 * HOUR, 40)
  const stats = await repo.billingStats({
    accountWindows: [{ account_id: 'acc', vm_id: 'vm-1', reset_7d: new Date(RESET).toISOString() }],
    now: NOW,
  })
  const row = stats.accounts.find((a) => a.vm_id === 'vm-1')
  assert.equal(row.forecast_7d.status, 'ok')
  assert.ok(Math.abs(row.forecast_7d.capacity_usd - 10) < 1e-9)
  assert.equal(row.forecast_5h.status, 'no_data')
  assert.equal(row.forecast_fable, null)
  assert.equal((await repo.billingStats({ now: NOW })).accounts[0].forecast_7d, null)
})

test('concurrent identical readings write one observation (R6 B7 review P2-1)', async (t) => {
  const { db, observe } = fixture(t)
  assert.equal(await observe(START + HOUR, 10), 1)
  const written = await Promise.all([observe(START + 2 * HOUR, 20), observe(START + 2 * HOUR, 20)])
  assert.deepEqual(written.sort(), [0, 1])
  assert.deepEqual(
    db
      .prepare('SELECT used_percent FROM quota_observations ORDER BY id')
      .all()
      .map((row) => row.used_percent),
    [10, 20],
  )
})
