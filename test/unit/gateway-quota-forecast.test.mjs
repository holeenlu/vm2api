import test from 'node:test'
import assert from 'node:assert/strict'
import { computeQuotaForecast, selectForecastSample } from '../../src/lib/gateway-worker/quota-forecast.mjs'

const HOUR = 3_600_000
const now = Date.UTC(2026, 10, 3, 12)
const resetAt = now + 72 * HOUR
const start = resetAt - 7 * 24 * HOUR

function quota(percent, at = now) {
  return {
    primary_window: { used_percent: 1, window_minutes: 300, reset_at: new Date(now + HOUR).toISOString() },
    secondary_window: { used_percent: percent, window_minutes: 10080, reset_at: new Date(resetAt).toISOString() },
    updated_at: new Date(at).toISOString(),
  }
}

// 每消耗 1 个百分点对应一次 1000 token、$0.1 的请求，并在完成时观测到新的百分比
function linearCycle(lastPercent = 30) {
  const observations = []
  const usageRows = []
  for (let p = 1; p <= lastPercent; p++) {
    const at = start + p * HOUR
    usageRows.push({ completedAt: at, included: true, tokens: 1000, missingTokens: false, cost: 0.1 })
    observations.push({ observedAt: at, quota: quota(p, at) })
  }
  return { observations, usageRows, observedAt: start + lastPercent * HOUR }
}

test('quota forecast extrapolates the remaining weekly quota from the latest blocks', () => {
  const { observations, usageRows, observedAt } = linearCycle()
  const [weekly, monthly] = computeQuotaForecast({
    quota: quota(30, observedAt),
    accountAddedAt: start - 24 * HOUR,
    now,
    observations: observations.slice(0, -1),
    usageRows,
  })
  assert.equal(weekly.unavailable_reason, null)
  assert.equal(weekly.extrapolated, false)
  assert.equal(weekly.target_seconds, 7 * 86_400)
  assert.equal(weekly.estimated_tokens, 100_000)
  assert.ok(Math.abs(weekly.estimated_usd - 10) < 1e-9)
  assert.equal(weekly.low_sample, false)
  assert.equal(weekly.incomplete_cost, false)
  assert.equal(weekly.source.used_percent, 30)
  assert.equal(monthly.extrapolated, true)
  assert.equal(monthly.estimated_tokens, Math.round((100_000 * 30) / 7))
})

test('quota forecast refuses discontinuous or too-early samples', () => {
  const { observations, usageRows, observedAt } = linearCycle(20)
  // 新账号在周期中途加入且没有足够的配对观测
  const [early] = computeQuotaForecast({
    quota: quota(20, observedAt),
    accountAddedAt: start + HOUR,
    now,
    observations: [],
    usageRows,
  })
  assert.match(early.unavailable_reason, /周期初记录不完整/)

  // 超过 1 个百分点的回落：只保留回落后的新段，进度不足时不预测
  const dropped = [
    ...observations.slice(0, 18),
    { observedAt: start + 19.5 * HOUR, quota: quota(3, start + 19.5 * HOUR) },
  ]
  const [weekly] = computeQuotaForecast({
    quota: quota(5, observedAt),
    accountAddedAt: start - HOUR,
    now,
    observations: dropped,
    usageRows,
  })
  assert.notEqual(weekly.unavailable_reason, null)
  assert.equal(weekly.estimated_tokens, null)

  const [missing] = computeQuotaForecast({ quota: { primary_window: quota(1).primary_window }, now, accountAddedAt: 0 })
  assert.match(missing.unavailable_reason, /缺少周额度窗口/)
})

test('forecast sampling keeps the last three complete blocks plus the tail', () => {
  const usageAt = (n) => ({
    request_count: n,
    tokens: n * 10,
    missing_token_count: 0,
    known_cost_count: n,
    unavailable_cost_count: 0,
    usd: n,
    excluded_request_count: 0,
  })
  const history = [0, 5, 10, 15, 20, 25].map((p, i) => ({ observedAt: i + 1, usedPercent: p, usage: usageAt(p) }))
  const sample = selectForecastSample({
    startAt: 0,
    current: { observedAt: 10, usedPercent: 27, usage: usageAt(27) },
    history,
  })
  assert.equal(sample.method, 'incremental')
  assert.equal(sample.baselinePercent, 10)
  assert.equal(sample.sampledPercent, 17)
  assert.equal(sample.blockCount, 3)
  assert.equal(sample.usage.request_count, 17)
})
