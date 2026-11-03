import test from 'node:test'
import assert from 'node:assert/strict'
import { HoldTimeTracker, estimateQueueWaitMs } from '../../src/lib/pool/queue-wait-estimate.mjs'
import { SeatPlanner } from '../../src/lib/pool/seat-planner.mjs'
import { formatPoolSelectionSummary } from '../../src/lib/pool/pool-routing-policy.mjs'

function holds(entries, samples = 5) {
  const tracker = new HoldTimeTracker()
  for (const [vmId, ms] of entries) for (let i = 0; i < samples; i++) tracker.note(vmId, ms)
  return tracker
}

const vm = (vmId, extra = {}) => ({
  vmId,
  maxConcurrency: 5,
  seatCap: 20,
  busy: true,
  waitReason: 'concurrency_limit',
  ...extra,
})

test('hold history is required before a VM has a mean', () => {
  const tracker = holds([['vm-a', 60_000]], 4)
  assert.equal(tracker.meanMs('vm-a'), null)
  tracker.note('vm-a', 60_000)
  assert.equal(tracker.meanMs('vm-a'), 60_000)
  tracker.note('vm-a', 10_000)
  assert.equal(tracker.meanMs('vm-a'), 50_000)
})

test('expected wait drains the queue at the summed slot rate', () => {
  const tracker = holds([
    ['vm-a', 60_000],
    ['vm-b', 60_000],
  ])
  // 10 slots of 60 s: one slot frees every 6 s; position 9 is the 10th.
  assert.equal(estimateQueueWaitMs([vm('vm-a'), vm('vm-b')], 9, tracker), 60_000)
  assert.equal(estimateQueueWaitMs([vm('vm-a'), vm('vm-b')], 0, tracker), 6_000)
  // Near the gate one call runs at a time; a smaller seat cap also bounds it.
  assert.equal(estimateQueueWaitMs([vm('vm-a', { draining: true })], 0, tracker), 60_000)
  assert.equal(estimateQueueWaitMs([vm('vm-a', { waitReason: 'quota_band_inflight' })], 1, tracker), 120_000)
  assert.equal(estimateQueueWaitMs([vm('vm-a', { seatCap: 2 })], 1, tracker), 60_000)
})

test('an unknown VM or a cooldown that may lift in time keeps the old wait', () => {
  const tracker = holds([['vm-a', 60_000]])
  const until = Date.now() + 30_000
  assert.equal(estimateQueueWaitMs([vm('vm-a'), vm('vm-new')], 0, tracker, until), null)
  const soon = vm('vm-c', { waitReason: 'account_cooldown', availableAt: Date.now() + 5_000 })
  assert.equal(estimateQueueWaitMs([vm('vm-a'), soon], 0, tracker, until), null)
  const rpm = vm('vm-c', { waitReason: 'rpm_limit', availableAt: null })
  assert.equal(estimateQueueWaitMs([vm('vm-a'), rpm], 0, tracker, until), null)
  // A cooldown past the budget adds no capacity and does not block the estimate.
  const late = vm('vm-c', { waitReason: 'account_cooldown', availableAt: until + 60_000 })
  assert.equal(estimateQueueWaitMs([vm('vm-a'), late], 0, tracker, until), 12_000)
  assert.equal(estimateQueueWaitMs([late], 0, tracker, until), null)
})

test('queuedAhead follows grant order: seated waits first, then seat waits and global by arrival', () => {
  const planner = new SeatPlanner()
  const ticket = (kind, vmId, enqueuedAt, vmIds = ['vm-a', 'vm-b']) => ({
    kind,
    vmId,
    enqueuedAt,
    accepts: () => true,
    vmIds: () => vmIds,
  })
  const conc1 = ticket('conc', 'vm-a', 1)
  const seat2 = ticket('seat', 'vm-a', 2)
  const global3 = ticket('global', null, 3)
  const conc4 = ticket('conc', 'vm-a', 4)
  const global5 = ticket('global', null, 5)
  const elsewhere6 = ticket('global', null, 6, ['vm-z'])
  for (const t of [conc1, seat2, global3, conc4, global5, elsewhere6]) planner.enqueue(t)
  assert.equal(planner.queuedAhead(['vm-a'], conc4), 1)
  assert.equal(planner.queuedAhead(['vm-a'], seat2), 2)
  assert.equal(planner.queuedAhead(['vm-a', 'vm-b'], global5), 4)
  assert.equal(planner.queuedAhead(['vm-a', 'vm-b']), 5)
})

test('the selection summary carries the estimate', () => {
  assert.equal(
    formatPoolSelectionSummary({ reason: 'pool_wait_estimate_exceeded', estimated_wait_ms: 87_400, eligible: 2 }),
    'pool_wait_estimate_exceeded estimate=87s eligible=2',
  )
})
