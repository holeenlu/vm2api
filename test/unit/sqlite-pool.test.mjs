import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { closeDatabase, getDb, openDatabase } from '../../src/lib/db/database.mjs'
import { UsageLogsRepo } from '../../src/lib/db/repos/usage-logs-repo.mjs'
import { readAll, usageRead } from '../../src/lib/db/sqlite-pool.mjs'
import { readVendorUsage, readVendorUsagePooled } from '../../src/lib/vendor/vendor-account-usage.mjs'
import { createUsageQueryService } from '../../src/lib/vendor/queries/usage-query-service.mjs'
import { GatewayWorkerRepo } from '../../src/lib/gateway-worker/gateway-repo.mjs'
import {
  attachListForecasts,
  pooledQuotaForecast,
  quotaForecastForAccount,
} from '../../src/lib/gateway-worker/quota-forecast.mjs'

test('usage reads run on read-only workers and leave the event loop free', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-sqlite-pool-'))
  openDatabase({ dataDir: dir, pooled: true })
  try {
    await readAll('SELECT 1 AS n')
    let ticks = 0
    const timer = setInterval(() => {
      ticks += 1
    }, 5)
    const started = Date.now()
    const rows = await readAll(
      'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 4000000) SELECT max(x) AS n FROM c',
    )
    const elapsed = Date.now() - started
    clearInterval(timer)
    assert.equal(Number(rows[0].n), 4000000)
    assert.ok(elapsed >= 20, `scan finished too fast to observe the loop: ${elapsed}ms`)
    assert.ok(ticks > 0, `main thread did not tick during a ${elapsed}ms scan`)

    await assert.rejects(readAll('CREATE TABLE forbidden_write (id INTEGER)'), /readonly/)

    const local = new UsageLogsRepo(getDb()).totals()
    const remote = await usageRead({ kind: 'repo', method: 'totals' })
    assert.equal(Number(remote.requests), Number(local.requests))
  } finally {
    closeDatabase()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('supplier usage reports run on the read-only workers and keep input errors typed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-sqlite-pool-vendor-'))
  openDatabase({ dataDir: dir, pooled: true })
  try {
    const db = getDb()
    const now = Date.parse('2026-10-30T00:00:00Z')
    const add = (id) =>
      db
        .prepare(
          "INSERT INTO usage_logs(id,request_id,vm_id,created_at,status,total_cost,model,input_tokens,output_tokens) VALUES (?,?,'vm-pool','2026-10-29T12:00:00.000Z',200,1,'claude-fable-5',10,2)",
        )
        .run(id, id)
    add('committed')
    assert.deepEqual(await readVendorUsagePooled(db, ['vm-pool'], {}, now), readVendorUsage(db, ['vm-pool'], {}, now))
    // A worker connection only sees committed rows; the main connection also sees its own open transaction.
    db.exec('BEGIN')
    try {
      add('uncommitted')
      assert.equal(readVendorUsage(db, ['vm-pool'], {}, now).summary.requests, 2)
      assert.equal((await readVendorUsagePooled(db, ['vm-pool'], {}, now)).summary.requests, 1)
    } finally {
      db.exec('ROLLBACK')
    }
    await assert.rejects(readVendorUsagePooled(db, ['vm-pool'], { range: 'bogus' }, now), {
      code: 'invalid_usage_range',
    })
    await assert.rejects(createUsageQueryService().admin(db, ['none'], { start_date: 'bogus' }), {
      code: 'invalid_period',
    })
  } finally {
    closeDatabase()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('Codex list forecasts run on the read-only workers and serve an aged forecast while it refreshes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-sqlite-pool-forecast-'))
  openDatabase({ dataDir: dir, pooled: true })
  try {
    const db = getDb()
    const now = Date.parse('2026-11-04T12:00:00.000Z')
    const reset = now + 3 * 86400_000
    const start = reset - 7 * 86400_000
    const stamp = new Date(start - 86400_000).toISOString()
    db.prepare(
      "INSERT INTO vendors(id,name,external_code,email,tier,root_id,created_by,created_at,updated_at) VALUES('v1','V','v1','v@x',1,'v1','t',?,?)",
    ).run(stamp, stamp)
    db.prepare(
      `INSERT INTO vendor_resources(id,vendor_id,resource_type,name,status,config_json,created_by,created_at,updated_at)
       VALUES('acct-f','v1','account','A','active',?,'t',?,?)`,
    ).run(JSON.stringify({ platform: 'openai', execution_kind: 'gateway_worker' }), stamp, stamp)
    const repo = new GatewayWorkerRepo(db)
    repo.upsertInstance({
      id: 'gw-f',
      base_url: 'http://127.0.0.1:1',
      health_state: 'healthy',
      boot_id: 'b',
      protocol_version: 1,
    })
    db.prepare(
      `INSERT INTO gateway_worker_account_bindings(id,account_resource_id,gateway_instance_id,runtime_account_id,quota_json,created_at,updated_at)
       VALUES('bind-f','acct-f','gw-f','rt-f',?,?,?)`,
    ).run(
      JSON.stringify({
        secondary_window: { used_percent: 40, window_minutes: 10080, reset_at: new Date(reset).toISOString() },
        updated_at: new Date(now - 60_000).toISOString(),
      }),
      stamp,
      stamp,
    )
    const insert = db.prepare(
      "INSERT INTO usage_logs(request_id,created_at,model,status,execution_kind,account_resource_id,total_cost,input_tokens,output_tokens) VALUES(?,?,'gpt-5-codex',200,'gateway_worker','acct-f',?,1000,0)",
    )
    insert.run('w1', new Date(start + 3600_000).toISOString(), 4)
    const estimate = async (at) =>
      (await attachListForecasts(db, repo.listCodexAccounts(), at)).find((row) => row.id === 'acct-f').usage.estimate_7d
        .total_usd
    const account = repo.listCodexAccounts().find((row) => row.id === 'acct-f')
    assert.deepEqual(await pooledQuotaForecast(db, account, now), quotaForecastForAccount(db, account, now))
    // $4 logged at 40% → $10. The worker connection only sees committed rows, so a forecast computed
    // inline on the panel thread would include the open transaction's $4 and report $20.
    db.exec('BEGIN')
    try {
      insert.run('w2', new Date(start + 7200_000).toISOString(), 4)
      assert.ok(Math.abs((await estimate(now)) - 10) < 1e-9)
    } finally {
      db.exec('ROLLBACK')
    }
    // Same weekly reading after the 5-minute TTL: the aged forecast answers at once, one refresh
    // runs for concurrent polls, and the next poll reads its result.
    insert.run('w3', new Date(start + 10800_000).toISOString(), 4)
    const later = now + 6 * 60_000
    const [a, b] = await Promise.all([estimate(later), estimate(later)])
    assert.ok(Math.abs(a - 10) < 1e-9 && Math.abs(b - 10) < 1e-9)
    let refreshed = a
    for (const deadline = Date.now() + 5_000; Math.abs(refreshed - 20) > 1e-9 && Date.now() < deadline; ) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      refreshed = await estimate(later + 1)
    }
    assert.ok(Math.abs(refreshed - 20) < 1e-9, `refreshed estimate ${refreshed}`)
  } finally {
    closeDatabase()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
