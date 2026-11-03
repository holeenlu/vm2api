import test from 'node:test'
import assert from 'node:assert/strict'
import { projectQuotaWindow, projectQuotaWindows } from '../../src/lib/usage/quota-window-projection.mjs'

test('quota window projection keeps unknown usage explicit', () => {
  const projected = projectQuotaWindow({ key: '5h', used: null, limit: 100 })
  assert.equal(projected.remaining, null)
  assert.equal(projected.percent, null)
  assert.equal(projected.unknown, true)
})

test('quota windows preserve keys and reset expiry', () => {
  const result = projectQuotaWindows(
    { day: { used: 5, limit: 10, reset_at: '2026-11-01T00:00:00Z' } },
    {
      now: Date.parse('2026-11-01T01:00:00Z'),
    },
  )
  assert.equal(result.day.percent, 50)
  assert.equal(result.day.reset_expired, true)
})
