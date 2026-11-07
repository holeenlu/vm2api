import test from 'node:test'
import assert from 'node:assert/strict'
import { mePayload, panelIdentity, canResource } from '../../src/lib/admin/panel-acl.mjs'
import {
  normalizeResourcePermissions,
  resourcePermissionsFor,
  resourceRouteRequirement,
} from '../../src/lib/admin/resource-permissions.mjs'

test('resource permissions add implied levels and drop unknown values', () => {
  assert.deepEqual(normalizeResourcePermissions(['resources.manage']), [
    'resources.read',
    'resources.edit',
    'resources.manage',
  ])
  assert.deepEqual(normalizeResourcePermissions('["resources.create","bogus"]'), ['resources.read', 'resources.create'])
  assert.deepEqual(normalizeResourcePermissions('not json'), [])
})

test('only admin grants count; super_admin owns everything; user and vendor own nothing', () => {
  assert.equal(resourcePermissionsFor('super_admin').length, 4)
  assert.deepEqual(resourcePermissionsFor('admin', ['resources.edit']), ['resources.read', 'resources.edit'])
  assert.deepEqual(resourcePermissionsFor('user', ['resources.manage']), [])
  assert.deepEqual(resourcePermissionsFor('vendor', ['resources.manage']), [])
})

test('me payload exposes resource views and capabilities only to granted admins', () => {
  const granted = mePayload({ panelUser: 'ops', panelRole: 'admin', panelResourcePermissions: ['resources.read'] })
  assert.ok(granted.views.includes('vm'))
  assert.ok(granted.views.includes('codex-accounts'))
  assert.ok(granted.views.includes('supplier-accounts'))
  assert.ok(!granted.views.includes('suppliers'))
  assert.deepEqual(granted.resource_permissions, ['resources.read'])
  assert.ok(granted.capabilities.includes('resources.read'))
  assert.equal('vm_create_quota' in granted, false)
  const plain = mePayload({ panelUser: 'ops', panelRole: 'admin' })
  assert.ok(!plain.views.includes('vm'))
  assert.deepEqual(plain.resource_permissions, [])
  assert.equal(panelIdentity({ apiKeyKind: 'master' }).resource_permissions.length, 4)
  assert.equal(canResource({ panelRole: 'admin', panelResourcePermissions: ['resources.edit'] }, 'manage'), false)
  assert.equal(canResource({ panelRole: 'admin', panelResourcePermissions: ['resources.manage'] }, 'edit'), true)
})

test('route requirements separate read, create, edit and manage', () => {
  const cases = [
    ['GET', '/api/panel/vms', 'read'],
    ['GET', '/api/panel/vms/vm-1', 'read'],
    ['GET', '/api/panel/vms/create-options', 'create'],
    ['POST', '/api/panel/vms/create', 'create'],
    ['POST', '/api/panel/vms/import', 'create'],
    ['PATCH', '/api/panel/vms/vm-1', 'edit'],
    ['POST', '/api/panel/vms/vm-1/oauth/exchange-code', 'edit'],
    ['POST', '/api/panel/vms/bulk-edit', 'edit'],
    ['DELETE', '/api/panel/vms/vm-1', 'manage'],
    ['POST', '/api/panel/vms/vm-1/reset', 'manage'],
    ['POST', '/api/panel/vms/vm-1/shell-ticket', 'manage'],
    ['GET', '/api/panel/vms/vm-1/package', 'manage'],
    ['POST', '/api/panel/vms/fleet-update', 'manage'],
    ['GET', '/api/panel/codex-accounts', 'read'],
    ['POST', '/api/panel/codex-accounts/drafts', 'create'],
    ['POST', '/api/panel/codex-accounts/import-file', 'create'],
    ['POST', '/api/panel/codex-accounts/acc-1/drafts', 'edit'],
    ['PATCH', '/api/panel/codex-accounts/acc-1', 'edit'],
    ['POST', '/api/panel/codex-accounts/export', 'manage'],
    ['GET', '/api/admin/vendors', 'read'],
    ['GET', '/api/admin/vendors/accounts', 'read'],
    ['POST', '/api/admin/vendors/accounts', 'create'],
    ['PATCH', '/api/admin/vendors/accounts/acc-1', 'edit'],
    ['POST', '/api/admin/vendors/accounts/acc-1/gateway-drafts', 'edit'],
    ['DELETE', '/api/admin/vendors/accounts/acc-1', 'manage'],
    ['GET', '/api/admin/vendors/proxies', 'read'],
    ['GET', '/api/panel/groups', 'read'],
  ]
  for (const [method, path, level] of cases)
    assert.equal(resourceRouteRequirement(method, path), level, method + ' ' + path)
  assert.equal(resourceRouteRequirement('GET', '/api/admin/vendors/settlements'), null)
  assert.equal(resourceRouteRequirement('GET', '/api/panel/gateway-workers'), null)
  assert.equal(resourceRouteRequirement('GET', '/api/panel/users'), null)
})

test('identity helpers: projection role, level checks and owner-field guard', async () => {
  const { identityCanResource, resourceViewRole, ownerChangeDenied } = await import('../../src/lib/admin/panel-acl.mjs')
  const ident = (role, perms = []) => panelIdentity({ panelRole: role, panelResourcePermissions: perms })
  assert.equal(resourceViewRole(ident('admin', ['resources.read'])), 'super_admin')
  assert.equal(resourceViewRole(ident('admin')), 'admin')
  assert.equal(resourceViewRole(ident('user', ['resources.manage'])), 'user')
  assert.equal(resourceViewRole(ident('super_admin')), 'super_admin')
  // 只带角色的身份（单元测试注入的 panelIdentity）对 super_admin 仍视为拥有全部能力
  assert.equal(identityCanResource({ role: 'super_admin' }, 'manage'), true)
  assert.equal(identityCanResource(ident('admin', ['resources.edit']), 'manage'), false)
  assert.equal(ownerChangeDenied(ident('admin', ['resources.edit']), { vendor_id: 'v1' }), true)
  assert.equal(ownerChangeDenied(ident('admin', ['resources.edit']), { weight: 2 }), false)
  assert.equal(ownerChangeDenied(ident('admin', ['resources.manage']), { owner_user_id: 'u' }), false)
})
