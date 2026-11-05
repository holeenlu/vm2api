import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { createGatewayWorkerReconciler } from '../../src/lib/gateway-worker/receipt-reconciler.mjs'

test('stale BPS catalogs are refreshed in the background; fresh ones and accounts without BPS are skipped (P4.5)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bps-catalog-'))
  const db = createDatabase({ dataDir: dir })
  try {
    const clock = Date.parse('2026-11-05T12:00:00Z')
    db.exec('PRAGMA foreign_keys=OFF')
    const insert = db.prepare(
      "INSERT INTO vendor_resources(id,vendor_id,resource_type,name,status,config_json,created_by,created_at,updated_at) VALUES(?,'v','account',?,?,?,'t','x','x')",
    )
    insert.run(
      'stale',
      'stale',
      'active',
      JSON.stringify({ bps_grant: true, bps_catalog: { fetched_at: '2026-11-05T01:00:00Z' } }),
    )
    insert.run('never', 'never', 'active', JSON.stringify({ bps_grant: true }))
    insert.run(
      'fresh',
      'fresh',
      'active',
      JSON.stringify({ bps_grant: true, bps_catalog: { fetched_at: '2026-11-05T11:00:00Z' } }),
    )
    insert.run('native', 'native', 'active', JSON.stringify({ bps_grant: false }))
    insert.run('paused', 'paused', 'paused', JSON.stringify({ bps_grant: true }))
    const calls = []
    const reconciler = createGatewayWorkerReconciler({
      db,
      now: () => clock,
      accountManager: {
        async bpsModels(id) {
          calls.push(id)
          if (id === 'never') throw new Error('worker down')
          return {}
        },
        reconcileBpsBlocks() {},
      },
    })
    assert.deepEqual(await reconciler.refreshBpsCatalogs(), { due: 2, refreshed: 1 })
    assert.deepEqual(calls, ['never', 'stale'], 'never-fetched catalogs come first')
    // 失败的账号 1 小时内不再重试（R4 审查 P2-6）
    calls.length = 0
    assert.deepEqual(await reconciler.refreshBpsCatalogs(), { due: 1, refreshed: 1 })
    assert.deepEqual(calls, ['stale'])
  } finally {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
