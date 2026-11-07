import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { i18n } from '@/i18n'
import type { StatisticsData, StatsRange } from '@/types/panel-statistics'
import type { UsageLogsOverview } from '@/types/panel-usage-logs'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { SYSTEM_TIMEZONE_LABEL } from '@/lib/system-time'
import {
  formatCurrency,
  formatDuration,
  formatTokenAmount,
} from '@/lib/usage-format'
import { cn } from '@/lib/utils'
import { Skeleton } from '@/components/ui/skeleton'
import { BentoCard } from './bento'
import { statisticsQueryOptions, usageOverviewQueryOptions } from './queries'

type HistoryRange = Exclude<StatsRange, 'today'>

const HISTORY_RANGES: { id: HistoryRange; label: string }[] = [
  {
    id: '7days',
    get label() {
      return i18n.t('statistics:sevenDays')
    },
  },
  {
    id: '30days',
    get label() {
      return i18n.t('statistics:thirtyDays')
    },
  },
  {
    id: 'thisMonth',
    get label() {
      return i18n.t('statistics:thisMonth')
    },
  },
]

type UsageSnapshot = {
  requests: number
  errors: number
  cost: number
  tokens: number
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheCreation5mTokens: number
  cacheCreation1hTokens: number
  cacheReadTokens: number
  cacheHitRate: number
  avgDurationMs: number | null
  avgTtftMs: number | null
}

function hitClass(pct: number) {
  if (pct >= 85) return 'text-green-600 dark:text-green-400'
  if (pct >= 60) return 'text-yellow-600 dark:text-yellow-400'
  return 'text-orange-600 dark:text-orange-400'
}

function ttft(ms: number | null) {
  return ms && ms > 0
    ? `${Math.round(ms).toLocaleString(i18n.language)} ms`
    : '-'
}

function parameterRows(snapshot: UsageSnapshot, t: TFunction<'statistics'>) {
  const hit = snapshot.cacheHitRate * 100
  const count = (value: number) => value.toLocaleString(i18n.language)
  return [
    { label: t('requests'), value: count(snapshot.requests) },
    { label: t('failures'), value: count(snapshot.errors) },
    { label: t('cost'), value: formatCurrency(snapshot.cost) },
    { label: t('totalTokensShort'), value: formatTokenAmount(snapshot.tokens) },
    { label: t('inputTokens'), value: formatTokenAmount(snapshot.inputTokens) },
    {
      label: t('outputTokens'),
      value: formatTokenAmount(snapshot.outputTokens),
    },
    {
      label: t('cacheWrite'),
      value: formatTokenAmount(snapshot.cacheCreationTokens),
    },
    {
      label: t('cacheWrite5m'),
      value: formatTokenAmount(snapshot.cacheCreation5mTokens),
    },
    {
      label: t('cacheWrite1h'),
      value: formatTokenAmount(snapshot.cacheCreation1hTokens),
    },
    {
      label: t('cacheRead'),
      value: formatTokenAmount(snapshot.cacheReadTokens),
    },
    {
      label: t('cacheHitRate'),
      value: `${hit.toFixed(1)}%`,
      className: hitClass(hit),
    },
    {
      label: t('averageResponse'),
      value: formatDuration(snapshot.avgDurationMs),
    },
    { label: t('averageTtft'), value: ttft(snapshot.avgTtftMs) },
  ]
}

function fromOverview(overview: UsageLogsOverview): UsageSnapshot {
  return {
    requests: overview.todayRequests,
    errors: overview.todayErrors,
    cost: overview.todayCost,
    tokens: overview.todayTokens,
    inputTokens: overview.todayInputTokens,
    outputTokens: overview.todayOutputTokens,
    cacheCreationTokens: overview.todayCacheCreationTokens,
    cacheCreation5mTokens: overview.todayCacheCreation5mTokens,
    cacheCreation1hTokens: overview.todayCacheCreation1hTokens,
    cacheReadTokens: overview.todayCacheReadTokens,
    cacheHitRate: overview.todayCacheHitRate,
    avgDurationMs: overview.todayAvgDurationMs,
    avgTtftMs: overview.todayAvgTtftMs,
  }
}

