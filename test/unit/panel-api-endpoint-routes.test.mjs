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

test('endpoint key edits only touch keys that belong to the endpoint in the path', async () => {
  const keys = new Map([
    ['ek_a', { id: 'ek_a', endpoint_id: 'ep-a' }],
    ['ek_b', { id: 'ek_b', endpoint_id: 'ep-b' }],
  ])
  const removed = []
  const updated = []
  const response = {}
  const handle = createPanelApiEndpointRoutes({
    apiEndpointStore: {
      getRaw: (id) => ({ id, api_key_entries: [...keys.values()].filter((key) => key.endpoint_id === id) }),
      removeKey: (id) => (removed.push(id), keys.delete(id)),
      updateKey: (id) => (updated.push(id), keys.get(id) || null),
      listRaw: () => [],
    },
    apiKeyStore: { db: { prepare: () => ({ all: () => [], get: () => undefined }) } },
    apiScheduler: { reload: () => {} },
    proxyPool: {},
    cfg: {},
    ctx: {},
    json(_res, status, body) {
      Object.assign(response, { status, body })
    },
    readBody: async () => ({ disabled: true }),
    upstreamFetchStatus: () => 502,
  })
  const call = (method, path) => handle({ method, panelRole: 'super_admin' }, {}, path)
  assert.equal(await call('DELETE', '/api/panel/api-endpoints/ep-a/keys/ek_b'), true)
  assert.equal(response.status, 404)
  assert.equal(await call('PATCH', '/api/panel/api-endpoints/ep-a/keys/ek_b'), true)
  assert.equal(response.status, 404)
  assert.deepEqual([removed, updated], [[], []], 'a key of another endpoint is never touched')
  assert.equal(await call('PATCH', '/api/panel/api-endpoints/ep-b/keys/ek_b'), true)
  assert.equal(response.status, 200)
  assert.equal(await call('DELETE', '/api/panel/api-endpoints/ep-b/keys/ek_b'), true)
  assert.deepEqual([response.status, removed], [200, ['ek_b']])
})
