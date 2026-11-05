import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { fmtNum } from '@/lib/format'
import { cn } from '@/lib/utils'
import { fmtHitPct } from '@/lib/vm-usage'
import { readPref, writePref } from '@/features/vm/vm-list-toolbar'
import {
  accountCounts,
  concurrencyOf,
  NEAR_LIMIT_PCT,
  quotaHighLoad,
  summarizeBucket,
  summarizeLive,
  windowDistribution,
  type QuotaWindow,
} from './account-overview-model'
import { liveStatsQueryOptions } from './queries'

const PREF = 'resource-overview-open'

function fmtMs(ms: number | null) {
  if (ms == null || !Number.isFinite(ms)) return '—'
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`
}

function Metric({
  label,
  value,
  sub,
  tone,
}: {
  label: string
  value: React.ReactNode
  sub?: string
  tone?: 'ok' | 'warn' | 'bad'
}) {
  return (
    <div className='flex min-w-0 flex-col gap-1 bg-card px-3.5 py-3'>
      <span className='truncate text-[11.5px] font-medium tracking-wide text-muted-foreground'>
        {label}
      </span>
      <span
        className={cn(
          'truncate text-[20px] leading-none font-[590] tracking-[-0.01em] tabular-nums',
          tone === 'ok' && 'text-[color:var(--status-ok)]',
          tone === 'warn' && 'text-[color:var(--status-warn)]',
          tone === 'bad' && 'text-[color:var(--status-bad)]'
        )}
      >
        {value}
      </span>
      {sub ? (
        <span className='truncate text-[11px] text-muted-foreground'>
          {sub}
        </span>
      ) : null}
    </div>
  )
}

function CountRow({
  label,
  n,
  tone,
}: {
  label: string
  n: number
  tone?: 'ok' | 'warn' | 'bad'
}) {
  return (
    <div className='flex items-baseline justify-between gap-3 text-xs'>
      <span className='text-muted-foreground'>{label}</span>
      <span
        className={cn(
          'font-semibold tabular-nums',
          n > 0 && tone === 'ok' && 'text-[color:var(--status-ok)]',
          n > 0 && tone === 'warn' && 'text-[color:var(--status-warn)]',
          n > 0 && tone === 'bad' && 'text-[color:var(--status-bad)]'
        )}
      >
        {n}
      </span>
    </div>
  )
}

function WindowBar({
  label,
  dist,
}: {
  label: string
  dist: ReturnType<typeof windowDistribution>
}) {
  const { t } = useTranslation('vm')
  const parts = [
    ['normal', 'var(--status-ok-solid)'],
    ['near', 'var(--status-warn-solid)'],
    ['reached', 'var(--status-bad-solid)'],
  ] as const
  return (
    <div className='flex min-w-0 flex-col gap-1.5 bg-card px-3.5 py-2.5'>
      <div className='flex items-baseline gap-1.5 text-xs'>
        <span className='font-medium'>{label}</span>
        <span className='text-muted-foreground tabular-nums'>
          · {t('vm:accountOverview.accounts', { count: dist.accounts })}
        </span>
      </div>
      <div className='flex h-1.5 w-full gap-px overflow-hidden rounded-full track-recessed'>
        {parts.map(([key, color]) =>
          dist[key] > 0 ? (
            <span
              key={key}
              className='h-full min-w-[3px]'
              style={{
                flexGrow: dist[key],
                flexBasis: 0,
                backgroundColor: color,
              }}
            />
          ) : null
        )}
      </div>
      <div className='flex flex-wrap gap-x-3 text-[11px] text-muted-foreground tabular-nums'>
        <span>{t('vm:accountOverview.normal', { n: dist.normal })}</span>
        <span title={`≥ ${NEAR_LIMIT_PCT}%`}>
          {t('vm:accountOverview.near', { n: dist.near })}
        </span>
        <span>{t('vm:accountOverview.reached', { n: dist.reached })}</span>
      </div>
    </div>
  )
}

/**
 * 账号概览：当前范围（入口、凭证面、归属筛选后）的账号数、实时指标与额度窗口分布。
 * 实时指标来自服务端最近 1 / 5 分钟的内存窗口；「全平台」一行是所有账号合计。
 */
export function AccountOverview({
  vms,
  enabled,
  className,
}: {
  vms: Vm[]
  enabled: boolean
  className?: string
}) {
  const { t } = useTranslation('vm')
  const [open, setOpen] = useState(
    () => readPref(PREF, ['1', '0'] as const, '1') === '1'
  )
  const live = useQuery({
    ...liveStatsQueryOptions(),
    enabled: enabled && open,
  })
  const counts = useMemo(() => accountCounts(vms), [vms])
  const conc = useMemo(() => concurrencyOf(vms), [vms])
  const scoped = useMemo(() => summarizeLive(vms, live.data), [vms, live.data])
  const platform = summarizeBucket(live.data?.total)
  const highLoad = useMemo(() => quotaHighLoad(vms), [vms])
  const windows = useMemo(
    () =>
      (['5h', '7d', 'fable'] as QuotaWindow[]).map((w) => ({
        w,
        dist: windowDistribution(vms, w),
      })),
    [vms]
  )
  const toggle = () => {
    setOpen(!open)
    writePref(PREF, open ? '0' : '1')
  }
  const recent1 = t('vm:accountOverview.last1m')
  const recent5 = t('vm:accountOverview.last5m')
  const known = Boolean(live.data)

  return (
    <section
      className={cn('overflow-hidden rounded-xl border bg-card', className)}
    >
      <div className='flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-3.5 py-2'>
        <div className='flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1'>
          <h3 className='text-[13px] font-medium'>
            {t('vm:accountOverview.title')}
          </h3>
          {known ? (
            <span className='text-[11.5px] text-muted-foreground tabular-nums'>
              {t('vm:accountOverview.platform', {
                rpm: fmtNum(platform.rpm),
                tpm: fmtNum(platform.tpm),
                io: fmtNum(platform.ioTpm),
              })}
            </span>
          ) : null}
        </div>
        <button
          type='button'
          onClick={toggle}
          aria-expanded={open}
          className='flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent/60'
        >
          {open
            ? t('vm:accountOverview.collapse')
            : t('vm:accountOverview.expand')}
          {open ? (
            <ChevronUp className='size-3.5' />
          ) : (
            <ChevronDown className='size-3.5' />
          )}
        </button>
      </div>
      {open ? (
        <>
          <div className='grid gap-px border-t bg-border/60 sm:grid-cols-3 lg:grid-cols-5 2xl:grid-cols-10'>
            <div className='grid grid-cols-[auto_1fr] items-center gap-x-5 bg-card px-3.5 py-3 sm:col-span-3 lg:col-span-2'>
              <div className='flex flex-col gap-1'>
                <span className='text-[11.5px] font-medium tracking-wide text-muted-foreground'>
                  {t('vm:accountOverview.total')}
                </span>
                <span className='text-[26px] leading-none font-[590] tabular-nums'>
                  {counts.total}
                </span>
              </div>
              <div className='grid grid-cols-2 gap-x-5 gap-y-1'>
                <CountRow
                  label={t('vm:accountOverview.available')}
                  n={counts.pool}
                  tone='ok'
                />
                <CountRow
                  label={t('vm:accountOverview.cooling')}
                  n={counts.restricted}
                  tone='warn'
                />
                <CountRow
                  label={t('vm:accountOverview.abnormal')}
                  n={counts.dead}
                  tone='bad'
                />
                <CountRow
                  label={t('vm:accountOverview.disabled')}
                  n={counts.off}
                />
                <CountRow
                  label={t('vm:accountOverview.noCredential')}
                  n={counts.none}
                />
              </div>
            </div>
            <Metric
              label={t('vm:accountOverview.rpm')}
              value={known ? fmtNum(scoped.rpm) : '—'}
              sub={recent1}
            />
            <Metric
              label={t('vm:accountOverview.tpm')}
              value={known ? fmtNum(scoped.tpm) : '—'}
              sub={t('vm:accountOverview.withCache')}
            />
            <Metric
              label={t('vm:accountOverview.ioTpm')}
              value={known ? fmtNum(scoped.ioTpm) : '—'}
              sub={t('vm:accountOverview.inputOutput')}
            />
            <Metric
              label={t('vm:accountOverview.concurrency')}
              value={
                <>
                  {conc.inflight}
                  <span className='text-[13px] font-normal text-muted-foreground'>
                    {' '}
                    / {conc.max || '—'}
                  </span>
                </>
              }
              sub={t('vm:accountOverview.inflightNow')}
            />
            <Metric
              label={t('vm:accountOverview.cacheHit')}
              value={fmtHitPct(scoped.hitPct)}
              sub={recent5}
            />
            <Metric
              label={t('vm:accountOverview.successRate')}
              value={
                scoped.successPct == null
                  ? '—'
                  : `${scoped.successPct.toFixed(scoped.successPct >= 99.95 ? 0 : 2)}%`
              }
              tone={
                scoped.successPct == null
                  ? undefined
                  : scoped.successPct >= 95
                    ? 'ok'
                    : scoped.successPct >= 80
                      ? 'warn'
                      : 'bad'
              }
              sub={recent5}
            />
            <Metric
              label={t('vm:accountOverview.ttft')}
              value={fmtMs(scoped.ttftMs)}
              sub={recent5}
            />
            <Metric
              label={t('vm:accountOverview.latency')}
              value={fmtMs(scoped.latencyMs)}
              sub={recent5}
            />
          </div>
          <div className='grid gap-px border-t bg-border/60 md:grid-cols-[repeat(3,minmax(0,1fr))_auto]'>
            {windows.map(({ w, dist }) => (
              <WindowBar
                key={w}
                label={
                  w === 'fable'
                    ? 'Fable'
                    : w === '5h'
                      ? t('vm:accountOverview.window5h')
                      : t('vm:accountOverview.window7d')
                }
                dist={dist}
              />
            ))}
            <div
              className='flex flex-col justify-center gap-1 bg-card px-3.5 py-2.5'
              title={t('vm:accountOverview.highLoadTitle', {
                pct: NEAR_LIMIT_PCT,
              })}
            >
              <span className='text-[11.5px] font-medium tracking-wide text-muted-foreground'>
                {t('vm:accountOverview.highLoad')}
              </span>
              <span
                className={cn(
                  'text-[20px] leading-none font-[590] tabular-nums',
                  highLoad > 0 && 'text-[color:var(--status-warn)]'
                )}
              >
                {highLoad}
              </span>
            </div>
          </div>
        </>
      ) : null}
    </section>
  )
}
