import test from 'node:test'
import assert from 'node:assert/strict'
import { createPanelUserRoutes } from '../../src/lib/admin/panel-user-routes.mjs'

test('panel user route factory handles the list route and preserves its envelope', async () => {
  const response = {}
  const handle = createPanelUserRoutes({
    panelUsers: {
      list(input) {
        assert.deepEqual(input, { actorId: 'admin-1', role: 'admin' })
        return [{ id: 'user-1' }]
      },
    },
    json(_res, status, body) {
      response.status = status
      response.body = body
    },
    readBody: async () => ({}),
    vendorPlatform: () => {
      throw new Error('not used by GET')
    },
  })

  const handled = await handle({ method: 'GET', panelUserId: 'admin-1', panelRole: 'admin' }, {}, '/api/panel/users')
  assert.equal(handled, true)
  assert.equal(response.status, 200)
  assert.deepEqual(response.body, { ok: true, data: { items: [{ id: 'user-1' }] } })
})
