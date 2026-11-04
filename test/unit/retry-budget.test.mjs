import test from 'node:test'
import assert from 'node:assert/strict'
import { createRetryBudget } from '../../src/lib/protocol/retry-budget.mjs'

test('retry budget bounds attempts and switches', () => {
  const budget = createRetryBudget({ maxAttempts: 2, maxSwitches: 1 })
  assert.equal(budget.consumeAttempt(), true)
  assert.equal(budget.consumeAttempt(), true)
  assert.equal(budget.consumeAttempt(), false)
  assert.equal(budget.consumeSwitch(), true)
  assert.equal(budget.consumeSwitch(), false)
  assert.deepEqual(budget.snapshot(), { attempts: 2, switches: 1, maxAttempts: 2, maxSwitches: 1, deadlineAt: null })
})
