import { createLegacyVendor, createLegacyChild, seedLegacyContract } from '../fixtures/vendor-legacy-pricing.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'
import { VendorPlatform } from '../../src/lib/vendor/vendor-platform.mjs'
import { vendorRuntimeBlock } from '../../src/lib/vendor/vendor-runtime-policy.mjs'
import {
  adminVendorIdentity,
  updateAdminVendor,
  settlementPreview,
  createSettlement,
  settlementAction,
} from '../../src/lib/vendor/vendor-admin.mjs'
import { accountPortalRows } from '../../src/lib/vendor/vendor-portal-view.mjs'
import {
  mutateDownstreamSettlement as downstreamSettlementAction,
  supplierBilling,
} from '../../src/lib/vendor/vendor-settlements.mjs'
import { supplierUsage } from '../../src/lib/vendor/vendor-account-usage.mjs'
import { deriveScheduleFields } from '../../src/lib/pool/schedule-state.mjs'
import { isVmScheduleReady } from '../../src/lib/vm/vm-registry.mjs'
import { isCodexSlotReady } from '../../src/lib/pool/codex-slot-pool.mjs'
const period = { start_date: '2026-10-01', end_date: '2026-10-02' }
function fixture(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supplier-review-'))
  closeDatabase()
  const db = openDatabase({ dataDir: dir })
  t.after(() => {
    closeDatabase()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  db.prepare(
    "INSERT INTO users (id,email,username,password_hash,role,status) VALUES ('u1','one@test','root-supplier','hash','user','active'),('other','other@test','other-user','hash','user','active'),('sa','sa@test','admin','hash','super_admin','active')",
  ).run()
  const platform = new VendorPlatform(db)
  const root = createLegacyVendor(platform, {
    actorUserId: 'sa',
    userId: 'u1',
    body: {
      name: 'root',
      email: 'root@test',
      external_code: 'root',
      platforms: ['anthropic'],
      groups: ['1'],
      capabilities: [
        'vendor.resource.manage',
        'vendor.vm.create',
        'vendor.create_child',
        'vendor.usage.read',
        'vendor.settlement.read',
      ],
      ...overrides,
    },
  })
  const identity = platform.identity('u1')
  const childBody = {
    name: 'child',
    email: 'child@test',
    external_code: 'child',
    username: 'child-login',
    password: 'test-password',
    groups: [],
    platforms: [],
  }
  const child = () => createLegacyChild(platform, identity, childBody)
  const fact = (vendorId, resourceId = 'resource', cost = 10, tokens = 100) => {
    db.prepare(
      'INSERT INTO vendor_usage_facts (id,vendor_id,model,input_tokens,output_tokens,cost_usd,occurred_at,created_at) VALUES (?,?,?,?,?,?,?,?)',
    ).run(resourceId, vendorId, 'model', tokens, 10, cost, '2026-10-01T01:00:00.000Z', new Date().toISOString())
  }
  return { db, platform, root, identity, childBody, child, fact }
}
test('S01 child creation cannot bind unrelated users or promote its capabilities', (t) => {
  const { db, platform, identity, childBody } = fixture(t)
  for (const user_id of ['other', 'sa', 'u1'])
    assert.throws(
      () => createLegacyChild(platform, identity, { ...childBody, user_id }),
      (e) => e.code === 'member_binding_forbidden',
    )
  assert.equal(db.prepare("SELECT role FROM users WHERE id='other'").get().role, 'user')
  assert.throws(
    () => createLegacyChild(platform, identity, { ...childBody, capabilities: ['vendor.create_child'] }),
    (e) => e.code === 'capability_scope_forbidden',
  )
  assert.equal(db.prepare('SELECT COUNT(*) n FROM vendors').get().n, 1)
})
test('S02 empty child scope inherits restrictions and old empty rows still obey the parent', (t) => {
  const { db, platform, identity, child, root } = fixture(t)
  const v = child()
  assert.deepEqual(v.groups, ['1'])
  assert.deepEqual(v.platforms, ['anthropic'])
  db.prepare("UPDATE vendors SET platforms_json='[]',groups_json='[]' WHERE id=?").run(v.id)
  const user = db.prepare('SELECT user_id FROM vendor_members WHERE vendor_id=?').get(v.id).user_id
  const ci = platform.identity(user)
  assert.throws(
    () => platform.createAccount(ci, { name: 'escape', platform: 'openai' }),
    (e) => e.code === 'platform_scope_forbidden',
  )
  assert.throws(
    () => platform.createAccount(ci, { name: 'escape', platform: 'anthropic', group_ids: [2] }),
    (e) => e.code === 'group_scope_forbidden',
  )
  const account = platform.createAccount(ci, { name: 'allowed', platform: 'anthropic' })
  assert.deepEqual(account.account.config.group_ids, ['1'])
  assert.equal(platform.getVendor(root.id).tier, 1)
})
test('S03 child request retries are idempotent at quota and reject conflicting replay', (t) => {
  const { db, platform, identity, childBody } = fixture(t, { child_limit: 1 })
  const a = createLegacyChild(platform, identity, { ...childBody, idempotency_key: 'once' })
  const b = createLegacyChild(platform, identity, { ...childBody, idempotency_key: 'once' })
  assert.equal(a.id, b.id)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM vendors WHERE tier=2').get().n, 1)
  assert.throws(
    () => createLegacyChild(platform, identity, { ...childBody, name: 'changed', idempotency_key: 'once' }),
    (e) => e.code === 'idempotency_conflict',
  )
})
test('S04 capabilities and membership are rechecked after identity creation', (t) => {
  const { db, platform, identity, child, root } = fixture(t)
  child()
  db.prepare("UPDATE vendor_capabilities SET enabled=0 WHERE vendor_id=? AND capability='vendor.create_child'").run(
    root.id,
  )
  assert.throws(
    () => platform.listResources(identity, 'account', { vendorId: 'all' }),
    (e) => e.code === 'capability_required',
  )
  assert.equal(supplierUsage(platform, identity).summary.requests, 0)
  db.prepare("UPDATE vendor_members SET status='revoked' WHERE user_id='u1'").run()
  assert.throws(
    () => platform.createProxy(identity, { name: 'exit', config: { endpoint: 'socks5://127.0.0.1:1080' } }),
    (e) => e.code === 'vendor_forbidden',
  )
})
test('S05 pause/archive keep paired resources consistent and block stale Claude/Codex slots', (t) => {
  const { db, platform, identity } = fixture(t)
  const pair = platform.createAccount(identity, { name: 'account', platform: 'anthropic' })
  db.prepare('UPDATE vendor_resources SET config_json=? WHERE id=?').run(
    JSON.stringify({ ...pair.vm.config, runtime_vm_id: 'vm-test' }),
    pair.vm.id,
  )
  const vm = {
    id: 'vm-test',
    vendor_account_resource_id: pair.account.id,
    status: 'running',
    schedulable: true,
    claude: { access_token: 'fake' },
  }
  db.prepare(
    "INSERT OR IGNORE INTO group_resources(group_id,resource_kind,resource_id) VALUES (1,'vm','vm-test')",
  ).run()
  assert.equal(vendorRuntimeBlock(vm), null)
  platform.updateResource(identity, pair.account.id, { status: 'paused' })
  assert.equal(platform.getResource(identity, pair.vm.id).status, 'paused')
  assert.equal(vendorRuntimeBlock(vm), 'vendor_paused')
  assert.equal(isVmScheduleReady(vm), false)
  assert.equal(isCodexSlotReady({ ...vm, platform: 'openai', family: 'openai', kind: 'codex', has_token: true }), false)
  platform.updateResource(identity, pair.account.id, { status: 'active' })
  assert.equal(vendorRuntimeBlock(vm), null)
  platform.updateResource(identity, pair.vm.id, { status: 'archived' })
  assert.equal(platform.getResource(identity, pair.account.id).status, 'archived')
  assert.equal(vendorRuntimeBlock(vm), 'vendor_archived')
  const manual = { schedule_off: true, schedule_off_reason: 'operator', vendor_resource_paused: true }
  deriveScheduleFields(manual)
  manual.vendor_resource_paused = false
  deriveScheduleFields(manual)
  assert.equal(manual.schedulable, false)
  assert.equal(manual.schedule_off_reason, 'operator')
})
test('S06 current parent policy revokes existing supply without trusting disk flags', (t) => {
  const { db, platform, identity, root } = fixture(t)
  const pair = platform.createAccount(identity, { name: 'account', platform: 'anthropic' })
  db.prepare('UPDATE vendor_resources SET config_json=? WHERE id=?').run(
    JSON.stringify({ ...pair.vm.config, runtime_vm_id: 'vm-test' }),
    pair.vm.id,
  )
  const vm = { id: 'vm-test', vendor_account_resource_id: pair.account.id, schedulable: true, vendor_disabled: false }
  db.prepare("UPDATE vendors SET status='disabled' WHERE id=?").run(root.id)
  assert.equal(vendorRuntimeBlock(vm), 'vendor_disabled')
  db.prepare("UPDATE vendors SET status='active',platforms_json='[\"openai\"]' WHERE id=?").run(root.id)
  assert.equal(vendorRuntimeBlock(vm), 'vendor_scope_revoked')
})
test('S07 supplier telemetry neither invents TPM nor leaks upstream error text', (t) => {
  const { db, platform, identity } = fixture(t)
  const pair = platform.createAccount(identity, { name: 'account' })
  db.prepare('UPDATE vendor_resources SET config_json=? WHERE id=?').run(
    JSON.stringify({ ...pair.vm.config, runtime_vm_id: 'vm-test' }),
    pair.vm.id,
  )
  const rows = accountPortalRows(platform, [pair.account], {
    usageAccounts: [{ vm_id: 'vm-test', total_tokens: 123456, requests: 5, error_message: 'Bearer secret-token' }],
  })
  assert.equal(rows[0].telemetry.tpm, 0)
  assert.ok(!JSON.stringify(rows).includes('secret-token'))
})
test('S08 preview covers frozen detail and repeated creation/confirmation keeps original statement', (t) => {
  const { db, platform, root, fact } = fixture(t)
  fact(root.id)
  const before = settlementPreview(platform, root.id, period)
  db.prepare('UPDATE vendor_usage_facts SET input_tokens=input_tokens+1').run()
  assert.throws(
    () => createSettlement(platform, root.id, { ...period, preview_token: before.preview_token }, 'sa'),
    (e) => e.code === 'settlement_preview_changed',
  )
  const s = createSettlement(platform, root.id, period, 'sa')
  db.prepare("UPDATE vendor_contracts SET status='expired'").run()
  assert.equal(createSettlement(platform, root.id, period, 'sa').id, s.id)
  settlementAction(platform, s.id, 'confirm', {}, 'sa')
  assert.equal(settlementAction(platform, s.id, 'confirm', {}, 'sa').id, s.id)
  assert.equal(JSON.parse(s.usage_snapshot_json).accounts[0].input_tokens, 101)
})
test('S09 downstream payer needs explicit capability and cannot touch platform or other payer bills', (t) => {
  const { platform, root, identity, child, fact } = fixture(t)
  const c = child()
  fact(c.id)
  const s = createSettlement(platform, c.id, period, 'sa', root.id)
  assert.throws(
    () => downstreamSettlementAction(platform, identity, s.id, 'confirm', {}),
    (e) => e.code === 'capability_required',
  )
  updateAdminVendor(platform, root.id, { settlement_pay: true }, 'sa')
  downstreamSettlementAction(platform, identity, s.id, 'confirm', {})
  const body = { amount_usdt: s.amount_usdt, reason: 'test receipt', idempotency_key: 'once-payment' }
  downstreamSettlementAction(platform, identity, s.id, 'payments', body)
  downstreamSettlementAction(platform, identity, s.id, 'payments', body)
  assert.equal(supplierBilling(platform, identity).downstream[0].status, 'paid')
  const platformBill = createSettlement(platform, root.id, period, 'sa')
  assert.throws(
    () => downstreamSettlementAction(platform, identity, platformBill.id, 'confirm', {}),
    (e) => e.code === 'settlement_payer_scope',
  )
  updateAdminVendor(platform, root.id, { settlement_pay: false }, 'sa')
  assert.throws(
    () => downstreamSettlementAction(platform, identity, s.id, 'payments', body),
    (e) => e.code === 'capability_required',
  )
})
test('S10 unsafe monetary precision and archived vendor edits are rejected', (t) => {
  const { db, platform, root, fact } = fixture(t)
  fact(root.id)
  db.prepare('UPDATE vendor_contracts SET price_cny_per_usd=?').run(1e100)
  assert.throws(
    () => settlementPreview(platform, root.id, period),
    (e) => e.code === 'invalid_settlement_amount',
  )
  updateAdminVendor(platform, root.id, { status: 'archived' }, 'sa')
  assert.throws(
    () => updateAdminVendor(platform, root.id, { status: 'active' }, 'sa'),
    (e) => e.code === 'vendor_archived',
  )
  assert.equal(adminVendorIdentity(platform, root.id, 'sa').system_admin, true)
})

test('S14 archived children remain in authorized historical usage without regaining write access', (t) => {
  const { platform, identity, child, fact } = fixture(t)
  const c = child()
  fact(c.id)
  updateAdminVendor(platform, c.id, { status: 'archived' }, 'sa')
  assert.equal(supplierUsage(platform, identity, { query: { vendor_id: 'all', range: 'all' } }).summary.cost_usd, 10)
  assert.ok(platform.resourceScope(identity, 'all').includes(c.id))
  assert.throws(
    () => platform.createAccount({ user_id: 'sa', vendor: c }, { name: 'blocked' }),
    (e) => e.code === 'vendor_inactive',
  )
})
