import { useTranslation } from 'react-i18next'
import { fmtNum } from '@/lib/format'
import { usageCost, pct } from './account-usage-dialog'
import { cacheTokenValue, type CacheUsage } from './cache-tokens'
import { number } from './portal-model'

export type UsageMetrics = CacheUsage & {
  input_tokens: number
  output_tokens: number
  cache_hit_rate: number | null
  cost_usd: number | null
}

export const usageMetricKeys = [
  'requests',
  'inputTokens',
  'outputTokens',
  'cacheRead',
  'cacheWrite',
  'cacheHitRate',
  'cost',
] as const

function values(row: UsageMetrics, compact = true) {
  const tokens = compact ? fmtNum : number
  return [
    number(row.requests),
    tokens(row.input_tokens),
    tokens(row.output_tokens),
    cacheTokenValue(row, 'read', '—', tokens),
    cacheTokenValue(row, 'creation', '—', tokens),
    pct(row.cache_hit_rate),
    usageCost(row.cost_usd),
  ]
}

export function UsageSummaryCards({ usage }: { usage: UsageMetrics }) {
  const { t } = useTranslation('vendor')
  const fullValues = values(usage, false)
  return (
    <div className='grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7'>
      {values(usage).map((value, i) => (
        <div
          key={usageMetricKeys[i]}
          title={fullValues[i]}
          className='min-w-0 rounded-xl border bg-card p-4 shadow-sm'
        >
          <h2 className='text-sm text-muted-foreground'>
            {t(`details.${usageMetricKeys[i]}`)}
          </h2>
          <p
            title={fullValues[i]}
            className={`mt-2 text-lg font-semibold break-words tabular-nums ${usageMetricKeys[i] === 'cost' ? 'text-primary' : ''}`}
          >
            {value}
          </p>
        </div>
      ))}
    </div>
  )
}

export function UsageMetricCells({ usage }: { usage: UsageMetrics }) {
  const fullValues = values(usage, false)
  return (
    <>
      {values(usage).map((value, i) => (
        <td
          key={usageMetricKeys[i]}
          title={fullValues[i]}
          className='p-4 text-end whitespace-nowrap tabular-nums'
        >
          {value}
        </td>
      ))}
    </>
  )
}
