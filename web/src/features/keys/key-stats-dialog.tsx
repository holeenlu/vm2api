import { useQuery } from '@tanstack/react-query'
import type { ApiKeyItem } from '@/types/panel-keys'
import type { Vm, VmUsageStatsRank } from '@/types/panel-vm'
import {
  Boxes,
  Calculator,
  ClipboardList,
  Clock,
  Coins,
  Flame,
  Gauge,
  TrendingUp,
  Zap,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { fmtMs, fmtNum, fmtUsd } from '@/lib/format'
import { cacheHitPct } from '@/lib/vm-usage'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { keyStatsQueryOptions } from '@/features/keys/queries'
import {
  ChartCard,
  DistributionChart,
  EndpointBars,
  fmtTokens,
  InfoCard,
  MetricCard,
  TrendChart,
} from '@/features/vm/vm-stats-dialog'
import { summarizeUsageStats } from '@/features/vm/vm-stats-model'

/** 一把密钥近 30 天的用量。版式跟虚拟机「查看统计」相同，数据只含这把 key。 */
export function KeyStatsDialog({
  item,
  vms,
  onOpenChange,
}: {
  item: ApiKeyItem | null
  vms: Vm[]
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation('keys')

  return (
    <Dialog open={item != null} onOpenChange={onOpenChange}>
      <DialogContent className='flex max-h-[92vh] flex-col gap-3 sm:max-w-4xl'>
        <DialogHeader>
          <DialogTitle className='text-base'>
            {t('keys:viewStats')}
            {item ? (
              <span className='ms-2 font-normal'>{item.name || item.id}</span>
            ) : null}
          </DialogTitle>
          <DialogDescription className='sr-only'>
            {t('keys:statsDescription')}
          </DialogDescription>
        </DialogHeader>
        <div className='-me-3 min-h-0 flex-1 overflow-y-auto pe-3'>
          {item ? <StatsBody key={item.id} item={item} vms={vms} /> : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function StatsBody({ item, vms }: { item: ApiKeyItem; vms: Vm[] }) {
  const { t } = useTranslation('keys')

  const q = useQuery(keyStatsQueryOptions(item.id))
  const usage = q.data?.usage_stats ?? null
  const view = summarizeUsageStats(usage)
  const today = view?.summary.today
  const names = new Map(vms.map((vm) => [vm.id, vm.name || vm.email || vm.id]))
  const vmRows: VmUsageStatsRank[] = (usage?.vms ?? []).map((row) => ({
    ...row,
    name: names.get(row.name) || row.name,
  }))

  return (
    <div className='space-y-3 pb-1'>
      <div className='text-xs text-muted-foreground'>
        {t('keys:statsSubtitle', {
          group: item.group_name || t('keys:platformService'),
          count: usage?.days ?? 30,
        })}
      </div>
      {q.isLoading ? (
        <div className='space-y-3'>
          <div className='grid grid-cols-2 gap-3 lg:grid-cols-4'>
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className='h-24 rounded-xl' />
            ))}
          </div>
          <Skeleton className='h-64 rounded-xl' />
        </div>
      ) : !view ? (
        <div className='grid h-40 place-items-center rounded-xl border text-sm text-muted-foreground'>
          {t('keys:noStats')}
        </div>
      ) : (
        <>
          <div className='grid grid-cols-2 gap-3 lg:grid-cols-4'>
            <MetricCard
              accent='emerald'
              icon={<Coins />}
              label={t('keys:periodCost', { count: view.summary.days })}
              value={fmtUsd(view.summary.cost, 2)}
              hint={t('keys:thisKey')}
            />
            <MetricCard
              accent='blue'
              icon={<Zap />}
              label={t('keys:periodRequests', { count: view.summary.days })}
              value={fmtNum(view.summary.requests)}
              hint={
                view.summary.errors > 0
                  ? t('keys:failedRequests', { count: view.summary.errors })
                  : t('keys:allSuccessful')
              }
            />
            <MetricCard
              accent='amber'
              icon={<Calculator />}
              label={t('keys:averageDailyCost')}
              value={fmtUsd(view.summary.avgDailyCost, 2)}
              hint={t('keys:activeDayCount', {
                count: view.summary.activeDays,
              })}
            />
            <MetricCard
              accent='purple'
              icon={<TrendingUp />}
              label={t('keys:averageDailyRequests')}
              value={fmtNum(Math.round(view.summary.avgDailyRequests))}
              hint={t('keys:activeDayAverage')}
            />
          </div>
          <div className='grid gap-3 lg:grid-cols-3'>
            <InfoCard
              tone='bg-cyan-500/15 text-cyan-600 dark:text-cyan-400'
              icon={<Clock />}
              title={t('keys:todayOverview')}
              rows={[
                {
                  label: t('keys:cost'),
                  value: fmtUsd(today?.total_cost ?? 0, 2),
                },
                {
                  label: t('keys:requests'),
                  value: fmtNum(today?.requests ?? 0),
                },
                {
                  label: t('keys:tokens'),
                  value: fmtTokens(
                    (today?.input_tokens ?? 0) + (today?.output_tokens ?? 0)
                  ),
                },
                {
                  label: t('keys:cacheHits'),
                  value: fmtCache(today),
                },
              ]}
            />
            <InfoCard
              tone='bg-orange-500/15 text-orange-600 dark:text-orange-400'
              icon={<Flame />}
              title={t('keys:highestCostDay')}
              rows={[
                {
                  label: t('keys:date'),
                  value: view.summary.highestCost?.day ?? '-',
                },
                {
                  label: t('keys:cost'),
                  value: fmtUsd(view.summary.highestCost?.total_cost ?? 0, 2),
                  strong: 'text-orange-600 dark:text-orange-400',
                },
                {
                  label: t('keys:requests'),
                  value: fmtNum(view.summary.highestCost?.requests ?? 0),
                },
              ]}
            />
            <InfoCard
              tone='bg-indigo-500/15 text-indigo-600 dark:text-indigo-400'
              icon={<TrendingUp />}
              title={t('keys:mostRequestsDay')}
              rows={[
                {
                  label: t('keys:date'),
                  value: view.summary.highestRequests?.day ?? '-',
                },
                {
                  label: t('keys:requests'),
                  value: fmtNum(view.summary.highestRequests?.requests ?? 0),
                  strong: 'text-indigo-600 dark:text-indigo-400',
                },
                {
                  label: t('keys:cost'),
                  value: fmtUsd(
                    view.summary.highestRequests?.total_cost ?? 0,
                    2
                  ),
                },
              ]}
            />
          </div>
          <div className='grid gap-3 lg:grid-cols-3'>
            <InfoCard
              tone='bg-teal-500/15 text-teal-600 dark:text-teal-400'
              icon={<Boxes />}
              title={t('keys:totalTokens')}
              rows={[
                {
                  label: t('keys:total'),
                  value: fmtTokens(view.summary.tokens),
                },
                {
                  label: t('keys:dailyAverage'),
                  value: fmtTokens(Math.round(view.summary.avgDailyTokens)),
                },
              ]}
            />
            <InfoCard
              tone='bg-rose-500/15 text-rose-600 dark:text-rose-400'
              icon={<Gauge />}
              title={t('keys:performance')}
              rows={[
                {
                  label: t('keys:averageResponse'),
                  value:
                    view.summary.avgMs == null
                      ? '—'
                      : fmtMs(view.summary.avgMs),
                },
                {
                  label: t('keys:activeDays'),
                  value: `${view.summary.activeDays} / ${view.summary.days}`,
                },
              ]}
            />
            <InfoCard
              tone='bg-lime-500/15 text-lime-600 dark:text-lime-400'
              icon={<ClipboardList />}
              title={t('keys:weeklyResults')}
              rows={[
                {
                  label: t('keys:successful'),
                  value: fmtNum(
                    view.points
                      .slice(-7)
                      .reduce((n, p) => n + p.requests - p.errors, 0)
                  ),
                  strong: 'text-[color:var(--status-ok)]',
                },
                {
                  label: t('keys:failed'),
                  value: fmtNum(
                    view.points.slice(-7).reduce((n, p) => n + p.errors, 0)
                  ),
                  strong: 'text-[color:var(--status-bad)]',
                },
              ]}
            />
          </div>
          <ChartCard
            title={t('keys:usageTrend')}
            meta={t('keys:trendPeriod', { count: view.summary.days })}
          >
            <TrendChart points={view.points} />
          </ChartCard>
          <ChartCard
            title={t('keys:modelDistribution')}
            meta={t('keys:upstreamRequests')}
          >
            <DistributionChart
              rows={usage?.models ?? []}
              empty={t('keys:noRecentRequests')}
            />
          </ChartCard>
          <ChartCard
            title={t('keys:vmDistribution')}
            meta={t('keys:byRequests')}
          >
            <EndpointBars rows={vmRows} />
          </ChartCard>
        </>
      )}
    </div>
  )
}

function fmtCache(
  today:
    | {
        input_tokens: number
        cache_read_tokens: number
        cache_creation_tokens: number
      }
    | undefined
): string {
  if (!today) return '—'
  const pct = cacheHitPct(
    today.input_tokens,
    today.cache_read_tokens,
    today.cache_creation_tokens
  )
  if (pct == null) return '—'
  return `${pct.toFixed(pct >= 10 ? 1 : 2)}%`
}
