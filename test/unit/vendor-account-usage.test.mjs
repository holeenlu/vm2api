import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { VendorPlatform } from '../../src/lib/vendor/vendor-platform.mjs'
import { readVendorUsage, supplierAccountUsage, supplierUsage } from '../../src/lib/vendor/vendor-account-usage.mjs'
import { vendorGroupPlatforms } from '../../src/lib/vendor/vendor-groups.mjs'

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-usage-'))
  const db = createDatabase({ dataDir: dir })
  t.after(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const platform = new VendorPlatform(db, { vmProvisioner: ({ resourceId }) => ({ id: 'vm-' + resourceId }) })
  const parent = await platform.createRoot({
    actorUserId: 'sa',
    body: {
      username: 'parent',
      password: 'test-vendor-123',
      groups: ['1'],
      capabilities: ['vendor.create_child', 'vendor.vm.create', 'vendor.resource.manage', 'vendor.usage.read'],
    },
  })
  const identity = { vendor: parent, user_id: db.prepare("SELECT id FROM users WHERE username='parent'").get().id }
  const child = await platform.createChild(identity, { username: 'child', password: 'test-vendor-123' })
  const childIdentity = { vendor: child, user_id: db.prepare("SELECT id FROM users WHERE username='child'").get().id }
  const pair = await platform.createAccount(childIdentity, { platform: 'anthropic' })
  const vmId = pair.vm.config.runtime_vm_id
  const add = (id, stamp, { vm = vmId, status = 200, cost = 2, model = 'claude-fable-5' } = {}) =>
    db
      .prepare(
        `INSERT INTO usage_logs(id,request_id,vm_id,created_at,status,total_cost,actual_cost,model,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens,duration_ms,first_token_ms) VALUES (?,?,?,?,?,?,99,?,100,20,60,40,18000,3200)`,
      )
      .run(id, id, vm, stamp, status, cost, model)
  return { db, platform, identity, childIdentity, pair, vmId, add }
}
test('supplier usage uses official cost, disjoint tokens, success, latency and timezone boundaries', async (t) => {
  const f = await fixture(t),
    now = Date.parse('2026-10-30T00:00:00Z')
  f.add('yesterday', '2026-10-29T15:59:00.000Z')
  f.add('today', '2026-10-29T16:01:00.000Z', { status: 500, cost: 3 })
  f.add('other', '2026-10-29T16:01:00.000Z', { vm: 'other', cost: 999 })
  const all = await readVendorUsage(f.db, [f.vmId], { timezone: 'Asia/Shanghai' }, now)
  assert.equal(all.summary.requests, 2)
  assert.equal(all.summary.success_rate, 0.5)
  assert.equal(all.summary.cost_usd, 2)
  assert.equal(all.summary.tokens, 240)
  assert.equal(all.summary.total_tokens, 440)
  assert.equal(all.summary.cache_hit_rate, 0.3)
  assert.equal(all.summary.avg_duration_ms, 18000)
  assert.equal(all.summary.avg_ttft_ms, 3200)
  assert.equal(all.models[0].fable_cost_usd, 2)
  assert.deepEqual(
    all.trend.map((r) => [r.date, r.requests]),
    [
      ['2026-10-29', 1],
      ['2026-10-30', 1],
    ],
  )
  const custom = await readVendorUsage(
    f.db,
    [f.vmId],
    { range: 'custom', start_date: '2026-10-29', end_date: '2026-10-29', timezone: 'Asia/Shanghai' },
    now,
  )
  assert.equal(custom.summary.cost_usd, 2)
  assert.equal(custom.fixed_windows['7d'].cost_usd, 2)
  assert.equal(custom.fixed_windows['5h'].requests, 0)
  await assert.rejects(
    async () =>
      readVendorUsage(f.db, [f.vmId], { range: 'custom', start_date: '2026-02-30', end_date: '2026-03-01' }, now),
    (e) => e.code === 'invalid_usage_period',
  )
})
test('unknown prices remain unknown in totals, daily trend and model distribution', async (t) => {
  const f = await fixture(t)
  f.add('unknown', '2026-10-29T12:00:00.000Z', { cost: null })
  const usage = await readVendorUsage(f.db, [f.vmId], {}, Date.parse('2026-10-30T00:00:00Z'))
  assert.equal(usage.summary.cost_usd, null)
  assert.equal(usage.trend[0].cost_usd, null)
  assert.equal(usage.models[0].cost_usd, null)
})
test('parent reads child usage but peers and children cannot read outside their scope; archive retains history', async (t) => {
  const f = await fixture(t)
  f.add('real', new Date(Date.now() - 1000).toISOString())
  assert.equal((await supplierAccountUsage(f.platform, f.identity, f.pair.account.id)).summary.requests, 1)
  assert.equal((await supplierUsage(f.platform, f.identity, { query: { vendor_id: 'all' } })).summary.requests, 1)
  assert.equal((await supplierUsage(f.platform, f.childIdentity)).summary.requests, 1)
  const parentPair = await f.platform.createAccount(f.identity, {})
  await assert.rejects(
    async () => supplierAccountUsage(f.platform, f.childIdentity, parentPair.account.id),
    (e) => e.status === 403,
  )
  await assert.rejects(
    async () => supplierUsage(f.platform, f.childIdentity, { query: { vendor_id: 'all' } }),
    (e) => e.status === 403,
  )
  await f.platform.updateResource(f.childIdentity, f.pair.account.id, { status: 'archived' })
  assert.equal((await supplierAccountUsage(f.platform, f.childIdentity, f.pair.account.id)).summary.requests, 1)
})
test('platform, group model families and authorization must agree before provisioning', async (t) => {
  const f = await fixture(t)
  assert.deepEqual(vendorGroupPlatforms({ platform: 'mixed', models: ['gpt-5.2'] }), ['anthropic', 'openai'])
  assert.deepEqual(vendorGroupPlatforms({ platform: 'mixed', models: ['claude-sonnet-4', 'gpt-5.2'] }), [
    'anthropic',
    'openai',
  ])
  assert.deepEqual(vendorGroupPlatforms({ platform: 'anthropic', models: [] }), ['anthropic'])
  f.db.prepare("UPDATE groups SET platform='mixed',models_json='[\"gpt-5.2\"]' WHERE id=1").run()
  await assert.rejects(
    async () => f.platform.createAccount(f.identity, { platform: 'anthropic', authorization_kind: 'codex_oauth' }),
    (e) => e.code === 'authorization_platform_mismatch',
  )
  await assert.rejects(
    async () => f.platform.createAccount(f.identity, { platform: 'openai', authorization_kind: 'claude_setup_token' }),
    (e) => e.code === 'authorization_platform_mismatch',
  )
  assert.equal(
    (await f.platform.createAccount(f.identity, { platform: 'anthropic', group_ids: [1] })).account.config.platform,
    'anthropic',
  )
  assert.equal(
    (
      await f.platform.createAccount(f.identity, {
        platform: 'openai',
        group_ids: [1],
        authorization_kind: 'codex_account_file',
      })
    ).account.config.platform,
    'openai',
  )
})
test('gateway usage can be filtered by the actual authorization mode', async (t) => {
  const f = await fixture(t)
  const insert = f.db.prepare(
    `INSERT INTO usage_logs(id,request_id,created_at,status,total_cost,model,input_tokens,output_tokens,execution_kind,account_resource_id,authorization_mode)
     VALUES (?,?,?,200,?,'gpt-5.5',10,2,'gateway_worker','acct_gw',?)`,
  )
  insert.run('n1', 'n1', '2026-10-29T12:00:00.000Z', 1, 'native')
  insert.run('b1', 'b1', '2026-10-29T12:01:00.000Z', 2, 'bps')
  insert.run('b2', 'b2', '2026-10-29T12:02:00.000Z', 3, 'bps')
  const now = Date.parse('2026-10-30T00:00:00Z')
  assert.equal((await readVendorUsage(f.db, ['gateway:acct_gw'], {}, now)).summary.requests, 3)
  const bps = await readVendorUsage(f.db, ['gateway:acct_gw'], { authorization_mode: 'bps' }, now)
  assert.equal(bps.summary.requests, 2)
  assert.equal(bps.summary.cost_usd, 5)
  assert.equal(bps.authorization_mode, 'bps')
  assert.equal(
    (await readVendorUsage(f.db, ['gateway:acct_gw'], { authorization_mode: 'native' }, now)).summary.requests,
    1,
  )
  await assert.rejects(
    async () => readVendorUsage(f.db, ['gateway:acct_gw'], { authorization_mode: 'cloud' }, now),
    (e) => e.code === 'invalid_authorization_mode',
  )
})
