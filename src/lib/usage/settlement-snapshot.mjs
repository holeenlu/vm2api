/** Frozen settlement input; no UI projection or historical row mutation. */
import { fromMicros, rowMicros } from '../core/money.mjs'

/** 一行金额的整数微单位（M6）：`amount_usd(_micros)` 优先，其次 `cost_usd(_micros)`；未知为 null。 */
function amountMicros(row) {
  const own = rowMicros(row, 'amount_usd')
  return own != null ? own : rowMicros(row, 'cost_usd')
}

export function createSettlementSnapshot({
  rows = [],
  periodStart = null,
  periodEnd = null,
  priceVersion = null,
} = {}) {
  const items = (Array.isArray(rows) ? rows : []).map((row) => Object.freeze({ ...row }))
  const amounts = items.map(amountMicros)
  const total = amounts.every((value) => value != null)
    ? fromMicros(amounts.reduce((sum, value) => sum + value, 0))
    : null
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
