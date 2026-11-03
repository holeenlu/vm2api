import assert from 'node:assert/strict'
import test from 'node:test'
import { createPanelVmLifecycleRoutes } from '../../src/lib/admin/panel-vm-lifecycle-routes.mjs'

test('VM lifecycle factory preserves action dispatch and public envelopes', async () => {
  const responses = []
  const handler = createPanelVmLifecycleRoutes({
    cfg: { paths: { project: '/tmp/project' } },
    routingConfig: {},
    proxyPool: {},
    clusterNodesOf: () => [],
    panel: {
      ok: (data) => ({ ok: true, data }),
      publicVmBootView: (vm) => vm,
      publicAllocatedProxy: () => null,
      publicRuntimeView: (value) => value,
      publicSlotBoot: (value) => value,
    },
    panelIdentity: () => ({ role: 'super_admin' }),
    gatewayCapabilities: { runtime: 'docker-container', kernel: 'mixed-os-docker' },
    start: async () => ({ ok: true, vm: { id: 'vm-1', runtime: {} }, boot: { ok: true } }),
    recover: async () => ({ ok: true, report: { recovered: true } }),
    stop: async () => ({ ok: true, vm: { id: 'vm-1', runtime: {} }, halt: { ok: true } }),
    json: (...args) => responses.push(args),
  })
  assert.equal(await handler({ method: 'POST' }, {}, '/api/panel/vms/vm-1/start'), true)
  assert.equal(responses.at(-1)[1], 200)
  assert.equal(responses.at(-1)[2].data.vm.id, 'vm-1')
  assert.equal(await handler({ method: 'POST' }, {}, '/api/panel/vms/vm-1/recover'), true)
  assert.deepEqual(responses.at(-1)[2].data, { recovered: true })
  assert.equal(await handler({ method: 'GET' }, {}, '/api/panel/vms/vm-1/stop'), false)
})
