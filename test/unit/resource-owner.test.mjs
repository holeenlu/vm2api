import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PLATFORM_SCOPE,
  canBindProxyToVm,
  filterVmsForPanel,
  ownerScopeFromApiKey,
  vmMatchesOwnerScope,
  vmOwnerId,
  vmOriginOf,
} from '../../src/lib/admin/resource-owner.mjs'
test('platform diagnostics exclude unmigrated private supply; commercial scope is separate', () => {
  assert.deepEqual(ownerScopeFromApiKey(null, { apiKeyKind: 'master' }), PLATFORM_SCOPE)
  assert.equal(vmMatchesOwnerScope({ owner_user_id: 'legacy' }, PLATFORM_SCOPE), false)
  assert.deepEqual(ownerScopeFromApiKey({ user_id: 'customer', group_id: 3 }), { type: 'any' })
  assert.equal(vmOwnerId({ owner_user_id: 'legacy' }), 'legacy')
  assert.equal(vmOriginOf({ owner_user_id: 'legacy' }), 'admin_assigned')
})
test('customers cannot administer legacy private resources; staff retain resource views', () => {
  const resources = [{ id: 'vm-1', owner_user_id: 'user' }, { id: 'vm-2' }]
  assert.deepEqual(filterVmsForPanel(resources, { role: 'user', userId: 'user' }), [])
  assert.equal(filterVmsForPanel(resources, { role: 'super' }).length, 2)
  assert.equal(canBindProxyToVm({ owner_user_id: 'user' }, { owner_user_id: 'user' }, { role: 'user' }), false)
  assert.equal(canBindProxyToVm({ owner_user_id: 'user' }, {}, { role: 'admin' }), false)
  assert.equal(canBindProxyToVm({}, {}, { role: 'super' }), true)
})
