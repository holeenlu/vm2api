import test from 'node:test'
import assert from 'node:assert/strict'
import { UnitCircuit } from '../../src/lib/pool/unit-circuit.mjs'
import { normalizePoolRouting } from '../../src/lib/pool/pool-scheduler.mjs'

test('stored circuit settings are the ones the breaker runs with', () => {
  const cases = [
    [{}, 3, 30000],
    [{ circuit_failure_threshold: 0, circuit_open_ms: 0 }, 3, 30000],
    [{ circuit_failure_threshold: 'junk', circuit_open_ms: null }, 3, 30000],
    [{ circuit_failure_threshold: 5, circuit_open_ms: 60000 }, 5, 60000],
    [{ circuit_failure_threshold: 100, circuit_open_ms: 500 }, 20, 1000],
  ]
  for (const [stored, threshold, openMs] of cases) {
    const pool = normalizePoolRouting(stored)
    const circuit = new UnitCircuit()
    circuit.configure({ failureThreshold: pool.circuit_failure_threshold, openMs: pool.circuit_open_ms })
    assert.equal(pool.circuit_failure_threshold, threshold)
    assert.equal(pool.circuit_open_ms, openMs)
    assert.equal(circuit.failureThreshold, threshold)
    assert.equal(circuit.openMs, openMs)
  }
})

test('half-open admits one probe and holds the rest', async () => {
  let now = 1_000
  const circuit = new UnitCircuit({ failureThreshold: 2, openMs: 500, now: () => now })
  await circuit.recordFailure('vm-a', now)
  await circuit.recordFailure('vm-a', now)
  assert.equal(circuit.admit('vm-a', now).ok, false)
  now = 1_600
  const probe = circuit.admit('vm-a', now)
  assert.equal(probe.ok, true)
  assert.equal(probe.probe, true)
  const blocked = circuit.admit('vm-a', now)
  assert.equal(blocked.ok, false)
  assert.equal(blocked.reason, 'circuit_probe')
  await circuit.recordSuccess('vm-a')
  assert.equal(circuit.admit('vm-a', now).state, 'closed')
})

test('inspect does not consume the half-open probe', async () => {
  let now = 1_000
  const circuit = new UnitCircuit({ failureThreshold: 1, openMs: 100, now: () => now })
  await circuit.recordFailure('vm-c', now)
  now = 1_200
  assert.equal((await circuit.inspect('vm-c', now)).probeAvailable, true)
  assert.equal((await circuit.inspect('vm-c', now)).probeAvailable, true)
  assert.equal(circuit.admit('vm-c', now).probe, true)
  assert.equal((await circuit.inspect('vm-c', now)).reason, 'circuit_probe')
})

test('model-style failures are not required to open the circuit', async () => {
  const circuit = new UnitCircuit({ failureThreshold: 1, openMs: 1000, now: () => 10 })
  assert.equal(circuit.admit('vm-b').ok, true)
  assert.equal((await circuit.snapshot('vm-b')).state, 'closed')
})

test('reset closes an open unit and view reports state', async () => {
  let now = 1_000
  const circuit = new UnitCircuit({ failureThreshold: 2, openMs: 500, now: () => now })
  await circuit.recordFailure('vm-r', now)
  assert.deepEqual(await circuit.view('vm-r', now), {
    state: 'closed',
    failures: 1,
    threshold: 2,
    open_until: null,
    open_ms: 500,
  })
  await circuit.recordFailure('vm-r', now)
  assert.equal((await circuit.view('vm-r', now)).state, 'open')
  assert.equal((await circuit.view('vm-r', now)).open_until, 1_500)
  now = 1_600
  assert.equal((await circuit.view('vm-r', now)).state, 'half_open')
  await circuit.reset('vm-r')
  assert.equal((await circuit.view('vm-r', now)).state, 'closed')
  assert.equal((await circuit.view('vm-r', now)).failures, 0)
  assert.equal(circuit.admit('vm-r', now).state, 'closed')
})
