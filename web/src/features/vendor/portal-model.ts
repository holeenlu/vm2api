import { t, i18n } from '@/i18n'
import {
  EMPTY_ACCOUNT_FILTERS,
  filterAccountRows,
} from '../../../../src/shared/vendor-account-filters.mjs'

export const VIEW_KEYS = [
  'accounts',
  'proxies',
  'vendors',
  'usage',
  'billing',
] as const
export type ViewKey = (typeof VIEW_KEYS)[number]
export const viewLabel = (view: ViewKey) => t(`vendor:view.${view}`)
export type Vendor = {
  id: string
  name: string
  tier: 1 | 2
  groups?: string[]
  effective_platforms?: string[]
  platforms?: string[]
  views: string[]
  capabilities: string[]
  child_limit: number
  account_limit: number
  proxy_limit: number
}
export type Telemetry = {
  vm_id: string | null
  state: string
  plan_type?: string | null
  rate_limit_tier?: string | null
  billing_type?: string | null
  subscription_type?: string | null
  requires_authorization?: boolean
  schedulable?: boolean
  priority?: number | null
  utilization_fable?: number | null
  reset_fable?: string | null
  has_fable?: boolean
  today_fable_cost?: number | null
  fable_cost?: number | null
  tpm_with_cache?: number | null
  cooldown_until?: string | null
  collected_at?: string | null
  email: string | null
  utilization_5h: number | null
  utilization_7d: number | null
  reset_5h: string | number | null
  reset_7d: string | number | null
  today_cost: number | null
  total_cost: number | null
  total_tokens: number | null
  requests: number | null
  cache_hit_rate: number | null
  cache_complete?: boolean
  inflight: number | null
  max_concurrency: number | null
  rpm: number | null
  max_rpm?: number | null
  tpm?: number | null
  tokens_in?: number | null
  tokens_out?: number | null
  cache_read_tokens?: number | null
  cache_creation_tokens?: number | null
  window_5h_cost?: number | null
  window_7d_cost?: number | null
  window_5h_requests?: number | null
  window_7d_requests?: number | null
  window_5h_tokens?: number | null
  window_7d_tokens?: number | null
  near_limit?: boolean | null
  failure_category?: string | null
  error_message?: string | null
}
export type Resource = {
  id: string
  vendor_id: string
  name: string
  resource_type: 'account' | 'proxy' | 'vm'
  status: string
  config: Record<string, unknown>
  created_at: string
  telemetry?: Telemetry
  updated_at?: string
  archived_at?: string | null
  notes?: string
  all_time_usage?: VendorUsageSummary | null
  today_usage?: VendorUsageSummary | null
  proxy?: {
    id: string
    name: string
    endpoint: string | null
    region?: string
    country?: string
    city?: string
  } | null
  groups?: { id: number; name: string; platform: string }[]
}
export function allowedViews(vendor: Vendor): ViewKey[] {
  const children =
    vendor.tier === 1 &&
    vendor.capabilities.includes('vendor.create_child') &&
    vendor.views.includes('vendors')
  return [
    'accounts',
    'proxies',
    ...(children ? (['vendors'] as const) : []),
    ...(vendor.capabilities.includes('vendor.usage.read')
      ? (['usage'] as const)
      : []),
    ...(vendor.capabilities.includes('vendor.settlement.read')
      ? (['billing'] as const)
      : []),
  ]
}
export const stateLabel = (state: string) => {
  const key = `vendor:state.${state}`
  const value = t(key)
  return value === key ? state : value
}
export const money = (value?: number | null) =>
  value == null ? '—' : '$' + value.toFixed(2)
export const number = (value?: number | null) =>
  value == null ? '—' : value.toLocaleString(i18n.language)
