import { queryOptions } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { panelQueryKeys } from '@/lib/query-keys'

export type CommercialGroup = {
  id: number
  name: string
  description: string
  platform: string
  status: string
  version: number
  rate_multiplier?: number
  is_exclusive?: boolean
  models: string[]
  supported_platforms?: string[]
  subscription_type: string
  daily_limit_usd?: number
  weekly_limit_usd?: number
  monthly_limit_usd?: number
  rpm_limit?: number
  allow_image_generation?: boolean
  image_count_billing?: boolean
  image_rate_independent?: boolean
  image_rate_multiplier?: number
  image_price_1k?: number | null
  image_price_2k?: number | null
  image_price_4k?: number | null
  web_search_price_per_call?: number | null
  codex_fast_mode?: 'default' | 'enabled' | 'disabled'
  rpm_override?: number | null
  capacity?: {
    kind: 'api' | 'vm'
    used: number
    limit: number
    resources: number
  }
  usage?: {
    today_cost: number
    yesterday_cost: number
    total_cost: number
    requests: number
    timezone: string
  }
  resources?: {
    resource_kind: string
    resource_id: string
    priority?: number
  }[]
}
export const groupsQueryOptions = (
  queryKey: readonly unknown[] = panelQueryKeys.groups()
) =>
  queryOptions({
    queryKey,
    queryFn: () => api<{ items: CommercialGroup[] }>('/api/panel/groups'),
  })
