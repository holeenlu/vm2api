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
