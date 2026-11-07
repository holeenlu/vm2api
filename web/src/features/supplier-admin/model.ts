import { addSystemDays } from '@/lib/system-time'
import type { Vendor, Resource } from '@/features/vendor/portal-model'
import type { PricingSnapshot } from '@/features/vendor/pricing-breakdown'

export type Supplier = Vendor & {
  remark?: string
  status: string
  external_code: string
  parent_id: string | null
  members: { id: string; username: string }[]
  account_count: number
  proxy_count: number
}
export type SupplierResource = Resource
export type SupplierProxy = SupplierResource & {
  config: Resource['config'] & {
    pool_id?: string
    host?: string
    port?: number
    has_auth?: boolean
    pool_status?: string
    pool_enabled?: boolean
    latency_ms?: number | null
    last_probe_at?: string | null
    last_error?: string | null
    quality?: { score?: number; grade?: string; status?: string } | null
    geo?: {
      ip?: string
      country?: string
      country_code?: string
      city?: string
    } | null
    bound_count?: number
    bind_limit?: number
    bound_vm_ids?: string[]
  }
}
export type UsageRow = {
  cache_read_tokens: number
  cache_creation_tokens: number
  cache_read_known_requests?: number
  cache_creation_known_requests?: number
  cache_complete?: boolean
  cache_hit_rate: number | null
  vendor_id?: string
  vendor_name?: string
  resource_id?: string
  account_name?: string
  status?: string | null
  telemetry?: Resource['telemetry']
  date?: string
  unpriced_requests?: number
  requests: number
  input_tokens: number
  output_tokens: number
  cost_usd: number | null
}
export type Usage = {
  period: { start: string; end: string }
  summary: UsageRow
  accounts: UsageRow[]
  trend: UsageRow[]
}
export type Statement = {
  payments: {
    id: string
    amount_usdt: number
    reason: string
    created_at: string
  }[]
  id: string
  vendor_name: string
  payee_vendor_id: string
  payer_vendor_id: string | null
  period_start: string
  period_end: string
  status: string
  created_at?: string
  confirmed_at?: string | null
  amount_usdt: number
  paid_usdt: number
  usage: PricingSnapshot & Partial<UsageRow> & { usage?: UsageRow }
}
export type Preview = {
  vendor_id: string
  preview_token: string
  idempotency_key: string
  expires_at: string
  available_count: number
  occupied_count: number
  statement: PricingSnapshot & {
    cost_usd: string
    total_usdt: string
    usage?: UsageRow
  }
  overlaps: {
    id: string
    status: string
    period_start: string
    period_end: string
    amount_usdt: number
  }[]
}
export const PAGES = [
  'suppliers',
  'accounts',
  'proxies',
  'usage',
  'settlements',
  'pricing',
] as const
export type SupplierPage = (typeof PAGES)[number]
export const ROOT = '/api/admin/vendors'
export const supplierQueryKeys = {
  root: () => ['supplier-admin'] as const,
  page: (page: SupplierPage, query = '') =>
    ['supplier-admin', page, query] as const,
  suppliers: () => ['supplier-admin', 'suppliers'] as const,
  accounts: (scope = '') => ['supplier-admin', 'accounts', scope] as const,
  proxies: (query: unknown) => ['supplier-admin', 'proxies', query] as const,
  pricing: () => ['supplier-admin', 'pricing'] as const,
  accountGroups: (vendorId: string, platform: string) =>
    ['supplier-admin', 'account-groups', vendorId, platform] as const,
  createProxies: (vendorId: string) =>
    ['supplier-admin', 'create-proxies', vendorId] as const,
}
export const selectClass = 'h-9 rounded-md border bg-background px-3 text-sm'
export const amount = (n: number | null | undefined) =>
  n === null
    ? '—'
    : Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 6 })

// 平台账单日期含首尾（北京时间），只能结算已结束的日期：快捷范围都截止到昨天。
export function settlementEditorPresets(
  today: string,
  settledThrough: string | null
) {
  const yesterday = addSystemDays(today, -1)
  const [year, month] = today.split('-').map(Number)
  const monthStart = (y: number, m: number) =>
    `${y}-${String(m).padStart(2, '0')}-01`
  const lastMonthStart =
    month === 1 ? monthStart(year - 1, 12) : monthStart(year, month - 1)
  const ranges: [string, string, string][] = [
    ['yesterday', yesterday, yesterday],
    ['7days', addSystemDays(today, -7), yesterday],
    ['30days', addSystemDays(today, -30), yesterday],
    ['lastMonth', lastMonthStart, addSystemDays(monthStart(year, month), -1)],
  ]
  if (settledThrough && settledThrough < yesterday)
    ranges.unshift(['sinceLast', addSystemDays(settledThrough, 1), yesterday])
  return ranges
}
