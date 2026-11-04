import assert from 'node:assert/strict'
import test from 'node:test'
import { createAccountCommandService } from '../../src/lib/vendor/commands/account-command-service.mjs'
import { createSettlementCommandService } from '../../src/lib/vendor/commands/settlement-command-service.mjs'
import { createAccountQueryService } from '../../src/lib/vendor/queries/account-query-service.mjs'
import { createSettlementQueryService } from '../../src/lib/vendor/queries/settlement-query-service.mjs'
import { createUsageQueryService } from '../../src/lib/vendor/queries/usage-query-service.mjs'
import { createProxyCommandService } from '../../src/lib/vendor/commands/proxy-command-service.mjs'
import { projectVendorUsage } from '../../src/lib/vendor/projections/usage-projection.mjs'

test('vendor services expose stable command/query seams', () => {
  const accountCommands = createAccountCommandService()
  const settlementCommands = createSettlementCommandService()
  const accountQueries = createAccountQueryService()
  const settlementQueries = createSettlementQueryService()
  const usageQueries = createUsageQueryService()
  const proxyCommands = createProxyCommandService((id, action) => ({ id, action }))
  for (const value of [
    accountCommands.createDraft,
    accountCommands.authorizeDraft,
    settlementCommands.createDownstream,
    settlementCommands.mutateDownstream,
    accountQueries.runtime,
    accountQueries.usage,
    settlementQueries.supplierBilling,
    usageQueries.admin,
    usageQueries.supplier,
    proxyCommands.action,
  ])
    assert.equal(typeof value, 'function')
  assert.deepEqual(proxyCommands.action('proxy-1', 'probe'), { id: 'proxy-1', action: 'probe' })
})

test('vendor usage projection freezes read DTOs and keeps incomplete money/tokens unknown', () => {
  const projected = projectVendorUsage({
    summary: {
      requests: 2,
      cost_usd: 3,
      unpriced_requests: 1,
      total_tokens: 12,
      cache_unknown_requests: 1,
    },
    accounts: [{ cost_usd: 1, unpriced_requests: 0, total_tokens: 4 }],
  })
  assert.equal(projected.summary.cost_usd, null)
  assert.equal(projected.summary.total_tokens, null)
  assert.equal(projected.summary.cost_known, false)
  assert.equal(projected.summary.cache_complete, false)
  assert.equal(projected.accounts[0].cost_usd, 1)
  assert.equal(Object.isFrozen(projected), true)
  assert.equal(Object.isFrozen(projected.summary), true)
  assert.equal(Object.isFrozen(projected.accounts), true)
})
