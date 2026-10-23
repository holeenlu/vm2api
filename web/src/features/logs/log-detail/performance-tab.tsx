import { t as translate } from '@/i18n'
import type { UsageLogRow } from '@/types/panel-usage-logs'
import { Clock, Gauge, Zap } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  calculateOutputRate,
  formatTokenAmount,
  shouldHideOutputRate,
} from '@/lib/usage-format'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { CircularProgress } from '@/components/ui/circular-progress'
import { formatDuration } from '@/features/logs/display-time'
import { queueWaitMs } from '../log-display'
import { LatencyBreakdownBar } from './latency-breakdown-bar'

type Assessment = { label: string; color: string; bg: string }

const ASSESSMENTS: Record<
  'excellent' | 'good' | 'warning' | 'poor',
  Assessment
> = {
  excellent: {
    get label() {
      return translate('logs:excellent')
    },
    color: 'text-emerald-600',
    bg: 'bg-emerald-50 dark:bg-emerald-950/20',
  },
  good: {
    get label() {
      return translate('logs:good')
    },
    color: 'text-blue-600',
    bg: 'bg-blue-50 dark:bg-blue-950/20',
  },
  warning: {
    get label() {
      return translate('logs:warning')
    },
    color: 'text-amber-600',
    bg: 'bg-amber-50 dark:bg-amber-950/20',
  },
  poor: {
    get label() {
      return translate('logs:poor')
    },
    color: 'text-rose-600',
    bg: 'bg-rose-50 dark:bg-rose-950/20',
  },
}

function PerformanceGauge({
  value,
  max,
  icon: Icon,
  label,
  display,
  assessment,
}: {
  value: number
  max: number
  icon: typeof Clock
  label: string
  display: string
  assessment: Assessment
}) {
  useTranslation('logs')

  return (
    <div
      className={cn(
        'flex flex-1 items-center gap-4 rounded-lg border p-4',
        assessment.bg
      )}
    >
      <div className='relative'>
        <CircularProgress
          value={Math.min(value, max)}
          max={max}
          size={64}
          strokeWidth={5}
          showPercentage={false}
          toneClassName={assessment.color}
        />
        <Icon
          className={cn(
            'absolute top-1/2 left-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2',
            assessment.color
          )}
        />
      </div>
      <div className='min-w-0'>
        <div className='text-xs text-muted-foreground'>{label}</div>
        <div className='font-mono text-xl font-bold'>{display}</div>
        <Badge
          variant='outline'
          className={cn('mt-1 text-[10px]', assessment.color)}
        >
          {assessment.label}
        </Badge>
      </div>
    </div>
  )
}

export function PerformanceTab({ row }: { row: UsageLogRow }) {
  const { t: translate } = useTranslation('logs')

  const { ttftMs, durationMs, outputTokens } = row
  const rate = calculateOutputRate(outputTokens, durationMs, ttftMs)
  const showRate =
    rate != null && !shouldHideOutputRate(rate, durationMs, ttftMs)
  const wait = queueWaitMs(row.providerChain || [])

  if (ttftMs == null && durationMs == null) {
    return (
      <div className='py-8 text-center text-muted-foreground'>
        <Gauge className='mx-auto mb-2 h-8 w-8 opacity-50' />
        {translate('logs:noPerformanceData')}
      </div>
    )
  }

  const ttftAssessment =
    ttftMs == null
      ? null
      : ASSESSMENTS[
          ttftMs < 1000
            ? 'excellent'
            : ttftMs < 2000
              ? 'good'
              : ttftMs < 3000
                ? 'warning'
                : 'poor'
        ]
  const rateAssessment = showRate
    ? ASSESSMENTS[
        rate >= 80
          ? 'excellent'
          : rate >= 50
            ? 'good'
            : rate >= 30
              ? 'warning'
              : 'poor'
      ]
    : null

  const rows: [string, string][] = []
  if (wait != null)
    rows.push([translate('logs:queueWait'), formatDuration(wait)])
  if (ttftMs != null)
    rows.push([translate('logs:ttftTitle'), formatDuration(ttftMs)])
  if (ttftMs != null && durationMs != null)
    rows.push([
      translate('logs:generationTime'),
      formatDuration(durationMs - ttftMs),
    ])
  if (durationMs != null)
    rows.push([translate('logs:totalDuration'), formatDuration(durationMs)])
  rows.push([translate('logs:outputTokens'), formatTokenAmount(outputTokens)])
  if (showRate)
    rows.push([translate('logs:outputRate'), `${rate.toFixed(1)} tok/s`])

  return (
    <div className='space-y-6'>
      {ttftAssessment || rateAssessment ? (
        <div className='flex flex-col gap-4 sm:flex-row'>
          {ttftAssessment && ttftMs != null ? (
            <PerformanceGauge
              value={ttftMs}
              max={3000}
              icon={Clock}
              label={translate('logs:ttft')}
              display={formatDuration(ttftMs)}
              assessment={ttftAssessment}
            />
          ) : null}
          {rateAssessment && rate != null ? (
            <PerformanceGauge
              value={rate}
              max={100}
              icon={Zap}
              label={translate('logs:outputRate')}
              display={`${rate.toFixed(1)} tok/s`}
              assessment={rateAssessment}
            />
          ) : null}
        </div>
      ) : null}
      {ttftMs != null && durationMs != null ? (
        <div className='space-y-2'>
          <h4 className='flex items-center gap-2 text-sm font-semibold'>
            <Gauge className='h-4 w-4 text-purple-600' />
            {translate('logs:latencyBreakdown')}
          </h4>
          <div className='rounded-lg border bg-card p-4'>
            <LatencyBreakdownBar
              waitMs={wait}
              ttftMs={ttftMs}
              durationMs={durationMs}
            />
          </div>
        </div>
      ) : null}
      <div className='space-y-2'>
        <h4 className='text-sm font-semibold'>
          {translate('logs:performanceData')}
        </h4>
        <div className='divide-y rounded-lg border bg-card'>
          {rows.map(([label, value]) => (
            <div
              key={label}
              className='flex items-center justify-between px-4 py-3'
            >
              <span className='text-sm text-muted-foreground'>{label}</span>
              <span className='font-mono text-sm font-medium'>{value}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
