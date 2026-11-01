import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Activity, Coins, Gauge, Timer, Layers3 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { api } from '@/lib/api'
import { SYSTEM_TIMEZONE } from '@/lib/system-time'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import {
  DateRangePicker,
  dateRangeValueForPreset,
} from '@/components/date-range-picker'
import { CacheTokens } from './cache-tokens'
import {
  number,
  time,
  type Resource,
  type VendorUsageReport,
  type VendorUsageSummary,
} from './portal-model'

export const usageCost = (value: number | null | undefined) =>
  value == null
    ? '—'
    : '$' +
      value.toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 8,
      })
export const pct = (value: number | null | undefined) =>
  value == null ? '—' : (value * 100).toFixed(2) + '%'
const duration = (value: number | null | undefined) =>
  value == null ? '—' : (value / 1000).toFixed(1) + ' s'
export type UsageRange = { range: string; start_date: string; end_date: string }
export const usageQueryString = (range: UsageRange) =>
  new URLSearchParams({
    range: ['all', 'today', '7days', '30days'].includes(range.range)
      ? range.range
      : 'custom',
    ...(!['all', 'today', '7days', '30days'].includes(range.range)
      ? { start_date: range.start_date, end_date: range.end_date }
      : {}),
    timezone: SYSTEM_TIMEZONE,
  }).toString()

type PresetRange =
  'today' | 'yesterday' | '7days' | '30days' | 'thisMonth' | 'lastMonth'
const RANGE_PRESETS: PresetRange[] = [
  'today',
  'yesterday',
  '7days',
  '30days',
  'thisMonth',
  'lastMonth',
]

export function usageRangeForPreset(
  preset: PresetRange,
  now = new Date()
): UsageRange {
  const dates = dateRangeValueForPreset(preset, now)
  return {
    range: preset,
    start_date: dates.startDate!,
    end_date: dates.endDate!,
  }
}

