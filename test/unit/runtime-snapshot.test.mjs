import test from 'node:test'
import assert from 'node:assert/strict'
import { createRuntimeSnapshot } from '../../src/lib/core/runtime-snapshot.mjs'

test('runtime snapshot publishes immutable, isolated routing views', () => {
  const routing = { failover: { enabled: true }, tiers: { default: { max_concurrency: 2 } } }
  const snapshot = createRuntimeSnapshot({ routingConfig: routing, configRevision: 7 })

  assert.equal(snapshot.revision(), 7)
  assert.equal(Object.isFrozen(snapshot.acquire()), true)
  assert.equal(Object.isFrozen(snapshot.routing()), true)
  assert.equal(Object.isFrozen(snapshot.routing().failover), true)
  assert.throws(() => {
    snapshot.routing().failover.enabled = false
  }, TypeError)

  routing.failover.enabled = false
  assert.equal(snapshot.routing().failover.enabled, true)

  const next = snapshot.publish({ quota: { max_rpm: 20 } }, 8)
  assert.equal(next, snapshot.acquire())
  assert.equal(snapshot.revision(), 8)
  assert.deepEqual(snapshot.routing(), { quota: { max_rpm: 20 } })
})
