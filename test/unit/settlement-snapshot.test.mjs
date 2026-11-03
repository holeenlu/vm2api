import test from 'node:test'
import assert from 'node:assert/strict'
import { createSettlementSnapshot } from '../../src/lib/usage/settlement-snapshot.mjs'

test('settlement snapshot freezes known totals and preserves unknown amounts', () => {
  const known = createSettlementSnapshot({ rows: [{ cost_usd: 1 }, { cost_usd: 2 }] })
  assert.equal(known.total_usd, 3)
  const unknown = createSettlementSnapshot({ rows: [{ cost_usd: 1 }, { cost_usd: null }] })
  assert.equal(unknown.total_usd, null)
  assert.equal(unknown.amount_known, false)
})
