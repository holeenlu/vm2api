import { queryOptions } from '@tanstack/react-query'
import type { ApiEndpointsPayload } from '@/types/panel-api-endpoints'
import { api } from '@/lib/api'
import { panelQueryKeys } from '@/lib/query-keys'

export function apiEndpointsQueryOptions() {
  return queryOptions({
    queryKey: panelQueryKeys.apiEndpoints(),
    queryFn: () => api<ApiEndpointsPayload>('/api/panel/api-endpoints'),
  })
}
