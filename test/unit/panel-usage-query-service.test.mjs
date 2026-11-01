import assert from 'node:assert/strict'
import test from 'node:test'
import { createPanelUsageQueryService } from '../../src/lib/admin/panel-usage-query-service.mjs'

test('panel usage query service exposes stable usage-log read methods', () => {
  const service = createPanelUsageQueryService({ db: {} })
  for (const method of [
    'listBatch',
    'ranking',
    'summary',
    'filterOptions',
    'sessionSuggestions',
    'activeSessions',
    'overview',
    'exportRows',
  ])
    assert.equal(typeof service[method], 'function')
})
