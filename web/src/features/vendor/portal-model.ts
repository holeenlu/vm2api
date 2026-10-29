import { t, i18n } from '@/i18n'

export const VIEW_KEYS = [
  'accounts',
  'proxies',
  'vendors',
  'usage',
  'billing',
  'settlements',
  'payables',
  'audit',
] as const
export type ViewKey = (typeof VIEW_KEYS)[number]
export const viewLabel = (view: ViewKey) => t(`vendor:view.${view}`)
export type Vendor = {
  id: string
  name: string
  email?: string
  tier: 1 | 2
  groups?: string[]
  platforms?: string[]
  views: string[]
  capabilities: string[]
  child_limit: number
  account_limit: number
  proxy_limit: number
  contact_name?: string
  settlement_email?: string
  binance_id?: string
  default_price_cny_per_usd?: number
  group_prices?: Record<string, number | string>
  fx_cny_per_usdt?: number
  default_multiplier?: number
  contract_version?: number
}
export type Telemetry = {
  vm_id: string | null
  state: string
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
    'audit',
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
  value == null ? '—' : value.toLocaleString('zh-CN')
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
    rpm: rows.reduce((s, r) => s + (r.telemetry?.rpm ?? 0), 0),
    tpm: rows.some((r) => r.telemetry?.tpm != null)
      ? rows.reduce((s, r) => s + (r.telemetry?.tpm ?? 0), 0)
      : null,
    inflight: rows.reduce((s, r) => s + (r.telemetry?.inflight ?? 0), 0),
    nearLimit: rows.filter((r) => r.telemetry?.near_limit).length,
  }
}
export function filterAccounts(
  rows: Resource[],
  search: string,
  platform: string,
  status: string
) {
  return rows.filter(
    (r) =>
      (!search ||
        [r.name, r.id, r.telemetry?.email].some((v) =>
          v?.toLowerCase().includes(search.toLowerCase())
        )) &&
      (platform === 'all' || r.config.platform === platform) &&
      (status === 'all' || r.telemetry?.state === status)
  )
}
