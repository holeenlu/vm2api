import { i18n } from '@/i18n'
import type { DatabaseRuntimeMetrics } from '@/types/panel-database'
import { useTranslation } from 'react-i18next'
import { StatusMark } from '@/components/status-mark'
import { PanelCard, StatCell } from '@/features/overview/panel-card'
import {
  formatMetricBytes,
  formatMetricNumber,
  formatMetricPercent,
  formatMetricTime,
} from './metrics'

function latency(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—'
  if (value < 10) return `${value.toFixed(2)}ms`
  return `${Math.round(value)}ms`
}

function synchronousLabel(value: number | null): string {
  if (value == null) return '—'
  return ['OFF', 'NORMAL', 'FULL', 'EXTRA'][value] || String(value)
}

function timeout(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—'
  if (value >= 1000 && value % 1000 === 0) return `${value / 1000}s`
  return `${value.toLocaleString(i18n.language)}ms`
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className='min-w-0'>
      <dt className='text-[11px] text-muted-foreground'>{label}</dt>
      <dd className='mt-0.5 truncate text-sm font-medium tabular-nums'>
        {value}
      </dd>
    </div>
  )
}

export function DatabaseOverview({
  metrics,
  sampledAt,
}: {
  metrics: DatabaseRuntimeMetrics
  sampledAt: string | null
}) {
  const { t } = useTranslation('database')

  const pageUse =
    metrics.used_pages == null && metrics.page_count == null
      ? '—'
      : `${formatMetricNumber(metrics.used_pages)} / ${formatMetricNumber(metrics.page_count)}`

  return (
    <PanelCard
      title={t('runtimeTitle')}
      meta={
        sampledAt
          ? t('sampledAt', { value1: formatMetricTime(sampledAt) })
          : t('currentSnapshot')
      }
      action={
        <StatusMark
          variant='pill'
          tone={
            metrics.ok
              ? { key: 'ok', cls: 'ok', text: t('probeHealthy') }
              : { key: 'bad', cls: 'bad', text: t('probeFailed') }
          }
        />
      }
    >
      <div className='grid grid-cols-2 gap-px bg-border/60 sm:grid-cols-3 xl:grid-cols-6'>
        <StatCell
          label={t('probeLatency')}
          value={latency(metrics.probe_latency_ms)}
          hint={t('probeQuery')}
        />
        <StatCell
          label={t('mainSize')}
          value={formatMetricBytes(metrics.file_size_bytes)}
          hint={t('mainFile')}
        />
        <StatCell
          label={t('walSize')}
          value={formatMetricBytes(metrics.wal_size_bytes)}
          hint={
            /* i18n-exempt "SHM {{expression}}" -- SHM is the SQLite shared-memory file suffix; adjacent value is a measured size. */ `SHM ${formatMetricBytes(metrics.shm_size_bytes)}`
          }
        />
        <StatCell
          label={t('freePageRatio')}
          value={formatMetricPercent(metrics.free_ratio)}
          hint={t('freePages', {
            value1: formatMetricNumber(metrics.freelist_pages),
          })}
        />
        <StatCell
          label={t('pageUsage')}
          value={pageUse}
          hint={formatMetricBytes(metrics.used_bytes)}
        />
        <StatCell
          label={t('migration')}
          value={metrics.latest_migration || '—'}
          hint={t('migrationHistory', {
            value1: formatMetricNumber(metrics.migration_count),
            value2: formatMetricTime(metrics.latest_migration_at),
          })}
        />
      </div>

      <dl className='grid grid-cols-2 gap-x-5 gap-y-3 border-t px-4 py-3 sm:grid-cols-3 xl:grid-cols-6'>
        <Detail label={t('engine')} value={metrics.engine.toUpperCase()} />
        <Detail
          label={t('journal')}
          value={metrics.journal_mode?.toUpperCase() || '—'}
        />
        <Detail
          label={t('synchronous')}
          value={synchronousLabel(metrics.synchronous)}
        />
        <Detail
          label={t('foreignKeys')}
          value={
            metrics.foreign_keys == null
              ? '—'
              : metrics.foreign_keys
                ? 'ON'
                : 'OFF'
          }
        />
        <Detail
          label={t('busyTimeout')}
          value={timeout(metrics.busy_timeout_ms)}
        />
        <Detail
          label={t('pageSize')}
          value={formatMetricBytes(metrics.page_size_bytes)}
        />
      </dl>

      <p className='border-t px-4 py-2.5 text-[11px] leading-relaxed text-muted-foreground'>
        {t('runtimeScope')}
      </p>
    </PanelCard>
  )
}