export const time = (value?: string | number | null) => {
  if (value == null || value === '') return t('vendor:unknown')
  const n = Number(value)
  const milliseconds = Number.isFinite(n)
    ? n < 1e12
      ? n * 1000
      : n
    : Date.parse(String(value))
  return Number.isFinite(milliseconds) && milliseconds > 0
    ? new Date(milliseconds).toLocaleString(i18n.language, { hour12: false })
    : t('vendor:unknown')
}
export function accountSummary(rows: Resource[]) {
  return {
    total: rows.length,
    available: rows.filter((r) => r.telemetry?.state === 'available').length,
    unauthorized: rows.filter((r) => r.telemetry?.state === 'unauthorized')
      .length,
    paused: rows.filter((r) => r.status === 'paused').length,
    reported: rows.filter((r) => r.telemetry?.total_cost != null).length,
    cost: rows.reduce((s, r) => s + (r.telemetry?.total_cost ?? 0), 0),
    rpm: rows.some((r) => r.telemetry?.rpm != null)
      ? rows.reduce((s, r) => s + (r.telemetry?.rpm ?? 0), 0)
      : null,
    tpm: rows.some((r) => r.telemetry?.tpm != null)
      ? rows.reduce((s, r) => s + (r.telemetry?.tpm ?? 0), 0)
      : null,
    inflight: rows.some((r) => r.telemetry?.inflight != null)
      ? rows.reduce((s, r) => s + (r.telemetry?.inflight ?? 0), 0)
      : null,
    nearLimit: rows.some(
      (r) =>
        r.telemetry?.near_limit != null ||
        quotaWindows(r).some((w) => w.value != null)
    )
      ? rows.filter(
          (r) =>
            r.telemetry?.near_limit === true ||
            quotaWindows(r).some((w) => w.value != null && w.value >= 0.9)
        ).length
      : null,
    cooling: rows.filter((r) => r.telemetry?.state === 'cooling').length,
    abnormal: rows.filter((r) =>
      ['error', 'unavailable', 'unauthorized', 'provisioning'].includes(
        r.telemetry?.state || 'provisioning'
      )
    ).length,
    disabled: rows.filter((r) => ['paused', 'archived'].includes(r.status))
      .length,
    tpmWithCache: rows.some((r) => r.telemetry?.tpm_with_cache != null)
      ? rows.reduce((sum, r) => sum + (r.telemetry?.tpm_with_cache ?? 0), 0)
      : null,
    capacity: rows.some((r) => r.telemetry?.max_concurrency === 0)
      ? 0
      : rows.some((r) => r.telemetry?.max_concurrency != null)
        ? rows.reduce((sum, r) => sum + (r.telemetry?.max_concurrency ?? 0), 0)
        : null,
    failures: Object.fromEntries(
      FAILURE_CATEGORIES.map((category) => [
        category,
        rows.filter((r) => r.telemetry?.failure_category === category).length,
      ])
    ),
    distributions: Object.fromEntries(
      ['5h', '7d', 'fable'].map((key) => {
        const values = rows.flatMap((r) =>
          quotaWindows(r)
            .filter((w) => w.key === key)
            .map((w) => w.value)
        )
        return [
          key,
          {
            total: values.length,
            normal: values.filter((v) => v != null && v < 0.9).length,
            near: values.filter((v) => v != null && v >= 0.9 && v < 0.99)
              .length,
            full: values.filter((v) => v != null && v >= 0.99).length,
            unknown: values.filter((v) => v == null).length,
          },
        ]
      })
    ) as Record<
      string,
      {
        total: number
        normal: number
        near: number
        full: number
        unknown: number
      }
    >,
  }
}
export const FAILURE_CATEGORIES = [
  'authentication',
  'kyc',
  'terms',
  'tier',
  'duplicate',
  'email_mismatch',
  'rejected',
  'connection',
  'permission',
  'proxy',
  'upstream',
  'unknown',
] as const

export function quotaWindows(row: Resource) {
  const t = row.telemetry
  return [
    ...(t?.has_fable
      ? [
          {
            key: 'fable',
            value: t.utilization_fable ?? null,
            reset: t.reset_fable,
          },
        ]
      : []),
    { key: '7d', value: t?.utilization_7d ?? null, reset: t?.reset_7d },
    { key: '5h', value: t?.utilization_5h ?? null, reset: t?.reset_5h },
  ]
}
export const EMPTY_FILTERS = EMPTY_ACCOUNT_FILTERS
export type AccountFilters = typeof EMPTY_FILTERS
export function filterAccounts(
  rows: Resource[],
  search: string,
  platform: string,
  status: string,
  extra: Partial<AccountFilters> = {}
) {
  return filterAccountRows(rows, { ...extra, search, platform, status })
}

export type VendorUsageSummary = {
  requests: number
  success: number
  errors: number
  success_rate: number | null
  input_tokens: number
  output_tokens: number
  tokens: number
  total_tokens: number | null
  cache_read_tokens: number
  cache_creation_tokens: number
  cache_hit_rate: number | null
  cache_complete?: boolean
  cost_usd: number | null
  unpriced_requests: number
  fable_cost_usd: number
  opus_cost_usd: number
  avg_duration_ms: number | null
  avg_ttft_ms: number | null
}
export type VendorUsageReport = {
  name?: string
  account_id?: string
  period: { range: string; start: string | null; end: string; timezone: string }
  summary: VendorUsageSummary
  trend: Array<{
    date: string
    requests: number
    input_tokens: number
    output_tokens: number
    tokens: number
    total_tokens: number | null
    cache_read_tokens: number
    cache_creation_tokens: number
    cache_complete?: boolean
    cost_usd: number | null
  }>
  models: Array<VendorUsageSummary & { model: string }>
  fixed_windows: Record<string, VendorUsageSummary>
  collected_at: string
  resolution: 'day' | 'month'
  source: string
}
export type VendorAccountDetail = Resource & {
  owner: { id: string; name: string }
  schedulable: boolean
  cooldowns: Array<{ kind: string; until: string }>
  model_limits: Array<{
    model: string
    until: string | null
    status: string
  }> | null
  group_version?: number
  snapshot_at: string
}

export function editableGroupOptions(
  current: { id: number; name: string; platform: string }[],
  available: { id: number; name: string; platform: string }[]
) {
  const allowed = new Set(available.map((g) => g.id))
  return [
    ...new Map([...current, ...available].map((g) => [g.id, g])).values(),
  ].map((g) => ({ ...g, available: allowed.has(g.id) }))
}
