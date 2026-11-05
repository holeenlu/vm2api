import { queryOptions } from '@tanstack/react-query'
import type { MeResponse } from '@/types/panel-auth'
import { api } from '@/lib/api'
import { panelQueryKeys } from '@/lib/query-keys'

export function meQueryOptions(enabled = true) {
  return queryOptions({
    queryKey: panelQueryKeys.me(),
    queryFn: () => api<MeResponse>('/api/panel/me'),
    enabled,
    retry: false,
  })
}
