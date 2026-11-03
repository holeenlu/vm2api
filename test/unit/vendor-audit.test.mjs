import '../fixtures/kin-computer-test-env.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'
import { VendorPlatform } from '../../src/lib/vendor/vendor-platform.mjs'
import { createVendorVmProvisioner } from '../../src/lib/vendor/vendor-vm-provisioner.mjs'
import { GroupsRepo } from '../../src/lib/db/repos/groups-repo.mjs'
import { RequestLogStore } from '../../src/lib/admin/request-log.mjs'
import { vendorRuntimeBlock } from '../../src/lib/vendor/vendor-runtime-policy.mjs'
import { readVendorUsage } from '../../src/lib/vendor/vendor-account-usage.mjs'
function fixture(t) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-audit-'))
  closeDatabase()
  const db = openDatabase({ dataDir: path.join(project, 'data') })
  t.after(() => {
    closeDatabase()
    fs.rmSync(project, { recursive: true, force: true })
  })
  const platform = new VendorPlatform(db, {
    vmProvisioner: createVendorVmProvisioner({ cfg: { paths: { project } }, routingConfig: {} }),
  })
  const vendor = platform.createRoot({
    actorUserId: 'sa',
    body: {
      username: 'audit-vendor',
      groups: ['1'],
      password: 'test-password',
      capabilities: [
        'vendor.resource.manage',
        'vendor.vm.create',
        'vendor.create_child',
        'vendor.usage.read',
        'vendor.settlement.read',
        'vendor.settlement.pay',
      ],
    },
  })
  const identity = platform.identity(db.prepare("SELECT id FROM users WHERE username='audit-vendor'").get().id)
  const groups = new GroupsRepo(db)
  const configure = (vm, account) =>
    groups.assignResource('vm', vm.id, account.config.group_ids, groups.resourceVersion('vm', vm.id), identity.user_id)
  return { project, db, platform, vendor, identity, groups, configure }
}
test('A01 no compatible group rejects creation before any proxy, VM or quota is consumed', (t) => {
  const f = fixture(t)
  assert.throws(
    () => f.platform.createAccount(f.identity, { platform: 'openai', proxy_endpoint: '127.0.0.1:4001' }),
    (e) => e.code === 'no_available_group',
  )
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM vendor_resources').get().n, 0)
  assert.equal(fs.existsSync(path.join(f.project, 'vms')), false)
})
test('A02 a binding failure rolls back resources and group membership before VM files are written', (t) => {
  const f = fixture(t)
  assert.throws(
    () =>
      f.platform.createAccount(
        f.identity,
        { platform: 'anthropic', idempotency_key: 'binding-failure' },
        {
          configure: (vm, account) => {
            f.configure(vm, account)
            throw new Error('pool full')
          },
        },
      ),
    /pool full/,
  )
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM vendor_resources').get().n, 0)
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM group_resources WHERE resource_kind='vm'").get().n, 0)
  assert.equal(fs.existsSync(path.join(f.project, 'vms', 'vm-01.json')), false)
  const retry = f.platform.createAccount(
    f.identity,
    { platform: 'anthropic', idempotency_key: 'binding-failure' },
    { configure: f.configure },
  )
  assert.equal(retry.vm.config.runtime_vm_id, 'vm-01')
})
test('A03 a database failure after provisioning removes only the newly created VM and seed files', (t) => {
  const f = fixture(t)
  f.db.exec(
    "CREATE TRIGGER fail_account_link BEFORE UPDATE OF config_json ON vendor_resources WHEN NEW.resource_type='account' BEGIN SELECT RAISE(ABORT,'reject link'); END",
  )
  assert.throws(
    () => f.platform.createAccount(f.identity, { platform: 'anthropic' }, { configure: f.configure }),
    /reject link/,
  )
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM vendor_resources').get().n, 0)
  assert.equal(fs.existsSync(path.join(f.project, 'vms', 'vm-01.json')), false)
  assert.equal(fs.existsSync(path.join(f.project, 'vms', 'vm-01')), false)
})
test('A04 auto numbering preserves abandoned directories and their old credentials', (t) => {
  const f = fixture(t),
    dir = path.join(f.project, 'vms', 'vm-01')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'private-marker'), 'preserve')
  const pair = f.platform.createAccount(f.identity, {}, { configure: f.configure })
  assert.equal(pair.vm.config.runtime_vm_id, 'vm-02')
  assert.equal(fs.readFileSync(path.join(dir, 'private-marker'), 'utf8'), 'preserve')
  assert.equal(pair.account.name, pair.vm.name)
  assert.equal(pair.account.status, pair.vm.status)
  const machine = JSON.parse(fs.readFileSync(path.join(f.project, 'vms', 'vm-02.json'))).machine
  assert.equal(machine.memory, '4g')
  assert.equal(machine.vcpus, 4)
  assert.equal(machine.docker_cpus, 4)
})
test('A05 runtime scope uses real group membership and enforces later parent restrictions', (t) => {
  const f = fixture(t)
  f.db.prepare('UPDATE vendors SET groups_json=\'["1"]\' WHERE id=?').run(f.vendor.id)
  const pair = f.platform.createAccount(f.identity, {}, { configure: f.configure })
  const vm = JSON.parse(fs.readFileSync(path.join(f.project, 'vms', pair.vm.config.runtime_vm_id + '.json')))
  assert.equal(vendorRuntimeBlock(vm, f.db), null)
  f.groups.assignResource('vm', vm.id, [], f.groups.resourceVersion('vm', vm.id), f.identity.user_id)
  assert.equal(vendorRuntimeBlock(vm, f.db), 'vendor_scope_revoked')
  const child = f.platform.createChild(f.identity, {
    username: 'audit-child',
    password: 'test-password',
    platforms: ['anthropic'],
  })
  f.db.prepare('UPDATE vendors SET platforms_json=\'["openai"]\' WHERE id=?').run(f.vendor.id)
  assert.deepEqual(f.platform.getVendor(child.id).effective_platforms, [])
})
test('A06 logging off retains minimal supplier usage without request bodies; other traffic remains off', (t) => {
  const f = fixture(t),
    pair = f.platform.createAccount(f.identity, {}, { configure: f.configure })
  const store = new RequestLogStore({ db: f.db, mode: 'off' })
  const request = { method: 'POST', url: '/v1/messages', headers: { 'x-request-id': 'supplier-off' } }
  const ctx = store.start(request, { protocol: 'anthropic' })
  store.finish(ctx, {
    vm_id: pair.vm.config.runtime_vm_id,
    status: 200,
    model: 'claude-sonnet-4',
    usage: { input_tokens: 10, output_tokens: 2 },
    request_body: { secret: 'never-store' },
  })
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM usage_logs').get().n, 1)
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM vendor_usage_facts').get().n, 1)
  assert.ok(!JSON.stringify(f.db.prepare('SELECT * FROM usage_logs').all()).includes('never-store'))
  store.finish(
    { ...ctx, request_id: 'other' },
    { vm_id: 'platform-slot', status: 200, model: 'claude-sonnet-4', usage: { input_tokens: 10 } },
  )
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM usage_logs').get().n, 1)
  f.db.prepare('DELETE FROM usage_logs').run()
  const report = readVendorUsage(f.db, [pair.vm.config.runtime_vm_id])
  assert.equal(report.summary.requests, 1)
  assert.ok(report.summary.cost_usd > 0)
  assert.equal(report.summary.total_tokens, null)
  assert.equal(report.trend[0].cache_complete, false)
  assert.equal(report.trend[0].total_tokens, null)
})

test('A12 supplier signup cannot set prices or create an implicit financial contract', (t) => {
  const f = fixture(t)
  for (const price of [true, 1.6, 1e12, Infinity])
    assert.throws(
      () =>
        f.platform.createChild(f.identity, {
          username: 'precision-child',
          password: 'test-password',
          default_price_cny_per_usd: price,
        }),
      (e) => e.code === 'pricing_settings_required',
    )
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM users WHERE username='precision-child'").get().n, 0)
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM vendor_contracts').get().n, 0)
})
