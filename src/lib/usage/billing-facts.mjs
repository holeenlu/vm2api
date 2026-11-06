import { normalizeUsageFacts, usageFactsFromLog } from './usage-facts.mjs'

function text(value) {
  const result = String(value ?? '').trim()
  return result || null
}

function numberOrNull(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : null
}

/** Canonical billing evidence; unknown money remains null. */
export function normalizeBillingFacts(input = {}) {
  const usage = normalizeUsageFacts(input)
  const costUsd = numberOrNull(input.cost_usd ?? input.actual_cost_usd ?? input.total_cost ?? usage.cost_usd)
  const billingStatus = text(input.billing_status ?? input.status_label ?? (costUsd == null ? null : 'priced'))
  return Object.freeze({
    usage_facts: usage,
    cost_usd: costUsd,
    cost_known: costUsd != null,
    billing_status: billingStatus,
    currency: text(input.currency) || (costUsd == null ? null : 'USD'),
    price_revision: text(input.price_revision ?? input.pricing_revision),
    idempotency_key: text(input.idempotency_key ?? input.charge_id),
  })
}

export function billingFactsFromLog(row) {
  return normalizeBillingFacts({
    ...row,
    ...usageFactsFromLog(row),
    cost_usd: row?.actual_cost_usd ?? row?.cost_usd ?? row?.total_cost,
  })
}
