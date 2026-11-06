import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Pause, Play, RefreshCw, ServerCog } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { api } from '@/lib/api'
import { systemDateTime } from '@/lib/system-time'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PageHeader } from '@/components/page-header'
import {
  ControlPlaneStatusCard,
  type ControlPlaneStatus,
} from './control-plane-status'

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
  mtls_unsupported: 'gatewayWorkerSupervisorMtlsUnsupported',
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
  /** 两次心跳之间的峰值在途数（心跳只采样瞬时值） */
  peak_concurrency?: number
  queue_depth?: number
  last_heartbeat_at?: string | null
  admission_state?: string | null
  drain_deadline?: string | null
  certificate_expires_at?: string | null
  receipt_backlog?: number
  last_error?: string | null
  capabilities?: { mtls?: boolean; responses_ws_bridge?: boolean }
  /** 事件发件箱水位（心跳上报，统一控制面重构 P1） */
  executor_events?: {
    required?: boolean
    head?: number
    acked?: number
    backlog_bytes?: number
    healthy?: boolean
    error?: string
  } | null
  /** 共享运行态（心跳上报，统一控制面重构 P5，KIN_REDIS_URL） */
  shared_state?: {
    backend?: 'redis' | 'local'
    healthy?: boolean
    last_error?: string
    leases_held?: number
    remote_holds?: number
  } | null
  /** 事实直读影子比对（设计第 19 节 G2）：Worker 直读控制面数据库与投影账号的逐项比较 */
  facts?: {
    accounts?: number
    with_errors?: number
    last_error?: string
    shadow?: {
      checked_at?: string
      matched?: number
      mismatched?: number
      items?: { account: string; fields: string[] }[]
      missing_in_store?: string[]
      missing_in_facts?: string[]
    }
  } | null
  /** 托管公钥（统一控制面重构 P3.5）：首次登记后固定；上报的新公钥待管理员确认（R3 审查 P1-5） */
  custody_public_key?: string | null
  custody_key_pending?: string | null
  custody_key_fingerprint?: string | null
  custody_key_pending_fingerprint?: string | null
  /** 待批准（中期技术债 M2 复审 P1-1）：新实例 ID 以共用令牌登记，批准或完成引导前不投影、不派发 */
  approval_state?: 'pending' | null
  /** 实例内部 HMAC 密钥（中期技术债 M2）：issued 已在用、pending 已签发未使用、none 未签发；只含指纹 */
  instance_key?: {
    state: 'issued' | 'pending' | 'none'
    keys: {
      key_id: string
      fingerprint: string
      state: 'active' | 'retiring'
      confirmed_at?: string | null
      expires_at?: string | null
    }[]
    /** 管理员开的一次性引导授权到期时间（未使用时） */
    bootstrap_allowed_until?: string | null
  }
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
  const [allowId, setAllowId] = useState('')
  const query = useQuery({
    queryKey: ['gateway-workers', 'instances'],
    queryFn: () =>
      api<{
        items: GatewayInstance[]
        multi_worker?: boolean
        supervisor?: SupervisorState | null
        control_plane?: ControlPlaneStatus
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
  async function acceptCustodyKey(id: string, publicKey: string) {
    setBusy(id + 'custody')
    try {
      await api(
        `/api/panel/gateway-workers/${encodeURIComponent(id)}/custody-key/accept`,
        { method: 'POST', body: JSON.stringify({ public_key: publicKey }) }
      )
      await qc.invalidateQueries({ queryKey: ['gateway-workers', 'instances'] })
    } finally {
      setBusy(null)
    }
  }
  async function instanceKeyAction(
    id: string,
    kind: 'rotate' | 'revoke' | 'allow-bootstrap'
  ) {
    const confirmKey = {
      rotate: 'gatewayWorkerInstanceKeyRotateConfirm',
      revoke: 'gatewayWorkerInstanceKeyRevokeConfirm',
      'allow-bootstrap': 'gatewayWorkerInstanceKeyAllowConfirm',
    }[kind]
    if (!window.confirm(t(confirmKey, { id }))) return
    setBusy(id + 'instance-key')
    try {
      await api(
        `/api/panel/gateway-workers/${encodeURIComponent(id)}/instance-key/${kind}`,
        { method: 'POST', body: '{}' }
      )
      await qc.invalidateQueries({ queryKey: ['gateway-workers', 'instances'] })
    } finally {
      setBusy(null)
    }
  }
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
          className={`rounded-lg border p-3 text-sm ${['backoff', 'missing_binary', 'missing_secret', 'mtls_unsupported'].includes(supervisor.status) ? 'border-destructive/50 text-destructive' : 'text-muted-foreground'}`}
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
      {query.data?.control_plane && (
        <ControlPlaneStatusCard status={query.data.control_plane} />
      )}
      {query.isError && (
        <p className='text-sm text-destructive'>
          {t('gatewayWorkerLoadFailed')}
        </p>
      )}
      <form
        className='flex flex-wrap items-center gap-2 text-sm'
        onSubmit={(event) => {
          event.preventDefault()
          const id = allowId.trim()
          if (id) void instanceKeyAction(id, 'allow-bootstrap')
        }}
      >
        <span className='text-muted-foreground'>
          {t('gatewayWorkerInstanceKeyAllowNew')}
        </span>
        <Input
          className='h-8 w-56'
          value={allowId}
          onChange={(event) => setAllowId(event.target.value)}
          placeholder={t('gatewayWorkerInstanceIdPlaceholder')}
          aria-label={t('gatewayWorkerInstanceIdPlaceholder')}
        />
        <Button
          size='sm'
          variant='outline'
          type='submit'
          disabled={!!busy || !allowId.trim()}
        >
          {t('gatewayWorkerInstanceKeyAllow')}
        </Button>
      </form>
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
                <dd>
                  {t('gatewayWorkerConcurrencyValue', {
                    active: item.active_concurrency || 0,
                    peak: Math.max(
                      item.peak_concurrency || 0,
                      item.active_concurrency || 0
                    ),
                  })}
                </dd>
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
              {item.executor_events ? (
                <div>
                  <dt className='text-muted-foreground'>
                    {t('gatewayWorkerEvents')}
                  </dt>
                  <dd
                    className={stateClass(
                      item.executor_events.healthy === false
                        ? 'degraded'
                        : 'healthy'
                    )}
                    title={item.executor_events.error || undefined}
                  >
                    {t(
                      item.executor_events.required
                        ? 'gatewayWorkerEventsConsumed'
                        : 'gatewayWorkerEventsSelfAcked',
                      {
                        pending: Math.max(
                          0,
                          (item.executor_events.head || 0) -
                            (item.executor_events.acked || 0)
                        ),
                        mib: (
                          (item.executor_events.backlog_bytes || 0) / 1048576
                        ).toFixed(1),
                      }
                    )}
                  </dd>
                </div>
              ) : null}
              {item.shared_state?.backend === 'redis' ? (
                <div>
                  <dt className='text-muted-foreground'>
                    {t('gatewayWorkerSharedState')}
                  </dt>
                  <dd
                    className={stateClass(
                      item.shared_state.healthy ? 'healthy' : 'degraded'
                    )}
                    title={item.shared_state.last_error || undefined}
                  >
                    {item.shared_state.healthy
                      ? t('gatewayWorkerSharedStateRedis', {
                          leases: item.shared_state.leases_held || 0,
                          holds: item.shared_state.remote_holds || 0,
                        })
                      : t('gatewayWorkerSharedStateDegraded')}
                  </dd>
                </div>
              ) : null}
              {item.facts ? (
                <div>
                  <dt className='text-muted-foreground'>
                    {t('gatewayWorkerFacts')}
                  </dt>
                  <dd
                    className={stateClass(
                      !item.facts.last_error &&
                        !item.facts.with_errors &&
                        !item.facts.shadow?.mismatched &&
                        !item.facts.shadow?.missing_in_store?.length &&
                        !item.facts.shadow?.missing_in_facts?.length
                        ? 'healthy'
                        : 'degraded'
                    )}
                    title={
                      [
                        item.facts.last_error,
                        ...(item.facts.shadow?.items || []).map(
                          (entry) =>
                            `${entry.account}: ${entry.fields.join(', ')}`
                        ),
                        ...(item.facts.shadow?.missing_in_store || []).map(
                          (id) => `${id}: missing_in_store`
                        ),
                        ...(item.facts.shadow?.missing_in_facts || []).map(
                          (id) => `${id}: missing_in_facts`
                        ),
                      ]
                        .filter(Boolean)
                        .join('\n') || undefined
                    }
                  >
                    {item.facts.last_error
                      ? t('gatewayWorkerFactsError')
                      : t('gatewayWorkerFactsShadow', {
                          matched: item.facts.shadow?.matched || 0,
                          mismatched: item.facts.shadow?.mismatched || 0,
                          errors: item.facts.with_errors || 0,
                        })}
                  </dd>
                </div>
              ) : null}
              {item.custody_key_pending ? (
                <div
                  className='col-span-full'
                  data-testid='custody-key-pending'
                >
                  <dt className='text-muted-foreground'>
                    {t('gatewayWorkerCustodyKey')}
                  </dt>
                  <dd className='space-y-2 text-amber-600'>
                    {/* 新实例的首个公钥同样要确认（终审 B2）：没有已确认的公钥时只显示新指纹 */}
                    <p>
                      {t(
                        item.custody_key_fingerprint
                          ? 'gatewayWorkerCustodyKeyPending'
                          : 'gatewayWorkerCustodyKeyFirst'
                      )}
                    </p>
                    <p className='font-mono text-xs break-all text-muted-foreground'>
                      {item.custody_key_fingerprint
                        ? `${item.custody_key_fingerprint} → `
                        : ''}
                      {item.custody_key_pending_fingerprint}
                    </p>
                    <Button
                      size='sm'
                      variant='outline'
                      disabled={busy === item.id + 'custody'}
                      onClick={() =>
                        void acceptCustodyKey(
                          item.id,
                          item.custody_key_pending as string
                        )
                      }
                    >
                      {t(
                        item.custody_key_fingerprint
                          ? 'gatewayWorkerCustodyKeyAccept'
                          : 'gatewayWorkerCustodyKeyAcceptFirst'
                      )}
                    </Button>
                  </dd>
                </div>
              ) : null}
              <div className='col-span-full' data-testid='instance-key'>
                <dt className='text-muted-foreground'>
                  {t('gatewayWorkerInstanceKey')}
                </dt>
                <dd className='space-y-2'>
                  {item.approval_state === 'pending' ? (
                    <p
                      className='text-amber-600'
                      data-testid='approval-pending'
                    >
                      {t('gatewayWorkerApprovalPending')}
                    </p>
                  ) : null}
                  <p
                    className={stateClass(
                      item.instance_key?.state === 'issued'
                        ? 'active'
                        : item.instance_key?.state === 'pending'
                          ? 'pending'
                          : 'unknown'
                    )}
                  >
                    {t(
                      item.instance_key?.state === 'issued'
                        ? 'gatewayWorkerInstanceKeyIssued'
                        : item.instance_key?.state === 'pending'
                          ? 'gatewayWorkerInstanceKeyPending'
                          : 'gatewayWorkerInstanceKeyNone'
                    )}
                  </p>
                  {(item.instance_key?.keys || []).map((key) => (
                    <p
                      key={key.key_id}
                      className='font-mono text-xs break-all text-muted-foreground'
                    >
                      {key.key_id} · {key.fingerprint}
                      {key.state === 'retiring' && key.expires_at
                        ? ` · ${t('gatewayWorkerInstanceKeyRetiring', { time: new Date(key.expires_at).toLocaleString() })}`
                        : ''}
                    </p>
                  ))}
                  {item.instance_key?.bootstrap_allowed_until ? (
                    <p className='text-xs text-amber-600'>
                      {t('gatewayWorkerInstanceKeyAllowedUntil', {
                        time: systemDateTime(
                          item.instance_key.bootstrap_allowed_until
                        ).slice(0, 16),
                      })}
                    </p>
                  ) : null}
                  <div className='flex flex-wrap gap-2'>
                    {item.instance_key?.state !== 'issued' ? (
                      <Button
                        size='sm'
                        variant='outline'
                        disabled={!!busy}
                        onClick={() =>
                          void instanceKeyAction(item.id, 'allow-bootstrap')
                        }
                      >
                        {t(
                          item.approval_state === 'pending'
                            ? 'gatewayWorkerApprove'
                            : 'gatewayWorkerInstanceKeyAllow'
                        )}
                      </Button>
                    ) : null}
                  </div>
                  {item.instance_key && item.instance_key.state !== 'none' ? (
                    <div className='flex flex-wrap gap-2'>
                      <Button
                        size='sm'
                        variant='outline'
                        disabled={!!busy}
                        onClick={() =>
                          void instanceKeyAction(item.id, 'rotate')
                        }
                      >
                        {t('gatewayWorkerInstanceKeyRotate')}
                      </Button>
                      <Button
                        size='sm'
                        variant='outline'
                        disabled={!!busy}
                        onClick={() =>
                          void instanceKeyAction(item.id, 'revoke')
                        }
                      >
                        {t('gatewayWorkerInstanceKeyRevoke')}
                      </Button>
                    </div>
                  ) : null}
                </dd>
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
