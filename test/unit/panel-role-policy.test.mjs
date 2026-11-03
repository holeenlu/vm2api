import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PANEL_VIEWS,
  canViewPage,
  capabilitiesForRole,
  normalizePanelRole,
  viewsForRole,
} from '../../src/lib/admin/panel-role-policy.mjs'

test('panel role policy preserves role normalization and view boundaries', () => {
  assert.equal(normalizePanelRole(' SUPER_ADMIN '), 'super_admin')
  assert.equal(normalizePanelRole('unknown'), 'user')
  assert.ok(viewsForRole('super_admin').includes('settings'))
  assert.ok(!viewsForRole('vendor').includes('overview'))
  assert.ok(canViewPage('admin', 'users'))
  assert.ok(!canViewPage('admin', 'vm'))
  assert.deepEqual(capabilitiesForRole('vendor'), ['panel.read', 'vendor.portal'])
  assert.equal(PANEL_VIEWS.length, 23)
})
