import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { VendorPlatform } from '../../src/lib/vendor/vendor-platform.mjs'
import { accountPortalRows, supplierStatements } from '../../src/lib/vendor/vendor-portal-view.mjs'
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
      name: 'A',
      email: 'a@local',
      external_code: 'a',
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
  assert.equal(rows[0].telemetry.total_cost, null)
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
  const other = platform.createRoot({ actorUserId: 'sa', body: { name: 'B', email: 'b@local', external_code: 'b' } })
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
          body: { name: 'bad', email: 'bad@local', external_code: 'bad', child_limit },
        }),
      (e) => e.code === 'invalid_child_limit',
    )
})
test('statements require explicit settlement permission', (t) => {
  const { platform, identity } = fixture(t)
  assert.deepEqual(supplierStatements(platform, identity), [])
  platform.db
    .prepare("UPDATE vendor_capabilities SET enabled=0 WHERE vendor_id=? AND capability='vendor.settlement.read'")
    .run(identity.vendor.id)
  assert.throws(
    () => supplierStatements(platform, identity),
    (e) => e.code === 'capability_required',
  )
})
