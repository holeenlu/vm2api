import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { api } from '@/lib/api'
import { fmtNum } from '@/lib/format'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from '@/components/ui/sheet'
import {
  quotaWindows,
  stateLabel,
  number,
  time,
  type Resource,
  type VendorAccountDetail,
} from './portal-model'

const compact = (value: number | null | undefined) =>
  value == null ? '—' : fmtNum(value)
const rate = (value: number | null | undefined) =>
  value == null ? '—' : (value * 100).toFixed(1) + '%'
export function AccountDetails({
  resource,
  apiBase = '/api/vendor/accounts',
  canManage,
  onClose,
  onChanged,
}: {
  resource: Resource
  apiBase?: string
  canManage: boolean
  onClose: () => void
  onChanged: () => void
}) {
  const { t } = useTranslation('vendor')
  const qc = useQueryClient()
  const query = useQuery({
    queryKey: ['vendor', apiBase, 'account', resource.id],
    queryFn: () => api<VendorAccountDetail>(apiBase + '/' + resource.id),
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
  })
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const data = query.data
  const clear = async () => {
    setBusy(true)
    setError('')
    try {
      await api(apiBase + '/' + resource.id + '/cooldown/clear', {
        method: 'POST',
      })
      await query.refetch()
      void qc.invalidateQueries({ queryKey: ['vendor', 'accounts'] })
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('updateFailed'))
    } finally {
      setBusy(false)
    }
  }
  const fields = data
    ? [
        [t('proxy'), data.proxy?.endpoint || '—'],
        [
          t('details.proxyRegion'),
          [data.proxy?.country || data.proxy?.region, data.proxy?.city]
            .filter(Boolean)
            .join(' · ') || t('details.regionUnknown'),
        ],
        [t('details.owner'), data.owner.name],
        [
          t('authMethod'),
          t('wb.method.' + String(data.config.auth_method || 'oauth')),
        ],
        [t('details.weight'), number(data.telemetry?.priority)],
        [
          t('details.totalRequests'),
          number(data.all_time_usage?.requests) +
            ' · ' +
            compact(data.all_time_usage?.total_tokens) +
            ' ' +
            t('token'),
        ],
        [t('createdAt'), time(data.created_at)],
        [t('groups'), data.groups?.map((g) => g.name).join('、') || '—'],
        [t('wb.column.notes'), data.notes || '—'],
      ]
    : []
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <SheetContent className='flex w-full flex-col gap-0 sm:max-w-xl'>
        <SheetHeader className='border-b px-6 py-5'>
          <SheetTitle>
            {resource.name} · {t('details.accountTitle')}
          </SheetTitle>
          <SheetDescription>{t('details.snapshotHelp')}</SheetDescription>
        </SheetHeader>
        <div className='min-h-0 flex-1 space-y-6 overflow-y-auto px-6 py-5'>
          {query.isPending ? (
            <p>{t('loading')}</p>
          ) : query.error ? (
            <p role='alert' className='text-sm text-destructive'>
              {query.error.message}
            </p>
          ) : (
            data && (
              <>
                <section className='space-y-3'>
                  <h3 className='font-semibold'>{t('details.basicInfo')}</h3>
                  <dl className='grid grid-cols-[100px_1fr] gap-x-4 gap-y-3 text-sm'>
                    {fields.map(([label, value]) => (
                      <div key={label} className='contents'>
                        <dt className='text-muted-foreground'>{label}</dt>
                        <dd className='min-w-0 break-words'>{value}</dd>
                      </div>
                    ))}
                  </dl>
                </section>
                <section className='space-y-3'>
                  <h3 className='font-semibold'>
                    {t('details.runtimeMetrics')}
                  </h3>
                  <dl className='grid grid-cols-[100px_1fr] gap-x-4 gap-y-3 text-sm'>
                    <dt className='text-muted-foreground'>
                      {t('details.throughput')}
                    </dt>
                    <dd>
                      {number(data.telemetry?.rpm)} {t('wb.rpm')} ·{' '}
                      {compact(data.telemetry?.tpm_with_cache)} {t('wb.tpm')}
                      <p className='mt-1 text-xs text-muted-foreground'>
                        {t('wb.tpmWithoutCache')} {compact(data.telemetry?.tpm)}{' '}
                        · {t('wb.recentMinute')}
                      </p>
                    </dd>
                    {[
                      [t('details.todaySuccess'), data.today_usage],
                      [t('details.totalSuccess'), data.all_time_usage],
                    ].map(([label, usage]) => {
                      const m = typeof usage === 'object' ? usage : null
                      return (
                        <div className='contents' key={String(label)}>
                          <dt className='text-muted-foreground'>
                            {String(label)}
                          </dt>
                          <dd>
                            {rate(m?.success_rate)}{' '}
                            <span className='text-muted-foreground'>
                              {number(m?.success)} / {number(m?.requests)}
                            </span>
                          </dd>
                        </div>
                      )
                    })}
                    <dt className='text-muted-foreground'>
                      {t('liveConcurrency')}
                    </dt>
                    <dd>
                      {number(data.telemetry?.inflight)} /{' '}
                      {data.telemetry?.max_concurrency === 0
                        ? t('unlimited')
                        : number(data.telemetry?.max_concurrency)}
                    </dd>
                  </dl>
                </section>
                <section className='space-y-3'>
                  <h3 className='font-semibold'>{t('details.currentState')}</h3>
                  <div className='flex items-center gap-3 text-sm'>
                    <span className='rounded-md bg-muted px-2 py-1'>
                      {stateLabel(data.telemetry?.state || 'provisioning')}
                    </span>
                    <span>
                      {t(
                        data.schedulable
                          ? 'details.schedulable'
                          : 'details.notSchedulable'
                      )}
                    </span>
                  </div>
                  {data.telemetry?.failure_category && (
                    <p className='text-xs text-destructive'>
                      {t('wb.failure.' + data.telemetry.failure_category)}
                    </p>
                  )}
                </section>
                <section className='space-y-3'>
                  <h3 className='font-semibold'>
                    {t('details.accountCooldown')}
                  </h3>
                  {data.cooldowns.length ? (
                    <dl className='space-y-2 text-sm'>
                      {data.cooldowns.map((c) => (
                        <div
                          key={c.kind}
                          className='flex justify-between gap-3'
                        >
                          <dt className='text-muted-foreground'>
                            {t('details.cooldownType.' + c.kind)}
                          </dt>
                          <dd>{time(c.until)}</dd>
                        </div>
                      ))}
                    </dl>
                  ) : (
                    <p className='text-sm text-muted-foreground'>
                      {t('details.noCooldown')}
                    </p>
                  )}
                </section>
                <section className='space-y-4'>
                  <h3 className='font-semibold'>
                    {t('details.quotaTitle', {
                      platform:
                        data.config.platform === 'openai' ? 'OpenAI' : 'Claude',
                    })}
                  </h3>
                  {quotaWindows(data).map((q) => (
                    <div key={q.key} className='space-y-2'>
                      <div className='flex justify-between gap-3 text-sm'>
                        <span>{t('wb.shortWindow.' + q.key)}</span>
                        <span className='text-muted-foreground'>
                          {q.value == null
                            ? '—'
                            : (q.value * 100).toFixed(1) + '%'}
                        </span>
                      </div>
                      <div className='h-1.5 overflow-hidden rounded-full bg-muted'>
                        <div
                          className={
                            'h-full rounded-full ' +
                            (q.value != null && q.value >= 0.99
                              ? 'bg-destructive'
                              : 'bg-primary')
                          }
                          style={{
                            width:
                              Math.min(100, Math.max(0, (q.value || 0) * 100)) +
                              '%',
                          }}
                        />
                      </div>
                      <p className='text-xs text-muted-foreground'>
                        {q.reset
                          ? t('details.resetsAt', { time: time(q.reset) })
                          : t('resetUnknown')}
                      </p>
                    </div>
                  ))}
                </section>
                <section className='space-y-3'>
                  <h3 className='font-semibold'>{t('details.modelLimits')}</h3>
                  {data.model_limits == null ? (
                    <p className='text-sm text-muted-foreground'>
                      {t('unknown')}
                    </p>
                  ) : data.model_limits.length ? (
                    <table className='w-full text-sm'>
                      <tbody>
                        {data.model_limits.map((m) => (
                          <tr key={m.model} className='border-b last:border-0'>
                            <td className='py-2 break-all'>{m.model}</td>
                            <td className='py-2 text-end text-muted-foreground'>
                              {m.until ? time(m.until) : t('resetUnknown')}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <p className='text-sm text-muted-foreground'>
                      {t('details.noModelLimits')}
                    </p>
                  )}
                </section>
                <p className='text-xs text-muted-foreground'>
                  {t('details.snapshotAt', { time: time(data.snapshot_at) })}
                </p>
              </>
            )
          )}
          {error && (
            <p role='alert' className='text-sm text-destructive'>
              {error}
            </p>
          )}
        </div>
        {canManage && resource.status !== 'archived' && (
          <SheetFooter className='border-t p-4'>
            <p className='text-xs text-muted-foreground'>
              {t('details.clearHelp')}
            </p>
            <Button
              variant='outline'
              disabled={busy || query.isPending}
              onClick={() => void clear()}
            >
              <RefreshCw className={busy ? 'animate-spin' : ''} />
              {t('details.clearCooldown')}
            </Button>
          </SheetFooter>
        )}
      </SheetContent>
    </Sheet>
  )
}
