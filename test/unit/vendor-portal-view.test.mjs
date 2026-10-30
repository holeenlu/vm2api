import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { VendorPlatform } from '../../src/lib/vendor/vendor-platform.mjs'
import { accountPortalRows } from '../../src/lib/vendor/vendor-portal-view.mjs'
import { supplierBilling } from '../../src/lib/vendor/vendor-settlements.mjs'
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supplier-view-'))
  const db = createDatabase({ dataDir: dir })
  t.after(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const platform = new VendorPlatform(db)
  const vendor = platform.createRoot({
    actorUserId: 'sa',
    body: {
      username: 'vendor-a',
      password: 'vendor-test-123',
      capabilities: ['vendor.vm.create', 'vendor.resource.manage', 'vendor.create_child', 'vendor.settlement.read'],
    },
  })
  return { platform, identity: { vendor, user_id: 'sa' } }
}
test('portal keeps unknown values null, excludes other accounts and omits raw credentials', (t) => {
  const { platform, identity } = fixture(t)
  const pair = platform.createAccount(identity, { name: 'A', platform: 'anthropic' })
  platform.db
    .prepare('UPDATE vendor_resources SET config_json=? WHERE id=?')
    .run(JSON.stringify({ runtime_vm_id: 'vm-a' }), pair.vm.id)
  const resources = platform.listResources(identity, 'account')
  let rows = accountPortalRows(platform, resources, {
    readVm: () => ({ schedulable: false, summary: { has_token: false, status: 'stopped', token: 'secret' } }),
  })
  assert.equal(rows[0].telemetry.state, 'unauthorized')
  assert.equal(rows[0].telemetry.total_cost, 0)
  platform.db
    .prepare(
      "INSERT INTO usage_logs(id,request_id,vm_id,created_at,status,total_cost) VALUES ('usage-test','req-test','vm-a',?,200,2.5)",
    )
    .run(new Date(Date.now() - 1000).toISOString())
  rows = accountPortalRows(platform, resources, {
    usageAccounts: [
      { vm_id: 'other', total_cost: 999 },
      { vm_id: 'vm-a', total_cost: 2.5, utilization_7d: 0.3, reset_7d: '2030-01-01T00:00:00Z', token: 'secret' },
    ],
    readVm: () => ({ schedulable: true, summary: { has_token: true, status: 'running' } }),
  })
  assert.equal(rows[0].telemetry.total_cost, 2.5)
  assert.equal(rows[0].telemetry.state, 'available')
  assert.equal(rows[0].telemetry.utilization_7d, 0.3)
  assert.equal(JSON.stringify(rows).includes('secret'), false)
})
test('proxy credentials stay private and binding validates supplier ownership', (t) => {
  const { platform, identity } = fixture(t)
  const proxy = platform.createProxy(identity, {
    name: 'exit',
    config: { endpoint: 'socks5://user:private@127.0.0.1:1080' },
  })
  assert.equal(JSON.stringify(proxy).includes('private'), false)
  let bound
  platform.vmProvisioner = ({ body }) => {
    bound = body.proxy
    return { id: 'vm-bound' }
  }
  platform.createAccount(identity, { name: 'bound', proxy_id: proxy.id })
  assert.equal(bound.url, 'socks5://user:private@127.0.0.1:1080')
  const other = platform.createRoot({ actorUserId: 'sa', body: { username: 'vendor-b', password: 'vendor-test-123' } })
  assert.throws(
    () => platform.createAccount({ user_id: 'sa', vendor: other }, { name: 'bad', proxy_id: proxy.id }),
    (e) => e.code === 'vendor_scope_forbidden',
  )
  assert.throws(
    () => platform.createProxy(identity, { name: 'bad', config: { endpoint: 'file:///tmp/test' } }),
    (e) => e.code === 'invalid_proxy',
  )
})
test('negative and fractional child limits rejected; zero remains stored', (t) => {
  const { platform, identity } = fixture(t)
  assert.equal(identity.vendor.child_limit, 0)
  for (const child_limit of [-1, 0.5, NaN])
    assert.throws(
      () =>
        platform.createRoot({
          actorUserId: 'sa',
          body: { username: 'bad-vendor', password: 'vendor-test-123', child_limit },
        }),
      (e) => e.code === 'invalid_child_limit',
    )
})
test('statements require explicit settlement permission', (t) => {
  const { platform, identity } = fixture(t)
  assert.deepEqual(supplierBilling(platform, identity).upstream, [])
  platform.db
    .prepare("UPDATE vendor_capabilities SET enabled=0 WHERE vendor_id=? AND capability='vendor.settlement.read'")
    .run(identity.vendor.id)
  assert.throws(
    () => supplierBilling(platform, identity),
    (e) => e.code === 'capability_required',
  )
})

