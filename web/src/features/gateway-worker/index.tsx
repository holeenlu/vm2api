import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Pause, Play, RefreshCw, ServerCog } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { api } from '@/lib/api'
import { systemDateTime } from '@/lib/system-time'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/page-header'

// 控制面托管的同机 Worker 进程状态（见 src/lib/gateway-worker/worker-supervisor.mjs）
type SupervisorState = {
  status: string
  pid?: number | null
  restarts?: number
  last_exit?: { code: number | null; signal: string | null; at: string } | null
}
const SUPERVISOR_LABELS: Record<string, string> = {
  running: 'gatewayWorkerSupervisorRunning',
  backoff: 'gatewayWorkerSupervisorBackoff',
  missing_binary: 'gatewayWorkerSupervisorMissingBinary',
  missing_secret: 'gatewayWorkerSupervisorMissingSecret',
  external: 'gatewayWorkerSupervisorExternal',
}

const DRAIN_DEADLINE_MS = 10 * 60_000

type GatewayInstance = {
  id: string
  name: string
  base_url: string
  health_state: string
  drain_state: string
  version?: string | null
  active_concurrency?: number
  queue_depth?: number
  last_heartbeat_at?: string | null
  admission_state?: string | null
  drain_deadline?: string | null
  certificate_expires_at?: string | null
  receipt_backlog?: number
  last_error?: string | null
  capabilities?: { mtls?: boolean; responses_ws_bridge?: boolean }
}

function stateClass(state: string) {
  if (['healthy', 'active', 'accepting', 'synced'].includes(state))
    return 'text-emerald-600'
  if (['draining', 'paused', 'degraded', 'pending'].includes(state))
    return 'text-amber-600'
  return 'text-destructive'
}

