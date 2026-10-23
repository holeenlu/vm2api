import { queryOptions } from '@tanstack/react-query'
import { api } from '@/lib/api'

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
  subscription_type: string
  daily_limit_usd?: number
  weekly_limit_usd?: number
  monthly_limit_usd?: number
  rpm_limit?: number
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
export const groupsQueryOptions = () =>
  queryOptions({
    queryKey: ['panel', 'groups'],
    queryFn: () => api<{ items: CommercialGroup[] }>('/api/panel/groups'),
  })
