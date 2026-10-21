import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { UsageAccountRow } from '@/types/panel-usage'
import type { Vm, VmUsageStatsRank } from '@/types/panel-vm'
import {
  BarChart3,
  Calculator,
  ClipboardList,
  Clock,
  Coins,
  Flame,
  Gauge,
  TrendingUp,
  Zap,
} from 'lucide-react'
import { useTranslation, Trans } from 'react-i18next'
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { fmtMs, fmtNum, fmtUsd } from '@/lib/format'
import { cn } from '@/lib/utils'
import { accountStatus, vmRunning } from '@/lib/vm-status'
import { fmtHitPct, vmTodayStats, vmWeekOutcome } from '@/lib/vm-usage'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { SlotIdentity } from '@/components/platform-chip'
import { StatusMark } from '@/components/status-mark'
import { VmCostByModel } from '@/features/vm/detail-cost-by-model'
import { vmQueryOptions } from '@/features/vm/queries'
import { VmUsagePanel } from '@/features/vm/usage-windows'
import {
  summarizeUsageStats,
  type StatsDayPoint,
} from '@/features/vm/vm-stats-model'

/** tokens 量级大，K / M / B 缩写比千分位好读。 */
export function fmtTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(2)}K`
  return fmtNum(n)
}

const PALETTE = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
  'oklch(0.66 0.12 200)',
  'oklch(0.62 0.13 290)',
  'oklch(0.7 0.1 130)',
]

const ACCENT = {
  emerald: {
    card: 'border-emerald-500/30 from-emerald-500/12',
    icon: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  },
  blue: {
    card: 'border-blue-500/30 from-blue-500/12',
    icon: 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
  },
  amber: {
    card: 'border-amber-500/30 from-amber-500/12',
    icon: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  },
  purple: {
    card: 'border-purple-500/30 from-purple-500/12',
    icon: 'bg-purple-500/15 text-purple-600 dark:text-purple-400',
  },
} as const

/** 顶部四张渐变指标卡：大数字 + 一行口径说明。 */
export function MetricCard({
  accent,
  icon,
  label,
  value,
  hint,
}: {
  accent: keyof typeof ACCENT
  icon: ReactNode
  label: string
  value: string
  hint: string
}) {
  useTranslation('vm')

  const tone = ACCENT[accent]
  return (
    <div
      className={cn(
        'min-w-0 rounded-xl border bg-gradient-to-br to-transparent p-3.5',
        tone.card
      )}
    >
      <div className='mb-1.5 flex items-center justify-between gap-2'>
        <span className='truncate text-xs font-medium text-muted-foreground'>
          {label}
        </span>
        <span className={cn('rounded-lg p-1.5 [&_svg]:size-4', tone.icon)}>
          {icon}
        </span>
      </div>
      <p className='truncate text-2xl leading-tight font-bold tabular-nums'>
        {value}
      </p>
      <p className='mt-1 truncate text-[11px] text-muted-foreground'>{hint}</p>
    </div>
  )
}

/** 带彩色图标头的信息卡，行内左标签右数值。 */
export function InfoCard({
  tone,
  icon,
  title,
  rows,
}: {
  tone: string
  icon: ReactNode
  title: string
  rows: { label: string; value: ReactNode; strong?: string }[]
}) {
  useTranslation('vm')

  return (
    <section className='min-w-0 rounded-xl border bg-card p-3.5'>
      <div className='mb-2.5 flex items-center gap-2'>
        <span className={cn('rounded-lg p-1.5 [&_svg]:size-4', tone)}>
          {icon}
        </span>
        <h3 className='text-sm font-semibold'>{title}</h3>
      </div>
      <dl className='space-y-1.5'>
        {rows.map((row) => (
          <div
            key={row.label}
            className='flex items-center justify-between gap-3'
          >
            <dt className='text-xs text-muted-foreground'>{row.label}</dt>
            <dd
              className={cn(
                'truncate text-sm font-semibold tabular-nums',
                row.strong
              )}
            >
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

export function ChartCard({
  title,
  meta,
  children,
}: {
  title: string
  meta?: string
  children: ReactNode
}) {
  useTranslation('vm')

  return (
    <section className='min-w-0 rounded-xl border bg-card p-3.5'>
      <div className='mb-3 flex items-baseline justify-between gap-2'>
        <h3 className='text-sm font-semibold'>{title}</h3>
        {meta ? (
          <span className='text-[11px] text-muted-foreground'>{meta}</span>
        ) : null}
      </div>
      {children}
    </section>
  )
}

function TrendTip({
  active,
  payload,
}: {
  active?: boolean
  payload?: { payload: StatsDayPoint }[]
}) {
  useTranslation('vm')

  const p = active ? payload?.[0]?.payload : undefined
  if (!p) return null
  return (
    <div className='rounded-lg border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md'>
      <div className='font-medium'>{p.day}</div>
      <dl className='mt-1.5 space-y-0.5 tabular-nums'>
        <div className='flex justify-between gap-4'>
          <dt className='text-muted-foreground'>
            <Trans ns='vm' i18nKey='detailCostByModel.cost' />
          </dt>
          <dd className='font-medium'>{fmtUsd(p.total_cost, 2)}</dd>
        </div>
        <div className='flex justify-between gap-4'>
          <dt className='text-muted-foreground'>
            <Trans ns='vm' i18nKey='detailAccountTab.requests' />
          </dt>
          <dd className='font-medium'>{fmtNum(p.requests)}</dd>
        </div>
        {p.errors > 0 ? (
          <div className='flex justify-between gap-4'>
            <dt className='text-muted-foreground'>
              <Trans ns='vm' i18nKey='officialCcCard.error' />
            </dt>
            <dd className='font-medium' style={{ color: 'var(--status-bad)' }}>
              {fmtNum(p.errors)}
            </dd>
          </div>
        ) : null}
        <div className='flex justify-between gap-4'>
          <dt className='text-muted-foreground'>
            <Trans ns='vm' i18nKey='labels.tokens' />
          </dt>
          <dd>{fmtTokens(p.input_tokens + p.output_tokens)}</dd>
        </div>
      </dl>
    </div>
  )
}

/** 双轴趋势：面积是费用（左轴），折线是请求数（右轴）。 */
export function TrendChart({ points }: { points: StatsDayPoint[] }) {
  const { t: tVm } = useTranslation('vm')

  return (
    <div className='h-60'>
      <ResponsiveContainer width='100%' height='100%'>
        <ComposedChart
          data={points}
          margin={{ top: 6, right: 4, bottom: 0, left: 0 }}
        >
          <defs>
            <linearGradient id='vm-stats-cost' x1='0' y1='0' x2='0' y2='1'>
              <stop offset='0%' stopColor='var(--chart-2)' stopOpacity={0.35} />
              <stop offset='100%' stopColor='var(--chart-2)' stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid
            vertical={false}
            stroke='var(--border)'
            strokeOpacity={0.6}
          />
          <XAxis
            dataKey='label'
            tickLine={false}
            axisLine={false}
            interval='preserveStartEnd'
            minTickGap={24}
            tick={{ fontSize: 10.5, fill: 'var(--muted-foreground)' }}
          />
          <YAxis
            yAxisId='cost'
            tickLine={false}
            axisLine={false}
            width={44}
            tickFormatter={(v: number) => fmtUsd(v, v >= 10 ? 0 : 2)}
            tick={{ fontSize: 10.5, fill: 'var(--chart-2)' }}
          />
          <YAxis
            yAxisId='req'
            orientation='right'
            allowDecimals={false}
            tickLine={false}
            axisLine={false}
            width={40}
            tickFormatter={(v: number) => fmtNum(v)}
            tick={{ fontSize: 10.5, fill: 'var(--chart-4)' }}
          />
          <ChartTooltip
            content={<TrendTip />}
            cursor={{ stroke: 'var(--border)' }}
            isAnimationActive={false}
          />
          <Area
            yAxisId='cost'
            type='linear'
            dataKey='total_cost'
            name={tVm('vm:detailCostByModel.cost')}
            stroke='var(--chart-2)'
            strokeWidth={2}
            fill='url(#vm-stats-cost)'
            dot={false}
            isAnimationActive={false}
          />
          <Line
            yAxisId='req'
            type='linear'
            dataKey='requests'
            name={tVm('vm:detailAccountTab.requests')}
            stroke='var(--chart-4)'
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
      <div className='-mt-1 flex justify-center gap-4 text-[11px] text-muted-foreground'>
        <span className='inline-flex items-center gap-1.5'>
          <Trans
            ns='vm'
            i18nKey='vmStatsDialog.costUSD'
            components={{
              part0: (
                <span
                  className='size-2 rounded-full'
                  style={{ background: 'var(--chart-2)' }}
                />
              ),
            }}
          />
        </span>
        <span className='inline-flex items-center gap-1.5'>
          <Trans
            ns='vm'
            i18nKey='vmStatsDialog.requests'
            components={{
              part0: (
                <span
                  className='size-2 rounded-full'
                  style={{ background: 'var(--chart-4)' }}
                />
              ),
            }}
          />
        </span>
      </div>
    </div>
  )
}

/** 环形图 + 右侧明细表：占比按请求数，表里同时给 tokens 与费用。 */
export function DistributionChart({
  rows,
  empty,
}: {
  rows: VmUsageStatsRank[]
  empty: string
}) {
  const { t: tVm } = useTranslation('vm')

  const total = rows.reduce((n, r) => n + r.requests, 0)
  if (total === 0) {
    return (
      <div className='grid h-32 place-items-center text-sm text-muted-foreground'>
        {empty}
      </div>
    )
  }
  const data = rows.map((r, i) => ({
    ...r,
    fill: PALETTE[i % PALETTE.length],
  }))
  return (
    <div className='grid items-center gap-3 md:grid-cols-[10rem_1fr]'>
      <div className='mx-auto h-40 w-40'>
        <ResponsiveContainer width='100%' height='100%'>
          <PieChart>
            <Pie
              data={data}
              dataKey='requests'
              nameKey='name'
              innerRadius='58%'
              outerRadius='92%'
              paddingAngle={1.5}
              stroke='var(--card)'
              strokeWidth={2}
              isAnimationActive={false}
            />
            <ChartTooltip
              isAnimationActive={false}
              formatter={(v, _n, item) => [
                tVm('vm:vmStatsDialog.requestsAlternative', {
                  value1: fmtNum(Number(v)),
                  value2: ((Number(v) / total) * 100).toFixed(1),
                  count: Number(v),
                }),
                String(item?.payload?.name ?? ''),
              ]}
              contentStyle={{
                fontSize: 12,
                borderRadius: 8,
                background: 'var(--popover)',
                border: '1px solid var(--border)',
                color: 'var(--popover-foreground)',
              }}
            />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <div className='min-w-0 overflow-x-auto'>
        <table className='w-full text-xs'>
          <thead>
            <tr className='text-muted-foreground'>
              <th className='pb-1.5 text-left font-medium'>
                <Trans ns='vm' i18nKey='createVmForm.name' />
              </th>
              <th className='pb-1.5 text-right font-medium'>
                <Trans ns='vm' i18nKey='detailAccountTab.requests' />
              </th>
              <th className='pb-1.5 text-right font-medium'>
                <Trans ns='vm' i18nKey='labels.tokens' />
              </th>
              <th className='pb-1.5 text-right font-medium'>
                <Trans ns='vm' i18nKey='detailCostByModel.cost' />
              </th>
              <th className='pb-1.5 text-right font-medium'>
                <Trans ns='vm' i18nKey='vmStatsDialog.share' />
              </th>
            </tr>
          </thead>
          <tbody className='tabular-nums'>
            {data.map((r) => (
              <tr key={r.name} className='border-t border-border/50'>
                <td className='max-w-[14rem] py-1'>
                  <span className='flex items-center gap-1.5'>
                    <span
                      className='size-2 shrink-0 rounded-full'
                      style={{ background: r.fill }}
                    />
                    <span className='truncate' title={r.name}>
                      {r.name}
                    </span>
                  </span>
                </td>
                <td className='py-1 text-right'>{fmtNum(r.requests)}</td>
                <td className='py-1 text-right'>{fmtTokens(r.tokens)}</td>
                <td className='py-1 text-right'>{fmtUsd(r.total_cost, 2)}</td>
                <td className='py-1 text-right text-muted-foreground'>
                  {((r.requests / total) * 100).toFixed(1)}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** 入站路径分布：横向条比表格更容易一眼看出主次。 */
export function EndpointBars({ rows }: { rows: VmUsageStatsRank[] }) {
  useTranslation('vm')

  const max = Math.max(1, ...rows.map((r) => r.requests))
  if (!rows.length) {
    return (
      <div className='grid h-20 place-items-center text-sm text-muted-foreground'>
        <Trans ns='vm' i18nKey='vmStatsDialog.noRequestsYet' />
      </div>
    )
  }
  return (
    <ul className='space-y-2'>
      {rows.map((r, i) => (
        <li key={r.name} className='min-w-0'>
          <div className='mb-0.5 flex items-baseline justify-between gap-2 text-xs'>
            <span className='truncate font-mono' title={r.name}>
              {r.name}
            </span>
            <span className='shrink-0 text-muted-foreground tabular-nums'>
              <Trans
                ns='vm'
                i18nKey='vmStatsDialog.requestsAlternativeWithformattedNumFormattedUsd'
                values={{
                  formattedNum: fmtNum(r.requests),
                  formattedUsd: fmtUsd(r.total_cost, 2),
                }}
                count={r.requests}
              />
            </span>
          </div>
          <div className='h-1.5 overflow-hidden rounded-full bg-muted'>
            <div
              className='h-full rounded-full'
              style={{
                width: `${Math.max(2, (r.requests / max) * 100)}%`,
                background: PALETTE[i % PALETTE.length],
              }}
            />
          </div>
        </li>
      ))}
    </ul>
  )
}

function StatsBody({ vm, accounts }: { vm: Vm; accounts?: UsageAccountRow[] }) {
  const { t: tVm } = useTranslation('vm')

  const detail = useQuery(vmQueryOptions(vm.id))
  const billing = detail.data?.billing
  const usage = billing?.usage_stats ?? null
  const view = summarizeUsageStats(usage)
  const today = vmTodayStats(vm, accounts)
  const week = vmWeekOutcome(vm, accounts)

  return (
    <div className='space-y-3 pb-1'>
      <div className='flex items-center justify-between gap-3 rounded-xl border border-primary/25 bg-gradient-to-r from-primary/10 to-transparent p-3'>
        <div className='flex min-w-0 items-center gap-3'>
          <span className='grid size-10 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground'>
            <BarChart3 className='size-5' />
          </span>
          <div className='min-w-0'>
            <div className='truncate font-semibold'>
              {vm.name || vm.email || vm.id}
            </div>
            <div className='text-xs text-muted-foreground'>
              <Trans
                ns='vm'
                i18nKey='vmStatsDialog.usageOverDaysOfficialPricing'
                values={{ value: usage?.days ?? 30 }}
                count={usage?.days ?? 30}
              />
            </div>
          </div>
        </div>
        <div className='flex shrink-0 items-center gap-1.5'>
          <StatusMark tone={accountStatus(vm)} variant='pill' />
          <span className='text-xs text-muted-foreground'>
            {vmRunning(vm)
              ? tVm('vm:detailPage.running')
              : tVm('vm:detailPage.stop')}
          </span>
        </div>
      </div>

      <section className='rounded-xl border bg-card px-3.5 py-3'>
        <VmUsagePanel vm={vm} accounts={accounts} />
      </section>

      {detail.isLoading ? (
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
          <Trans ns='vm' i18nKey='vmStatsDialog.noStatisticsYet' />
        </div>
      ) : (
        <>
          <div className='grid grid-cols-2 gap-3 lg:grid-cols-4'>
            <MetricCard
              accent='emerald'
              icon={<Coins />}
              label={tVm('vm:vmStatsDialog.dayCost', {
                days: view.summary.days,
              })}
              value={fmtUsd(view.summary.cost, 2)}
              hint={tVm('vm:vmStatsDialog.requestsOnOfDays', {
                activeDays: view.summary.activeDays,
                days: view.summary.days,
                count: view.summary.days,
              })}
            />
            <MetricCard
              accent='blue'
              icon={<Zap />}
              label={tVm('vm:vmStatsDialog.dayRequests', {
                days: view.summary.days,
              })}
              value={fmtNum(view.summary.requests)}
              hint={
                view.summary.errors > 0
                  ? tVm('vm:vmStatsDialog.includesFailures', {
                      value1: fmtNum(view.summary.errors),
                      count: view.summary.errors,
                    })
                  : tVm('vm:vmStatsDialog.allSucceeded')
              }
            />
            <MetricCard
              accent='amber'
              icon={<Calculator />}
              label={tVm('vm:vmStatsDialog.averageDailyCost')}
              value={fmtUsd(view.summary.avgDailyCost, 2)}
              hint={tVm('vm:vmStatsDialog.acrossActiveDays', {
                activeDays: view.summary.activeDays,
                count: view.summary.activeDays,
              })}
            />
            <MetricCard
              accent='purple'
              icon={<TrendingUp />}
              label={tVm('vm:vmStatsDialog.averageDailyRequests')}
              value={fmtNum(Math.round(view.summary.avgDailyRequests))}
              hint={tVm('vm:vmStatsDialog.averagePerActiveDay')}
            />
          </div>

          <div className='grid gap-3 lg:grid-cols-3'>
            <InfoCard
              tone='bg-cyan-500/15 text-cyan-600 dark:text-cyan-400'
              icon={<Clock />}
              title={tVm('vm:vmStatsDialog.todaySOverview')}
              rows={[
                {
                  label: tVm('vm:detailCostByModel.cost'),
                  value: fmtUsd(today.today, 2),
                },
                {
                  label: tVm('vm:detailAccountTab.requests'),
                  value: fmtNum(today.req),
                },
                { label: tVm('vm:labels.tokens'), value: fmtTokens(today.tok) },
                {
                  label: tVm('vm:detailAccountTab.cacheHit'),
                  value: fmtHitPct(today.hit),
                },
              ]}
            />
            <InfoCard
              tone='bg-orange-500/15 text-orange-600 dark:text-orange-400'
              icon={<Flame />}
              title={tVm('vm:vmStatsDialog.highestCostDay')}
              rows={[
                {
                  label: tVm('vm:vmStatsDialog.date'),
                  value: view.summary.highestCost?.day ?? '-',
                },
                {
                  label: tVm('vm:detailCostByModel.cost'),
                  value: fmtUsd(view.summary.highestCost?.total_cost ?? 0, 2),
                  strong: 'text-orange-600 dark:text-orange-400',
                },
                {
                  label: tVm('vm:detailAccountTab.requests'),
                  value: fmtNum(view.summary.highestCost?.requests ?? 0),
                },
              ]}
            />
            <InfoCard
              tone='bg-indigo-500/15 text-indigo-600 dark:text-indigo-400'
              icon={<TrendingUp />}
              title={tVm('vm:vmStatsDialog.mostRequestedDay')}
              rows={[
                {
                  label: tVm('vm:vmStatsDialog.date'),
                  value: view.summary.highestRequests?.day ?? '-',
                },
                {
                  label: tVm('vm:detailAccountTab.requests'),
                  value: fmtNum(view.summary.highestRequests?.requests ?? 0),
                  strong: 'text-indigo-600 dark:text-indigo-400',
                },
                {
                  label: tVm('vm:detailCostByModel.cost'),
                  value: fmtUsd(
                    view.summary.highestRequests?.total_cost ?? 0,
                    2
                  ),
                },
              ]}
            />
          </div>

          <div className='grid gap-3 lg:grid-cols-2'>
            <InfoCard
              tone='bg-rose-500/15 text-rose-600 dark:text-rose-400'
              icon={<Gauge />}
              title={tVm('vm:vmStatsDialog.performance')}
              rows={[
                {
                  label: tVm('vm:vmStatsDialog.averageResponse'),
                  value:
                    view.summary.avgMs == null
                      ? '—'
                      : fmtMs(view.summary.avgMs),
                },
                {
                  label: tVm('vm:vmStatsDialog.activeDays'),
                  value: `${view.summary.activeDays} / ${view.summary.days}`,
                },
              ]}
            />
            <InfoCard
              tone='bg-lime-500/15 text-lime-600 dark:text-lime-400'
              icon={<ClipboardList />}
              title={tVm('vm:vmDetailCard.7DayRequests')}
              rows={[
                {
                  label: tVm('vm:testChatResultCard.succeeded'),
                  value: week.known ? fmtNum(week.success) : '—',
                  strong: 'text-[color:var(--status-ok)]',
                },
                {
                  label: tVm('vm:officialCcCard.failed'),
                  value: week.known ? fmtNum(week.fail) : '—',
                  strong: 'text-[color:var(--status-bad)]',
                },
              ]}
            />
          </div>

          <ChartCard
            title={tVm('vm:vmStatsDialog.usageTrend')}
            meta={tVm('vm:vmStatsDialog.lastDaysShanghaiCalendarDays', {
              days: view.summary.days,
              count: view.summary.days,
            })}
          >
            <TrendChart points={view.points} />
          </ChartCard>

          <ChartCard
            title={tVm('vm:vmStatsDialog.modelDistribution')}
            meta={tVm('vm:vmStatsDialog.byRequestCountUpstreamModels')}
          >
            <DistributionChart
              rows={usage?.models ?? []}
              empty={tVm('vm:vmStatsDialog.noRecentRequests')}
            />
          </ChartCard>

          <ChartCard
            title={tVm('vm:vmStatsDialog.inboundEndpointDistribution')}
            meta={tVm('vm:vmStatsDialog.byRequestPath')}
          >
            <EndpointBars rows={usage?.endpoints ?? []} />
          </ChartCard>
        </>
      )}
      <VmCostByModel rows={billing?.by_model} compact />
    </div>
  )
}

/** 查看统计：近 30 天用量的可视化面板，版式参照 sub2api 的 AccountStatsModal。 */
export function VmStatsDialog({
  vm,
  accounts,
  onOpenChange,
}: {
  vm: Vm | null
  accounts?: UsageAccountRow[]
  onOpenChange: (open: boolean) => void
}) {
  useTranslation('vm')

  return (
    <Dialog open={vm != null} onOpenChange={onOpenChange}>
      <DialogContent className='flex max-h-[92vh] flex-col gap-3 sm:max-w-4xl'>
        <DialogHeader>
          <DialogTitle className='flex items-center gap-2 text-base'>
            <Trans
              ns='vm'
              i18nKey='vmStatsDialog.viewStatistics'
              components={{
                part0: <>{vm ? <SlotIdentity vm={vm} compact /> : null}</>,
              }}
            />
          </DialogTitle>
          <DialogDescription className='sr-only'>
            <Trans
              ns='vm'
              i18nKey='vmStatsDialog.usageCostAndDistributionOverTheLast30Days'
            />
          </DialogDescription>
        </DialogHeader>
        <div className='-me-3 min-h-0 flex-1 overflow-y-auto pe-3'>
          {vm ? <StatsBody key={vm.id} vm={vm} accounts={accounts} /> : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
