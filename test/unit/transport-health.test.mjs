import assert from 'node:assert/strict'
import test from 'node:test'
import { projectTransportHealth } from '../../src/lib/transport/transport-health.mjs'

test('transport health keeps unknown readiness explicit', () => {
  assert.deepEqual(projectTransportHealth({ status: 200, reachable: true, process_up: true, healthy: true }), {
    status: 200,
    reachable: true,
    process_up: true,
    healthy: true,
    ready: true,
    error_code: null,
  })
  assert.equal(projectTransportHealth({ status: 503, reachable: false }).ready, null)
})
