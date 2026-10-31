import { createLegacyVendor, createLegacyChild, seedLegacyContract } from '../fixtures/vendor-legacy-pricing.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase, applyMigrations } from '../../src/lib/db/database.mjs'
import { VendorPlatform } from '../../src/lib/vendor/vendor-platform.mjs'
import { UsageLogsRepo } from '../../src/lib/db/repos/usage-logs-repo.mjs'
import { vendorUsage } from '../../src/lib/vendor/vendor-usage.mjs'
import { supplierBilling } from '../../src/lib/vendor/vendor-settlements.mjs'
import { readVendorUsage, supplierUsage } from '../../src/lib/vendor/vendor-account-usage.mjs'
import { createGlobalPricing } from '../../src/lib/vendor/vendor-pricing.mjs'
import {
  adminVendors,
  adminResources,
  updateAdminVendor,
  settlementPreview,
  createSettlement,
  settlementAction,
  listSettlements,
} from '../../src/lib/vendor/vendor-admin.mjs'
import { deriveScheduleFields, applyScheduleOff } from '../../src/lib/pool/schedule-state.mjs'
function fixture(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supplier-admin-'))
  const db = createDatabase({ dataDir: dir })
  t.after(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const platform = new VendorPlatform(db)
  const vendor = createLegacyVendor(platform, {
    actorUserId: 'sa',
    body: {
      username: 'supplier-a',
      groups: ['1'],
      password: 'supplier-test-123',
      email: 'a@test',
      external_code: 'a',
      capabilities: [
        'vendor.resource.manage',
        'vendor.vm.create',
        'vendor.create_child',
        'vendor.usage.read',
        'vendor.settlement.read',
      ],
      default_price_cny_per_usd: 2,
      fx_cny_per_usdt: 5,
      default_multiplier: 1,
      ...overrides,
    },
  })
  createGlobalPricing(
    platform,
    { system_admin: true, user_id: 'sa' },
    {
      idempotency_key: 'fixture-global-pricing',
      effective_date: '2026-10-01',
      openai_price: 2,
      claude_price: 2,
      exchange_rate: 5,
    },
  )
  const identity = { user_id: 'sa', vendor }
  const pair = platform.createAccount(identity, { name: 'Account A', platform: 'anthropic' })
  db.prepare('UPDATE vendor_resources SET config_json=? WHERE id=?').run(
    JSON.stringify({ runtime_vm_id: 'vm-supplier' }),
    pair.vm.id,
  )
  db.prepare("INSERT INTO vms (id,name,vm_json) VALUES ('vm-supplier','supplier','{}')").run()
  const repo = new UsageLogsRepo(db)
  const insert = (id, overrides = {}) =>
    repo.insertSummary({
      id,
      request_id: id,
      vm_id: 'vm-supplier',
      status: 200,
      created_at: '2026-10-01T12:00:00.000Z',
      model: 'claude-test',
      input_tokens: 100,
      output_tokens: 20,
      total_cost: 10,
      ...overrides,
    })
  return { db, platform, vendor, identity, pair, repo, insert }
}
const period = { start_date: '2026-10-01', end_date: '2026-10-02' }
test('request ingestion feeds both supplier consoles once and survives usage-log pruning', (t) => {
  const { db, platform, vendor, identity, repo, insert } = fixture(t)
  insert('success')
  insert('failed', { status: 500, total_cost: 99 })
  insert('platform', { vm_id: null, total_cost: 99 })
  assert.equal(repo.insertSummaryIfAbsent({ id: 'success', request_id: 'success', status: 200 }), false)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM vendor_usage_facts').get().n, 1)
  const admin = vendorUsage(db, [vendor.id], period)
  const supplier = supplierUsage(platform, identity, { query: period })
  assert.equal(supplier.summary.cost_usd, admin.summary.cost_usd)
  assert.equal(supplier.summary.requests, 2)
  assert.equal(supplier.summary.errors, 1)
  assert.equal(admin.summary.cost_usd, 10)
  assert.equal(admin.summary.requests, 2)
  db.prepare("DELETE FROM usage_logs WHERE request_id='success'").run()
  assert.equal(vendorUsage(db, [vendor.id], period).summary.cost_usd, 10)
  assert.equal(vendorUsage(db, [vendor.id], { start_date: '2026-10-02', end_date: '2026-10-03' }).summary.requests, 0)
  assert.throws(
    () => supplierUsage(platform, identity, { query: { ...period, vendor_id: 'outside' } }),
    (e) => e.code === 'vendor_scope_forbidden',
  )
})
test('retained old logs and new facts have a single aggregation path', (t) => {
  const { db, vendor, insert } = fixture(t)
  insert('old')
  insert('new')
  db.prepare("DELETE FROM vendor_usage_facts WHERE source_request_id='old'").run()
  const summary = vendorUsage(db, [vendor.id], period).summary
  assert.equal(summary.requests, 2)
  assert.equal(summary.cost_usd, 20)
  assert.throws(
    () => vendorUsage(db, [vendor.id], { start_date: 'bad', end_date: '2026-10-02' }),
    (e) => e.code === 'invalid_period',
  )
})
test('statements freeze shared usage, reject overlaps and enforce payment idempotency', (t) => {
  const { platform, vendor, identity, insert } = fixture(t)
  insert('paid-usage')
  const preview = settlementPreview(platform, vendor.id, period)
  assert.equal(preview.amount_usdt, 4)
  const statement = createSettlement(platform, vendor.id, period, 'sa')
  assert.equal(createSettlement(platform, vendor.id, period, 'sa').id, statement.id)
  assert.throws(
    () => createSettlement(platform, vendor.id, { start_date: '2026-09-30', end_date: '2026-10-02' }, 'sa'),
    (e) => e.code === 'settlement_overlap',
  )
  assert.equal(supplierBilling(platform, identity).upstream[0].usage.cost_usd, 10)
  assert.throws(
    () =>
      settlementAction(
        platform,
        statement.id,
        'payments',
        { amount_usdt: 1, idempotency_key: 'p0', reason: 'receipt' },
        'sa',
      ),
    (e) => e.code === 'invalid_settlement_state',
  )
  settlementAction(platform, statement.id, 'confirm', {}, 'sa')
  const body = { amount_usdt: 1, idempotency_key: 'p1', reason: 'receipt-1' }
  settlementAction(platform, statement.id, 'payments', body, 'sa')
  settlementAction(platform, statement.id, 'payments', body, 'sa')
  assert.equal(listSettlements(platform)[0].paid_usdt, 1)
  assert.equal(supplierBilling(platform, identity).upstream[0].status, 'partial')
  assert.throws(
    () => settlementAction(platform, statement.id, 'payments', { ...body, amount_usdt: 2 }, 'sa'),
    (e) => e.code === 'idempotency_conflict',
  )
  assert.throws(
    () =>
      settlementAction(
        platform,
        statement.id,
        'payments',
        { amount_usdt: 4, idempotency_key: 'p2', reason: 'receipt' },
        'sa',
      ),
    (e) => e.code === 'payment_exceeds_due',
  )
  assert.throws(
    () => settlementAction(platform, statement.id, 'void', { reason: 'wrong' }, 'sa'),
    (e) => e.code === 'invalid_settlement_state',
  )
  settlementAction(
    platform,
    statement.id,
    'payments',
    { amount_usdt: 3, idempotency_key: 'p3', reason: 'receipt-3' },
    'sa',
  )
  assert.equal(supplierBilling(platform, identity).upstream[0].status, 'paid')
  insert('late')
  assert.equal(listSettlements(platform)[0].amount_usdt, 4)
  assert.equal(listSettlements(platform)[0].usage.usage.requests, 1)
})
test('supplier policies share records and reject limits below inventory', (t) => {
  const { platform, vendor, identity } = fixture(t)
  assert.equal(adminResources(platform, 'account').length, 1)
  assert.equal(adminVendors(platform)[0].account_count, 1)
  const updated = updateAdminVendor(platform, vendor.id, { create_child: false }, 'sa')
  assert.equal(updated.id, vendor.id)
  assert.ok(!updated.capabilities.includes('vendor.create_child'))
  platform.createAccount(identity, { name: 'Account B' })
  assert.throws(
    () => updateAdminVendor(platform, vendor.id, { account_limit: 1 }, 'sa'),
    (e) => e.code === 'limit_below_usage',
  )
})
test('supplier disable cannot be cleared by ordinary VM scheduling or credential changes', () => {
  const vm = {
    status: 'running',
    vendor_disabled: true,
    schedule_off: true,
    unschedulable: { reason: 'no_credential' },
  }
  applyScheduleOff(vm, false)
  assert.equal(vm.schedulable, false)
  assert.equal(vm.schedule_disabled_reason, 'vendor_disabled')
  vm.vendor_disabled = false
  vm.unschedulable = { reason: 'no_credential' }
  deriveScheduleFields(vm)
  assert.equal(vm.schedulable, false)
  assert.equal(vm.schedule_disabled_reason, 'no_credential')
})

test('unpriced requests block settlement, and changed preview cannot be confirmed silently', (t) => {
  const { db, platform, vendor, insert } = fixture(t)
  insert('unpriced', { total_cost: 0, pricing_model: 'unpriced' })
  assert.equal(vendorUsage(db, [vendor.id], period).summary.unpriced_requests, 1)
  assert.throws(
    () => settlementPreview(platform, vendor.id, period),
    (e) => e.code === 'settlement_unpriced_usage',
  )
  db.prepare("UPDATE usage_logs SET total_cost=10,pricing_model='priced' WHERE request_id='unpriced'").run()
  const preview = settlementPreview(platform, vendor.id, period)
  insert('arrived-later')
  assert.throws(
    () =>
      createSettlement(
        platform,
        vendor.id,
        { ...period, expected_amount_usdt: preview.amount_usdt, contract_version: preview.contract_version },
        'sa',
      ),
    (e) => e.code === 'settlement_preview_changed',
  )
})
test('platform statements include child usage once and child bills show the same downstream statement', (t) => {
  const { db, platform, vendor, identity, insert } = fixture(t)
  const child = createLegacyChild(platform, identity, {
    name: 'Child',
    email: 'child@test',
    external_code: 'child',
    username: 'child-supplier',
    password: 'test-password',
  })
  const childIdentity = { user_id: 'sa', vendor: child }
  const pair = platform.createAccount(childIdentity, { name: 'Child account' })
  db.prepare('UPDATE vendor_resources SET config_json=? WHERE id=?').run(
    JSON.stringify({ runtime_vm_id: 'vm-child' }),
    pair.vm.id,
  )
  db.prepare("INSERT INTO vms (id,name,vm_json) VALUES ('vm-child','child','{}')").run()
  insert('root-usage')
  insert('child-usage', { vm_id: 'vm-child' })
  assert.equal(settlementPreview(platform, vendor.id, period).usage.cost_usd, 20)
  const downstream = createSettlement(platform, child.id, period, 'sa', vendor.id)
  assert.equal(supplierBilling(platform, childIdentity).upstream[0].id, downstream.id)
  assert.equal(supplierBilling(platform, identity).downstream[0].id, downstream.id)
  assert.throws(
    () => settlementAction(platform, downstream.id, 'confirm', {}, 'sa'),
    (e) => e.code === 'settlement_payer_scope',
  )
  updateAdminVendor(platform, vendor.id, { status: 'disabled' }, 'sa')
  assert.throws(
    () => platform.createAccount(childIdentity, { name: 'must not create' }),
    (e) => e.code === 'vendor_inactive',
  )
})

test('zero-value statements settle without a payment and void records are not overwritten', (t) => {
  const { platform, vendor } = fixture(t)
  const zero = createSettlement(platform, vendor.id, period, 'sa')
  assert.equal(settlementAction(platform, zero.id, 'confirm', {}, 'sa').status, 'paid')
  const anotherPeriod = { start_date: '2026-10-02', end_date: '2026-10-03' }
  const voided = createSettlement(platform, vendor.id, anotherPeriod, 'sa')
  settlementAction(platform, voided.id, 'void', { reason: 'wrong period' }, 'sa')
  assert.throws(
    () => createSettlement(platform, vendor.id, anotherPeriod, 'sa'),
    (e) => e.code === 'settlement_period_voided',
  )
})

test('root account limits include child supply and cannot be bypassed by opening another child', (t) => {
  const { platform, vendor, identity } = fixture(t)
  updateAdminVendor(platform, vendor.id, { account_limit: 2 }, 'sa')
  const child = createLegacyChild(platform, identity, {
    name: 'Child',
    email: 'limit-child@test',
    external_code: 'limit-child',
    username: 'limit-child',
    password: 'test-password',
  })
  assert.equal(child.account_limit, 2)
  platform.createAccount({ user_id: 'sa', vendor: child }, { name: 'Child account' })
  assert.throws(
    () => platform.createAccount(identity, { name: 'Third account' }),
    (e) => e.code === 'resource_limit_exceeded',
  )
})

test('global prices separate mixed platforms and issued bills keep their snapshot', (t) => {
  const { db, platform, vendor, identity, insert } = fixture(t)
  db.prepare('UPDATE vendors SET groups_json=?,platforms_json=? WHERE id=?').run(
    JSON.stringify(['1']),
    JSON.stringify(['anthropic', 'openai']),
    vendor.id,
  )
  db.prepare("UPDATE groups SET platform='mixed' WHERE id=1").run()
  identity.vendor.groups = ['1']
  identity.vendor.platforms = ['anthropic', 'openai']
  const codex = platform.createAccount(identity, { name: 'Codex', platform: 'openai' })
  db.prepare('UPDATE vendor_resources SET config_json=? WHERE id=?').run(
    JSON.stringify({ runtime_vm_id: 'vm-codex' }),
    codex.vm.id,
  )
  db.prepare("INSERT INTO vms (id,name,vm_json) VALUES ('vm-codex','codex','{}')").run()
  insert('claude-rate')
  insert('codex-rate', { vm_id: 'vm-codex', model: 'gpt-test', total_cost: 20 })
  const preview = settlementPreview(platform, vendor.id, period)
  assert.equal(preview.amount_usdt, 12)
  assert.deepEqual(preview.rate_breakdown.map((r) => [r.platform, r.price_cny_per_usd, r.amount_usdt]).sort(), [
    ['anthropic', '2.0000000000', '4.000000'],
    ['openai', '2.0000000000', '8.000000'],
  ])
  const frozen = createSettlement(platform, vendor.id, period, 'sa')
  assert.equal(listSettlements(platform)[0].amount_usdt, frozen.amount_usdt)
  assert.throws(
    () => updateAdminVendor(platform, vendor.id, { group_prices: { anthropic: 4 } }, 'sa'),
    (e) => e.code === 'pricing_settings_required',
  )
})

test('unknown usage platforms cannot be silently assigned a global price', (t) => {
  const { db, platform, vendor, pair, insert } = fixture(t)
  insert('unknown-platform')
  db.prepare("UPDATE vendor_resources SET config_json=json_remove(config_json,'$.platform') WHERE id=?").run(
    pair.account.id,
  )
  assert.throws(
    () => settlementPreview(platform, vendor.id, period),
    (e) => e.code === 'unknown_usage_platform',
  )
})

test('contract price migration preserves old rows and reapplies idempotently', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-price-upgrade-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const migrationsDir = path.join(dir, 'migrations')
  fs.mkdirSync(migrationsDir)
  const source = new URL('../../src/lib/db/migrations/', import.meta.url)
  for (const file of fs.readdirSync(source)) {
    if (
      file.endsWith('.sql') &&
      !['067_vendor_contract_platform_prices.sql', '068_vendor_admin_remark.sql'].includes(file)
    )
      fs.copyFileSync(new URL(file, source), path.join(migrationsDir, file))
  }
  const db = createDatabase({ dataDir: dir, migrationsDir })
  t.after(() => db.close())
  db.prepare(
    "INSERT INTO vendors (id,name,email,external_code,tier,root_id,created_by,created_at,updated_at) VALUES ('old','Old','old@test','old',1,'old','sa','2026-10-01','2026-10-01')",
  ).run()
  db.prepare(
    "INSERT INTO vendor_contracts (id,leg,payee_vendor_id,version,effective_at,price_cny_per_usd,fx_cny_per_usdt,multiplier,created_by,created_at) VALUES ('old-contract','platform_to_l1','old',1,'2026-10-01',1.9,6.7,1,'sa','2026-10-01')",
  ).run()
  const before = db.prepare('SELECT * FROM vendor_contracts').get()
  const vendorBefore = db.prepare('SELECT * FROM vendors').get()
  applyMigrations(db)
  const after = db.prepare('SELECT * FROM vendor_contracts').get()
  const { group_prices_json, ...rest } = after
  assert.equal(group_prices_json, '{}')
  const { remark, ...vendorAfter } = db.prepare('SELECT * FROM vendors').get()
  assert.equal(remark, '')
  assert.deepEqual(vendorAfter, { ...vendorBefore })
  assert.deepEqual(rest, { ...before })
  applyMigrations(db)
  assert.deepEqual(db.prepare('SELECT * FROM vendor_contracts').get(), after)
})

