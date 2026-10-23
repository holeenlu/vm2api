import { useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { VIEW_DESCRIPTIONS, VIEW_TITLES } from '@/config/nav'
import { t, i18n } from '@/i18n'
import type { LeaderboardScope, StatsDimension } from '@/types/panel-statistics'
import { Activity, Clock, DollarSign, TrendingUp } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '@/stores/auth-store'
import { formatCurrency, formatDuration } from '@/lib/usage-format'
import { cn } from '@/lib/utils'
import { PageHeader } from '@/components/page-header'
import { QueryGate } from '@/components/query-gate'
import { meQueryOptions } from '@/features/auth/queries'
import { BentoGrid } from './bento'
import { LeaderboardCard } from './leaderboard-card'
import { LeaderboardSection } from './leaderboard-section'
import { LiveSessionsPanel } from './live-sessions-panel'
import { BentoMetricCard } from './metric-card'
import { usageOverviewQueryOptions } from './queries'
import { StatisticsChartCard } from './statistics-chart-card'
import { browserTimeZone, percentChange } from './stats-format'

const ADMIN_DIMENSIONS: StatsDimension[] = [
  'user',
  'key',
  'model',
  'group',
  'endpoint',
  'vm',
]
// user 角色只能看本人数据，后端对 user / vm 维度回 400。
const USER_DIMENSIONS: StatsDimension[] = ['key', 'model', 'group', 'endpoint']

const ADMIN_CARDS: { scope: LeaderboardScope; title: string }[] = [
  {
    scope: 'user',
    get title() {
      return t('statistics:userRanking')
    },
  },
  {
    scope: 'vm',
    get title() {
      return t('statistics:providerRanking')
    },
  },
  {
    scope: 'model',
    get title() {
      return t('statistics:modelRanking')
    },
  },
]
const USER_CARDS: { scope: LeaderboardScope; title: string }[] = [
  {
    scope: 'key',
    get title() {
      return t('statistics:keyRanking')
    },
  },
  {
    scope: 'model',
    get title() {
      return t('statistics:modelRanking')
    },
  },
]
const CARD_ACCENTS = ['primary', 'purple', 'blue'] as const

export function StatisticsPage() {
  useTranslation('statistics')

  const me = useQuery(meQueryOptions())
  return (
    <PageHeader
      title={VIEW_TITLES.statistics}
      description={VIEW_DESCRIPTIONS.statistics}
    >
      <QueryGate loading={me.isLoading} error={me.error}>
        <StatisticsDashboard isUser={me.data?.role === 'user'} />
      </QueryGate>
    </PageHeader>
  )
}

function StatisticsDashboard({ isUser }: { isUser: boolean }) {
  const { t } = useTranslation('statistics')

  const canSeeMoney = useAuthStore((s) => s.me?.role !== 'super')
  const [tz] = useState(browserTimeZone)
  const dimensions = isUser ? USER_DIMENSIONS : ADMIN_DIMENSIONS
  const cards = isUser ? USER_CARDS : ADMIN_CARDS
  const boardScopes = cards.map((card) => card.scope)
  const [boardScope, setBoardScope] = useState<LeaderboardScope>(boardScopes[0])
  const boardRef = useRef<HTMLDivElement>(null)
  const overview = useQuery(usageOverviewQueryOptions(tz)).data

  const openBoard = (scope: LeaderboardScope) => {
    setBoardScope(scope)
    boardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const vsYesterday = (value: number | null) =>
    value == null
      ? undefined
      : [{ value, label: t('statistics:comparedYesterday') }]
  const durationChange = percentChange(
    overview?.todayAvgDurationMs,
    overview?.yesterdayAvgDurationMs
  )

  return (
    <div className='space-y-6'>
      <BentoGrid>
        <BentoMetricCard
          title={t('statistics:activeSessions')}
          value={overview?.activeSessions ?? 0}
          formatter={(v) => Math.round(v).toLocaleString(i18n.language)}
          icon={Activity}
          accentColor='emerald'
          className='min-h-[120px]'
          comparisons={[
            { value: overview?.rpm ?? 0, label: 'RPM', isPercentage: false },
          ]}
        />
        <BentoMetricCard
          title={t('statistics:todayRequests')}
          value={overview?.todayRequests ?? 0}
          formatter={(v) => Math.round(v).toLocaleString(i18n.language)}
          icon={TrendingUp}
          accentColor='blue'
          className='min-h-[120px]'
          comparisons={vsYesterday(
            percentChange(overview?.todayRequests, overview?.yesterdayRequests)
          )}
        />
        {canSeeMoney && (
          <BentoMetricCard
            title={t('statistics:todayCost')}
            value={overview?.todayCost ?? 0}
            formatter={(v) => formatCurrency(v)}
            icon={DollarSign}
            accentColor='amber'
            className='min-h-[120px]'
            comparisons={vsYesterday(
              percentChange(overview?.todayCost, overview?.yesterdayCost)
            )}
          />
        )}
        <BentoMetricCard
          title={t('statistics:averageResponseTime')}
          value={overview?.todayAvgDurationMs ?? 0}
          formatter={(v) => formatDuration(Math.round(v))}
          icon={Clock}
          accentColor='purple'
          className='min-h-[120px]'
          // 响应时间变短是好事：取反让下降显示为绿色上箭头（与 hub 一致）。
          comparisons={vsYesterday(
            durationChange == null ? null : -durationChange
          )}
        />
      </BentoGrid>

      <StatisticsChartCard dimensions={dimensions} tz={tz} />

      <div
        className={cn(
          'grid grid-cols-1 gap-6 sm:grid-cols-2',
          isUser
            ? 'lg:grid-cols-[1fr_1fr_280px]'
            : 'lg:grid-cols-[1fr_1fr_1fr_280px]'
        )}
      >
        {cards.map((card, index) => (
          <LeaderboardCard
            key={card.scope}
            title={card.title}
            scope={card.scope}
            tz={tz}
            accentColor={CARD_ACCENTS[index]}
            onViewAll={() => openBoard(card.scope)}
          />
        ))}
        <LiveSessionsPanel className='min-h-[280px]' />
      </div>

      <div ref={boardRef} className='scroll-mt-20'>
        <LeaderboardSection
          scopes={boardScopes}
          tz={tz}
          scope={boardScope}
          onScopeChange={setBoardScope}
        />
      </div>
    </div>
  )
}
