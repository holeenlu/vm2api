import test from 'node:test'
import assert from 'node:assert/strict'
import { createPanelApiEndpointRoutes } from '../../src/lib/admin/panel-api-endpoint-routes.mjs'

test('panel API endpoint route factory preserves public list projection', async () => {
  const response = {}
  const handle = createPanelApiEndpointRoutes({
    apiEndpointStore: {
      list: (input) => {
        assert.deepEqual(input, { reveal: false, role: 'super_admin' })
        return [{ id: 'ep-1', name: 'OpenAI' }]
      },
    },
    apiKeyStore: {
      db: {
        prepare: () => ({ all: () => [], get: () => undefined }),
      },
    },
    apiScheduler: {},
    proxyPool: {},
    cfg: {},
    ctx: {},
    json(_res, status, body) {
      response.status = status
      response.body = body
    },
    readBody: async () => ({}),
    upstreamFetchStatus: () => 502,
  })

  const handled = await handle({ method: 'GET', panelRole: 'super_admin' }, {}, '/api/panel/api-endpoints')
  assert.equal(handled, true)
  assert.equal(response.status, 200)
  assert.equal(response.body.ok, true)
  assert.deepEqual(response.body.items, [{ id: 'ep-1', name: 'OpenAI', groups: [], groups_version: 0 }])
})