test('account workbench reports recent throughput, Fable windows and scoped metadata', (t) => {
  const { platform, identity } = fixture(t)
  const proxy = platform.createProxy(identity, {
    name: 'private exit',
    config: { endpoint: 'http://user:never-echo@127.0.0.1:3128' },
  })
  platform.vmProvisioner = () => ({ id: 'vm-metrics' })
  const pair = platform.createAccount(identity, { name: 'metrics', proxy_id: proxy.id })
  const now = Date.now()
  for (const [id, vm, ago, cost, tokens, model] of [
    ['old', 'vm-metrics', 120000, 8, 9999, 'claude-fable-5'],
    ['new', 'vm-metrics', 1000, 2, 100, 'claude-fable-5'],
    ['outside', 'vm-other', 1000, 999, 50000, 'other'],
  ]) {
    platform.db
      .prepare(
        'INSERT INTO usage_logs(id,request_id,vm_id,created_at,status,model,total_cost,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens) VALUES (?,?,?,?,200,?,?,?,20,30,10)',
      )
      .run(id, id, vm, new Date(now - ago).toISOString(), model, cost, tokens)
  }
  const row = accountPortalRows(platform, [pair.account], {
    now,
    usageAccounts: [
      {
        vm_id: 'vm-metrics',
        total_cost: 10,
        today_cost: 10,
        utilization_7d_oi: 0.3,
        reset_7d_oi: '2030-01-01',
        usage_has_fable: true,
      },
    ],
    readVm: () => ({
      schedulable: true,
      summary: { has_token: true, status: 'running', platform: 'anthropic', account_tier: 'max', weight: 2 },
    }),
  })[0]
  assert.equal(row.telemetry.rpm, 1)
  assert.equal(row.telemetry.tpm, 120)
  assert.equal(row.telemetry.tpm_with_cache, 160)
  assert.equal(row.telemetry.has_fable, true)
  assert.equal(row.telemetry.utilization_fable, 0.3)
  assert.equal(row.telemetry.fable_cost, 10)
  assert.equal(row.telemetry.priority, 2)
  assert.equal(row.proxy.name, 'private exit')
  assert.equal(JSON.stringify(row).includes('never-echo'), false)
})

test('OpenAI unknown quota readings do not fall back to synthetic zero counters', (t) => {
  const { platform, identity } = fixture(t)
  platform.db.prepare("UPDATE groups SET platform='mixed' WHERE id=1").run()
  platform.vmProvisioner = () => ({ id: 'vm-codex-unknown' })
  const pair = platform.createAccount(identity, { name: 'unknown', platform: 'openai' })
  const row = accountPortalRows(platform, [pair.account], {
    usageAccounts: [{ vm_id: 'vm-codex-unknown', utilization_5h: 0, utilization_7d: 0, total_tokens: 999999 }],
    readVm: () => ({
      summary: {
        platform: 'openai',
        has_token: false,
        account_tier: 'codex',
        utilization_5h: null,
        utilization_7d: null,
      },
    }),
  })[0]
  assert.equal(row.telemetry.utilization_5h, null)
  assert.equal(row.telemetry.utilization_7d, null)
  assert.equal(row.telemetry.plan_type, null)
  assert.equal(row.telemetry.tpm, 0)
})
