import { t as translate } from '@/i18n'
import type { UsageCacheMetrics } from '@/types/panel-database'
import { useTranslation } from 'react-i18next'
import { EmptyState } from '@/components/empty-state'
import { PanelCard, StatCell } from '@/features/overview/panel-card'
import {
  formatMetricNumber,
  formatMetricPercent,
  formatMetricTime,
} from './metrics'

function ttlLabel(value: number): string {
  if (!Number.isFinite(value)) return '—'
  if (value % 60_000 === 0)
    return translate('database:minutes', { value1: value / 60_000 })
  return translate('database:seconds', { value1: Math.round(value / 1000) })
}

function Detail({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className='text-[11px] text-muted-foreground'>{label}</dt>
      <dd className='mt-0.5 text-sm font-medium tabular-nums'>
        {formatMetricNumber(value)}
      </dd>
    </div>
  )
}

export function UsageCacheMetricsPanel({
  metrics,
}: {
  metrics: UsageCacheMetrics | null
}) {
  const { t } = useTranslation('database')

  if (!metrics) {
    return (
      <PanelCard title={t('usageCache')} meta={t('instanceMetrics')}>
        <EmptyState reason={t('usageUnavailable')} />
      </PanelCard>
    )
  }

  return (
    <PanelCard
      title={t('usageCache')}
      meta={t('instanceSince', { value1: formatMetricTime(metrics.since) })}
      action={
        <span className='text-[11px] text-muted-foreground tabular-nums'>
          {t('loadCalls', { value1: formatMetricNumber(metrics.requests) })}
        </span>
      }
    >
      <div className='grid grid-cols-2 gap-px bg-border/60 sm:grid-cols-4'>
        <StatCell
          label={t('directHitRate')}
          value={formatMetricPercent(metrics.hit_rate)}
          hint={t('directHitFormula')}
        />
        <StatCell
          label={t('reuseRate')}
          value={formatMetricPercent(metrics.reuse_rate)}
          hint={t('reuseFormula')}
        />
        <StatCell
          label={t('freshEntries')}
          value={`${formatMetricNumber(metrics.entries_fresh)} / ${formatMetricNumber(metrics.entries_total)}`}
          hint={t('expiredEntries', {
            value1: formatMetricNumber(metrics.entries_stale),
          })}
        />
        <StatCell
          label={t('upstreamFailures')}
          value={`${formatMetricNumber(metrics.upstream_failures)} / ${formatMetricNumber(metrics.upstream_fetches)}`}
          hint={t('inflight', { value1: formatMetricNumber(metrics.inflight) })}
          valueClassName={
            metrics.upstream_failures > 0
              ? 'text-[color:var(--status-bad)]'
              : undefined
          }
        />
      </div>

      <dl className='grid grid-cols-2 gap-x-5 gap-y-3 border-t px-4 py-3 sm:grid-cols-4 xl:grid-cols-6'>
        <Detail label={t('successHits')} value={metrics.success_hits} />
        <Detail label={t('negativeHits')} value={metrics.error_hits} />
        <Detail label={t('misses')} value={metrics.misses} />
        <Detail
          label={t('coalescedRequests')}
          value={metrics.singleflight_joins}
        />
        <div>
          <dt className='text-[11px] text-muted-foreground'>
            {t('successTtl')}
          </dt>
          <dd className='mt-0.5 text-sm font-medium tabular-nums'>
            {ttlLabel(metrics.success_ttl_ms)}
          </dd>
        </div>
        <div>
          <dt className='text-[11px] text-muted-foreground'>{t('errorTtl')}</dt>
          <dd className='mt-0.5 text-sm font-medium tabular-nums'>
            {ttlLabel(metrics.error_ttl_ms)}
          </dd>
        </div>
      </dl>

      <p className='border-t px-4 py-2.5 text-[11px] leading-relaxed text-muted-foreground'>
        {t('negativeCacheScope')}
      </p>
    </PanelCard>
  )
}
