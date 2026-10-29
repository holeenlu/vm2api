import { useQuery } from '@tanstack/react-query'
import { i18n } from '@/i18n'
import { useTranslation } from 'react-i18next'
import { api } from '@/lib/api'
import { PageHeader } from '@/components/page-header'
import { StatCard } from '@/components/stat-card'

type Snapshot = {
  uptime: number
  traffic: {
    sla: number | null
    client_rejections: number
    rpm: number
    requests: number
    server_errors: number
    ttft_ms: number | null
    duration_ms: number | null
  }
  queues: { waiting: number }
  tasks: { scheduled: number; running: string[] }
  alerts: { code: string; message: string; to: string }[]
  concurrency: { users: Record<string, number>; keys: Record<string, number> }
  memory: { rss: number }
  resources: { total: number; running: number; schedulable: number }
  errors: {
    request_id: string
    created_at: string
    status: number
    error_code: string
    error_message: string
    vm_id: string
    model: string
  }[]
}
export function OpsPage() {
  const { t: translate } = useTranslation('ops')

  const q = useQuery({
    queryKey: ['panel', 'ops'],
    queryFn: () => api<Snapshot>('/api/panel/ops'),
    refetchInterval: 10000,
  })
  const d = q.data
  return (
    <PageHeader
      title={translate('ops:title')}
      description={translate('ops:description')}
    >
      {q.error ? (
        <p role='alert' className='text-destructive'>
          {q.error.message}
        </p>
      ) : null}
      {d?.alerts.length ? (
        <div className='mb-4 space-y-2 rounded border border-amber-500/30 p-3'>
          {d.alerts.map((a) => (
            <p key={a.code} className='text-sm'>
              <a href={'#' + a.to} className='underline'>
                {a.code === 'queue_waiting'
                  ? translate('ops:alertQueueWaiting', {
                      count: d.queues.waiting,
                    })
                  : a.code === 'no_ready_supply'
                    ? translate('ops:alertNoSupply')
                    : a.code === 'service_failures'
                      ? translate('ops:alertServiceFailures', {
                          count: d.traffic.server_errors,
                        })
                      : a.message}
              </a>
            </p>
          ))}
        </div>
      ) : null}
      <div className='mb-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4'>
        <StatCard
          label={translate('ops:requestsLastHour')}
          value={String(d?.traffic.requests ?? '—')}
        />
        <StatCard
          label={translate('ops:serverErrors')}
          value={String(d?.traffic.server_errors ?? '—')}
        />
        <StatCard
          label={translate('ops:ttftMilliseconds')}
          value={String(
            d?.traffic.ttft_ms == null
              ? translate('ops:noSamples')
              : Math.round(d.traffic.ttft_ms)
          )}
        />
        <StatCard
          label={translate('ops:siteSla')}
          value={
            d?.traffic.sla == null
              ? translate('ops:noSamples')
              : (d.traffic.sla * 100).toFixed(2) + '%'
          }
        />
        <StatCard
          label={translate('ops:clientRejections')}
          value={String(d?.traffic.client_rejections ?? '—')}
        />
        <StatCard
          label={translate('ops:waitingRequests')}
          value={String(d?.queues.waiting ?? '—')}
        />
        <StatCard
          label={translate('ops:scheduledAndRunningTasks')}
          value={d ? d.tasks.scheduled + ' / ' + d.tasks.running.length : '—'}
        />
        <StatCard
          label={translate('ops:userInFlightRequests')}
          value={
            d
              ? String(
                  Object.values(d.concurrency.users).reduce((a, b) => a + b, 0)
                )
              : '—'
          }
        />
        <StatCard
          label={translate('ops:runningAndTotalVms')}
          value={String(
            d ? d.resources.running + ' / ' + d.resources.total : '—'
          )}
        />
        <StatCard
          label={translate('ops:schedulingEnabled')}
          value={String(d?.resources.schedulable ?? '—')}
        />
        <StatCard
          label={translate('ops:controlPlaneMemory')}
          value={String(d ? Math.round(d.memory.rss / 1048576) : '—')}
        />
        <StatCard
          label={translate('ops:uptimeMinutes')}
          value={String(d ? Math.round(d.uptime / 60) : '—')}
        />
      </div>
      <div className='overflow-auto rounded border'>
        <table className='w-full text-sm'>
          <thead>
            <tr className='border-b bg-muted/40'>
              {[
                translate('ops:time'),
                translate('ops:request'),
                'VM',
                translate('ops:model'),
                translate('ops:status'),
                translate('ops:error'),
              ].map((v) => (
                <th key={v} className='p-3 text-left'>
                  {v}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {d?.errors.map((e) => (
              <tr key={e.request_id} className='border-b'>
                <td className='p-3'>
                  {new Date(e.created_at).toLocaleTimeString(i18n.language)}
                </td>
                <td className='p-3 font-mono text-xs'>{e.request_id}</td>
                <td className='p-3'>{e.vm_id || '—'}</td>
                <td className='p-3'>{e.model}</td>
                <td className='p-3'>{e.status}</td>
                <td className='max-w-sm p-3'>
                  {e.error_code}
                  <p className='text-xs text-muted-foreground'>
                    {e.error_message}
                  </p>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </PageHeader>
  )
}
