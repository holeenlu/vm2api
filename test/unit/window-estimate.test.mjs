import { test } from 'node:test'
import assert from 'node:assert/strict'
import { estimateFromForecast, projectWindowRemaining, usedRatioOf } from '../../src/lib/admin/window-estimate.mjs'

test('a sampled capacity becomes total, remaining and tokens next to the logged spend', () => {
  const est = estimateFromForecast({
    forecast: {
      status: 'ok',
      capacity_usd: 30,
      capacity_tokens: 7_499_999.6,
      low_sample: true,
      incomplete_cost: false,
    },
    spentUsd: 12,
    usedRatio: 0.4,
  })
  assert.equal(est.status, 'ok')
  assert.equal(est.total_usd, 30)
  assert.equal(est.remaining_usd, 18)
  assert.equal(est.total_tokens, 7_500_000)
  assert.equal(est.used_ratio, 0.4)
  assert.equal(est.low_sample, true)
})

test('header 0-1 ratios and leftover 0-100 percents normalize to the same ratio', () => {
  assert.equal(usedRatioOf(0.4), 0.4)
  assert.equal(usedRatioOf(40), 0.4)
  assert.equal(usedRatioOf(null), null)
  assert.equal(usedRatioOf(''), null)
})

test('spend past the sampled capacity leaves nothing remaining', () => {
  const est = estimateFromForecast({ forecast: { status: 'ok', capacity_usd: 10, capacity_tokens: 1 }, spentUsd: 12 })
  assert.equal(est.total_usd, 10)
  assert.equal(est.remaining_usd, 0)
})

test('an unavailable forecast keeps its status and never shows a number', () => {
  for (const status of ['no_data', 'no_reset', 'log_gap', 'low_usage', 'resampling']) {
    const est = estimateFromForecast({ forecast: { status, capacity_usd: 99 }, spentUsd: 3, usedRatio: 0.2 })
    assert.equal(est.status, status)
    assert.equal(est.total_usd, null)
    assert.equal(est.remaining_usd, null)
    assert.equal(est.spent_usd, 3)
  }
  assert.equal(estimateFromForecast({ spentUsd: 1 }).status, 'no_data')
})

test('unpriced calls keep the estimate but flag the cost as incomplete', () => {
  const est = estimateFromForecast({
    forecast: { status: 'ok', capacity_usd: 20, capacity_tokens: 100, incomplete_cost: true },
    spentUsd: 5,
  })
  assert.equal(est.total_usd, 20)
  assert.equal(est.incomplete_cost, true)
})

test('projection: live estimate wins when it has a number', () => {
  const live = estimateFromForecast({ forecast: { status: 'ok', capacity_usd: 30, capacity_tokens: 1 }, spentUsd: 12 })
  const out = projectWindowRemaining({ live, closed: { used_ratio: 0.5, total_cost: 100 }, spentUsd: 12 })
  assert.deepEqual(out, { source: 'current', total_usd: 30, remaining_usd: 18 })
})

test('projection: a fresh window falls back to last window spend ÷ final used%', () => {
  const live = estimateFromForecast({ forecast: { status: 'low_usage' }, spentUsd: 1, usedRatio: 0.02 })
  assert.equal(live.status, 'low_usage')
  const closed = { start: '2026-10-14T05:00:00Z', used_ratio: 0.8, total_cost: 40, unpriced: 0 }
  const out = projectWindowRemaining({ live, closed, spentUsd: 1, coveredSince: '2026-10-01T00:00:00Z' })
  assert.deepEqual(out, { source: 'previous', total_usd: 50, remaining_usd: 49 })
})

test('projection: no number when the last window is thin, unpriced or not fully logged', () => {
  const closed = { start: '2026-10-14T05:00:00Z', used_ratio: 0.8, total_cost: 40, unpriced: 0 }
  const coveredSince = '2026-10-01T00:00:00Z'
  const none = { source: null, total_usd: null, remaining_usd: null }
  assert.deepEqual(projectWindowRemaining({ closed: { ...closed, used_ratio: 0.03 }, coveredSince }), none)
  assert.deepEqual(projectWindowRemaining({ closed: { ...closed, unpriced: 2 }, coveredSince }), none)
  assert.deepEqual(projectWindowRemaining({ closed, coveredSince: '2026-10-14T06:00:00Z' }), none)
  assert.deepEqual(projectWindowRemaining({ closed: null, coveredSince }), none)
})
