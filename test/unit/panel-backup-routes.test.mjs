import test from 'node:test'
import assert from 'node:assert/strict'
import { createPanelBackupRoutes } from '../../src/lib/admin/panel-backup-routes.mjs'

test('panel backup route factory preserves backup list response', async () => {
  const response = {}
  const handle = createPanelBackupRoutes({
    backupService: {
      list: () => [{ id: 'b1' }],
      getSchedule: () => ({ enabled: true }),
      nextAutoAt: () => '2026-11-01T12:00:00.000Z',
      isRestoring: false,
    },
    apiKeyStore: { inflight: new Map() },
    json(_res, status, body) {
      response.status = status
      response.body = body
    },
    readBody: async () => ({}),
  })

  const handled = await handle({ method: 'GET' }, {}, '/api/panel/backups')
  assert.equal(handled, true)
  assert.equal(response.status, 200)
  assert.deepEqual(response.body.items, [{ id: 'b1' }])
  assert.deepEqual(response.body.config, { enabled: true })
})
