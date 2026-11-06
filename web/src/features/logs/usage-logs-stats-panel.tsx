import { useQuery } from '@tanstack/react-query'
import { i18n } from '@/i18n'
import type { UsageLogFilters } from '@/types/panel-usage-logs'
import { BarChart3 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatCurrency, formatTokenAmount } from '@/lib/usage-format'
import { Skeleton } from '@/components/ui/skeleton'
import { usageLogsSummaryQueryOptions } from './queries'

function Tile({
  label,
  value,
  rows,
}: {
  label: string
  value: string
  rows?: [string, string][]
}) {
  useTranslation('logs')

  return (
    <div className='rounded-lg border border-border/50 bg-card/20 p-4'>
      <div className='mb-1 text-sm text-muted-foreground'>{label}</div>
      <div className='font-mono text-2xl font-semibold'>{value}</div>
      {rows ? (
        <div className='mt-2 space-y-1 text-xs text-muted-foreground'>
          {rows.map(([k, v]) => (
            <div key={k} className='flex justify-between'>
              <span>{k}:</span>
              <span className='font-mono'>{v}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function numberOf(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/**
 * 当前筛选下的聚合（hub `UsageLogsStatsPanel`）。屏蔽非 auth 类或钻取错误类时
 * 后端只聚合最近 5000 条命中行，所以文案不宣称「全部」。
 */
export function UsageLogsStatsPanel({ filters }: { filters: UsageLogFilters }) {
  const { t: translate } = useTranslation('logs')

  const { data, isLoading, error } = useQuery(
    usageLogsSummaryQueryOptions(filters)
  )
  return (
    <div className='relative overflow-hidden rounded-xl border border-border/50 bg-card/30 backdrop-blur-sm transition-all duration-200 hover:border-border'>
      <div className='pointer-events-none absolute inset-0 bg-gradient-to-br from-white/[0.02] to-transparent' />
      <div className='relative'>
        <div className='flex items-center gap-3 border-b border-border/30 px-4 py-3'>
          <div className='flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground'>
            <BarChart3 className='h-4 w-4' />
          </div>
          <div className='space-y-1'>
            <div className='text-sm leading-none font-semibold text-foreground'>
              {translate('logs:statistics')}
            </div>
            <p className='hidden text-xs leading-relaxed text-muted-foreground sm:block'>
              {translate('logs:statisticsHint')}
            </p>
          </div>
        </div>
        <div className='px-4 py-4'>
          {isLoading ? (
            <div className='grid gap-4 md:grid-cols-4'>
              {[0, 1, 2, 3].map((i) => (
                <div
                  key={i}
                  className='space-y-2 rounded-lg border border-border/50 bg-card/20 p-4'
                >
                  <Skeleton className='h-4 w-24' />
                  <Skeleton className='h-8 w-32' />
                </div>
              ))}
            </div>
          ) : error || !data ? (
            <div className='py-4 text-center text-destructive'>
              {error instanceof Error
                ? error.message
                : translate('logs:loadFailed')}
            </div>
          ) : (
            <div className='grid gap-4 md:grid-cols-4'>
              <Tile
                label={translate('logs:totalRequests')}
                value={numberOf(data.totalRequests).toLocaleString(
                  i18n.language
                )}
                rows={[
                  [
                    translate('logs:success'),
                    numberOf(data.successRequests).toLocaleString(
                      i18n.language
                    ),
                  ],
                  [
                    translate('logs:failure'),
                    numberOf(data.errorRequests).toLocaleString(i18n.language),
                  ],
                ]}
              />
              <Tile
                label={translate('logs:totalSpending')}
                value={formatCurrency(data.totalActualCost)}
                rows={[
                  [translate('logs:listPrice'), formatCurrency(data.totalCost)],
                ]}
              />
              <Tile
                label={translate('logs:totalTokens')}
                value={formatTokenAmount(numberOf(data.totalTokens))}
                rows={[
                  [
                    translate('logs:input'),
                    formatTokenAmount(numberOf(data.totalInputTokens)),
                  ],
                  [
                    translate('logs:output'),
                    formatTokenAmount(numberOf(data.totalOutputTokens)),
                  ],
                ]}
              />
              <Tile
                label={translate('logs:cacheTokens')}
                value={formatTokenAmount(
                  numberOf(data.totalCacheCreationTokens) +
                    numberOf(data.totalCacheReadTokens)
                )}
                rows={[
                  [
                    translate('logs:write'),
                    formatTokenAmount(numberOf(data.totalCacheCreationTokens)),
                  ],
                  [
                    translate('logs:read'),
                    formatTokenAmount(numberOf(data.totalCacheReadTokens)),
                  ],
                ]}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
