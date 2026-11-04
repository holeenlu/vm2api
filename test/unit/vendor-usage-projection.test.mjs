import test from 'node:test'
import assert from 'node:assert/strict'
import { projectVendorUsage } from '../../src/lib/vendor/projections/usage-projection.mjs'

test('vendor usage projection preserves unknown cost and incomplete cache evidence', () => {
  const value = projectVendorUsage({
    summary: { cost_usd: 3, unpriced_requests: 1, total_tokens: 9, cache_complete: false },
    accounts: [{ cost_usd: 2, total_tokens: 4, cache_unknown_requests: 1 }],
    fixed_windows: { '5h': { cost_usd: 1, total_tokens: 2 } },
  })
  assert.equal(value.summary.cost_usd, null)
  assert.equal(value.summary.cost_known, false)
  assert.equal(value.accounts[0].total_tokens, null)
  assert.equal(value.fixed_windows['5h'].cost_known, true)
})
