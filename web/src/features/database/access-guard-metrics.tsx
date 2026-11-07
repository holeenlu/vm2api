import type {
  DatabaseWriteHealth,
  StatsRouteBudgetMetrics,
  WriteBehindMetrics,
} from '@/types/panel-database'
import { useTranslation } from 'react-i18next'
import { PanelCard, StatCell } from '@/features/overview/panel-card'
import { formatMetricNumber } from './metrics'

const BAD = 'text-[color:var(--status-bad)]'

/**
 * 数据访问保护：数据库写入健康（写不进去时计费请求被拒、收口在后台重试）、写回队列（观测写入满时丢弃、计费写入满时直写）
 * 与统计类接口的并发上限 / 超时计数。旧控制面不返回这些字段时不渲染。
 */
export function AccessGuardMetricsPanel({
  writeHealth,
  writeBehind,
  routeBudget,
}: {
  writeHealth?: DatabaseWriteHealth
  writeBehind?: WriteBehindMetrics
  routeBudget?: StatsRouteBudgetMetrics
}) {
  const { t } = useTranslation('database')
  if (!writeHealth && !writeBehind && !routeBudget) return null
  const limit = (value: number) =>
    value > 0 ? formatMetricNumber(value) : t('unlimited')

  return (
    <PanelCard title={t('accessGuards')} meta={t('accessGuardsMeta')}>
      <div className='grid grid-cols-2 gap-px bg-border/60 sm:grid-cols-3 xl:grid-cols-6'>
        {writeHealth ? (
          <>
            <StatCell
              label={t('dbWrites')}
              value={
                writeHealth.writable ? t('dbWritesOk') : t('dbWritesFailing')
              }
              hint={
                writeHealth.writable
                  ? t('dbWritesOkHint', {
                      value1: formatMetricNumber(writeHealth.failures),
                    })
                  : t('dbWritesFailingHint', {
                      value1: writeHealth.last_error_code ?? '-',
                      value2: writeHealth.since ?? '-',
                    })
              }
              valueClassName={writeHealth.writable ? undefined : BAD}
            />
            <StatCell
              label={t('settlementRetry')}
              value={formatMetricNumber(writeHealth.settlement_retry.pending)}
              hint={t('settlementRetryHint', {
                value1: formatMetricNumber(
                  writeHealth.settlement_retry.recovered
                ),
                value2: formatMetricNumber(
                  writeHealth.settlement_retry.abandoned
                ),
                value3: formatMetricNumber(
                  writeHealth.settlement_retry.persisted ?? 0
                ),
              })}
              valueClassName={
                writeHealth.settlement_retry.pending > 0 ||
                (writeHealth.settlement_retry.persisted ?? 0) > 0 ||
                writeHealth.settlement_retry.abandoned > 0
                  ? BAD
                  : undefined
              }
            />
          </>
        ) : null}
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