function fromTotals(totals: StatisticsData['totals']): UsageSnapshot {
  return {
    requests: totals.requests,
    errors: totals.errors,
    cost: totals.cost,
    tokens: totals.tokens,
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    cacheCreationTokens: totals.cacheCreationTokens,
    cacheCreation5mTokens: totals.cacheCreation5mTokens,
    cacheCreation1hTokens: totals.cacheCreation1hTokens,
    cacheReadTokens: totals.cacheReadTokens,
    cacheHitRate: totals.cacheHitRate,
    avgDurationMs: totals.avgDurationMs,
    avgTtftMs: totals.avgTtftMs,
  }
}

function ParameterGrid({ snapshot }: { snapshot: UsageSnapshot }) {
  const { t } = useTranslation('statistics')
  return (
    <dl className='grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3'>
      {parameterRows(snapshot, t).map((row) => (
        <div key={row.label} className='min-w-0'>
          <dt className='text-xs text-muted-foreground'>{row.label}</dt>
          <dd
            className={cn(
              'truncate font-mono text-sm font-medium tabular-nums',
              row.className
            )}
          >
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  )
}

function LoadingGrid() {
  return (
    <div className='grid grid-cols-2 gap-3 sm:grid-cols-3'>
      {Array.from({ length: 6 }, (_, i) => (
        <Skeleton key={i} className='h-10' />
      ))}
    </div>
  )
}

/** 租户统计：今日明细，以及 7 天 / 30 天 / 本月的同一组参数。 */
export function TenantUsage({ tz }: { tz: string }) {
  const { t } = useTranslation('statistics')
  const [history, setHistory] = useState<HistoryRange>('7days')
  const overview = useQuery(usageOverviewQueryOptions(tz))
  const past = useQuery(statisticsQueryOptions(history, 'model', tz))
  const today = overview.data ? fromOverview(overview.data) : null
  const historySnapshot = past.data ? fromTotals(past.data.totals) : null

  return (
    <div className='grid gap-6 lg:grid-cols-2'>
      <BentoCard>
        <div className='mb-3'>
          <h3 className='text-sm font-semibold'>{t('todayUsage')}</h3>
          <p className='text-xs text-muted-foreground'>
            {t('todayUsageHint', { zone: SYSTEM_TIMEZONE_LABEL })}
          </p>
        </div>
        {today ? (
          <ParameterGrid snapshot={today} />
        ) : overview.isError ? (
          <p className='text-sm text-muted-foreground'>
            {t('todayUsageFailed')}
          </p>
        ) : (
          <LoadingGrid />
        )}
      </BentoCard>
      <BentoCard>
        <div className='mb-3 flex flex-wrap items-start justify-between gap-2'>
          <div>
            <h3 className='text-sm font-semibold'>{t('historyUsage')}</h3>
            <p className='text-xs text-muted-foreground'>
              {t('historyUsageHint')}
            </p>
          </div>
          <div className='inline-flex rounded-md border bg-muted/30 p-0.5'>
            {HISTORY_RANGES.map((item) => (
              <button
                key={item.id}
                type='button'
                aria-pressed={history === item.id}
                onClick={() => setHistory(item.id)}
                className={cn(
                  'cursor-pointer rounded px-2 py-1 text-xs font-medium',
                  history === item.id
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
        {historySnapshot ? (
          <ParameterGrid snapshot={historySnapshot} />
        ) : past.isError ? (
          <p className='text-sm text-muted-foreground'>
            {t('historyUsageFailed')}
          </p>
        ) : (
          <LoadingGrid />
        )}
      </BentoCard>
    </div>
  )
}
