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
    protocol?: string
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
  usage: PricingSnapshot & Partial<UsageRow> & { usage?: UsageRow }
}
export type Preview = PricingSnapshot & {
  preview_token: string
  vendor_id: string
  vendor_name: string
  period_start: string
  period_end: string
  amount_usdt: number
  usage: UsageRow
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
export const selectClass = 'h-9 rounded-md border bg-background px-3 text-sm'
export const amount = (n: number | undefined) =>
  Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 6 })
