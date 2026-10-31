import test from 'node:test'
import assert from 'node:assert/strict'
import {
  keyScopeFromRecord,
  keyScopeFromRequest,
  keyAllowsVm,
  keyAllowsModel,
  groupScopeDenial,
} from '../../src/lib/admin/key-scope.mjs'
test('platform service keys are explicit; a missing commercial database fails closed', () => {
  assert.equal(keyScopeFromRecord({}, null).platform, true)
  const group = keyScopeFromRecord({ group_id: 3 }, null)
  assert.equal(keyAllowsVm(group, { id: 'vm-1' }), false)
  assert.equal(groupScopeDenial(group).code, 'group_unavailable')
  assert.equal(keyScopeFromRequest({ apiKeyKind: 'master' }).platform, true)
})
test('live group candidates require membership and compatible platform', () => {
  const scope = { group_id: 3, group_type: 'anthropic', allowed_vms: ['vm-1'], models: ['claude-sonnet-5'] }
  assert.equal(keyAllowsVm(scope, { id: 'vm-1', platform: 'anthropic' }), true)
  assert.equal(keyAllowsVm(scope, { id: 'vm-2', platform: 'anthropic' }), false)
  assert.equal(keyAllowsVm({ ...scope, allowed_vms: [] }, { id: 'vm-1' }), false)
  assert.equal(keyAllowsVm({ ...scope, error: 'group_disabled' }, { id: 'vm-1' }), false)
  assert.equal(keyAllowsModel(scope, 'claude-sonnet-5'), true)
  assert.equal(keyAllowsModel(scope, 'gpt-5'), false)
})
