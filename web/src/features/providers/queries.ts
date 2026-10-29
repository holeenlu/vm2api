import { queryOptions } from '@tanstack/react-query'
import { api } from '@/lib/api'

export type ProviderRow = {
  id: string
  vm_id?: string | null
  account_id?: string | null
  name: string
  provider_type: string
  email?: string | null
  status: string
  vm_status?: string | null
  has_token?: boolean
  credential_mode?: string | null
  vendor_id?: string | null
  vendor_name?: string | null
  vendor_tier?: number | null
  utilization_5h?: number | null
  reset_5h?: string | number | null
  utilization_7d?: number | null
  reset_7d?: string | number | null
  estimate_7d?: {
    status?: string
    total_usd?: number | null
    remaining_usd?: number | null
  } | null
  total_cost?: number
  total_tokens?: number
  inflight?: number
  requests?: number
  max_concurrency?: number
  max_rpm?: number
  schedulable?: boolean
  schedule_disabled_reason?: string | null
}

export type ProvidersPayload = {
  items?: ProviderRow[]
  totals?: Record<string, number>
  vendors?: { id: string; name: string; tier: number }[]
}

export function providersQueryOptions(refetchInterval?: number) {
  return queryOptions({
    queryKey: ['panel', 'providers'] as const,
    queryFn: () => api<ProvidersPayload>('/api/panel/providers'),
    ...(refetchInterval
      ? { refetchInterval, refetchOnWindowFocus: false }
      : {}),
  })
}
