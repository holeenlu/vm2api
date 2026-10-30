import test from 'node:test'
import assert from 'node:assert/strict'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { AccountQuota } from '../../src/lib/pool/account-quota.mjs'
import {
  computeWeeklySplit,
  publicWeeklySplit,
  splitBlocksModel,
  weeklySplitConfig,
} from '../../src/lib/pool/weekly-split.mjs'
import { quotaFromAccount } from '../../src/lib/admin/panel-api.mjs'

for (const limit of [0.25, 0.5, 0.75]) {
  test(`Fable's own window blocks exactly at ${limit * 100}% and leaves other families alone`, () => {
    for (const usage of [limit - 0.001, limit, limit + 0.001]) {
      const s = computeWeeklySplit({ fable_share: limit, utilization_7d_oi: usage })
      assert.equal(s.fable_utilization, usage)
      assert.equal(splitBlocksModel(s, 'claude-fable-5-1'), usage >= limit ? 'fable_usage_limit' : null)
      for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5', 'gpt-6-astra'])
        assert.equal(splitBlocksModel(s, model), null)
    }
  })
}

test('0% disables only Fable, 100% permits the full window, and disabled ignores the configured cap', () => {
  const zero = computeWeeklySplit({ fable_share: 0 })
  assert.equal(splitBlocksModel(zero, 'claude-fable-5'), 'fable_usage_limit')
  assert.equal(splitBlocksModel(zero, 'claude-sonnet-5'), null)
  assert.equal(computeWeeklySplit({ fable_share: 1, utilization_7d_oi: 0.99 }).fable_blocked, false)
  assert.equal(computeWeeklySplit({ fable_share: 1, utilization_7d_oi: 1 }).fable_blocked, true)
  const off = computeWeeklySplit({ enabled: false, fable_share: 0, utilization_7d_oi: 1 })
  assert.equal(splitBlocksModel(off, 'claude-fable-5'), null)
  assert.equal(publicWeeklySplit(off), null)
  assert.equal(weeklySplitConfig({}).enabled, false)
  for (const value of [undefined, null, '', false, -1, 2, 'wrong'])
    assert.equal(weeklySplitConfig({ weekly_split: { fable_share: value } }).fable_share, 0.5)
  assert.equal(weeklySplitConfig({ weekly_split: { fable_share: 0 } }).fable_share, 0)
})

test('an expired Fable window clears stale utilization; an unknown reading is not fabricated', () => {
  const now = Date.parse('2026-10-30T00:00:00Z')
  for (const reset of [now - 1, String((now - 1000) / 1000), new Date(now - 1).toISOString()]) {
    const s = computeWeeklySplit({ utilization_7d_oi: 0.9, reset_7d_oi: reset, now })
    assert.equal(s.fable_blocked, false)
    assert.equal(s.fable_utilization, 0)
  }
  assert.equal(computeWeeklySplit({ utilization_7d_oi: 50, reset_7d_oi: now + 1000, now }).fable_blocked, true)
  for (const reset of [undefined, null, 0, -1, '0', 'invalid'])
    assert.equal(computeWeeklySplit({ utilization_7d_oi: 0.9, reset_7d_oi: reset, now }).fable_blocked, true)
  for (const usage of [null, undefined, '', 'unknown']) {
    const s = computeWeeklySplit({ utilization_7d_oi: usage })
    assert.equal(s.fable_utilization, null)
    assert.equal(s.fable_remaining, null)
    assert.equal(s.fable_blocked, false)
  }
})

test('live account data, global reload and VM enable overrides use the same Fable ceiling as the panel', (t) => {
  const db = createDatabase({ dbPath: ':memory:' })
  t.after(() => db.close())
  const config = { quota: { weekly_split: { enabled: true, fable_share: 0.5 } } }
  const q = new AccountQuota({ db, config, accounts: [{ account_id: 'acc', vm_id: 'vm' }] })
  q.ingestHeaders('acc', {
    'anthropic-ratelimit-unified-7d-utilization': '0.88',
    'anthropic-ratelimit-unified-7d_oi-utilization': '0.25',
    'anthropic-ratelimit-unified-7d_oi-reset': new Date(Date.now() + 3600000).toISOString(),
  })
  const early = q.weeklySplitOf('acc')
  assert.equal(early.fable_blocked, false)
  assert.equal(splitBlocksModel(early, 'claude-sonnet-5'), null)
  q.ingestHeaders('acc', { 'anthropic-ratelimit-unified-7d_oi-utilization': '0.50' })
  assert.equal(q.weeklySplitOf('acc').fable_blocked, true)
  assert.deepEqual(
    quotaFromAccount(q.repo.get('acc'), q.config).weekly_split,
    publicWeeklySplit(q.weeklySplitOf('acc')),
  )
  q.setVmQuotaOverride('vm', { weekly_split: false })
  assert.equal(q.weeklySplitOf('acc').fable_blocked, false)
  q.setVmQuotaOverride('vm', { weekly_split: true })
  q.reloadConfig({ quota: { weekly_split: { enabled: false, fable_share: 0.75 } } })
  assert.equal(q.weeklySplitOf('acc').enabled, true)
  assert.equal(q.weeklySplitOf('acc').fable_blocked, false)
  q.setVmQuotaOverride('vm', null)
  assert.equal(q.weeklySplitOf('acc').enabled, false)
  assert.equal(Object.hasOwn(early, 'regular_blocked'), false)
})

test('legacy Fable samples with only their own reset timestamp agree between display and scheduling', (t) => {
  const db = createDatabase({ dbPath: ':memory:' })
  t.after(() => db.close())
  const q = new AccountQuota({ db, config: { quota: { weekly_split: { enabled: true, fable_share: 0.5 } } } })
  const acc = q.ensure({ account_id: 'legacy', vm_id: 'vm' })
  acc.unified = { fable: { utilization: 0.9, reset: new Date(Date.now() - 1000).toISOString() } }
  q.repo.save(acc)
  assert.equal(q.weeklySplitOf('legacy').fable_blocked, false)
  assert.deepEqual(quotaFromAccount(acc, q.config).weekly_split, publicWeeklySplit(q.weeklySplitOf('legacy')))
})
