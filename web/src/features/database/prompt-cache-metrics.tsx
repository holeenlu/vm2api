import type { RequestLogStats, StatsBucket } from '@/types/panel-overview'
import { useTranslation } from 'react-i18next'
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { fmtNum } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/empty-state'
import { errorMessage } from '@/components/query-gate'
import { PanelCard, StatCell } from '@/features/overview/panel-card'
import { formatMetricPercent, promptCacheRate } from './metrics'

export type PromptCacheWindow = '1h' | '6h' | '24h'

type PromptPoint = {
  key: string
  label: string
  cacheRate: number | null
  cacheRatePct: number | null
  input: number
  read: number
  creation: number
}

const WINDOW_HOURS: Record<PromptCacheWindow, number> = {
  '1h': 1,
  '6h': 6,
  '24h': 24,
}

function promptPoints(
  buckets: StatsBucket[],
  window: PromptCacheWindow
): PromptPoint[] {
  const map = new Map(buckets.map((bucket) => [bucket.bucket, bucket]))
  const base = Math.floor(Date.now() / 3_600_000) * 3_600_000
  const points: PromptPoint[] = []
  for (let index = WINDOW_HOURS[window]; index >= 0; index -= 1) {
    const date = new Date(base - index * 3_600_000)
    const key = `${date.toISOString().slice(0, 13)}:00`
    const bucket = map.get(key)
    const input = Number(bucket?.input_tokens || 0)
    const read = Number(bucket?.cache_read_tokens || 0)
    const creation = Number(bucket?.cache_creation_tokens || 0)
    const cacheRate = promptCacheRate({ input, read, creation })
    points.push({
      key,
      label: `${String(date.getHours()).padStart(2, '0')}:00`,
      cacheRate,
      cacheRatePct: cacheRate == null ? null : cacheRate * 100,
      input,
      read,
      creation,
    })
  }
  return points
}

function PromptTip({
  active,
  payload,
}: {
  active?: boolean
  payload?: { payload: PromptPoint }[]
}) {
  const { t } = useTranslation('database')

  const point = active ? payload?.[0]?.payload : undefined
  if (!point) return null
  return (
    <div className='rounded-lg border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md'>
      <div className='font-medium'>{point.label}</div>
      <dl className='mt-1.5 space-y-0.5 tabular-nums'>
        <div className='flex justify-between gap-4'>
          <dt className='text-muted-foreground'>{t('hitRate')}</dt>
          <dd>{formatMetricPercent(point.cacheRate)}</dd>
        </div>
        <div className='flex justify-between gap-4'>
          <dt className='text-muted-foreground'>{t('readWrite')}</dt>
          <dd>
            {fmtNum(point.read)} / {fmtNum(point.creation)}
          </dd>
        </div>
        <div className='flex justify-between gap-4'>
          <dt className='text-muted-foreground'>{t('input')}</dt>
          <dd>{fmtNum(point.input)}</dd>
        </div>
      </dl>
    </div>
  )
}

export function PromptCacheMetricsPanel({
  stats,
  loading,
  error,
  window,
  onWindowChange,
}: {
  stats?: RequestLogStats
  loading: boolean
  error: unknown
  window: PromptCacheWindow
  onWindowChange: (window: PromptCacheWindow) => void
}) {
  const { t } = useTranslation('database')

  const input = Number(stats?.window?.input_tokens || 0)
  const read = Number(stats?.window?.cache_read_tokens || 0)
  const creation = Number(stats?.window?.cache_creation_tokens || 0)
  const rate = promptCacheRate({ input, read, creation })
  const points = promptPoints(stats?.buckets || [], window)
  const hasRate = points.some((point) => point.cacheRate != null)

  return (
    <PanelCard
      title={t('promptCache')}
      meta={t('hourlyLogs')}
      action={
        <div className='flex items-center gap-1' aria-label={t('promptWindow')}>
          {(['1h', '6h', '24h'] as const).map((item) => (
            <Button
              key={item}
              type='button'
              size='sm'
              variant={window === item ? 'secondary' : 'ghost'}
              aria-pressed={window === item}
              onClick={() => onWindowChange(item)}
              className='h-7 min-w-10 px-2 text-xs'
            >
              {item}
            </Button>
          ))}
        </div>
      }
    >
      {loading ? (
        <div
          className='space-y-4 p-4'
          role='status'
          aria-label={t('loadingPrompt')}
        >
          <div className='grid grid-cols-2 gap-3 sm:grid-cols-4'>
            {Array.from({ length: 4 }).map((_, index) => (
              <Skeleton key={index} className='h-16' />
            ))}
          </div>
          <Skeleton className='h-56' />
        </div>
      ) : error ? (
        <div className='px-4 py-8 text-center text-sm text-muted-foreground'>
          {t('promptLoadFailed', { value1: errorMessage(error) })}
        </div>
      ) : (
        <>
          <div className='grid grid-cols-2 gap-px bg-border/60 sm:grid-cols-4'>
            <StatCell
              label={t('cacheHitRate')}
              value={formatMetricPercent(rate)}
              hint={t('hitRateFormula')}
            />
            <StatCell
              label={t('cacheRead')}
              value={fmtNum(read)}
              hint={t('readTokens')}
            />
            <StatCell
              label={t('cacheWrite')}
              value={fmtNum(creation)}
              hint={t('creationTokens')}
            />
            <StatCell
              label={t('promptTotal')}
              value={fmtNum(input + read + creation)}
              hint={t('windowLabel', { value1: window })}
            />
          </div>

          <div className='min-h-[240px] border-t px-2 pt-4 pb-2'>
            {hasRate ? (
              <ResponsiveContainer width='100%' height='100%' minHeight={224}>
                <LineChart
                  data={points}
                  margin={{ top: 4, right: 12, bottom: 0, left: -8 }}
                >
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
                    domain={[0, 100]}
                    tickLine={false}
                    axisLine={false}
                    width={44}
                    tickFormatter={(value: number) => `${value}%`}
                    tick={{ fontSize: 10.5, fill: 'var(--muted-foreground)' }}
                  />
                  <Tooltip content={<PromptTip />} isAnimationActive={false} />
                  <Line
                    type='monotone'
                    dataKey='cacheRatePct'
                    stroke='var(--chart-1)'
                    strokeWidth={2}
                    dot={{ r: 2.5, fill: 'var(--chart-1)', strokeWidth: 0 }}
                    activeDot={{ r: 4 }}
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className='grid min-h-[224px] place-items-center'>
                <EmptyState reason={t('noPromptTokens')} />
              </div>
            )}
          </div>
        </>
      )}
    </PanelCard>
  )
}
