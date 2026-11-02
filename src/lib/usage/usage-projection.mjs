import { billingFactsFromLog } from './billing-facts.mjs'

/**
 * Canonical reporting projection for legacy log rows.
 * SQL adapters keep their existing DTOs; this function supplies a stable
 * fact-aware view for new readers without rewriting historical rows.
 */
export function projectUsageRow(row = {}) {
  const billing = billingFactsFromLog(row)
  const facts = billing.usage_facts
  return Object.freeze({
    ...row,
    usage_facts: facts,
    input_tokens: facts.input_tokens,
    output_tokens: facts.output_tokens,
    total_tokens: facts.total_tokens,
    cost_usd: billing.cost_usd,
    usage_complete: facts.usage_complete,
    cost_known: billing.cost_known,
  })
}

export function projectUsageRows(rows = []) {
  return Object.freeze((Array.isArray(rows) ? rows : []).map(projectUsageRow))
}

export function projectUsageSummary(summary = {}) {
  const rows = projectUsageRows(summary.rows || [])
  const costKnown = rows.every((row) => row.cost_known)
  return Object.freeze({
    ...summary,
    rows,
    cost_known: costKnown,
    total_cost_usd: costKnown ? rows.reduce((total, row) => total + Number(row.cost_usd || 0), 0) : null,
  })
}
