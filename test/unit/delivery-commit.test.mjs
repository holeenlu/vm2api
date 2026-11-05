import test from 'node:test'
import assert from 'node:assert/strict'
import { advanceDeliveryCommit, isDeliveryCommitted } from '../../src/lib/protocol/delivery-commit.mjs'

test('delivery commit state is monotonic', () => {
  assert.equal(advanceDeliveryCommit('committed', 'pending'), 'committed')
  assert.equal(advanceDeliveryCommit('pending', 'ambiguous'), 'ambiguous')
  assert.equal(isDeliveryCommitted(advanceDeliveryCommit('ambiguous', 'committed')), true)
})
