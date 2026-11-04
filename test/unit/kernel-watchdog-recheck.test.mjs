import assert from 'node:assert/strict'
import test from 'node:test'
import { createKernelWatchdog } from '../../src/lib/transport/kernel-watchdog.mjs'
import { kernelFaults } from '../../src/lib/transport/rust-kernel-client.mjs'

const HEALTHY = { ok: true, healthy: true, ready_slots: 20, cli_pid: 7 }

for (const result of [
  { ok: true, reason: 'already_up', health: HEALTHY },
  { ok: true, reason: 'busy', health: { ...HEALTHY, ready_slots: 0 } },
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
