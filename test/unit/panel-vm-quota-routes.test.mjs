import assert from 'node:assert/strict'
import test from 'node:test'
import { createPanelVmQuotaRoutes } from '../../src/lib/admin/panel-vm-quota-routes.mjs'

test('VM quota factory ignores unsupported methods', async () => {
  const handler = createPanelVmQuotaRoutes({ cfg: {}, routingConfig: {}, accountQuota: {}, panel: {}, json: () => {} })
  assert.equal(await handler({ method: 'GET' }, {}, '/api/panel/vms/vm-1/openai-quota/refresh'), false)
})