export function GatewayWorkersPage() {
  const { t } = useTranslation('common')
  const qc = useQueryClient()
  const [busy, setBusy] = useState<string | null>(null)
  const query = useQuery({
    queryKey: ['gateway-workers', 'instances'],
    queryFn: () =>
      api<{
        items: GatewayInstance[]
        multi_worker?: boolean
        supervisor?: SupervisorState | null
      }>('/api/panel/gateway-workers'),
  })
  const items = query.data?.items || []
  const multiWorker = query.data?.multi_worker === true
  const supervisor = query.data?.supervisor
  const accepting = items.filter(
    (item) =>
      ['healthy', 'degraded'].includes(item.health_state) &&
      item.drain_state === 'accepting'
  ).length
  async function action(id: string, actionName: 'health' | 'drain' | 'resume') {
    setBusy(id + actionName)
    try {
      await api(
        `/api/panel/gateway-workers/${encodeURIComponent(id)}/${actionName}`,
        {
          method: 'POST',
          // 排空超过截止时间仍未完成的请求由 Worker 取消，避免下线无限等待
          ...(actionName === 'drain'
            ? {
                body: JSON.stringify({
                  deadline: new Date(
                    Date.now() + DRAIN_DEADLINE_MS
                  ).toISOString(),
                }),
              }
            : {}),
        }
      )
      await qc.invalidateQueries({ queryKey: ['gateway-workers', 'instances'] })
    } finally {
      setBusy(null)
    }
  }
  return (
    <div className='space-y-6'>
      <PageHeader
        title={t('gatewayWorkerTitle')}
        description={t('gatewayWorkerDescription')}
      />
      {query.data && (
        <p
          className={`rounded-lg border p-3 text-sm ${multiWorker && accepting > 1 ? 'border-amber-500/50 text-amber-700 dark:text-amber-400' : 'text-muted-foreground'}`}
        >
          {multiWorker
            ? accepting > 1
              ? t('gatewayWorkerMultiActive', { value: accepting })
              : t('gatewayWorkerMultiMode')
            : t('gatewayWorkerSingleMode')}
        </p>
      )}
      {supervisor && (
        <p
          className={`rounded-lg border p-3 text-sm ${['backoff', 'missing_binary', 'missing_secret'].includes(supervisor.status) ? 'border-destructive/50 text-destructive' : 'text-muted-foreground'}`}
        >
          {t(
            SUPERVISOR_LABELS[supervisor.status] ||
              'gatewayWorkerSupervisorIdle'
          )}
          {supervisor.pid
            ? ` · ${t('gatewayWorkerSupervisorPid', { value: supervisor.pid })}`
            : ''}
          {supervisor.restarts
            ? ` · ${t('gatewayWorkerSupervisorRestarts', { value: supervisor.restarts })}`
            : ''}
          {supervisor.last_exit
            ? ` · ${t('gatewayWorkerSupervisorLastExit', {
                value:
                  supervisor.last_exit.signal ??
                  String(supervisor.last_exit.code ?? ''),
                time: systemDateTime(supervisor.last_exit.at).slice(0, 16),
              })}`
            : ''}
        </p>
      )}
      {query.isError && (
        <p className='text-sm text-destructive'>
          {t('gatewayWorkerLoadFailed')}
        </p>
      )}
      {!query.isLoading && !items.length && (
        <p className='rounded-lg border p-6 text-sm text-muted-foreground'>
          {t('gatewayWorkerEmpty')}
        </p>
      )}
      <div className='grid gap-4 md:grid-cols-2'>
        {items.map((item) => (
          <section
            key={item.id}
            className='rounded-xl border bg-card p-5 shadow-sm'
          >
            <div className='flex items-start justify-between gap-3'>
              <div className='flex items-center gap-3'>
                <ServerCog className='size-5 text-primary' />
                <div>
                  <h2 className='font-semibold'>{item.name}</h2>
                  <p className='text-xs text-muted-foreground'>{item.id}</p>
                </div>
              </div>
              <span
                className={`text-sm font-medium ${stateClass(item.health_state)}`}
              >
                {item.health_state}
              </span>
            </div>
            <dl className='mt-4 grid grid-cols-2 gap-3 text-sm'>
              <div>
                <dt className='text-muted-foreground'>
                  {t('gatewayWorkerVersion')}
                </dt>
                <dd>{item.version || '—'}</dd>
              </div>
              <div>
                <dt className='text-muted-foreground'>
                  {t('gatewayWorkerDrain')}
                </dt>
                <dd className={stateClass(item.drain_state)}>
                  {item.drain_state}
                  {item.drain_state === 'draining' && item.drain_deadline && (
                    <span className='ml-1 text-xs text-muted-foreground'>
                      {t('gatewayWorkerDrainDeadline', {
                        time: new Date(
                          item.drain_deadline
                        ).toLocaleTimeString(),
                      })}
                    </span>
                  )}
                </dd>
              </div>
              <div>
                <dt className='text-muted-foreground'>
                  {t('gatewayWorkerConcurrency')}
                </dt>
                <dd>{item.active_concurrency || 0}</dd>
              </div>
              <div>
                <dt className='text-muted-foreground'>
                  {t('gatewayWorkerQueue')}
                </dt>
                <dd>{item.queue_depth || 0}</dd>
              </div>
              <div>
                <dt className='text-muted-foreground'>
                  {t('gatewayWorkerMtls')}
                </dt>
                <dd
                  className={stateClass(
                    item.capabilities?.mtls ? 'active' : 'paused'
                  )}
                >
                  {item.capabilities?.mtls
                    ? t('gatewayWorkerRequired')
                    : t('gatewayWorkerDevHmac')}
                </dd>
              </div>
              <div>
                <dt className='text-muted-foreground'>
                  {t('gatewayWorkerReceipt')}
                </dt>
                <dd>{item.receipt_backlog || 0}</dd>
              </div>
              <div>
                <dt className='text-muted-foreground'>
                  {t('gatewayWorkerAdmission')}
                </dt>
                <dd className={stateClass(item.admission_state || 'unknown')}>
                  {item.admission_state || t('unknown')}
                </dd>
              </div>
            </dl>
            <div className='mt-5 flex flex-wrap gap-2'>
              <Button
                size='sm'
                variant='outline'
                disabled={!!busy}
                onClick={() => action(item.id, 'health')}
              >
                <RefreshCw className='mr-1 size-4' />
                {t('gatewayWorkerCheck')}
              </Button>
              <Button
                size='sm'
                variant='outline'
                disabled={!!busy || item.drain_state === 'draining'}
                onClick={() => action(item.id, 'drain')}
              >
                <Pause className='mr-1 size-4' />
                {t('gatewayWorkerDrain')}
              </Button>
              <Button
                size='sm'
                variant='outline'
                disabled={!!busy || item.drain_state === 'accepting'}
                onClick={() => action(item.id, 'resume')}
              >
                <Play className='mr-1 size-4' />
                {t('gatewayWorkerResume')}
              </Button>
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}

export { CodexAccountsPage } from './accounts-page'
