import test from 'node:test'
import assert from 'node:assert/strict'
import { createPanelRouteContext } from '../../src/lib/admin/route-context.mjs'

test('panel route context preserves injected handlers and fallbacks', async () => {
  const calls = []
  const ctx = {
    cfg: { paths: { project: '/tmp/project' } },
    json: (...args) => calls.push(['json', ...args]),
    readBody: async (...args) => ['body', ...args],
    requireAuth: (...args) => ['auth', ...args],
    refreshClusterSlotPayloads: null,
    applyVmRpm: (...args) => ['rpm', ...args],
  }
  const fallbackReadRawBody = async (...args) => ['raw', ...args]
  const fallbackRefresh = () => 'refresh'
  const route = createPanelRouteContext(ctx, {
    defaultReadRawBody: fallbackReadRawBody,
    refreshClusterSlotPayloads: fallbackRefresh,
  })

  route.json('res', 200, { ok: true })
  assert.deepEqual(calls, [['json', 'res', 200, { ok: true }]])
  assert.deepEqual(await route.readBody('req'), ['body', 'req'])
  assert.deepEqual(await route.readRawBody('req'), ['raw', 'req'])
  assert.equal(route.refreshCluster, fallbackRefresh)
  assert.deepEqual(route.requireAuth('req'), ['auth', 'req'])
  assert.deepEqual(route.applyVmRpm('vm', 3), ['rpm', 'vm', 3])
  assert.equal(route.cfg.paths.project, '/tmp/project')
})
