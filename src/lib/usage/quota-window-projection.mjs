/** Stable quota-window DTO. Missing usage or limits remain unknown. */
function numberOrNull(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : null
}

export function projectQuotaWindow(input = {}, { now = Date.now() } = {}) {
  const used = numberOrNull(input.used ?? input.used_value)
  const limit = numberOrNull(input.limit ?? input.limit_value)
  const resetAt = input.reset_at ?? input.resetAt ?? null
  const resetMs = resetAt == null ? null : Date.parse(String(resetAt))
  const remaining = used != null && limit != null ? Math.max(0, limit - used) : null
  const percent = used != null && limit > 0 ? Math.min(100, (used / limit) * 100) : limit === 0 ? 100 : null
  return Object.freeze({
    key: String(input.key ?? input.window ?? '').trim() || null,
    used,
    limit,
    remaining,
    percent,
    reset_at: resetAt,
    reset_expired: Number.isFinite(resetMs) ? resetMs <= now : null,
    unknown: used == null || limit == null,
  })
}

export function projectQuotaWindows(input = {}, options = {}) {
  return Object.fromEntries(
    Object.entries(input || {}).map(([key, value]) => [key, projectQuotaWindow({ ...value, key }, options)]),
  )
}
