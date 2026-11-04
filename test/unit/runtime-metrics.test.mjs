import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { RuntimeMetrics } from '../../src/lib/core/runtime-metrics.mjs'

test('work measurements preserve results and errors with bounded size and traffic labels', () => {
  const metrics = new RuntimeMetrics()
  metrics.start()
  try {
    const result = { answer: 42 }
    const sizes = [0, 16_384, 16_385, 262_144, 262_145, 1_048_576, 1_048_577, 4_194_304, 4_194_305]
    for (const bytes of sizes) {
      const req = { url: '/v1/responses?private=secret' }
      metrics.setBodyBytes(req, bytes)
      assert.equal(
        metrics.measure(req, 'json_parse', () => result),
        result,
      )
    }
    const error = new Error('private prompt')
    assert.throws(
      () =>
        metrics.measure({ url: '/api/panel/private' }, 'json_parse', () => {
          throw error
        }),
      (caught) => caught === error,
    )
    metrics.measure({}, 'unbounded-user-label', () => null)
    const snapshot = metrics.snapshot()
    const rows = snapshot.request_work_total
    assert.equal(rows.length, 6)
    assert.deepEqual(
      rows.filter((row) => row.traffic === 'inference').map((row) => row.count),
      [2, 2, 2, 2, 1],
    )
    const failed = rows.find((row) => row.traffic === 'other')
    assert.equal(failed.errors, 1)
    assert.equal(failed.size_bucket, 'unknown')
    for (const row of rows) {
      assert.equal(
        row.duration_counts.reduce((a, b) => a + b, 0),
        row.count,
      )
      assert.ok(row.total_ms >= row.max_ms)
    }
    assert.doesNotMatch(JSON.stringify(snapshot), /private|secret|prompt|unbounded-user-label/)
    rows[0].duration_counts.fill(-1)
    assert.ok(metrics.snapshot().request_work_total[0].duration_counts.every((n) => n >= 0))
  } finally {
    metrics.stop()
  }
})

test('fixed windows measure main-loop stalls; reads do not reset shared observations', async () => {
  const metrics = new RuntimeMetrics({ resolutionMs: 5 })
  metrics.start()
  try {
    assert.equal(metrics.snapshot().last_window, null)
    assert.equal(metrics.timer.hasRef(), false)
    const req = { url: '/v1/messages' }
    metrics.setBodyBytes(req, 1024)
    await delay(20)
    metrics.measure(req, 'claude_convert', () => {
      const end = performance.now() + 60
      while (performance.now() < end) {
        /* simulate synchronous protocol work */
      }
    })
    await delay(15)
    metrics.sample()
    const first = metrics.snapshot().last_window
    assert.ok(first.event_loop.utilization > 0 && first.event_loop.utilization <= 1)
    assert.ok(first.event_loop.active_ms > 0)
    assert.ok(first.event_loop.delay.samples > 0)
    assert.ok(first.event_loop.delay.max_ms >= 40)
    assert.equal(first.request_work[0].count, 1)
    assert.deepEqual(metrics.snapshot().last_window, first)
    first.request_work[0].duration_counts.fill(-1)
    assert.ok(metrics.snapshot().last_window.request_work[0].duration_counts.every((n) => n >= 0))
    metrics.sample()
    assert.equal(metrics.snapshot().last_window.request_work.length, 0)
    assert.equal(metrics.snapshot().request_work_total[0].count, 1)
  } finally {
    metrics.stop()
  }
  assert.equal(metrics.snapshot().enabled, false)
  metrics.measure({}, 'json_parse', () => null)
  assert.equal(metrics.snapshot().request_work_total.length, 1)
})

test('periodic samples and lifecycle can restart without stale counters', async () => {
  const metrics = new RuntimeMetrics({ windowMs: 20, resolutionMs: 5 })
  metrics.start()
  const timer = metrics.timer
  metrics.start()
  assert.equal(metrics.timer, timer)
  try {
    metrics.measure({}, 'codex_convert', () => 1)
    await delay(50)
    assert.ok(metrics.snapshot().last_window)
  } finally {
    metrics.stop()
  }
  metrics.stop()
  metrics.start()
  try {
    assert.equal(metrics.snapshot().request_work_total.length, 0)
    assert.equal(metrics.snapshot().last_window, null)
  } finally {
    metrics.stop()
  }
})
