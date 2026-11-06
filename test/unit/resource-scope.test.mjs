import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PLATFORM_SCOPE,
  normalizeOwnerId,
  ownerScopeFromApiKey,
  ownerScopeFromRequest,
  vmMatchesOwnerScope,
} from '../../src/lib/admin/resource-scope.mjs'

test('resource scope keeps platform and tenant ownership separate', async () => {
  assert.equal(normalizeOwnerId('  user-1  '), 'user-1')
  assert.deepEqual(ownerScopeFromApiKey(null, { apiKeyKind: 'master' }), PLATFORM_SCOPE)
  assert.deepEqual(ownerScopeFromApiKey({ user_id: 'user-1' }), { type: 'any' })
  assert.deepEqual(await ownerScopeFromRequest({ panelUser: 'user-1', panelUserId: 'user-1', panelRole: 'user' }), {
    type: 'user',
    userId: 'user-1',
  })
  assert.equal(vmMatchesOwnerScope({ owner_user_id: 'user-1' }, { type: 'user', userId: 'user-1' }), true)
  assert.equal(vmMatchesOwnerScope({ owner_user_id: 'user-2' }, { type: 'user', userId: 'user-1' }), false)
})
