import { queryOptions } from '@tanstack/react-query'
import type { PanelUsersPayload } from '@/types/panel-users'
import { api } from '@/lib/api'
import { panelQueryKeys } from '@/lib/query-keys'

export function usersQueryOptions() {
  return queryOptions({
    queryKey: panelQueryKeys.users(),
    queryFn: () => api<PanelUsersPayload>('/api/panel/users'),
  })
}
