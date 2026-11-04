import assert from 'node:assert/strict'
import test from 'node:test'
import { createPanelVmDiagnoseRoutes } from '../../src/lib/admin/panel-vm-diagnose-routes.mjs'

test('VM diagnosis factory ignores non-diagnosis routes', async () => {
  const handler = createPanelVmDiagnoseRoutes({
    cfg: { paths: { project: '/tmp/project' } },
    routingConfig: {},
    panelIdentity: () => ({ role: 'user' }),
    json: () => {},
  })
  assert.equal(await handler({ method: 'POST' }, {}, '/api/panel/vms/vm-1/diagnose'), false)
})
