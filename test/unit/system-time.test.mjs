import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { systemDate, systemDateTime, systemDateTimeToIso, systemDayStartMs } from '../../src/shared/system-time.mjs'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { VendorPlatform } from '../../src/lib/vendor/vendor-platform.mjs'
import { vendorUsage, usagePeriod } from '../../src/lib/vendor/vendor-usage.mjs'
import { createGlobalPricing } from '../../src/lib/vendor/vendor-pricing.mjs'
import { previewDownstreamSettlements } from '../../src/lib/vendor/vendor-settlements.mjs'
import { UsageLogsRepo } from '../../src/lib/db/repos/usage-logs-repo.mjs'

test('system dates and form values use fixed UTC+8 across midnight, leap days and years', () => {
  assert.equal(systemDate('2026-10-31T15:59:59.999Z'), '2026-10-31')
  assert.equal(systemDate('2026-10-31T16:00:00Z'), '2026-11-01')
  assert.equal(systemDateTime('2026-12-31T16:00:00Z'), '2027-01-01T00:00:00')
  assert.equal(systemDateTimeToIso('2024-02-29'), '2024-02-28T16:00:00.000Z')
  assert.equal(systemDateTimeToIso('2026-11-01T08:30'), '2026-11-01T00:30:00.000Z')
  assert.equal(systemDateTimeToIso('2026-11-01T00:30:00Z'), '2026-11-01T00:30:00.000Z')
  assert.equal(new Date(systemDayStartMs(Date.parse('2026-10-31T16:30:00Z'))).toISOString(), '2026-10-31T16:00:00.000Z')
  assert.throws(() => systemDateTimeToIso('2026-02-30'), RangeError)
})

test('supplier report, day buckets and new settlement snapshots share UTC+8 boundaries', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'system-time-'))
  const db = createDatabase({ dataDir: dir })
  t.after(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const platform = new VendorPlatform(db)
  const parent = platform.createRoot({
    actorUserId: 'sa',
    body: {
      username: 'timezone-parent',
      password: 'timezone-test-pass',
      capabilities: ['vendor.create_child', 'vendor.settlement.read'],
    },
  })
  const identity = platform.identity(db.prepare("SELECT id FROM users WHERE username='timezone-parent'").get().id)
  const child = platform.createChild(identity, { username: 'timezone-child', password: 'timezone-test-pass' })
  createGlobalPricing(
    platform,
    { system_admin: true, user_id: 'sa' },
    {
      idempotency_key: 'timezone-prices',
      effective_date: '2026-01-01',
      openai_price: 2,
      claude_price: 2,
      exchange_rate: 5,
    },
  )
  const stamps = [
    '2026-10-31T15:59:59.999Z',
    '2026-10-31T16:00:00.000Z',
    '2026-11-01T15:59:59.999Z',
    '2026-11-01T16:00:00.000Z',
  ]
  for (const [i, stamp] of stamps.entries()) {
    db.prepare(`INSERT INTO vendor_usage_facts(id,vendor_id,model,input_tokens,output_tokens,cost_usd,occurred_at,source_request_id,created_at)
      VALUES (?,?,'claude-sonnet-4',100,20,?,?,?,?)`).run('tz-' + i, parent.id, i + 1, stamp, 'tz-' + i, stamp)
  }
  const period = usagePeriod({ start_date: '2026-11-01', end_date: '2026-11-02' })
  assert.deepEqual(period, { start: stamps[1], end: stamps[3], timezone: 'Asia/Shanghai' })
  const report = vendorUsage(db, [parent.id], { start_date: '2026-11-01', end_date: '2026-11-02' })
  assert.equal(report.summary.requests, 2)
  assert.equal(report.summary.cost_usd, 5)
  assert.deepEqual(
    report.trend.map((row) => [row.date, row.requests]),
    [['2026-11-01', 2]],
  )
  for (const [i, stamp] of stamps.entries()) {
    db.prepare('INSERT INTO usage_logs(id,request_id,created_at,status,total_cost) VALUES (?,?,?,200,1)').run(
      'log-' + i,
      'log-' + i,
      stamp,
    )
  }
  const buckets = new UsageLogsRepo(db).aggregate()
  assert.deepEqual(
    buckets.map((row) => [row.bucket, row.requests]),
    [
      ['2026-10-31', 1],
      ['2026-11-01', 2],
      ['2026-11-02', 1],
    ],
  )
  const before = db.prepare('SELECT occurred_at FROM vendor_usage_facts ORDER BY occurred_at').all()
  const preview = previewDownstreamSettlements(
    platform,
    identity,
    {
      vendor_ids: [child.id],
      start_date: '2026-11-01',
      end_date: '2026-11-01',
      timezone: 'America/New_York',
    },
    { now: Date.parse('2026-11-02T00:00:00Z') },
  ).items[0].statement
  assert.equal(preview.timezone, 'Asia/Shanghai')
  assert.equal(preview.start_at, stamps[1])
  assert.equal(preview.end_at, stamps[3])
  assert.deepEqual(db.prepare('SELECT occurred_at FROM vendor_usage_facts ORDER BY occurred_at').all(), before)
})
