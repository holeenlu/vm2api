import { queryOptions } from '@tanstack/react-query'
import type { DatabaseMetricsPayload } from '@/types/panel-database'
import { api } from '@/lib/api'
import { panelQueryKeys } from '@/lib/query-keys'

export const DATABASE_METRICS_REFETCH_MS = 30_000

export function databaseMetricsQueryOptions() {
  return queryOptions({
    queryKey: panelQueryKeys.databaseMetrics(),
    queryFn: () => api<DatabaseMetricsPayload>('/api/panel/database/metrics'),
    refetchInterval: DATABASE_METRICS_REFETCH_MS,
    refetchOnWindowFocus: false,
  })
}
