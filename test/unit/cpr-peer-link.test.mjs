import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { buildPeerLinkSnapshot, keyUsage } from '../../src/lib/protocol/cpr-peer-link.mjs'
import { normalizePeerSharing } from '../../src/lib/admin/peer-sharing.mjs'
import { ApiKeyStore } from '../../src/lib/admin/api-keys.mjs'

const now = Date.UTC(2026, 10, 3, 12)

function withDb(fn) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-peer-'))
    const db = createDatabase({ dataDir: dir })
    try {
      await fn(db)
    } finally {
      db.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
}

test('key usage reports the access verdict and only the configured budget windows', () => {
  const open = new Date(now - 3600_000).toISOString()
  const usage = keyUsage(
    { status: 'active', quota: 100, quota_used: 20, rate_limit_5h: 5, usage_5h: 5, window_5h_start: open },
    now,
  )
  assert.equal(usage.status, 'available')
  assert.equal(usage.data.allowed, false)
  assert.equal(usage.data.unit, 'USD')
  assert.deepEqual(
    usage.data.windows.map((w) => [w.key, w.used, w.remaining, w.limit_reached]),
    [
      ['total', '20', '80', false],
      ['5h', '5', '0', true],
    ],
  )
  assert.equal(usage.data.windows[1].reset_at, new Date(now + 4 * 3600_000).toISOString().replace('.000Z', 'Z'))
  // 窗口已过期：用量归零、不触顶，也不给出 reset_at
  const expired = keyUsage(
    { status: 'active', rate_limit_5h: 5, usage_5h: 9, window_5h_start: new Date(now - 6 * 3600_000).toISOString() },
    now,
  )
  assert.equal(expired.data.allowed, true)
  assert.equal(expired.data.windows[0].used, '0')
  assert.equal(expired.data.windows[0].reset_at, undefined)
  // 只有访问结论时不带金额窗口
  assert.deepEqual(keyUsage({ status: 'active' }, now).data, { allowed: true })
  assert.equal(keyUsage({ status: 'quota_exhausted' }, now).data.allowed, false)
})

test(
  'peer snapshot shares pool and anonymous quota windows only when enabled',
  withDb(async (db) => {
    db.exec('PRAGMA foreign_keys=OFF')
    db.prepare(
      "INSERT INTO groups(id,name,platform,status,models_json,created_at,updated_at) VALUES(7,'Codex','openai','active','[]','now','now')",
    ).run()
    const quota = (percent) =>
      JSON.stringify({
        primary_window: { used_percent: 10, window_minutes: 300, reset_at: new Date(now + 3600_000).toISOString() },
        secondary_window: {
          used_percent: percent,
          window_minutes: 10080,
          reset_at: new Date(now + 86_400_000).toISOString(),
        },
        plan_type: 'plus',
        updated_at: new Date(now - 60_000).toISOString(),
      })
    for (const [id, status, percent, models] of [
      ['acc_a', 'active', 40, { mode: 'all', models: [] }],
      ['acc_b', 'active', 100, { mode: 'allowlist', models: ['gpt-5.5'] }],
      ['acc_c', 'paused', 0, { mode: 'all', models: [] }],
    ]) {
      db.prepare(
        "INSERT INTO vendor_resources(id,vendor_id,resource_type,name,status,config_json,created_by,created_at,updated_at) VALUES(?,'v','account',?,?,?,'t','now','now')",
      ).run(
        id,
        id,
        status,
        JSON.stringify({
          platform: 'openai',
          execution_kind: 'gateway_worker',
          group_ids: [7],
          model_access: models,
          email: `${id}@example.com`,
        }),
      )
      db.prepare(
        "INSERT INTO gateway_worker_account_bindings(id,account_resource_id,gateway_instance_id,runtime_account_id,projection_status,quota_json,created_at,updated_at) VALUES(?,?,'gw','rt_'||?,'synced',?,'now','now')",
      ).run('b_' + id, id, id, quota(percent))
      db.prepare(
        "INSERT INTO group_resources(group_id,resource_kind,resource_id,priority) VALUES(7,'gateway_worker_account',?,0)",
      ).run(id)
    }
    const record = { id: 'key_1', status: 'active', group_id: 7, peer_sharing: '{"enabled":true}' }
    const minimal = buildPeerLinkSnapshot({ db, record, models: ['gpt-5.5'], now })
    assert.deepEqual(minimal.capabilities, ['key_usage'])
    assert.equal(minimal.pool, undefined)
    assert.equal(minimal.object, 'cpr.peer')
    assert.equal(minimal.schema_version, 2)

    const full = buildPeerLinkSnapshot({
      db,
      record: {
        ...record,
        peer_sharing: JSON.stringify({ enabled: true, share_pool: true, share_plans: true, share_quota: true }),
      },
      models: ['gpt-5.5', 'gpt-5.4'],
      now,
    })
    assert.deepEqual(full.capabilities, ['key_usage', 'pool_summary', 'quota_windows', 'model_availability'])
    assert.equal(full.pool.account_count, 3)
    assert.deepEqual(full.pool.states, { ready: 1, cooldown: 0, exhausted: 1, disabled: 1, error: 0, unknown: 0 })
    assert.deepEqual(full.pool.plans, [{ name: 'plus', count: 3 }])
    const text = JSON.stringify(full)
    assert.ok(!text.includes('acc_a') && !text.includes('example.com'), 'snapshot must not leak account identity')
    assert.equal(full.quota.accounts.length, 3)
    assert.match(full.quota.accounts[0].id, /^[0-9a-f]{32}$/)
    const exhausted = full.quota.accounts.find((a) => a.windows.some((w) => w.limit_reached))
    assert.deepEqual(exhausted.models, ['gpt-5.5'])
    const byModel = Object.fromEntries(full.models.map((m) => [m.model, m]))
    // gpt-5.5 有一个可用、一个耗尽的候选：可用；gpt-5.4 仅 acc_a 可用
    assert.equal(byModel['gpt-5.5'].state, 'available')
    assert.equal(byModel['gpt-5.5'].coverage, 'complete')
    assert.equal(byModel['gpt-5.4'].state, 'available')
    assert.ok(Date.parse(full.expires_at) - Date.parse(full.observed_at) <= 30 * 60_000)
  }),
)

test(
  'api keys persist peer sharing flags',
  withDb(async (db) => {
    const store = new ApiKeyStore({ db })
    const created = store.create({ name: 'peer', peer_sharing: { enabled: true, sharePool: true } })
    assert.deepEqual(normalizePeerSharing(store.getById(created.id).peer_sharing), {
      enabled: true,
      share_pool: true,
      share_plans: false,
      share_quota: false,
    })
    store.update(created.id, { peer_sharing: { enabled: false } })
    assert.equal(normalizePeerSharing(store.getById(created.id).peer_sharing).enabled, false)
    assert.deepEqual(
      normalizePeerSharing(store.getById(store.create({ name: 'plain' }).id).peer_sharing).enabled,
      false,
    )
  }),
)
