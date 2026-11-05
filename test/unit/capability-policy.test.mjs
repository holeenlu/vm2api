import test from 'node:test'
import assert from 'node:assert/strict'
import { authorizePanelRoute } from '../../src/lib/admin/capability-policy.mjs'

test('capability policy preserves panel route boundaries', () => {
  assert.equal(authorizePanelRoute('GET', '/api/panel/me', 'user').ok, true)
  assert.equal(authorizePanelRoute('POST', '/api/panel/users', 'admin').ok, true)
  assert.equal(authorizePanelRoute('POST', '/api/panel/users', 'user').ok, false)
  assert.equal(authorizePanelRoute('GET', '/api/panel/jev-usage', 'super_admin').ok, true)
  assert.equal(authorizePanelRoute('GET', '/api/panel/jev-usage', 'vendor').ok, false)
})

test('admin resource grants open exactly the routes their level covers', () => {
  const read = ['resources.read']
  const edit = ['resources.edit']
  const manage = ['resources.manage']
  // 未授予：资源路由一律拒绝，原有 admin 能力不变
  assert.equal(authorizePanelRoute('GET', '/api/panel/vms', 'admin').ok, false)
  assert.equal(authorizePanelRoute('GET', '/api/panel/vms', 'admin', []).ok, false)
  assert.equal(authorizePanelRoute('POST', '/api/panel/users', 'admin', []).ok, true)
  assert.equal(authorizePanelRoute('GET', '/api/panel/groups', 'admin', []).ok, true)

  assert.equal(authorizePanelRoute('GET', '/api/panel/vms', 'admin', read).ok, true)
  assert.equal(authorizePanelRoute('GET', '/api/panel/vms/vm-1', 'admin', read).ok, true)
  assert.equal(authorizePanelRoute('PATCH', '/api/panel/vms/vm-1', 'admin', read).ok, false)
  assert.equal(authorizePanelRoute('POST', '/api/panel/vms/create', 'admin', read).ok, false)
  assert.equal(authorizePanelRoute('POST', '/api/panel/vms/create', 'admin', ['resources.create']).ok, true)

  assert.equal(authorizePanelRoute('PATCH', '/api/panel/vms/vm-1', 'admin', edit).ok, true)
  assert.equal(authorizePanelRoute('DELETE', '/api/panel/vms/vm-1', 'admin', edit).ok, false)
  assert.equal(authorizePanelRoute('POST', '/api/panel/vms/vm-1/shell-ticket', 'admin', edit).ok, false)
  assert.equal(authorizePanelRoute('GET', '/api/panel/vms/vm-1/package', 'admin', edit).ok, false)
  assert.equal(authorizePanelRoute('POST', '/api/panel/vms/fleet-update', 'admin', edit).ok, false)

  assert.equal(authorizePanelRoute('DELETE', '/api/panel/vms/vm-1', 'admin', manage).ok, true)
  assert.equal(authorizePanelRoute('POST', '/api/panel/vms/vm-1/shell-ticket', 'admin', manage).ok, true)
  assert.equal(authorizePanelRoute('GET', '/api/panel/vms/vm-1/package', 'admin', manage).ok, true)

  // 平台级页面不因资源能力放开
  for (const [method, path] of [
    ['GET', '/api/panel/jev-usage'],
    ['GET', '/api/panel/gateway-workers'],
    ['PUT', '/api/panel/test-schedule/default'],
    ['POST', '/api/panel/proxies/import'],
    ['GET', '/api/panel/database/metrics'],
  ])
    assert.equal(authorizePanelRoute(method, path, 'admin', manage).ok, false, method + path)
  // user / vendor 携带授予记录也无效；super_admin 不受影响
  assert.equal(authorizePanelRoute('GET', '/api/panel/vms', 'user', manage).ok, false)
  assert.equal(authorizePanelRoute('GET', '/api/panel/vms', 'vendor', manage).ok, false)
  assert.equal(authorizePanelRoute('DELETE', '/api/panel/vms/vm-1', 'super_admin').ok, true)
})
