import assert from 'node:assert/strict'
import test from 'node:test'
import { createKernelWatchdog } from '../../src/lib/transport/kernel-watchdog.mjs'
import { kernelFaults } from '../../src/lib/transport/rust-kernel-client.mjs'

const HEALTHY = { ok: true, healthy: true, ready_slots: 20, cli_pid: 7 }
const TIMEOUT = { ok: false, status: 0, code: 'worker_timeout', error: 'slot worker timeout after 800ms' }

test('a short health timeout followed by a healthy confirmation never spends the recovery budget', async () => {
  let at = 0
  const timeouts = []
  const ensured = []
  const wd = createKernelWatchdog({
    config: { restart_backoff_sec: [10], timeout_ms: 5000 },
    listTargets: () => [{ id: 'vm-transient', status: 'running' }],
    now: () => at,
    observeRuntime: async () => ({ state: 'running' }),
    health: async (_, { timeoutMs }) => {
      timeouts.push(timeoutMs)
      return timeoutMs === 800 ? TIMEOUT : HEALTHY
    },
    ensure: async () => {
      ensured.push(at)
      return { ok: true, reason: 'already_up', health: HEALTHY }
    },
  })
  try {
    for (const value of [0, 10_000, 30_000, 60_000]) {
      at = value
      await wd.tick()
      assert.equal(kernelFaults.has('vm-transient'), false)
      assert.equal(wd.restartsInWindow('vm-transient'), 0)
    }
    assert.deepEqual(ensured, [])
    assert.deepEqual(timeouts, [800, 5000, 800, 5000, 800, 5000, 800, 5000])
  } finally {
    kernelFaults.delete('vm-transient')
  }
})

test('a healthy confirmation clears an existing fault and its spent budget', async () => {
  let at = 0
  let recovered = false
  let ensured = 0
  const wd = createKernelWatchdog({
    config: { restart_backoff_sec: [10] },
    listTargets: () => [{ id: 'vm-confirm-recovery', status: 'running' }],
    now: () => at,
    observeRuntime: async () => ({ state: 'running' }),
    health: async (_, { timeoutMs }) => (recovered && timeoutMs > 800 ? HEALTHY : TIMEOUT),
    ensure: async () => {
      ensured++
      return { ok: false, reason: 'health_timeout' }
    },
  })
  try {
    for (const value of [0, 10_000, 30_000]) {
      at = value
      await wd.tick()
    }
    assert.equal(ensured, 1, 'persistent timeouts still have a bounded recovery attempt')
    assert.equal(kernelFaults.has('vm-confirm-recovery'), true)
    recovered = true
    at = 60_000
    await wd.tick()
    assert.equal(kernelFaults.has('vm-confirm-recovery'), false)
    assert.equal(wd.restartsInWindow('vm-confirm-recovery'), 0)
    assert.equal(ensured, 1)
  } finally {
    kernelFaults.delete('vm-confirm-recovery')
  }
})

for (const result of [
  { ok: true, reason: 'already_up', health: HEALTHY },
  { ok: true, reason: 'health_cache', health: HEALTHY },
  { ok: true, reason: 'busy', health: { ...HEALTHY, ready_slots: 0 } },
  { ok: true, skipped: true, reason: 'cooldown' },
]) {
  test(`ensure ${result.reason} does not count or log a recovery action`, async (t) => {
    let at = 0
    let ensured = 0
    const warnings = []
    t.mock.method(console, 'warn', (value) => warnings.push(value))
    const wd = createKernelWatchdog({
      config: { restart_backoff_sec: [10] },
      listTargets: () => [{ id: 'vm-noop', status: 'running' }],
      now: () => at,
      observeRuntime: async () => ({ state: 'running' }),
      health: async () => ({ ok: true, healthy: false, unhealthy_reason: 'cli restarts spent' }),
      ensure: async () => {
        ensured++
        return result
      },
    })
    try {
      for (const value of [0, 10_000, 30_000, 60_000]) {
        at = value
        await wd.tick()
        assert.equal(wd.restartsInWindow('vm-noop'), 0)
        assert.equal(kernelFaults.has('vm-noop'), false)
      }
      assert.ok(ensured > 0)
      assert.deepEqual(warnings, [])
    } finally {
      kernelFaults.delete('vm-noop')
    }
  })
}

test('a failed recovery action still consumes the bounded budget', async () => {
  let at = 0
  let ensured = 0
  const wd = createKernelWatchdog({
    config: { restart_backoff_sec: [10] },
    listTargets: () => [{ id: 'vm-action-failed', status: 'running' }],
    now: () => at,
    observeRuntime: async () => ({ state: 'running' }),
    health: async () => ({ ok: true, healthy: false, unhealthy_reason: 'native cli stdout closed' }),
    ensure: async () => {
      ensured++
      throw new Error('recovery command failed')
    },
  })
  try {
    for (const value of [0, 10_000, 30_000, 60_000]) {
      at = value
      await wd.tick()
    }
    assert.equal(ensured, 1)
    assert.equal(wd.restartsInWindow('vm-action-failed'), 1)
    assert.equal(kernelFaults.has('vm-action-failed'), true)
  } finally {
    kernelFaults.delete('vm-action-failed')
  }
})

test('a hold taken during confirmation prevents recovery and fault accounting', async () => {
  let finish
  let confirmStarted
  const pending = new Promise((resolve) => {
    confirmStarted = resolve
  })
  const actions = []
  const wd = createKernelWatchdog({
    listTargets: () => [{ id: 'vm-confirm-hold', status: 'running' }],
    observeRuntime: async () => ({ state: 'running' }),
    health: (_, { timeoutMs }) => {
      if (timeoutMs === 800) return TIMEOUT
      confirmStarted()
      return new Promise((resolve) => {
        finish = resolve
      })
    },
    ensure: async () => actions.push('ensure'),
    revive: async () => actions.push('revive'),
  })
  const tick = wd.tick()
  await pending
  let settled = false
  const held = wd.hold('vm-confirm-hold').then(() => {
    settled = true
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(settled, false)
  finish(TIMEOUT)
  await Promise.all([tick, held])
  assert.deepEqual(actions, [])
  assert.equal(wd.restartsInWindow('vm-confirm-hold'), 0)
  assert.equal(kernelFaults.has('vm-confirm-hold'), false)
})

test('a remote relay lost during the initial probe is not a kernel fault', async () => {
  let at = 0
  let hasRelay = true
  let ensured = 0
  const wd = createKernelWatchdog({
    config: { restart_backoff_sec: [10] },
    listTargets: () => [{ id: 'vm-lost-relay', node_id: 'node-test', status: 'running' }],
    now: () => at,
    probeVm: (vm) => (hasRelay ? vm : null),
    observeRuntime: async () => ({ state: 'running' }),
    health: async () => {
      hasRelay = false
      return TIMEOUT
    },
    ensure: async () => {
      ensured++
      return { ok: true }
    },
  })
  try {
    for (const value of [0, 10_000, 30_000]) {
      at = value
      hasRelay = true
      await wd.tick()
    }
    assert.equal(ensured, 0)
    assert.equal(wd.restartsInWindow('vm-lost-relay'), 0)
    assert.equal(kernelFaults.has('vm-lost-relay'), false)
  } finally {
    kernelFaults.delete('vm-lost-relay')
  }
})
