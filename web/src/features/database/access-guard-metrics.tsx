import type {
  StatsRouteBudgetMetrics,
  WriteBehindMetrics,
} from '@/types/panel-database'
import { useTranslation } from 'react-i18next'
import { PanelCard, StatCell } from '@/features/overview/panel-card'
import { formatMetricNumber } from './metrics'

const BAD = 'text-[color:var(--status-bad)]'

/**
 * 数据访问保护：写回队列（观测写入满时丢弃、计费写入满时直写）与统计类接口的并发上限 / 超时计数。
 * 旧控制面不返回这两组字段时不渲染。
 */
export function AccessGuardMetricsPanel({
  writeBehind,
  routeBudget,
}: {
  writeBehind?: WriteBehindMetrics
  routeBudget?: StatsRouteBudgetMetrics
}) {
  const { t } = useTranslation('database')
  if (!writeBehind && !routeBudget) return null
  const limit = (value: number) =>
    value > 0 ? formatMetricNumber(value) : t('unlimited')

  return (
    <PanelCard title={t('accessGuards')} meta={t('accessGuardsMeta')}>
      <div className='grid grid-cols-2 gap-px bg-border/60 sm:grid-cols-3 xl:grid-cols-6'>
        {writeBehind ? (
          <>
            <StatCell
              label={t('writeQueue')}
              value={formatMetricNumber(writeBehind.queued)}
              hint={t('writeQueueHint', {
                value1: formatMetricNumber(writeBehind.max_queue),
                value2: formatMetricNumber(writeBehind.peak),
              })}
            />
            <StatCell
              label={t('droppedObservation')}
              value={formatMetricNumber(writeBehind.dropped_observation)}
              hint={t('droppedObservationHint')}
              valueClassName={
                writeBehind.dropped_observation > 0 ? BAD : undefined
              }
            />
            <StatCell
              label={t('billingDirect')}
              value={formatMetricNumber(writeBehind.billing_direct)}
              hint={t('billingDirectHint')}
              valueClassName={writeBehind.billing_direct > 0 ? BAD : undefined}
            />
          </>
        ) : null}
        {routeBudget ? (
          <>
            <StatCell
              label={t('statsRunning')}
              value={formatMetricNumber(routeBudget.running)}
              hint={t('statsRunningHint', {
                value1: limit(routeBudget.limits.route_concurrency),
                value2: limit(routeBudget.limits.concurrency),
              })}
            />
            <StatCell
              label={t('statsBusy')}
              value={formatMetricNumber(routeBudget.rejected_busy)}
              hint={t('statsBusyHint', {
                value1: formatMetricNumber(routeBudget.admitted),
              })}
              valueClassName={routeBudget.rejected_busy > 0 ? BAD : undefined}
            />
            <StatCell
              label={t('statsTimeout')}
              value={formatMetricNumber(routeBudget.timed_out)}
              hint={
                routeBudget.limits.timeout_ms > 0
                  ? t('statsTimeoutHint', {
                      value1: formatMetricNumber(
                        Math.round(routeBudget.limits.timeout_ms / 1000)
                      ),
                    })
                  : t('unlimited')
              }
              valueClassName={routeBudget.timed_out > 0 ? BAD : undefined}
            />
          </>
        ) : null}
      </div>
    </PanelCard>
  )
}
