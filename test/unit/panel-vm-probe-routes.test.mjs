import assert from 'node:assert/strict'
import test from 'node:test'
import { createPanelVmProbeRoutes } from '../../src/lib/admin/panel-vm-probe-routes.mjs'

test('VM probe factory ignores unrelated methods and paths', async () => {
  const handler = createPanelVmProbeRoutes({
    cfg: { paths: { project: '/tmp/project' } },
    routingConfig: {},
    accountQuota: {},
    panel: {},
    probeExitGeo: async () => ({ ok: true }),
    json: () => {},
  })
  assert.equal(await handler({ method: 'GET' }, {}, '/api/panel/vms/vm-1/probe'), false)
})
