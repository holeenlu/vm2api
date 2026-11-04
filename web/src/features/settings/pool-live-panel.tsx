import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Activity, Eye, Radio } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { seatTitle } from '@/lib/vm-status'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { SeatCells, SeatLegend } from '@/components/scheduler-viz'
import { vmsListQueryOptions } from '@/features/vm/queries'
import { usePoolSeatStream } from '@/features/vm/use-pool-seat-stream'
import { predictSeatOrder } from './pool-seat-order'
import { PaneSection } from './scheduler-controls'

function Kpi({
  label,
  value,
  hint,
  tone,
  children,
}: {
  label: string
  value: React.ReactNode
  hint?: React.ReactNode
  tone?: 'warn' | 'bad'
  children?: React.ReactNode
}) {
  return (
    <div className='min-w-0 rounded-lg border bg-background/60 px-3 py-2.5'>
      <div className='text-[11px] text-muted-foreground'>{label}</div>
      <div
        className={cn(
          'mt-0.5 text-xl leading-7 font-semibold tabular-nums',
          tone === 'warn' && 'text-[color:var(--status-warn)]',
          tone === 'bad' && 'text-[color:var(--status-bad)]'
        )}
      >
        {value}
      </div>
      {children}
      {hint ? (
        <div className='mt-1 text-[11px] leading-4 text-muted-foreground'>
          {hint}
        </div>
      ) : null}
    </div>
  )
}

