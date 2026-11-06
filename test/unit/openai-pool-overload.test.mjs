import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  OPENAI_OUTLIER_HOLD_MS,
  openAIOverloadOutlierHold,
  openAIPoolFailureBps,
  openAIPoolOverloaded,
  reportOpenAIAttempt,
  resetOpenAIAccountRuntime,
} from '../../src/lib/pool/openai-account-runtime.mjs'

beforeEach(() => resetOpenAIAccountRuntime())

const now = 1_700_000_000_000

function report(id, kind, times, at = now) {
  for (let n = 0; n < times; n++) reportOpenAIAttempt(id, kind, null, at)
}

test('pool failure needs three recently active accounts and uses the median', () => {
  report('a', 'capacity_rejected', 6)
  report('b', 'succeeded', 1)
  assert.equal(openAIPoolFailureBps({ now }), null)
  assert.equal(openAIPoolOverloaded(now), false)
  report('c', 'succeeded', 1)
  assert.equal(openAIPoolFailureBps({ now }), 0)
  report('stale', 'capacity_rejected', 6, now - 16 * 60_000)
  assert.equal(openAIPoolFailureBps({ now }), 0)
})

test('a pool-wide overload is not an outlier; a lone bad account is', () => {
  for (const id of ['a', 'b', 'c']) report(id, 'capacity_rejected', 6)
  assert.equal(openAIPoolOverloaded(now), true)
  assert.equal(openAIOverloadOutlierHold('a', now), null)

  resetOpenAIAccountRuntime()
  report('bad', 'capacity_rejected', 6)
  for (const id of ['a', 'b', 'c']) report(id, 'succeeded', 3)
  assert.equal(openAIPoolOverloaded(now), false)
  const hold = openAIOverloadOutlierHold('bad', now)
  assert.equal(hold.reason, 'overload_outlier')
  assert.equal(hold.until, now + OPENAI_OUTLIER_HOLD_MS)
  // Below the absolute floor nothing is parked, however healthy the peers.
  report('mild', 'capacity_rejected', 1)
  assert.equal(openAIOverloadOutlierHold('mild', now), null)
})