test('admin notes persist independently of the global pricing record', (t) => {
  const { platform, vendor, identity } = fixture(t)
  const updated = updateAdminVendor(platform, vendor.id, { remark: '  工作日联系 / weekly review  ' }, 'sa')
  assert.equal(updated.remark, '工作日联系 / weekly review')
  assert.equal(adminVendors(platform).find((v) => v.id === vendor.id).remark, updated.remark)
  assert.equal(platform.getVendor(vendor.id).remark, undefined)
  assert.equal(supplierBilling(platform, identity).profile, undefined)
  for (const remark of [null, 5, 'x'.repeat(1001)])
    assert.throws(
      () => updateAdminVendor(platform, vendor.id, { remark }, 'sa'),
      (e) => e.code === 'invalid_vendor_remark',
    )
  assert.throws(
    () => updateAdminVendor(platform, vendor.id, { binance_id: 'abc' }, 'sa'),
    (e) => e.code === 'pricing_settings_required',
  )
  assert.equal(updateAdminVendor(platform, vendor.id, { remark: '' }, 'sa').remark, '')
})

test('supplier consoles agree across UTC+8 midnight, failures, unpriced requests and cache history', (t) => {
  const { db, vendor, insert } = fixture(t)
  insert('before-midnight', {
    created_at: '2026-10-31T15:59:59.999Z',
    cache_read_tokens: 1000,
    cache_creation_tokens: 50,
  })
  insert('after-midnight', {
    created_at: '2026-10-31T16:00:00.000Z',
    cache_read_tokens: 2000,
    cache_creation_tokens: null,
  })
  insert('error', {
    created_at: '2026-10-31T16:01:00.000Z',
    status: 500,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    total_cost: 99,
  })
  insert('unknown-price', {
    created_at: '2026-10-31T16:02:00.000Z',
    pricing_model: 'unpriced',
    total_cost: null,
    cache_read_tokens: 20,
    cache_creation_tokens: 0,
  })
  insert('outside', { vm_id: null, created_at: '2026-10-31T16:02:00.000Z', cache_read_tokens: 99999 })
  const query = { start_date: '2026-10-31', end_date: '2026-11-02' }
  const compare = () => {
    const admin = vendorUsage(db, [vendor.id], query)
    const portal = readVendorUsage(
      db,
      ['vm-supplier'],
      { start_date: '2026-10-31', end_date: '2026-11-01' },
      Date.parse('2026-11-02T00:00:00Z'),
    )
    for (const key of [
      'requests',
      'input_tokens',
      'output_tokens',
      'cache_read_tokens',
      'cache_creation_tokens',
      'cache_read_known_requests',
      'cache_creation_known_requests',
      'cache_hit_rate',
      'cost_usd',
      'unpriced_requests',
    ])
      assert.equal(admin.summary[key], portal.summary[key], key)
    for (const row of admin.trend) {
      const other = portal.trend.find((r) => r.date === row.date)
      for (const key of [
        'requests',
        'input_tokens',
        'output_tokens',
        'cache_read_tokens',
        'cache_creation_tokens',
        'cache_read_known_requests',
        'cache_creation_known_requests',
        'cost_usd',
      ])
        assert.equal(row[key], other[key], `${row.date} ${key}`)
    }
    assert.equal(portal.account_usage.length, 1)
    assert.equal(portal.account_usage[0].requests, 4)
    assert.equal(portal.account_usage[0].cache_read_tokens, 3020)
    assert.equal(admin.trend[0].cache_hit_rate, 1000 / 1150)
    assert.equal(admin.trend[1].cache_hit_rate, null)
    assert.equal(admin.summary.requests, 4)
    assert.equal(admin.summary.cache_read_tokens, 3020)
    assert.equal(admin.summary.cache_creation_tokens, 50)
    assert.equal(admin.summary.cache_read_known_requests, 4)
    assert.equal(admin.summary.cache_creation_known_requests, 3)
    assert.equal(admin.summary.cost_usd, null)
    assert.deepEqual(
      admin.trend.map((r) => [r.date, r.requests]),
      [
        ['2026-10-31', 1],
        ['2026-11-01', 3],
      ],
    )
    return admin
  }
  compare()
  db.prepare("DELETE FROM usage_logs WHERE request_id IN ('before-midnight','after-midnight')").run()
  compare()
  const filtered = vendorUsage(db, [vendor.id], { ...query, model: 'absent' })
  assert.equal(filtered.summary.requests, 0)
  assert.equal(filtered.summary.cache_complete, true)
})

