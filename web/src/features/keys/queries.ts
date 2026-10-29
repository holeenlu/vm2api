import { queryOptions } from '@tanstack/react-query'
import type { ApiKeysPayload, KeyStatsPayload } from '@/types/panel-keys'
import { api } from '@/lib/api'

export function apiKeysQueryOptions(scope: 'all' | 'mine' = 'all') {
  return queryOptions({
    queryKey: ['panel', 'api-keys', scope] as const,
    queryFn: () => api<ApiKeysPayload>(`/api/panel/api-keys${scope === 'mine' ? '?scope=mine' : ''}`),
  })
}

export function keyStatsQueryOptions(id: string) {
  return queryOptions({
    queryKey: ['panel', 'api-keys', id, 'stats'] as const,
    queryFn: () =>
      api<KeyStatsPayload>(
        `/api/panel/api-keys/${encodeURIComponent(id)}/stats`
      ),
  })
}
