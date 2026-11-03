/** Frozen settlement input; no UI projection or historical row mutation. */
function amount(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

export function createSettlementSnapshot({
  rows = [],
  periodStart = null,
  periodEnd = null,
  priceVersion = null,
} = {}) {
  const items = (Array.isArray(rows) ? rows : []).map((row) => Object.freeze({ ...row }))
  const amounts = items.map((row) => amount(row.amount_usd ?? row.cost_usd))
  const total = amounts.every((value) => value != null) ? amounts.reduce((sum, value) => sum + value, 0) : null
  return Object.freeze({
    source: 'usage_facts',
    period_start: periodStart,
    period_end: periodEnd,
    price_version: priceVersion,
    row_count: items.length,
    total_usd: total,
    amount_known: total != null,
    rows: Object.freeze(items),
  })
}
