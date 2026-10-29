import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { VendorError, VendorPlatform } from '../../src/lib/vendor/vendor-platform.mjs'

function fixture() {
  const db = createDatabase({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-platform-')) })
  const stamp = new Date().toISOString()
  for (const [id, username] of [
    ['u1', 'vendor-one'],
    ['u2', 'vendor-two'],
    ['u3', 'outside'],
  ]) {
    db.prepare(
      'INSERT INTO users (id,email,username,password_hash,role,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
    ).run(id, `${username}@test.local`, username, 'hash', 'user', 'active', stamp, stamp)
  }
  return { db, platform: new VendorPlatform(db) }
}

function root(platform, overrides = {}) {
  return platform.createRoot({
    actorUserId: 'sa',
    body: {
      name: '供应商一',
      email: 'one@test.local',
      external_code: 'vendor-one',
      groups: ['coding'],
      platforms: ['claude'],
      account_limit: 2,
      proxy_limit: 2,
      child_limit: 1,
      capabilities: ['vendor.create_child', 'vendor.resource.manage', 'vendor.vm.create', 'vendor.usage.read'],
      user_id: 'u1',
      ...overrides,
    },
  })
}

test('vendor hierarchy creates a scoped V1 and V2 with member bindings', () => {
  const { platform } = fixture()
  const v1 = root(platform)
  assert.ok(v1.views.includes('vendors'))
  const v1Identity = platform.identity('u1')
  const v2 = platform.createChild(v1Identity, {
    name: '供应商二',
    email: 'two@test.local',
    external_code: 'vendor-two',
    groups: ['coding'],
    platforms: ['claude'],
    account_limit: 1,
    proxy_limit: 1,
    username: 'child-login',
    password: 'test-password',
  })
  assert.equal(v1.tier, 1)
  assert.equal(v2.tier, 2)
  assert.equal(v2.parent_id, v1.id)
  assert.equal(v2.root_id, v1.id)
  assert.equal(
    platform.identity(platform.db.prepare("SELECT id FROM users WHERE username='child-login'").get()?.id || 'u2').vendor
      .role,
    'vendor',
  )
  assert.equal(
    platform.identity(platform.db.prepare("SELECT id FROM users WHERE username='child-login'").get()?.id || 'u2').vendor
      .tier,
    2,
  )

  const childUser = platform.db
    .prepare('SELECT role FROM users WHERE id = ?')
    .get(platform.db.prepare("SELECT id FROM users WHERE username='child-login'").get().id)
  assert.equal(childUser.role, 'vendor')
})

test('supplier portal child creation provisions one vendor login identity', () => {
  const { platform } = fixture()
  root(platform, { child_limit: 1 })
  const child = platform.createChild(platform.identity('u1'), {
    name: '供应商二',
    email: 'child@test.local',
    external_code: 'child-vendor',
    username: 'child-vendor',
    password: 'strong-pass-123',
    groups: [],
    platforms: [],
  })
  const user = platform.db.prepare('SELECT id, role FROM users WHERE username = ?').get('child-vendor')
  assert.equal(user.role, 'vendor')
  assert.equal(platform.identity(user.id).vendor.id, child.id)
})

test('zero child limit allows unlimited direct child suppliers', () => {
  const { platform } = fixture()
  const parent = root(platform, { child_limit: 0 })
  const identity = platform.identity('u1')

  const first = platform.createChild(identity, {
    name: '供应商二 A',
    email: 'child-a@test.local',
    external_code: 'child-a',
    username: 'child-a',
    password: 'strong-pass-123',
    groups: [],
    platforms: [],
  })
  const second = platform.createChild(identity, {
    name: '供应商二 B',
    email: 'child-b@test.local',
    external_code: 'child-b',
    username: 'child-b',
    password: 'strong-pass-123',
    groups: [],
    platforms: [],
  })

  assert.equal(first.parent_id, parent.id)
  assert.equal(second.parent_id, parent.id)
  assert.equal(platform.db.prepare('SELECT COUNT(*) AS count FROM vendors WHERE parent_id = ?').get(parent.id).count, 2)
})

test('child creation enforces capability, parent subsets, quota and depth', () => {
  const { platform } = fixture()
  const v1 = root(platform, { capabilities: ['vendor.resource.manage'], groups: ['coding'] })
  assert.throws(
    () =>
      platform.createChild(platform.identity('u1'), {
        name: 'no',
        email: 'no@test.local',
        external_code: 'no',
        groups: [],
        platforms: [],
        username: 'child-login',
        password: 'test-password',
      }),
    (error) => error instanceof VendorError && error.code === 'capability_required',
  )

  const { platform: scoped } = fixture()
  const parent = root(scoped, { groups: ['coding'], platforms: ['claude'] })
  const identity = scoped.identity('u1')
  assert.throws(
    () =>
      scoped.createChild(identity, {
        name: 'bad',
        email: 'bad@test.local',
        external_code: 'bad',
        groups: ['other'],
        platforms: ['openai'],
        username: 'child-login',
        password: 'test-password',
      }),
    (error) => error.code === 'parent_scope_violation',
  )
  const child = scoped.createChild(identity, {
    name: 'good',
    email: 'good@test.local',
    external_code: 'good',
    groups: [],
    platforms: [],
    username: 'child-login',
    password: 'test-password',
  })
  assert.equal(scoped.getVendor(child.id).views.includes('vendors'), false)
  assert.throws(
    () =>
      scoped.createChild(identity, {
        name: 'third',
        email: 'third@test.local',
        external_code: 'third',
        groups: [],
        platforms: [],
        username: 'other-child',
        password: 'test-password',
      }),
    (error) => error.code === 'child_limit_exceeded',
  )
  assert.equal(child.parent_id, parent.id)
  assert.throws(
    () =>
      scoped.createChild(
        scoped.identity(scoped.db.prepare("SELECT id FROM users WHERE username='child-login'").get().id),
        {
          name: 'illegal',
          email: 'illegal@test.local',
          external_code: 'illegal',
          groups: [],
          platforms: [],
          username: 'other-child',
          password: 'test-password',
        },
      ),
    (error) => error.code === 'child_vendor_forbidden',
  )
})

test('resource writes are owner scoped and archived resources remain readable', () => {
  const { platform } = fixture()
  root(platform)
  const identity = platform.identity('u1')
  const resource = platform.createResource(identity, 'vm', { name: 'VM 01', config: { runtime: 'docker' } })
  assert.equal(resource.status, 'provisioning')
  assert.equal(platform.listResources(identity, 'vm').length, 1)
  const archived = platform.updateResource(identity, resource.id, { status: 'archived' })
  assert.equal(archived.status, 'archived')
  assert.equal(platform.listResources(identity, 'vm').length, 0)
  assert.throws(
    () =>
      platform.getResource(
        platform.identity(platform.db.prepare("SELECT id FROM users WHERE username='child-login'").get()?.id || 'u2'),
        resource.id,
      ),
    (error) => error.code === 'vendor_forbidden',
  )
})

test('tier-1 child resource inventory is read-only and capability scoped', () => {
  const { platform } = fixture()
  const parent = root(platform)
  const child = platform.createChild(platform.identity('u1'), {
    name: '供应商二',
    email: 'two@test.local',
    external_code: 'vendor-two',
    groups: [],
    platforms: [],
    username: 'child-login',
    password: 'test-password',
  })
  const childIdentity = platform.identity(
    platform.db.prepare("SELECT id FROM users WHERE username='child-login'").get()?.id || 'u2',
  )
  platform.createResource(childIdentity, 'account', { name: 'Child account' })
  platform.createResource(childIdentity, 'proxy', { name: 'Child proxy' })

  assert.equal(platform.listResources(platform.identity('u1'), 'account', { vendorId: child.id }).length, 1)
  assert.equal(platform.listResources(platform.identity('u1'), 'proxy', { vendorId: child.id }).length, 1)
  assert.throws(
    () => platform.listResources(childIdentity, 'account', { vendorId: parent.id }),
    (error) => error.code === 'vendor_scope_forbidden',
  )

  const { platform: restrictedPlatform } = fixture()
  root(restrictedPlatform, { capabilities: ['vendor.resource.manage'] })
  assert.throws(
    () => restrictedPlatform.listResources(restrictedPlatform.identity('u1'), 'account', { vendorId: child.id }),
    (error) => error.code === 'capability_required',
  )
  assert.equal(platform.listResources(platform.identity('u1'), 'account').length, 0)
  assert.equal(platform.listResources(platform.identity('u1'), 'account', { vendorId: 'all' }).length, 1)
  assert.throws(
    () => platform.resourceScope(platform.identity('u1'), 'unrelated'),
    (e) => e.code === 'vendor_scope_forbidden',
  )
  assert.equal(parent.tier, 1)
  assert.equal(child.tier, 2)
})

test('account creation is the only supplier path that creates a VM resource', () => {
  const { platform } = fixture()
  root(platform)
  const identity = platform.identity('u1')
  const result = platform.createAccount(identity, {
    name: '账号 01',
    platform: 'anthropic',
    auth_method: 'oauth',
    locale: 'zh_CN.UTF-8',
    idempotency_key: 'account-once',
  })
  assert.equal(result.account.resource_type, 'account')
  assert.equal(result.vm.resource_type, 'vm')
  assert.equal(result.vm.status, 'provisioning')
  assert.equal(result.vm.config.account_resource_id, result.account.id)
  const retry = platform.createAccount(identity, {
    name: 'ignored',
    platform: 'anthropic',
    auth_method: 'oauth',
    idempotency_key: 'account-once',
  })
  assert.equal(retry.account.id, result.account.id)
})

test('V1 usage aggregate includes direct child while V2 remains isolated', () => {
  const { platform } = fixture()
  const parent = root(platform)
  const child = platform.createChild(platform.identity('u1'), {
    name: '供应商二',
    email: 'two@test.local',
    external_code: 'vendor-two',
    groups: [],
    platforms: [],
    username: 'child-login',
    password: 'test-password',
  })
  const stamp = new Date().toISOString()
  platform.db
    .prepare(
      'INSERT INTO vendor_usage_facts (id,vendor_id,model,input_tokens,output_tokens,cost_usd,occurred_at,source_request_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    )
    .run('usage-1', child.id, 'gpt', 10, 5, 1.25, stamp, 'req-1', stamp)
  assert.equal(platform.usageSummary(platform.identity('u1')).totals.cost_usd, 1.25)
  assert.equal(
    platform.usageSummary(
      platform.identity(platform.db.prepare("SELECT id FROM users WHERE username='child-login'").get()?.id || 'u2'),
    ).totals.cost_usd,
    1.25,
  )
})

test('supplier audit records child and resource mutations', () => {
  const { platform } = fixture()
  root(platform)
  const identity = platform.identity('u1')
  platform.createResource(identity, 'proxy', { name: 'Proxy 01', config: { scheme: 'socks5' } })
  const events = platform.auditLogs(identity)
  assert.ok(events.some((event) => event.action === 'vendor.created'))
  assert.ok(events.some((event) => event.action === 'resource.proxy.created'))
})
