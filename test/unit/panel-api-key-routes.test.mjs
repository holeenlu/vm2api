import test from 'node:test'
import assert from 'node:assert/strict'
import { createPanelApiKeyRoutes } from '../../src/lib/admin/panel-api-key-routes.mjs'

test('panel API key route factory handles role-scoped list responses', async () => {
  const response = {}
  const handle = createPanelApiKeyRoutes({
    apiKeyStore: {
      snapshot: () => ({ keys: [{ id: 'k1', user_id: 'user-1', status: 'active' }] }),
      users: { scopeIds: () => [] },
    },
    requestLog: null,
    json(_res, status, body) {
      response.status = status
      response.body = body
    },
    readBody: async () => ({}),
    ctx: {},
    normalizeInput: (body) => body,
  })

  const handled = await handle(
    { method: 'GET', panelUserId: 'user-1', panelRole: 'user' },
    {},
    '/api/panel/api-keys',
    new URL('http://localhost/api/panel/api-keys'),
  )
  assert.equal(handled, true)
  assert.equal(response.status, 200)
  assert.deepEqual(response.body, {
    ok: true,
    total: 1,
    active: 1,
    keys: [{ id: 'k1', user_id: 'user-1', status: 'active' }],
  })
})
