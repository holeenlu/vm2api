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

test('supplier audit records child and resource mutations', () => {
  const { platform } = fixture()
  root(platform)
  const identity = platform.identity('u1')
  platform.createResource(identity, 'proxy', { name: 'Proxy 01', config: { scheme: 'socks5' } })
  const events = platform.db.prepare('SELECT * FROM vendor_audit_events WHERE vendor_id=?').all(identity.vendor.id)
  assert.ok(events.some((event) => event.action === 'vendor.created'))
  assert.ok(events.some((event) => event.action === 'resource.proxy.created'))
})

test('supplier signup derives internal identity and refuses inline settlement parameters', () => {
  const { platform, db } = fixture()
  const parent = root(platform)
  assert.throws(
    () =>
      platform.createChild(platform.identity('u1'), {
        username: 'simple-child',
        password: 'login-password-123',
        default_price_cny_per_usd: 2.5,
      }),
    (e) => e.code === 'pricing_settings_required',
  )
  const child = platform.createChild(platform.identity('u1'), {
    username: 'simple-child',
    password: 'login-password-123',
  })
  assert.equal(child.name, 'simple-child')
  assert.equal(child.parent_id, parent.id)
  for (const key of [
    'external_code',
    'email',
    'contact_name',
    'settlement_email',
    'binance_id',
    'default_price_cny_per_usd',
    'group_prices',
    'fx_cny_per_usdt',
    'default_multiplier',
  ])
    assert.equal(key in child, false)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM vendor_contracts').get().n, 0)
  assert.throws(
    () => platform.createChild(platform.identity('u1'), { username: 'simple-child', password: 'login-password-123' }),
    (e) => ['username_exists', 'child_limit_exceeded'].includes(e.code),
  )
})

test('inline proxy accepts compact syntax, reuses owned endpoints, and rolls back invalid accounts', () => {
  const { platform, db } = fixture()
  root(platform, { account_limit: 0, proxy_limit: 0 })
  const identity = platform.identity('u1')
  let proxy
  platform.vmProvisioner = ({ resourceId, body }) => {
    proxy = body.proxy
    return { id: 'vm-' + resourceId }
  }
  const first = platform.createAccount(identity, {
    name: 'inline',
    authorization_kind: 'claude_oauth',
    proxy_endpoint: '127.0.0.1:3128:alice:p:a:ss',
    idempotency_key: 'first',
  })
  assert.equal(proxy.url, 'http://alice:p%3Aa%3Ass@127.0.0.1:3128')
  const second = platform.createAccount(identity, {
    name: 'existing',
    authorization_kind: 'claude_oauth',
    proxy_endpoint: 'http://alice:p%3Aa%3Ass@127.0.0.1:3128',
    idempotency_key: 'second',
  })
  assert.equal(first.account.config.proxy_id, second.account.config.proxy_id)
  const replay = platform.createAccount(identity, { idempotency_key: 'first', proxy_endpoint: '127.0.0.1:4999' })
  assert.equal(replay.account.id, first.account.id)
  assert.equal(platform.listResources(identity, 'proxy').length, 1)
  assert.equal(JSON.stringify(platform.listResources(identity, 'proxy')).includes('p%3Aa%3Ass'), false)
  const before = db.prepare('SELECT COUNT(*) n FROM vendor_resources').get().n
  assert.throws(
    () => platform.createAccount(identity, { proxy_endpoint: '127.0.0.1:9999', authorization_kind: 'bad' }),
    (e) => e.code === 'authorization_kind_invalid',
  )
  assert.equal(db.prepare('SELECT COUNT(*) n FROM vendor_resources').get().n, before)
  assert.throws(
    () => platform.createAccount(identity, { proxy_endpoint: 'file:///tmp/secret' }),
    (e) => e.code === 'invalid_proxy',
  )
})

test('proxy updates keep the existing endpoint when the edit payload omits it', () => {
  const { platform } = fixture()
  root(platform)
  const identity = platform.identity('u1')
  const proxy = platform.createProxy(identity, {
    name: 'proxy-a',
    config: { endpoint: 'socks5://user:password@127.0.0.1:1080' },
  })
  const renamed = platform.updateProxyResource(identity, proxy.id, { name: 'proxy-b' })
  assert.equal(renamed.name, 'proxy-b')
  assert.equal(platform.resourceSecret(identity, proxy.id).endpoint, 'socks5://user:password@127.0.0.1:1080')
  const changed = platform.updateProxyResource(identity, proxy.id, { endpoint: 'http://127.0.0.1:8080' })
  assert.equal(platform.resourceSecret(identity, proxy.id).endpoint, 'http://127.0.0.1:8080')
  assert.equal(changed.config.endpoint, 'http://127.0.0.1:8080/')
})
