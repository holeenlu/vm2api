import { useTranslation } from 'react-i18next'

// 控制面运行状态（审计 U8，见 src/lib/executor/control-plane-status.mjs）
export type ControlPlaneStatus = {
  events: {
    mode?: string
    since_hours: number
    by_status: Record<string, number>
    attempts: Record<string, number>
    lag: { instance_id: string; lag: number }[]
  } | null
}

const sum = (counts: Record<string, number>, keys: string[]) =>
  keys.reduce((total, key) => total + (counts[key] || 0), 0)

export function ControlPlaneStatusCard({
  status,
}: {
  status: ControlPlaneStatus
}) {
  const { t } = useTranslation('common')
  const events = status.events
  const problems = events
    ? sum(events.by_status, ['diff', 'missing', 'failed', 'invalid'])
    : 0
  const attemptProblems = events ? sum(events.attempts, ['failed']) : 0
  return (
    <section
      className='space-y-3 rounded-lg border p-4 text-sm'
      data-testid='control-plane-status'
    >
      <h2 className='font-medium'>{t('gatewayWorkerControlPlane')}</h2>
      <div>
        <div className='text-xs text-muted-foreground'>
          {t('gatewayWorkerControlPlaneInbox', {
            hours: events?.since_hours ?? 24,
          })}
        </div>
        {events ? (
          <p
            className={`mt-1 ${problems || attemptProblems ? 'text-destructive' : ''}`}
          >
            {t('gatewayWorkerControlPlaneInboxCounts', {
              done: sum(events.by_status, [
                'applied',
                'matched',
                'recorded',
                'stale',
              ]),
              pending: events.by_status.pending || 0,
              diff: sum(events.by_status, ['diff', 'missing']),
              failed: sum(events.by_status, ['failed', 'invalid']),
            })}
            {` · ${t('gatewayWorkerControlPlaneAttempts', {
              failed: events.attempts.failed || 0,
              retry: events.attempts.retry || 0,
            })}`}
            {events.lag.some((item) => item.lag > 0) &&
              ` · ${t('gatewayWorkerControlPlaneLag', {
                value: events.lag
                  .filter((item) => item.lag > 0)
                  .map((item) => `${item.instance_id} ${item.lag}`)
                  .join(', '),
              })}`}
          </p>
        ) : (
          <p className='mt-1 text-destructive'>
            {t('gatewayWorkerControlPlaneUnavailable')}
          </p>
        )}
      </div>
    </section>
  )
}
