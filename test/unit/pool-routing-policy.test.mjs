import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_POOL_CONFIG,
  formatPoolSelectionSummary,
  normalizePoolConfig,
  normalizePoolRouting,
} from '../../src/lib/pool/pool-routing-policy.mjs'
import { formatPoolSelectionSummary as schedulerSummary } from '../../src/lib/pool/pool-scheduler.mjs'

test('pool routing policy preserves legacy normalization semantics', () => {
  assert.equal(normalizePoolRouting({}).queue_max, 50)
  assert.equal(normalizePoolRouting({ queue_max: 0 }).queue_max, 1)
  assert.equal(normalizePoolRouting({ queue_max: 1000 }).queue_max, 999)
  assert.equal(normalizePoolRouting({ strategy: 'round-robin' }).strategy, 'balanced')
  assert.equal(normalizePoolRouting({ strategy: 'fill' }).strategy, 'fill')
  assert.equal(normalizePoolRouting({ max_waiters_per_account: 2 }).max_waiters_per_account, undefined)
})

test('pool routing policy normalizes circuit and wait bounds without mutating input', () => {
  const input = {
    circuit_failure_threshold: 100,
    circuit_open_ms: 0,
    sticky_wait_timeout_ms: 999999,
    seat_budget_reserve_pct: 0.5,
  }
  const normalized = normalizePoolRouting(input)
  assert.equal(normalized.circuit_failure_threshold, 20)
  assert.equal(normalized.circuit_open_ms, DEFAULT_POOL_CONFIG.circuit_open_ms)
  assert.equal(normalized.sticky_wait_timeout_ms, 120000)
  assert.equal(normalized.seat_budget_reserve_pct, 0.5)
  assert.deepEqual(input, {
    circuit_failure_threshold: 100,
    circuit_open_ms: 0,
    sticky_wait_timeout_ms: 999999,
    seat_budget_reserve_pct: 0.5,
  })
})

test('pool selection summary remains a compact stable string', () => {
  assert.equal(formatPoolSelectionSummary({}), '')
  assert.equal(
    formatPoolSelectionSummary({
      reason: 'slot_busy',
      soonest_available_ms: 2500,
      eligible: 2,
      sticky_cleared: true,
    }),
    'slot_busy soonest=3s eligible=2 sticky_cleared',
  )
})

test('pool scheduler keeps the legacy summary export facade', () => {
  assert.equal(schedulerSummary({ reason: 'slot_busy' }), 'slot_busy')
})
