import { useTranslation } from 'react-i18next'
import { systemDateTime } from '@/lib/system-time'

const minute = (value: string) =>
  systemDateTime(value).slice(0, 16).replace('T', ' ')

// 控制面运行状态（审计 U8，见 src/lib/executor/control-plane-status.mjs）
export type ControlPlaneStatus = {
  switches: {
    name: string
    value: string
    valid: boolean
    allowed?: string[]
    given?: string
    scope?: string
  }[]
  events: {
    mode?: string
    since_hours: number
    by_status: Record<string, number>
    attempts: Record<string, number>
    lag: { instance_id: string; lag: number }[]
  } | null
  refresh_leases: {
    by_state: Record<string, number>
    ambiguous: {
      account_resource_id: string
      grant_kind: string
      holder_instance_id: string
      expires_at: string
    }[]
    denials: {
      since: string
      counts: Record<string, number>
      recent: {
        reason: string
        account_resource_id: string | null
        grant: string | null
        instance_id: string | null
        holder: string | null
        at: string
      }[]
    }
  } | null
}

const DENIAL_LABELS: Record<string, string> = {
  lease_held: 'gatewayWorkerLeaseDenialHeld',
  stale_revision: 'gatewayWorkerLeaseDenialStaleRevision',
  stale_token: 'gatewayWorkerLeaseDenialStaleToken',
  outcome_unknown: 'gatewayWorkerLeaseDenialOutcomeUnknown',
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
  const leases = status.refresh_leases
  const problems = events
    ? sum(events.by_status, ['diff', 'missing', 'failed', 'invalid'])
    : 0
  const attemptProblems = events ? sum(events.attempts, ['failed']) : 0
  const denials = leases ? Object.entries(leases.denials.counts) : []
  return (
    <section
      className='space-y-3 rounded-lg border p-4 text-sm'
      data-testid='control-plane-status'
    >
      <h2 className='font-medium'>{t('gatewayWorkerControlPlane')}</h2>
      <div>
        <div className='text-xs text-muted-foreground'>
          {t('gatewayWorkerControlPlaneSwitches')}
        </div>
        <ul className='mt-1 flex flex-wrap gap-x-4 gap-y-1'>
          {status.switches.map((item) => (
            <li
              key={item.name}
              className={item.valid ? '' : 'text-destructive'}
              title={item.allowed?.join(' / ')}
            >
              <code>{item.name}</code> = {item.value}
              {item.scope === 'control_plane_env' &&
                ` · ${t('gatewayWorkerControlPlaneRedisHint')}`}
              {!item.valid &&
                ` · ${t('gatewayWorkerControlPlaneInvalidSwitch', { value: item.given })}`}
            </li>
          ))}
        </ul>
      </div>
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
      <div>
        <div className='text-xs text-muted-foreground'>
          {t('gatewayWorkerControlPlaneLeases')}
        </div>
        {leases ? (
          <div className='mt-1 space-y-1'>
            <p className={leases.ambiguous.length ? 'text-amber-600' : ''}>
              {t('gatewayWorkerControlPlaneLeaseCounts', {
                held: leases.by_state.held || 0,
                ambiguous: leases.by_state.ambiguous || 0,
                expired: leases.by_state.expired || 0,
              })}
              {` · ${
                denials.length
                  ? t('gatewayWorkerControlPlaneDenials', {
                      time: minute(leases.denials.since),
                      value: denials
                        .map(
                          ([reason, count]) =>
                            `${t(DENIAL_LABELS[reason] || reason)} ${count}`
                        )
                        .join(', '),
                    })
                  : t('gatewayWorkerControlPlaneNoDenials', {
                      time: minute(leases.denials.since),
                    })
              }`}
            </p>
            {leases.ambiguous.slice(0, 5).map((item) => (
              <p
                key={`${item.account_resource_id}:${item.grant_kind}`}
                className='text-xs text-amber-600'
              >
                {t('gatewayWorkerControlPlaneAmbiguous', {
                  account: item.account_resource_id,
                  grant: item.grant_kind,
                  instance: item.holder_instance_id,
                  time: minute(item.expires_at),
                })}
              </p>
            ))}
          </div>
        ) : (
          <p className='mt-1 text-destructive'>
            {t('gatewayWorkerControlPlaneUnavailable')}
          </p>
        )}
      </div>
    </section>
  )
}
