import { queryOptions } from '@tanstack/react-query'
import type { ApiKeysPayload, KeyStatsPayload } from '@/types/panel-keys'
import { api } from '@/lib/api'
import { panelQueryKeys } from '@/lib/query-keys'

export function apiKeysQueryOptions(scope: 'all' | 'mine' = 'all') {
  return queryOptions({
    queryKey: panelQueryKeys.apiKeys(scope),
    queryFn: () =>
      api<ApiKeysPayload>(
        `/api/panel/api-keys${scope === 'mine' ? '?scope=mine' : ''}`
      ),
  })
}

export function keyStatsQueryOptions(id: string) {
  return queryOptions({
    queryKey: panelQueryKeys.apiKeyStats(id),
    queryFn: () =>
      api<KeyStatsPayload>(
        `/api/panel/api-keys/${encodeURIComponent(id)}/stats`
      ),
  })
}
