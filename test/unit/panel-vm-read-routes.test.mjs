import assert from 'node:assert/strict'
import test from 'node:test'
import { createPanelVmReadRoutes } from '../../src/lib/admin/panel-vm-read-routes.mjs'

function makeHarness() {
  const responses = []
  const calls = []
  const panel = {
    ok: (data) => ({ ok: true, data }),
    buildVmList: async (input) => {
      calls.push(['list', input])
      return { ok: true, data: { items: [{ id: 'vm-1' }] } }
    },
    buildVmDetail: async (input) => {
      calls.push(['detail', input])
      return { ok: true, data: { vm: { id: input.id } } }
    },
  }
  const handler = createPanelVmReadRoutes({
    panel,
    cfg: { paths: { project: '/tmp/project' } },
    accountQuota: {},
    routingConfig: { vm: { memory: '1g' } },
    poolScheduler: {},
    proxyPool: {},
    requestLog: {},
    clusterNodesOf: () => [],
    panelIdentity: () => ({ role: 'super_admin' }),
    listVms: () => [],
    probeLocalKvm: async () => ({ available: true }),
    usageProbeMonitor: { refreshVisible: async () => {} },
    json: (...args) => responses.push(args),
  })
  return { handler, responses, calls }
}

test('VM read factory preserves list, detail, fleet and create-options routes', async () => {
  const { handler, responses, calls } = makeHarness()
  assert.equal(await handler({ method: 'GET' }, {}, '/api/panel/vms'), true)
  assert.equal(responses.at(-1)[1], 200)
  assert.equal(calls[0][0], 'list')

  assert.equal(await handler({ method: 'GET' }, {}, '/api/panel/vms/vm-1'), true)
  assert.equal(calls[1][1].id, 'vm-1')

  assert.equal(await handler({ method: 'GET' }, {}, '/api/panel/vms/create-options'), true)
  assert.deepEqual(responses.at(-1)[2].data.kvm, { available: true })

  assert.equal(await handler({ method: 'GET' }, {}, '/api/panel/vms/fleet-status'), true)
})

test('VM read factory ignores write routes', async () => {
  const { handler } = makeHarness()
  assert.equal(await handler({ method: 'POST' }, {}, '/api/panel/vms/vm-1/start'), false)
})
