import assert from 'node:assert/strict'
import test from 'node:test'
import { createSharedSnapshot } from '../../src/lib/vendor/shared-snapshot.mjs'

function harness() {
  let clock = 1_000_000
  const loads = []
  const read = createSharedSnapshot(
    () =>
      new Promise((resolve, reject) => {
        loads.push({ resolve, reject })
      }),
    { freshMs: 10_000, maxAgeMs: 60_000, now: () => clock },
  )
  return {
    read,
    loads,
    advance: (ms) => {
      clock += ms
    },
  }
}
const settle = () => new Promise((resolve) => setImmediate(resolve))

test('first callers share one load; a fresh snapshot is reused without loading', async () => {
  const h = harness()
  const first = h.read()
  const second = h.read()
  await settle()
  assert.equal(h.loads.length, 1)
  h.loads[0].resolve('v1')
  assert.deepEqual(await Promise.all([first, second]), ['v1', 'v1'])
  h.advance(9_999)
  assert.equal(await h.read(), 'v1')
  await settle()
  assert.equal(h.loads.length, 1)
})

test('a stale snapshot answers at once while one background refresh runs', async () => {
  const h = harness()
  const first = h.read()
  await settle()
  h.loads[0].resolve('v1')
  await first
  h.advance(15_000)
  assert.equal(await h.read(), 'v1')
  assert.equal(await h.read(), 'v1')
  await settle()
  assert.equal(h.loads.length, 2)
  h.loads[1].resolve('v2')
  await settle()
  assert.equal(await h.read(), 'v2')
  await settle()
  assert.equal(h.loads.length, 2)
})

test('a snapshot older than the maximum age is not served', async () => {
  const h = harness()
  const first = h.read()
  await settle()
  h.loads[0].resolve('v1')
  await first
  h.advance(60_000)
  const waiting = h.read()
  await settle()
  assert.equal(h.loads.length, 2)
  h.loads[1].resolve('v2')
  assert.equal(await waiting, 'v2')
})

test('a failed refresh keeps the previous snapshot and retries on the next call', async () => {
  const h = harness()
  const cold = h.read()
  await settle()
  h.loads[0].reject(new Error('down'))
  await assert.rejects(cold, /down/)
  const retry = h.read()
  await settle()
  assert.equal(h.loads.length, 2)
  h.loads[1].resolve('v1')
  assert.equal(await retry, 'v1')
  h.advance(20_000)
  assert.equal(await h.read(), 'v1')
  await settle()
  h.loads[2].reject(new Error('down'))
  await settle()
  assert.equal(await h.read(), 'v1')
  await settle()
  assert.equal(h.loads.length, 4)
})