/** 实时态势：席位、排队与「下一席位落点」。数据来自 VM 列表 + 席位 SSE。 */
export function PoolLivePanel({
  strategy,
  queueMax,
}: {
  /** 草稿策略，用来预估开席顺序。 */
  strategy: string
  /** 草稿 queue_max；与运行值不同时提示保存后生效。 */
  queueMax: number
}) {
  const { t } = useTranslation('settings')

  const list = useQuery(vmsListQueryOptions(5000))
  usePoolSeatStream()
  const rows = useMemo(
    () => predictSeatOrder(list.data?.items || [], strategy, t),
    [list.data?.items, strategy, t]
  )
  const poolQueue = list.data?.pool_queue
  const totals = rows.reduce(
    (acc, row) => ({
      used: acc.used + row.used,
      grace: acc.grace + row.grace,
      max: acc.max + row.max,
      queued: acc.queued + row.queued,
      conc: acc.conc + row.concWaiting,
    }),
    { used: 0, grace: 0, max: 0, queued: 0, conc: 0 }
  )
  const outOfPool = rows.filter((row) => !row.inPool)
  const globalDepth = poolQueue?.global_queue_depth ?? 0
  const runningMax = poolQueue?.queue_max ?? 0
  const queuedAll = totals.queued + globalDepth
  const queueFill = runningMax
    ? Math.min(100, (queuedAll / runningMax) * 100)
    : 0
  const seatFill = totals.max ? (totals.used / totals.max) * 100 : 0
  const [detailsOpen, setDetailsOpen] = useState(false)

  return (
    <PaneSection
      icon={Activity}
      title={t('poolLive.title')}
      desc={t('poolLive.description')}
      aside={
        <span className='inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground'>
          <Radio
            className='size-3 text-[color:var(--status-ok-solid)] motion-safe:animate-pulse'
            aria-hidden
          />
          {t('live')}
        </span>
      }
    >
      <div className='flex flex-wrap items-center justify-between gap-3'>
        <div className='flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-xs'>
          <span className='font-medium'>
            {t('poolLive.seats', { value1: totals.used, value2: totals.max })}
          </span>
          <span
            className={cn(
              totals.queued > 0 && 'text-[color:var(--status-warn)]'
            )}
          >
            {t('poolLive.queue', {
              value1: queuedAll,
              value2: runningMax || '—',
            })}
          </span>
          <span className='text-muted-foreground'>
            {t('poolLive.poolSize', {
              value1: rows.length - outOfPool.length,
              value2: rows.length,
            })}
          </span>
        </div>
        <Dialog open={detailsOpen} onOpenChange={setDetailsOpen}>
          <DialogTrigger asChild>
            <Button type='button' variant='outline' size='sm'>
              <Eye className='size-4' aria-hidden />
              {t('poolLive.viewDetails')}
            </Button>
          </DialogTrigger>
          <DialogContent className='flex max-h-[90dvh] max-w-5xl flex-col overflow-hidden'>
            <DialogHeader>
              <DialogTitle>{t('poolLive.dialogTitle')}</DialogTitle>
              <DialogDescription>{t('poolLive.draftHelp')}</DialogDescription>
            </DialogHeader>
            <div className='min-h-0 flex-1 space-y-4 overflow-y-auto pr-1'>
              <div className='grid grid-cols-2 gap-2 sm:grid-cols-4'>
                <Kpi
                  label={t('poolLive.seatUsage')}
                  value={
                    <>
                      {totals.used}
                      <span className='text-sm font-normal text-muted-foreground'>
                        /{totals.max}
                      </span>
                    </>
                  }
                  hint={t('poolLive.gracePool', {
                    value1: totals.grace,
                    value2: rows.length - outOfPool.length,
                    value3: rows.length,
                  })}
                >
                  <div className='mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted'>
                    <div
                      className='h-full rounded-full bg-primary transition-[width] duration-300'
                      style={{ width: `${seatFill}%` }}
                    />
                  </div>
                </Kpi>
                <Kpi
                  label={t('poolLive.vmQueue')}
                  value={totals.queued}
                  tone={totals.queued ? 'warn' : undefined}
                  hint={t('poolLive.waitingConcurrency', {
                    value1: totals.conc,
                  })}
                />
                <Kpi
                  label={t('pool.globalQueue')}
                  value={globalDepth}
                  tone={globalDepth ? 'warn' : undefined}
                  hint={t('poolLive.waitingSeat')}
                />
                <Kpi
                  label={t('poolLive.queueLimit')}
                  value={
                    <>
                      {queuedAll}
                      <span className='text-sm font-normal text-muted-foreground'>
                        /{runningMax || '—'}
                      </span>
                    </>
                  }
                  tone={
                    queueFill >= 100
                      ? 'bad'
                      : queueFill >= 80
                        ? 'warn'
                        : undefined
                  }
                  hint={
                    !runningMax
                      ? t('poolLive.loadingLimit')
                      : runningMax !== queueMax
                        ? t('poolLive.pendingLimit', {
                            value1: runningMax,
                            value2: queueMax,
                          })
                        : t('poolLive.fullReturns')
                  }
                >
                  <div className='mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted'>
                    <div
                      className={cn(
                        'h-full rounded-full transition-[width] duration-300',
                        queueFill >= 80
                          ? 'bg-[color:var(--status-warn-solid)]'
                          : 'bg-primary'
                      )}
                      style={{ width: `${queueFill}%` }}
                    />
                  </div>
                </Kpi>
              </div>
              <div className='space-y-2'>
                <div className='flex flex-wrap items-center justify-between gap-2'>
                  <div className='text-xs font-medium'>
                    {t('poolLive.vmSeats')}
                  </div>
                  <SeatLegend />
                </div>
                {list.isError ? (
                  <p className='rounded-lg border border-[color:var(--status-bad)]/40 px-3 py-6 text-center text-xs text-[color:var(--status-bad)]'>
                    {t('poolLive.loadFailed')}
                  </p>
                ) : rows.length ? (
                  <ul className='grid gap-2 sm:grid-cols-2 xl:grid-cols-3'>
                    {rows.map((row) => (
                      <li key={row.vm.id}>
                        <Link
                          to='/vm/$id'
                          params={{ id: row.vm.id }}
                          title={seatTitle(row.vm)}
                          className={cn(
                            'flex h-full items-center gap-3 rounded-lg border px-3 py-2 hover:border-primary/50 hover:bg-accent/40',
                            !row.inPool && 'opacity-60'
                          )}
                        >
                          <span className='grid size-6 shrink-0 place-items-center rounded-full bg-muted text-[11px] font-semibold tabular-nums'>
                            {row.rank ?? '—'}
                          </span>
                          <div className='min-w-0 flex-1 space-y-1'>
                            <div className='flex items-baseline justify-between gap-2'>
                              <span className='truncate text-xs font-medium'>
                                {row.vm.name || row.vm.id}
                              </span>
                              <span className='shrink-0 text-[11px] text-muted-foreground tabular-nums'>
                                {row.why ? `${row.why} · ` : ''}
                                {row.used}/{row.max}
                                {row.queued
                                  ? t('poolLive.queuedSuffix', {
                                      value1: row.queued,
                                    })
                                  : ''}
                              </span>
                            </div>
                            <SeatCells
                              used={row.used}
                              grace={row.grace}
                              max={row.max}
                              next={row.rank === 1}
                              size='sm'
                            />
                          </div>
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className='rounded-lg border border-dashed px-3 py-6 text-center text-xs text-muted-foreground'>
                    {list.isLoading ? t('reading') : t('poolLive.empty')}
                  </p>
                )}
              </div>
            </div>
            <DialogFooter>
              <Button
                type='button'
                variant='outline'
                className='min-h-11'
                onClick={() => setDetailsOpen(false)}
              >
                {t('off')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </PaneSection>
  )
}
