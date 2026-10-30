import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDatabase, applyMigrations } from '../../src/lib/db/database.mjs'
import { VendorPlatform } from '../../src/lib/vendor/vendor-platform.mjs'
import {
  previewDownstreamSettlements,
  createDownstreamSettlement,
  mutateDownstreamSettlement,
  supplierBilling,
} from '../../src/lib/vendor/vendor-settlements.mjs'

const NOW = Date.parse('2026-10-30T00:00:00Z')
const defaults = {
  start_date: '2026-10-29',
  end_date: '2026-10-29',
  timezone: 'Asia/Shanghai',
  exchange_rate: '6.4',
  exchange_rate_source: 'contract',
  adjustment: '0',
}
function fixture(t, { legacy = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supplier-settlements-'))
  const migrations = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/lib/db/migrations')
  let migrationsDir
  if (legacy) {
    migrationsDir = path.join(dir, 'migrations')
    fs.mkdirSync(migrationsDir)
    for (const file of fs.readdirSync(migrations).filter((f) => f.endsWith('.sql') && !f.startsWith('070_')))
      fs.symlinkSync(path.join(migrations, file), path.join(migrationsDir, file))
  }
  const db = createDatabase({ dataDir: dir, migrationsDir })
  t.after(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const platform = new VendorPlatform(db, { vmProvisioner: ({ resourceId }) => ({ id: 'vm-' + resourceId }) })
  const parent = platform.createRoot({
    actorUserId: 'sa',
    body: {
      username: 'payer',
      password: 'supplier-test-123',
      capabilities: [
        'vendor.create_child',
        'vendor.resource.manage',
        'vendor.vm.create',
        'vendor.settlement.read',
        'vendor.settlement.pay',
      ],
    },
  })
  const user = db.prepare("SELECT id FROM users WHERE username='payer'").get()
  const identity = platform.identity(user.id)
  const child = platform.createChild(identity, {
    username: 'payee',
    password: 'supplier-test-123',
    default_price_cny_per_usd: 1.6,
    fx_cny_per_usdt: 6.4,
    binance_id: 'payee-binance',
  })
  const childUser = db.prepare("SELECT id FROM users WHERE username='payee'").get()
  const childIdentity = platform.identity(childUser.id)
  const pair = platform.createAccount(childIdentity, { name: 'usage-account', platform: 'anthropic' })
  const vmId = pair.vm.config.runtime_vm_id
  const add = (id, cost = 100, stamp = '2026-10-29T12:00:00.000Z') =>
    db
      .prepare(
        "INSERT INTO usage_logs(id,request_id,vm_id,group_id,created_at,status,model,total_cost,input_tokens,output_tokens) VALUES (?,?,?,1,?,200,'claude-sonnet-4',?,100,20)",
      )
      .run(id, id, vmId, stamp, cost)
  add('usage-1')
  return { platform, db, parent, identity, child, childIdentity, add, migrations }
}
const preview = (f, patch = {}) =>
  previewDownstreamSettlements(
    f.platform,
    f.identity,
    { ...defaults, vendor_ids: [f.child.id], ...patch },
    { now: NOW },
  ).items[0]
const create = (f, p, key = 'draft-request-1') =>
  createDownstreamSettlement(
    f.platform,
    f.identity,
    { preview_token: p.preview_token, idempotency_key: key },
    { now: NOW },
  )

test('settlement preview uses real scoped usage, calendar dates and exact contract arithmetic', (t) => {
  const f = fixture(t)
  const p = preview(f, { adjustment: '1.25', adjustment_reason: 'agreed adjustment' })
  assert.equal(p.statement.start_at, '2026-10-28T16:00:00.000Z')
  assert.equal(p.statement.end_at, '2026-10-29T16:00:00.000Z')
  assert.equal(p.available_count, 1)
  assert.equal(p.statement.cost_usd, '100.0000000000')
  assert.equal(p.statement.subtotal_usdt, '25.000000')
  assert.equal(p.statement.total_usdt, '26.250000')
  assert.equal(p.statement.lines[0].coefficient, '1.6000000000')
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM vendor_settlements').get().n, 0)
})

test('draft reserves usage once; confirmation exposes the upstream bill to the child', (t) => {
  const f = fixture(t),
    p = preview(f),
    p2 = preview(f)
  const draft = create(f, p)
  assert.equal(draft.status, 'draft')
  assert.equal(create(f, p).id, draft.id)
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM vendor_settlement_allocations').get().n, 1)
  assert.deepEqual(supplierBilling(f.platform, f.childIdentity).upstream, [])
  assert.throws(
    () => create(f, p2, 'different-request'),
    (e) => e.code === 'settlement_preview_changed',
  )
  const after = preview(f)
  assert.equal(after.available_count, 0)
  assert.equal(after.occupied_count, 1)
  mutateDownstreamSettlement(f.platform, f.identity, draft.id, 'confirm')
  const upstream = supplierBilling(f.platform, f.childIdentity).upstream
  assert.equal(upstream.length, 1)
  assert.equal(upstream[0].id, draft.id)
  assert.equal(upstream[0].counterparty_name, 'payer')
  assert.equal(upstream[0].status, 'confirmed')
  assert.equal(supplierBilling(f.platform, f.identity).downstream.length, 1)
  assert.throws(
    () => mutateDownstreamSettlement(f.platform, f.childIdentity, draft.id, 'void', { reason: 'unauthorized' }),
    (e) => e.code === 'settlement_payer_scope',
  )
})

test('late usage in the same period can be settled separately and voiding releases only its own allocations', (t) => {
  const f = fixture(t)
  const p = preview(f)
  f.add('late', 20)
  const first = create(f, p)
  assert.equal(first.amount_usdt, 25)
  const next = preview(f)
  assert.equal(next.available_count, 1)
  assert.equal(next.occupied_count, 1)
  const second = create(f, next, 'late-request-key')
  assert.equal(second.amount_usdt, 5)
  assert.notEqual(second.id, first.id)
  mutateDownstreamSettlement(f.platform, f.identity, second.id, 'void', { reason: 'incorrect account selection' })
  assert.equal(preview(f).available_count, 1)
  assert.equal(preview(f).occupied_count, 1)
})

test('quote expiry, contract changes, unpriced usage and foreign vendors fail closed', (t) => {
  const f = fixture(t),
    p = preview(f)
  assert.throws(
    () =>
      createDownstreamSettlement(
        f.platform,
        f.identity,
        { preview_token: p.preview_token, idempotency_key: 'expired-request' },
        { now: NOW + 16 * 60000 },
      ),
    (e) => e.code === 'settlement_preview_expired',
  )
  assert.throws(
    () => preview(f, { vendor_ids: [f.parent.id] }),
    (e) => e.code === 'vendor_scope_forbidden',
  )
  assert.throws(
    () =>
      previewDownstreamSettlements(
        f.platform,
        f.childIdentity,
        { ...defaults, vendor_ids: [f.child.id] },
        { now: NOW },
      ),
    (e) => e.code === 'capability_required' || e.code === 'vendor_scope_forbidden',
  )
  f.db.prepare('UPDATE vendor_contracts SET multiplier=2 WHERE payee_vendor_id=?').run(f.child.id)
  assert.throws(
    () => create(f, p),
    (e) => e.code === 'settlement_preview_changed',
  )
  f.add('unpriced', null)
  assert.throws(
    () => preview(f),
    (e) => e.code === 'settlement_unpriced_usage',
  )
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM vendor_settlements').get().n, 0)
})

test('group purchase rates and negative adjustments are bounded', (t) => {
  const f = fixture(t)
  f.db
    .prepare('UPDATE vendor_contracts SET group_prices_json=? WHERE payee_vendor_id=?')
    .run(JSON.stringify({ 1: 2.4 }), f.child.id)
  assert.equal(preview(f).statement.total_usdt, '37.500000')
  assert.throws(
    () => preview(f, { adjustment: '-100', adjustment_reason: 'too large' }),
    (e) => e.code === 'negative_settlement_total',
  )
  assert.throws(
    () => preview(f, { adjustment: '-1', adjustment_reason: '' }),
    (e) => e.code === 'invalid_settlement_reason',
  )
  assert.throws(
    () => preview(f, { exchange_rate: '0' }),
    (e) => e.code === 'invalid_settlement_rate',
  )
  assert.throws(
    () => preview(f, { start_date: '2026-02-30' }),
    (e) => e.code === 'invalid_settlement_period',
  )
})

test('migration retains historical paid statements and payment references', (t) => {
  const f = fixture(t, { legacy: true })
  const contract = f.db
    .prepare("SELECT id FROM vendor_contracts WHERE payee_vendor_id=? AND leg='l1_to_l2'")
    .get(f.child.id)
  f.db
    .prepare(
      "INSERT INTO vendor_settlements(id,contract_id,period_start,period_end,status,amount_usdt,usage_snapshot_json,created_by,created_at,updated_at) VALUES ('legacy',?,'2026-10-28T16:00:00.000Z','2026-10-29T16:00:00.000Z','paid',25,'{}','sa','2026-10-30','2026-10-30')",
    )
    .run(contract.id)
  f.db
    .prepare(
      "INSERT INTO vendor_payments(id,settlement_id,idempotency_key,amount_usdt,action,reason,actor_user_id,created_at) VALUES ('payment','legacy','legacy-payment',25,'payment','paid','sa','2026-10-30')",
    )
    .run()
  applyMigrations(f.db, { migrationsDir: f.migrations })
  assert.equal(f.db.prepare("SELECT amount_usdt FROM vendor_payments WHERE id='payment'").get().amount_usdt, 25)
  assert.equal(f.db.prepare("SELECT status FROM vendor_settlements WHERE id='legacy'").get().status, 'paid')
  assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), [])
  assert.equal(preview(f).available_count, 0)
  assert.equal(preview(f).occupied_count, 1)
  assert.throws(
    () => mutateDownstreamSettlement(f.platform, f.identity, 'legacy', 'void', { reason: 'already paid' }),
    (e) => e.code === 'invalid_settlement_state',
  )
})
