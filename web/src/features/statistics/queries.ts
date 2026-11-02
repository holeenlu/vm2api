import { keepPreviousData, queryOptions } from '@tanstack/react-query'
import type {
  LeaderboardData,
  LeaderboardScope,
  StatisticsData,
  StatsDimension,
  StatsRange,
} from '@/types/panel-statistics'
import type {
  ActiveSessionsData,
  UsageLogsOverview,
} from '@/types/panel-usage-logs'
import { api } from '@/lib/api'
import { panelQueryKeys } from '@/lib/query-keys'

export function usageOverviewQueryOptions(tz: string) {
  return queryOptions({
    queryKey: panelQueryKeys.statsOverview(tz),
    queryFn: () =>
      api<UsageLogsOverview>(
        `/api/panel/usage-logs/overview?tz=${encodeURIComponent(tz)}`
      ),
    refetchInterval: 15_000,
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  })
}

export function statisticsQueryOptions(
  range: StatsRange,
  dimension: StatsDimension,
  tz: string
) {
  return queryOptions({
    queryKey: panelQueryKeys.statsChart(range, dimension, tz),
    queryFn: () => {
      const qs = new URLSearchParams({ range, dimension, tz })
      return api<StatisticsData>(`/api/panel/statistics?${qs.toString()}`)
    },
    staleTime: 30_000,
    placeholderData: keepPreviousData,
    refetchInterval: 5000,
    refetchOnWindowFocus: false,
  })
}

export function leaderboardQueryOptions(
  range: StatsRange,
  scope: LeaderboardScope,
  limit: number,
  tz: string
) {
  return queryOptions({
    queryKey: panelQueryKeys.statsLeaderboard(range, scope, limit, tz),
    queryFn: () => {
      const qs = new URLSearchParams({
        range,
        scope,
        limit: String(limit),
        tz,
      })
      return api<LeaderboardData>(
        `/api/panel/statistics/leaderboard?${qs.toString()}`
      )
    },
    staleTime: 60_000,
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: false,
  })
}

export function activeSessionsQueryOptions(minutes = 5, limit = 12) {
  return queryOptions({
    queryKey: panelQueryKeys.activeSessions(minutes, limit),
    queryFn: () =>
      api<ActiveSessionsData>(
        `/api/panel/usage-logs/active-sessions?minutes=${minutes}&limit=${limit}`
      ),
    refetchInterval: 5000,
    refetchOnWindowFocus: false,
  })
}
