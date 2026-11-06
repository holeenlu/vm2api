import { systemDateTimeToIso } from '@/lib/system-time'

export const KEY_NUMERIC_FIELDS = {
  max_concurrency: 'concurrencyLimit',
  quota_usd: 'amountLimit',
  quota_requests: 'requestLimit',
  rpm: 'rpmLimit',
  rate_limit_5h: 'fiveHourLimit',
  rate_limit_1d: 'dailyLimit',
  rate_limit_7d: 'weeklyLimit',
} as const

export const BULK_FIELDS = {
  group_id: 'serviceGroup',
  status: 'status',
  ...KEY_NUMERIC_FIELDS,
  expires_at: 'expiryTime',
  ip_whitelist: 'ipAllowlist',
  ip_blacklist: 'ipBlocklist',
} as const
export type BulkField = keyof typeof BULK_FIELDS
export type BulkDraft = Partial<Record<BulkField, string>>

// Presence means opt-in. An empty expiry/IP list clears that limit; an empty
// number is invalid and must never silently become an unlimited quota.
export function bulkKeyPatch(draft: BulkDraft) {
  const patch: Record<string, unknown> = {}
  for (const [field, value] of Object.entries(draft)) {
    if (value === undefined) continue
    if (field in KEY_NUMERIC_FIELDS) {
      if (!value.trim() || !Number.isFinite(Number(value)) || Number(value) < 0)
        throw new Error('invalid_number')
      patch[field] = Number(value)
    } else if (field === 'group_id') {
      if (!value) throw new Error('group_required')
      patch[field] = value === '__platform__' ? null : Number(value)
    } else if (field === 'expires_at') {
      patch[field] = value ? systemDateTimeToIso(value) : null
    } else if (field === 'ip_whitelist' || field === 'ip_blacklist') {
      patch[field] = value
        .split(/[\n,，]/)
        .map((v) => v.trim())
        .filter(Boolean)
    } else patch[field] = value
  }
  return patch
}