export function UsageRangePicker({
  value,
  onChange,
}: {
  value: UsageRange
  onChange: (value: UsageRange) => void
}) {
  const { t } = useTranslation('vendor')
  const presets = [
    { id: 'all', label: t('details.rangeLabel.all'), value: {} },
    ...RANGE_PRESETS.map((preset) => ({
      id: preset,
      label: t('details.rangeLabel.' + preset),
      value: dateRangeValueForPreset(preset),
    })),
  ]

  return (
    <div className='grid gap-1 text-xs text-muted-foreground'>
      <span>{t('details.range')}</span>
      <DateRangePicker
        value={
          value.range === 'all'
            ? {}
            : { startDate: value.start_date, endDate: value.end_date }
        }
        presets={presets}
        disableFuture
        labels={{
          empty: t('details.rangeLabel.all'),
          clear: t('clear'),
        }}
        onChange={(next) => {
          if (!next.startDate || !next.endDate) {
            onChange({ range: 'all', start_date: '', end_date: '' })
            return
          }
          const preset = RANGE_PRESETS.find((id) => {
            const presetValue = dateRangeValueForPreset(id)
            return (
              presetValue.startDate === next.startDate &&
              presetValue.endDate === next.endDate
            )
          })
          onChange({
            range: preset || 'custom',
            start_date: next.startDate,
            end_date: next.endDate,
          })
        }}
      />
    </div>
  )
}
export function UsageSummaryCards({
  summary: s,
}: {
  summary: VendorUsageSummary
}) {
  const { t } = useTranslation('vendor')
  const cards = [
    {
      label: t('details.totalRequests'),
      value: number(s.requests),
      hint: t('details.successFailure', {
        success: number(s.success),
        failure: number(s.errors),
      }),
      icon: Activity,
    },
    {
      label: t('details.cost'),
      value: usageCost(s.cost_usd),
      hint: t('details.officialCost'),
      icon: Coins,
    },
    {
      label: t('details.successRate'),
      value: pct(s.success_rate),
      hint: t('details.successFailure', {
        success: number(s.success),
        failure: number(s.errors),
      }),
      icon: Gauge,
    },
    {
      label: t('details.tokens'),
      value: number(s.tokens),
      hint: t('details.inputOutput', {
        input: number(s.input_tokens),
        output: number(s.output_tokens),
      }),
      icon: Activity,
    },
    {
      label: t('details.cache'),
      value: pct(s.cache_hit_rate),
      hint: <CacheTokens usage={s} />,
      icon: Layers3,
    },
    {
      label: t('details.avgLatency'),
      value: duration(s.avg_duration_ms),
      hint: '',
      icon: Timer,
    },
    {
      label: t('details.firstToken'),
      value: duration(s.avg_ttft_ms),
      hint: '',
      icon: Timer,
    },
  ]
  return (
    <>
      <div className='grid grid-cols-2 gap-3 lg:grid-cols-4'>
        {cards.map(({ label, value, hint, icon: Icon }) => (
          <div
            key={label}
            className='space-y-3 rounded-xl border bg-muted/20 p-4'
          >
            <div className='flex justify-between gap-2 text-xs text-muted-foreground'>
              <span>{label}</span>
              <Icon className='size-4' />
            </div>
            <p className='text-xl font-semibold break-words tabular-nums'>
              {value}
            </p>
            {hint && (
              <p className='text-xs leading-5 text-muted-foreground'>{hint}</p>
            )}
          </div>
        ))}
      </div>
      {s.unpriced_requests > 0 && (
        <p className='text-sm text-amber-600'>
          {t('details.unpriced', { count: s.unpriced_requests })}
        </p>
      )}
    </>
  )
}
export function UsageAnalysis({ data }: { data: VendorUsageReport }) {
  const { t } = useTranslation('vendor')
  const [metric, setMetric] = useState<'requests' | 'tokens' | 'cost_usd'>(
    'requests'
  )
  const value = (v: unknown) =>
    metric === 'cost_usd'
      ? usageCost(v == null ? null : Number(v))
      : number(v == null ? null : Number(v))
  return (
    <div className='space-y-5'>
      <UsageSummaryCards summary={data.summary} />
      <section className='overflow-hidden rounded-xl border'>
        <h3 className='border-b bg-muted/20 px-4 py-3 text-sm font-semibold'>
          {t('details.fixedWindows')}{' '}
          <span className='text-xs font-normal text-muted-foreground'>
            {t('details.fixedWindowsHelp')}
          </span>
        </h3>
        <div className='overflow-x-auto'>
          <table className='w-full text-sm'>
            <thead className='text-muted-foreground'>
              <tr>
                {[
                  t('period'),
                  t('requests'),
                  t('details.tokensWithCache'),
                  t('details.officialPrice'),
                ].map((label) => (
                  <th
                    key={label}
                    className='px-4 py-3 text-start text-xs font-medium'
                  >
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {['5h', '7d', '30d'].map((key) => {
                const w = data.fixed_windows[key]
                return (
                  <tr key={key} className='border-t [&_td]:px-4 [&_td]:py-3'>
                    <td>{t('details.fixedWindow.' + key)}</td>
                    <td>{number(w?.requests)}</td>
                    <td>{number(w?.total_tokens)}</td>
                    <td>{usageCost(w?.cost_usd)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>
      <section className='space-y-4 rounded-xl border p-4'>
        <div className='flex flex-wrap items-center justify-between gap-2'>
          <h3 className='text-sm font-semibold'>{t('details.trends')}</h3>
          <div className='flex gap-1'>
            {(['requests', 'tokens', 'cost_usd'] as const).map((key) => (
              <Button
                key={key}
                variant={metric === key ? 'secondary' : 'ghost'}
                size='sm'
                onClick={() => setMetric(key)}
                aria-pressed={metric === key}
              >
                {t('details.metric.' + key)}
              </Button>
            ))}
          </div>
        </div>
        {data.trend.length ? (
          <div
            className='h-64 min-w-0'
            role='img'
            aria-label={t('details.trends')}
          >
            <ResponsiveContainer width='100%' height='100%'>
              <AreaChart
                data={data.trend}
                margin={{ top: 10, right: 12, left: 4, bottom: 0 }}
              >
                <CartesianGrid stroke='var(--border)' strokeDasharray='3 3' />
                <XAxis
                  dataKey='date'
                  tickFormatter={(date) =>
                    data.resolution === 'month' ? date : String(date).slice(5)
                  }
                  tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
                />
                <YAxis
                  width={70}
                  tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
                />
                <Tooltip
                  formatter={(v) => value(v)}
                  contentStyle={{
                    background: 'var(--card)',
                    borderColor: 'var(--border)',
                    color: 'var(--foreground)',
                    borderRadius: 8,
                  }}
                />
                <Area
                  type='monotone'
                  dataKey={metric}
                  name={t('details.metric.' + metric)}
                  stroke='var(--primary)'
                  fill='var(--primary)'
                  fillOpacity={0.15}
                  strokeWidth={2}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <p className='py-12 text-center text-sm text-muted-foreground'>
            {t('noRecords')}
          </p>
        )}
      </section>
      <section className='space-y-4 rounded-xl border p-4'>
        <h3 className='text-sm font-semibold'>
          {t('details.modelDistribution')} · {t('details.metric.' + metric)}
        </h3>
        {data.models.length ? (
          <>
            <div className='max-h-96 overflow-y-auto'>
              <div
                style={{ height: Math.max(130, data.models.length * 42) }}
                role='img'
                aria-label={t('details.modelDistribution')}
              >
                <ResponsiveContainer width='100%' height='100%'>
                  <BarChart
                    data={data.models}
                    layout='vertical'
                    margin={{ top: 0, right: 20, left: 5, bottom: 0 }}
                  >
                    <CartesianGrid
                      stroke='var(--border)'
                      strokeDasharray='3 3'
                      horizontal={false}
                    />
                    <XAxis
                      type='number'
                      tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
                    />
                    <YAxis
                      type='category'
                      dataKey='model'
                      width={180}
                      tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
                    />
                    <Tooltip
                      formatter={(v) => value(v)}
                      contentStyle={{
                        background: 'var(--card)',
                        borderColor: 'var(--border)',
                        color: 'var(--foreground)',
                        borderRadius: 8,
                      }}
                    />
                    <Bar
                      dataKey={metric}
                      name={t('details.metric.' + metric)}
                      fill='var(--primary)'
                      radius={[0, 4, 4, 0]}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
            <div className='overflow-x-auto'>
              <table className='w-full text-xs'>
                <thead>
                  <tr>
                    {[
                      t('details.model'),
                      t('requests'),
                      t('token'),
                      t('details.cost'),
                    ].map((label) => (
                      <th
                        key={label}
                        className='px-3 py-2 text-start font-medium text-muted-foreground'
                      >
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.models.map((model) => (
                    <tr
                      className='border-t [&_td]:px-3 [&_td]:py-2'
                      key={model.model}
                    >
                      <td>{model.model}</td>
                      <td>{number(model.requests)}</td>
                      <td>{number(model.tokens)}</td>
                      <td>{usageCost(model.cost_usd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <p className='py-5 text-sm text-muted-foreground'>{t('noRecords')}</p>
        )}
      </section>
      <p className='text-xs text-muted-foreground'>
        {t('details.snapshotAt', { time: time(data.collected_at) })} ·{' '}
        {data.period.timezone}
      </p>
    </div>
  )
}
export function AccountUsageDialog({
  apiBase = '/api/vendor/accounts',
  resource,
  onClose,
}: {
  resource: Resource
  apiBase?: string
  onClose: () => void
}) {
  const { t } = useTranslation('vendor')
  const [range, setRange] = useState<UsageRange>({
    range: 'all',
    start_date: '',
    end_date: '',
  })
  const query = useQuery({
    queryKey: ['vendor', apiBase, 'account-usage', resource.id, range],
    queryFn: () =>
      api<VendorUsageReport>(
        apiBase + '/' + resource.id + '/usage?' + usageQueryString(range)
      ),
    refetchOnWindowFocus: false,
  })
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className='max-h-[90vh] overflow-y-auto sm:max-w-6xl'>
        <DialogHeader>
          <DialogTitle>
            {resource.name} · {t('details.usageTitle')}
          </DialogTitle>
          <DialogDescription>{t('details.usageHelp')}</DialogDescription>
        </DialogHeader>
        <div className='flex justify-end'>
          <UsageRangePicker value={range} onChange={setRange} />
        </div>
        {query.isPending ? (
          <p className='p-8 text-center'>{t('loading')}</p>
        ) : query.error ? (
          <p role='alert' className='text-sm text-destructive'>
            {query.error.message}
          </p>
        ) : (
          query.data && <UsageAnalysis data={query.data} />
        )}
      </DialogContent>
    </Dialog>
  )
}
