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
