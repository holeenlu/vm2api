import assert from 'node:assert/strict'
import test from 'node:test'
import { createPanelVmCommandRoutes } from '../../src/lib/admin/panel-vm-command-routes.mjs'

test('VM command factory keeps route matching and body mapping isolated', async () => {
  const responses = []
  const handler = createPanelVmCommandRoutes({
    cfg: { paths: { project: '/tmp/project' } },
    routingConfig: { pool: { queue_max: 4 } },
    readBody: async () => ({ action: 'probe', ids: ['vm-1'], concurrency: 2 }),
    json: (...args) => responses.push(args),
  })
  assert.equal(await handler({ method: 'POST' }, {}, '/api/panel/vms/reconcile-fingerprints'), true)
  assert.equal(responses.at(-1)[1], 200)
  assert.equal(await handler({ method: 'GET' }, {}, '/api/panel/vms/fleet-update'), false)
})
