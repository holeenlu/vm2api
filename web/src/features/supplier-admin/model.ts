import type { Vendor, Resource } from '@/features/vendor/portal-model'

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
export type UsageRow = {
  vendor_id?: string
  vendor_name?: string
  resource_id?: string
  account_name?: string
  model?: string
  date?: string
  unpriced_requests?: number
  requests: number
  input_tokens: number
  output_tokens: number
  cost_usd: number
}
export type Usage = {
  period: { start: string; end: string }
  summary: UsageRow
  accounts: UsageRow[]
  trend: UsageRow[]
}
export type Statement = {
  group_prices?: Record<string, number>
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
  amount_usdt: number
  paid_usdt: number
  contract_version: number
  price_cny_per_usd: number
  fx_cny_per_usdt: number
  multiplier: number
  usage: UsageRow | { usage: UsageRow }
}
export type Preview = {
  preview_token: string
  group_prices?: Record<string, number>
  rate_breakdown?: Array<{
    platform: string
    cost_usd: number
    price_cny_per_usd: number
    amount_usdt: number
  }>
  vendor_id: string
  vendor_name: string
  period_start: string
  period_end: string
  amount_usdt: number
  contract_version: number
  price_cny_per_usd: number
  fx_cny_per_usdt: number
  multiplier: number
  usage: UsageRow
}
export const PAGES = [
  'suppliers',
  'accounts',
  'proxies',
  'usage',
  'settlements',
] as const
export type SupplierPage = (typeof PAGES)[number]
export const ROOT = '/api/admin/vendors'
export const selectClass = 'h-9 rounded-md border bg-background px-3 text-sm'
export const amount = (n: number | undefined) =>
  Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 6 })
