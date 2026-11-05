import { createLegacyVendor, createLegacyChild, seedLegacyContract } from '../fixtures/vendor-legacy-pricing.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'
import { VendorPlatform } from '../../src/lib/vendor/vendor-platform.mjs'
import {
  vendorRuntimeBlock as vendorRuntimeBlockAsync,
  vendorRuntimeBlockSync,
} from '../../src/lib/vendor/vendor-runtime-policy.mjs'
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
// R6 临时同步出口：每个判定状态下同步版本与 async 版本结果一致
async function vendorRuntimeBlock(vm, db) {
  const result = await vendorRuntimeBlockAsync(vm, db)
  assert.equal(vendorRuntimeBlockSync(vm, db), result)
  return result
}
const period = { start_date: '2026-10-01', end_date: '2026-10-02' }
async function fixture(t, overrides = {}) {
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
  const root = await createLegacyVendor(platform, {
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
  const identity = await platform.identity('u1')
  const childBody = {
    name: 'child',
    email: 'child@test',
    external_code: 'child',
    username: 'child-login',
    password: 'test-password',
    groups: [],
    platforms: [],
  }
  const child = async () => createLegacyChild(platform, identity, childBody)
  const fact = (vendorId, resourceId = 'resource', cost = 10, tokens = 100) => {
    db.prepare(
      'INSERT INTO vendor_usage_facts (id,vendor_id,model,input_tokens,output_tokens,cost_usd,occurred_at,created_at) VALUES (?,?,?,?,?,?,?,?)',
    ).run(resourceId, vendorId, 'model', tokens, 10, cost, '2026-10-01T01:00:00.000Z', new Date().toISOString())
  }
  return { db, platform, root, identity, childBody, child, fact }
}
test('S01 child creation cannot bind unrelated users or promote its capabilities', async (t) => {
  const { db, platform, identity, childBody } = await fixture(t)
  for (const user_id of ['other', 'sa', 'u1'])
    await assert.rejects(
      async () => createLegacyChild(platform, identity, { ...childBody, user_id }),
      (e) => e.code === 'member_binding_forbidden',
    )
  assert.equal(db.prepare("SELECT role FROM users WHERE id='other'").get().role, 'user')
  await assert.rejects(
    async () => createLegacyChild(platform, identity, { ...childBody, capabilities: ['vendor.create_child'] }),
    (e) => e.code === 'capability_scope_forbidden',
  )
  assert.equal(db.prepare('SELECT COUNT(*) n FROM vendors').get().n, 1)
})
test('S02 empty child scope inherits restrictions and old empty rows still obey the parent', async (t) => {
  const { db, platform, identity, child, root } = await fixture(t)
  const v = await child()
  assert.deepEqual(v.groups, ['1'])
  assert.deepEqual(v.platforms, ['anthropic'])
  db.prepare("UPDATE vendors SET platforms_json='[]',groups_json='[]' WHERE id=?").run(v.id)
  const user = db.prepare('SELECT user_id FROM vendor_members WHERE vendor_id=?').get(v.id).user_id
  const ci = await platform.identity(user)
  await assert.rejects(
    async () => platform.createAccount(ci, { name: 'escape', platform: 'openai' }),
    (e) => e.code === 'platform_scope_forbidden',
  )
  await assert.rejects(
    async () => platform.createAccount(ci, { name: 'escape', platform: 'anthropic', group_ids: [2] }),
    (e) => e.code === 'group_scope_forbidden',
  )
  const account = await platform.createAccount(ci, { name: 'allowed', platform: 'anthropic' })
  assert.deepEqual(account.account.config.group_ids, ['1'])
  assert.equal((await platform.getVendor(root.id)).tier, 1)
})
test('S03 child request retries are idempotent at quota and reject conflicting replay', async (t) => {
  const { db, platform, identity, childBody } = await fixture(t, { child_limit: 1 })
  const a = await createLegacyChild(platform, identity, { ...childBody, idempotency_key: 'once' })
  const b = await createLegacyChild(platform, identity, { ...childBody, idempotency_key: 'once' })
  assert.equal(a.id, b.id)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM vendors WHERE tier=2').get().n, 1)
  await assert.rejects(
    async () => createLegacyChild(platform, identity, { ...childBody, name: 'changed', idempotency_key: 'once' }),
    (e) => e.code === 'idempotency_conflict',
  )
})
test('S04 capabilities and membership are rechecked after identity creation', async (t) => {
  const { db, platform, identity, child, root } = await fixture(t)
  await child()
  db.prepare("UPDATE vendor_capabilities SET enabled=0 WHERE vendor_id=? AND capability='vendor.create_child'").run(
    root.id,
  )
  await assert.rejects(
    async () => platform.listResources(identity, 'account', { vendorId: 'all' }),
    (e) => e.code === 'capability_required',
  )
  assert.equal((await supplierUsage(platform, identity)).summary.requests, 0)
  db.prepare("UPDATE vendor_members SET status='revoked' WHERE user_id='u1'").run()
  await assert.rejects(
    async () => platform.createProxy(identity, { name: 'exit', config: { endpoint: 'socks5://127.0.0.1:1080' } }),
    (e) => e.code === 'vendor_forbidden',
  )
})
test('S05 pause/archive keep paired resources consistent and block stale Claude/Codex slots', async (t) => {
  const { db, platform, identity } = await fixture(t)
  const pair = await platform.createAccount(identity, { name: 'account', platform: 'anthropic' })
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
  assert.equal(await vendorRuntimeBlock(vm), null)
  await platform.updateResource(identity, pair.account.id, { status: 'paused' })
  assert.equal((await platform.getResource(identity, pair.vm.id)).status, 'paused')
  assert.equal(await vendorRuntimeBlock(vm), 'vendor_paused')
  assert.equal(isVmScheduleReady(vm), false)
  assert.equal(isCodexSlotReady({ ...vm, platform: 'openai', family: 'openai', kind: 'codex', has_token: true }), false)
  await platform.updateResource(identity, pair.account.id, { status: 'active' })
  assert.equal(await vendorRuntimeBlock(vm), null)
  await platform.updateResource(identity, pair.vm.id, { status: 'archived' })
  assert.equal((await platform.getResource(identity, pair.account.id)).status, 'archived')
  assert.equal(await vendorRuntimeBlock(vm), 'vendor_archived')
  const manual = { schedule_off: true, schedule_off_reason: 'operator', vendor_resource_paused: true }
  deriveScheduleFields(manual)
  manual.vendor_resource_paused = false
  deriveScheduleFields(manual)
  assert.equal(manual.schedulable, false)
  assert.equal(manual.schedule_off_reason, 'operator')
})
test('S06 current parent policy revokes existing supply without trusting disk flags', async (t) => {
  const { db, platform, identity, root } = await fixture(t)
  const pair = await platform.createAccount(identity, { name: 'account', platform: 'anthropic' })
  db.prepare('UPDATE vendor_resources SET config_json=? WHERE id=?').run(
    JSON.stringify({ ...pair.vm.config, runtime_vm_id: 'vm-test' }),
    pair.vm.id,
  )
  const vm = { id: 'vm-test', vendor_account_resource_id: pair.account.id, schedulable: true, vendor_disabled: false }
  db.prepare("UPDATE vendors SET status='disabled' WHERE id=?").run(root.id)
  assert.equal(await vendorRuntimeBlock(vm), 'vendor_disabled')
  db.prepare("UPDATE vendors SET status='active',platforms_json='[\"openai\"]' WHERE id=?").run(root.id)
  assert.equal(await vendorRuntimeBlock(vm), 'vendor_scope_revoked')
})
test('S07 supplier telemetry neither invents TPM nor leaks upstream error text', async (t) => {
  const { db, platform, identity } = await fixture(t)
  const pair = await platform.createAccount(identity, { name: 'account' })
  db.prepare('UPDATE vendor_resources SET config_json=? WHERE id=?').run(
    JSON.stringify({ ...pair.vm.config, runtime_vm_id: 'vm-test' }),
    pair.vm.id,
  )
  const rows = await accountPortalRows(platform, [pair.account], {
    usageAccounts: [{ vm_id: 'vm-test', total_tokens: 123456, requests: 5, error_message: 'Bearer secret-token' }],
  })
  assert.equal(rows[0].telemetry.tpm, 0)
  assert.ok(!JSON.stringify(rows).includes('secret-token'))
})
test('S08 preview covers frozen detail and repeated creation/confirmation keeps original statement', async (t) => {
  const { db, platform, root, fact } = await fixture(t)
  fact(root.id)
  const before = await settlementPreview(platform, root.id, period)
  db.prepare('UPDATE vendor_usage_facts SET input_tokens=input_tokens+1').run()
  await assert.rejects(
    async () => createSettlement(platform, root.id, { ...period, preview_token: before.preview_token }, 'sa'),
    (e) => e.code === 'settlement_preview_changed',
  )
  const s = await createSettlement(platform, root.id, period, 'sa')
  db.prepare("UPDATE vendor_contracts SET status='expired'").run()
  assert.equal((await createSettlement(platform, root.id, period, 'sa')).id, s.id)
  await settlementAction(platform, s.id, 'confirm', {}, 'sa')
  assert.equal((await settlementAction(platform, s.id, 'confirm', {}, 'sa')).id, s.id)
  assert.equal(JSON.parse(s.usage_snapshot_json).accounts[0].input_tokens, 101)
})
test('S09 downstream payer needs explicit capability and cannot touch platform or other payer bills', async (t) => {
  const { platform, root, identity, child, fact } = await fixture(t)
  const c = await child()
  fact(c.id)
  const s = await createSettlement(platform, c.id, period, 'sa', root.id)
  await assert.rejects(
    async () => downstreamSettlementAction(platform, identity, s.id, 'confirm', {}),
    (e) => e.code === 'capability_required',
  )
  await updateAdminVendor(platform, root.id, { settlement_pay: true }, 'sa')
  await downstreamSettlementAction(platform, identity, s.id, 'confirm', {})
  const body = { amount_usdt: s.amount_usdt, reason: 'test receipt', idempotency_key: 'once-payment' }
  await downstreamSettlementAction(platform, identity, s.id, 'payments', body)
  await downstreamSettlementAction(platform, identity, s.id, 'payments', body)
  assert.equal((await supplierBilling(platform, identity)).downstream[0].status, 'paid')
  const platformBill = await createSettlement(platform, root.id, period, 'sa')
  await assert.rejects(
    async () => downstreamSettlementAction(platform, identity, platformBill.id, 'confirm', {}),
    (e) => e.code === 'settlement_payer_scope',
  )
  await updateAdminVendor(platform, root.id, { settlement_pay: false }, 'sa')
  await assert.rejects(
    async () => downstreamSettlementAction(platform, identity, s.id, 'payments', body),
    (e) => e.code === 'capability_required',
  )
})
test('S10 unsafe monetary precision and archived vendor edits are rejected', async (t) => {
  const { db, platform, root, fact } = await fixture(t)
  fact(root.id)
  db.prepare('UPDATE vendor_contracts SET price_cny_per_usd=?').run(1e100)
  await assert.rejects(
    async () => settlementPreview(platform, root.id, period),
    (e) => e.code === 'invalid_settlement_amount',
  )
  await updateAdminVendor(platform, root.id, { status: 'archived' }, 'sa')
  await assert.rejects(
    async () => updateAdminVendor(platform, root.id, { status: 'active' }, 'sa'),
    (e) => e.code === 'vendor_archived',
  )
  assert.equal((await adminVendorIdentity(platform, root.id, 'sa')).system_admin, true)
})

test('S14 archived children remain in authorized historical usage without regaining write access', async (t) => {
  const { platform, identity, child, fact } = await fixture(t)
  const c = await child()
  fact(c.id)
  await updateAdminVendor(platform, c.id, { status: 'archived' }, 'sa')
  assert.equal(
    (await supplierUsage(platform, identity, { query: { vendor_id: 'all', range: 'all' } })).summary.cost_usd,
    10,
  )
  assert.ok((await platform.resourceScope(identity, 'all')).includes(c.id))
  await assert.rejects(
    async () => platform.createAccount({ user_id: 'sa', vendor: c }, { name: 'blocked' }),
    (e) => e.code === 'vendor_inactive',
  )
})
