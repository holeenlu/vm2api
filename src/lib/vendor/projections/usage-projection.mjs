/** Stable vendor usage projection over legacy query DTOs. */
function row(value) {
  if (!value || typeof value !== 'object') return value
  const cost = value.cost_usd == null || Number(value.unpriced_requests || 0) > 0 ? null : Number(value.cost_usd)
  const cacheComplete = value.cache_complete !== false && Number(value.cache_unknown_requests || 0) === 0
  return Object.freeze({
    ...value,
    cost_usd: Number.isFinite(cost) ? cost : null,
    total_tokens: cacheComplete ? (value.total_tokens ?? null) : null,
    cache_complete: cacheComplete,
    cost_known: Number.isFinite(cost),
  })
}

export function projectVendorUsage(value) {
  if (!value || typeof value !== 'object') return value
  return Object.freeze({
    ...value,
    summary: row(value.summary),
    accounts: Array.isArray(value.accounts) ? Object.freeze(value.accounts.map(row)) : value.accounts,
    account_usage: Array.isArray(value.account_usage)
      ? Object.freeze(value.account_usage.map(row))
      : value.account_usage,
    trend: Array.isArray(value.trend) ? Object.freeze(value.trend.map(row)) : value.trend,
    models: Array.isArray(value.models) ? Object.freeze(value.models.map(row)) : value.models,
    fixed_windows:
      value.fixed_windows && typeof value.fixed_windows === 'object'
        ? Object.freeze(Object.fromEntries(Object.entries(value.fixed_windows).map(([key, item]) => [key, row(item)])))
        : value.fixed_windows,
  })
}