test('cache migration recovers retained evidence and leaves missing historical values unknown', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-cache-upgrade-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const migrationsDir = path.join(dir, 'migrations')
  fs.mkdirSync(migrationsDir)
  const source = new URL('../../src/lib/db/migrations/', import.meta.url)
  for (const file of fs.readdirSync(source))
    if (file.endsWith('.sql') && file < '075_') fs.copyFileSync(new URL(file, source), path.join(migrationsDir, file))
  const db = createDatabase({ dataDir: dir, migrationsDir })
  t.after(() => db.close())
  db.exec(`INSERT INTO vendors (id,name,external_code,email,tier,root_id,created_by,created_at,updated_at) VALUES ('old','Old','old','old@test',1,'old','sa','2026-10-01','2026-10-01');
    INSERT INTO vendor_usage_facts (id,vendor_id,model,cost_usd,occurred_at,source_request_id,created_at) VALUES
      ('known','old','gpt-test',10,'2026-10-01','known','2026-10-01'),
      ('missing','old','gpt-test',20,'2026-10-01','missing','2026-10-01');
    INSERT INTO usage_logs (id,request_id,created_at,status,cache_read_tokens,cache_creation_tokens) VALUES ('known','known','2026-10-01',200,12345,NULL);`)
  applyMigrations(db)
  const rows = db
    .prepare('SELECT id,cost_usd,cache_read_tokens,cache_creation_tokens FROM vendor_usage_facts ORDER BY id')
    .all()
    .map((r) => ({ ...r }))
  assert.deepEqual(rows, [
    { id: 'known', cost_usd: 10, cache_read_tokens: 12345, cache_creation_tokens: null },
    { id: 'missing', cost_usd: 20, cache_read_tokens: null, cache_creation_tokens: null },
  ])
  applyMigrations(db)
  assert.deepEqual(
    db
      .prepare('SELECT id,cost_usd,cache_read_tokens,cache_creation_tokens FROM vendor_usage_facts ORDER BY id')
      .all()
      .map((r) => ({ ...r })),
    rows,
  )
  db.exec('DELETE FROM usage_logs')
  const report = vendorUsage(db, ['old'], { start_date: '2026-09-30', end_date: '2026-10-02' })
  assert.equal(report.summary.cache_read_tokens, 12345)
  assert.equal(report.summary.cache_read_known_requests, 1)
  assert.equal(report.summary.cache_creation_known_requests, 0)
})
