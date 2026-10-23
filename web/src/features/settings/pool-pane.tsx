import { useEffect, useRef, useState, type ReactNode } from 'react'
import { t as translate } from '@/i18n'
import {
  ArrowRightLeft,
  Armchair,
  Hourglass,
  Layers,
  Link2,
  ShieldAlert,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import { useTranslation, Trans } from 'react-i18next'
import { fmtDuration } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { SEAT_CAP_MAX, SeatCells } from '@/components/scheduler-viz'
import { SEAT_CAP_STEPS, withCurrent } from '@/features/vm/scheduling-steps'
import { PoolLivePanel } from './pool-live-panel'
import { ChipGroup, SliderSetting, StepperSetting } from './scheduler-controls'

type Obj = Record<string, unknown>
type PoolDialog = 'strategy' | 'seats' | 'queue' | 'retry' | 'circuit'

type PoolPaneProps = {
  pool: Obj
  failover: Obj
  inference: Obj
  onPoolChange: (patch: Obj) => void
  onFailoverChange: (patch: Obj) => void
  onInferenceChange: (patch: Obj) => void
  saving?: boolean
  pending?: boolean
}

/** 与后端 DEFAULT_POOL_ROUTING / failover-runner 默认值一致。 */
const POOL_DEFAULTS = {
  queue_max: 50,
  seat_grace_ms: 30000,
  seat_budget_reserve_pct: 0.02,
  sticky_wait_timeout_ms: 45000,
  fallback_wait_timeout_ms: 30000,
  circuit_failure_threshold: 3,
  circuit_open_ms: 30000,
}

const FAILOVER_DEFAULTS = {
  max_same_account_retries: 1,
  same_account_retry_delay_ms: 500,
  max_account_switches: 10,
  max_total_attempts: 12,
  total_retry_deadline_ms: 120000,
  oauth_401_cooldown_ms: 120000,
  same_account_retry_max_hop_ms: 10000,
  signature_repair: false,
  stream_idle_timeout_ms: 180000,
  max_request_mib: 32,
  eager_tool_streaming: true,
}

function numOf(source: Obj, key: string, fallback: number): number {
  const n = Number(source[key] ?? fallback)
  return Number.isFinite(n) ? n : fallback
}

function getStrategies(): {
  id: 'balanced' | 'fill'
  title: string
  desc: string
  demo: number[]
  next: number
}[] {
  return [
    {
      id: 'balanced',
      title: translate('settings:pool.balance'),
      desc: translate('settings:pool.balanceHelp'),
      demo: [2, 1, 3],
      next: 1,
    },
    {
      id: 'fill',
      title: translate('settings:pool.fill'),
      desc: translate('settings:pool.fillHelp'),
      demo: [4, 3, 1],
      next: 1,
    },
  ]
}

function StrategyCards({
  value,
  onChange,
}: {
  value: 'balanced' | 'fill'
  onChange: (next: 'balanced' | 'fill') => void
}) {
  const { t } = useTranslation('settings')

  return (
    <div
      role='radiogroup'
      aria-label={t('pool.seatStrategy')}
      className='grid gap-3 sm:grid-cols-2'
    >
      {getStrategies().map((strategy) => {
        const selected = strategy.id === value
        return (
          <button
            key={strategy.id}
            type='button'
            role='radio'
            aria-checked={selected}
            onClick={() => onChange(strategy.id)}
            className={cn(
              'flex cursor-pointer flex-col gap-3 rounded-lg border p-3 text-left transition-colors duration-150 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
              selected
                ? 'border-primary bg-primary/5 ring-1 ring-primary/30'
                : 'hover:border-primary/40 hover:bg-accent/40'
            )}
          >
            <div className='flex items-center justify-between gap-2'>
              <span className='text-sm font-semibold'>{strategy.title}</span>
              <span
                aria-hidden
                className={cn(
                  'grid size-4 place-items-center rounded-full border',
                  selected ? 'border-primary' : 'border-muted-foreground/40'
                )}
              >
                {selected ? (
                  <span className='size-2 rounded-full bg-primary' />
                ) : null}
              </span>
            </div>
            <p className='text-xs leading-5 text-muted-foreground'>
              {strategy.desc}
            </p>
            <div className='grid grid-cols-3 gap-2 rounded-md bg-muted/40 p-2'>
              {strategy.demo.map((used, index) => (
                <div key={index} className='space-y-1'>
                  <div
                    className={cn(
                      'text-[10px] text-muted-foreground',
                      index === strategy.next && 'font-medium text-foreground'
                    )}
                  >
                    VM {String.fromCharCode(65 + index)}
                    {index === strategy.next ? t('pool.nextSeat') : ''}
                  </div>
                  <SeatCells
                    used={used}
                    max={4}
                    next={index === strategy.next}
                    size='sm'
                  />
                </div>
              ))}
            </div>
          </button>
        )
      })}
    </div>
  )
}

/** 第 k 个席位要求的余量阶梯：(已开 + 1) × 预留，超过 100% 的席位永远开不出。 */
function BudgetStairs({
  reservePct,
  cap,
}: {
  reservePct: number
  cap: number
}) {
  const { t } = useTranslation('settings')

  const reachable =
    reservePct > 0 ? Math.min(cap, Math.floor(100 / reservePct)) : cap
  return (
    <div className='space-y-1.5 rounded-md border bg-muted/30 p-2.5'>
      <div className='flex h-14 items-end gap-[3px]' aria-hidden>
        {Array.from({ length: cap }, (_, index) => {
          const need = (index + 1) * reservePct
          return (
            <div
              key={index}
              title={t('pool.seatBudget', {
                value1: index + 1,
                value2: need.toFixed(1),
              })}
              className={cn(
                'flex-1 rounded-t-[2px]',
                need > 100
                  ? 'bg-[color:var(--status-bad-solid)]/70'
                  : 'bg-primary/60'
              )}
              style={{ height: `${Math.max(4, Math.min(100, need))}%` }}
            />
          )
        })}
      </div>
      <p className='text-[11px] leading-4 text-muted-foreground'>
        {reservePct > 0 ? (
          <>
            {
              <>
                {t('pool.budgetHelp', {
                  reserve: reservePct.toFixed(1),
                  capacity: cap,
                  total: (cap * reservePct).toFixed(1),
                })}
                {reachable < cap ? (
                  <span className='text-[color:var(--status-bad)]'>
                    {' '}
                    {t('pool.unreachableSeat', { seat: reachable + 1 })}
                  </span>
                ) : null}
              </>
            }
          </>
        ) : (
          t('pool.zeroBudget')
        )}
      </p>
    </div>
  )
}

function Segment({
  label,
  ms,
  total,
  className,
}: {
  label: string
  ms: number
  total: number
  className: string
}) {
  return (
    <div
      className={cn(
        'flex min-w-0 items-center justify-center overflow-hidden px-1 text-[10px] leading-5 font-medium whitespace-nowrap',
        className
      )}
      style={{ width: `${(ms / total) * 100}%` }}
      title={`${label} ${fmtDuration(ms)}`}
    >
      <span className='truncate'>
        {label} {fmtDuration(ms)}
      </span>
    </div>
  )
}

/** 一次请求最长能排多久：有家设备先守原 VM，再进全局；整体被总重试时限截断。 */
function QueueTimeline({
  sticky,
  fallback,
  deadline,
}: {
  sticky: number
  fallback: number
  deadline: number
}) {
  const { t } = useTranslation('settings')

  const total = Math.max(sticky + fallback, deadline, 1)
  const lanes: { title: string; segments: [string, number, string][] }[] = [
    {
      title: t('pool.returningDevice'),
      segments: [
        [t('pool.stayHome'), sticky, 'bg-primary/80 text-primary-foreground'],
        [
          t('pool.globalQueue'),
          fallback,
          'bg-[color:var(--status-caution-solid)] text-white',
        ],
      ],
    },
    {
      title: t('pool.newDevice'),
      segments: [
        [
          t('pool.globalQueue'),
          fallback,
          'bg-[color:var(--status-caution-solid)] text-white',
        ],
      ],
    },
  ]
  return (
    <div className='space-y-2 rounded-md border bg-muted/30 p-2.5'>
      {lanes.map((lane) => (
        <div key={lane.title} className='space-y-1'>
          <div className='text-[11px] text-muted-foreground'>{lane.title}</div>
          <div className='relative flex h-5 overflow-hidden rounded bg-muted'>
            {lane.segments.map(([label, ms, className]) => (
              <Segment
                key={label}
                label={label}
                ms={ms}
                total={total}
                className={className}
              />
            ))}
            <span className='ml-1 self-center text-[10px] font-semibold text-[color:var(--status-bad)]'>
              529
            </span>
            <div
              aria-hidden
              className='absolute inset-y-0 w-0.5 bg-[color:var(--status-bad-solid)]'
              style={{ left: `${Math.min(100, (deadline / total) * 100)}%` }}
            />
          </div>
        </div>
      ))}
      <p className='text-[11px] leading-4 text-muted-foreground'>
        <Trans
          t={t}
          i18nKey='pool.retryDeadlineHelp'
          values={{ value1: fmtDuration(deadline), value2: ' ' }}
          components={{ part1: <code /> }}
        />
      </p>
    </div>
  )
}

function CircuitFlow({
  threshold,
  openMs,
}: {
  threshold: number
  openMs: number
}) {
  const { t } = useTranslation('settings')

  const step = (icon: ReactNode, title: string, sub: string) => (
    <div className='flex min-w-0 flex-1 flex-col items-center gap-1 text-center'>
      <div className='flex h-6 items-center'>{icon}</div>
      <div className='text-[11px] font-medium'>{title}</div>
      <div className='text-[10px] leading-3 text-muted-foreground'>{sub}</div>
    </div>
  )
  const arrow = (
    <span aria-hidden className='mt-2 text-muted-foreground'>
      →
    </span>
  )
  return (
    <div className='flex items-start gap-1 rounded-md border bg-muted/30 p-2.5'>
      {step(
        <span className='flex flex-wrap justify-center gap-0.5'>
          {Array.from({ length: Math.min(threshold, 10) }, (_, index) => (
            <span
              key={index}
              className='size-2 rounded-full bg-[color:var(--status-bad-solid)]'
            />
          ))}
          {threshold > 10 ? (
            <span className='text-[10px]'>+{threshold - 10}</span>
          ) : null}
        </span>,
        t('pool.consecutiveFailures', { value1: threshold }),
        t('pool.excludedFailures')
      )}
      {arrow}
      {step(
        <ShieldAlert className='size-5 text-[color:var(--status-bad)]' />,
        t('pool.circuitDuration', { value1: fmtDuration(openMs) }),
        t('pool.circuitExclude')
      )}
      {arrow}
      {step(
        <Zap className='size-5 text-[color:var(--status-caution)]' />,
        t('pool.probeOnce'),
        t('pool.probeRecovery')
      )}
    </div>
  )
}

function SummaryButton({
  icon: Icon,
  title,
  value,
  desc,
  pending,
  onClick,
  buttonRef,
  disabled,
}: {
  icon: LucideIcon
  title: string
  value: string
  desc: string
  pending: boolean
  onClick: () => void
  buttonRef: (node: HTMLButtonElement | null) => void
  disabled: boolean
}) {
  const { t } = useTranslation('settings')

  return (
    <Button
      ref={buttonRef}
      type='button'
      variant='outline'
      disabled={disabled}
      className='h-auto min-h-24 min-w-0 justify-start gap-3 px-3 py-3 text-left'
      onClick={onClick}
    >
      <span className='grid size-8 shrink-0 place-items-center rounded-md bg-primary/10 text-primary'>
        <Icon className='size-4' aria-hidden />
      </span>
      <span className='min-w-0'>
        <span className='flex items-center gap-2 text-xs text-muted-foreground'>
          <span className='truncate'>{title}</span>
          {pending ? (
            <span className='shrink-0 rounded bg-[color:var(--status-caution)]/15 px-1.5 py-0.5 text-[10px] text-[color:var(--status-caution)]'>
              {t('pendingSave')}
            </span>
          ) : null}
        </span>
        <span className='block truncate text-sm font-semibold'>{value}</span>
        <span className='block truncate text-xs font-normal text-muted-foreground'>
          {desc}
        </span>
      </span>
    </Button>
  )
}

export function PoolPane({
  pool,
  failover,
  inference,
  onPoolChange,
  onFailoverChange,
  onInferenceChange,
  saving = false,
  pending = false,
}: PoolPaneProps) {
  const { t } = useTranslation('settings')

  const strategy = pool.strategy === 'fill' ? 'fill' : 'balanced'
  const seatCap = Math.min(
    SEAT_CAP_MAX,
    Math.max(1, numOf(inference, 'session_slots', SEAT_CAP_MAX))
  )
  const queueMax = numOf(pool, 'queue_max', POOL_DEFAULTS.queue_max)
  const grace = numOf(pool, 'seat_grace_ms', POOL_DEFAULTS.seat_grace_ms)
  const reservePct =
    Math.round(
      numOf(
        pool,
        'seat_budget_reserve_pct',
        POOL_DEFAULTS.seat_budget_reserve_pct
      ) * 1000
    ) / 10
  const sticky = numOf(
    pool,
    'sticky_wait_timeout_ms',
    POOL_DEFAULTS.sticky_wait_timeout_ms
  )
  const fallbackWait = numOf(
    pool,
    'fallback_wait_timeout_ms',
    POOL_DEFAULTS.fallback_wait_timeout_ms
  )
  const deadline = numOf(
    failover,
    'total_retry_deadline_ms',
    FAILOVER_DEFAULTS.total_retry_deadline_ms
  )
  const [open, setOpen] = useState<PoolDialog | null>(null)
  const [drafts, setDrafts] = useState<{
    pool: Obj
    failover: Obj
    inference: Obj
  }>({ pool: {}, failover: {}, inference: {} })
  const triggerRefs = useRef<
    Partial<Record<PoolDialog, HTMLButtonElement | null>>
  >({})
  const previousOpen = useRef<PoolDialog | null>(null)

  useEffect(() => {
    if (previousOpen.current && !open) {
      triggerRefs.current[previousOpen.current]?.focus()
    }
    previousOpen.current = open
  }, [open])

  const begin = (kind: PoolDialog) => {
    setDrafts({
      pool: { ...pool },
      failover: { ...failover },
      inference: { ...inference },
    })
    setOpen(kind)
  }
  const close = () => {
    if (!saving) setOpen(null)
  }
  const updateDraft = (key: 'pool' | 'failover' | 'inference', patch: Obj) => {
    setDrafts((current) => ({
      ...current,
      [key]: { ...current[key], ...patch },
    }))
  }
  const apply = () => {
    if (!open || saving) return
    const poolDraft = drafts.pool
    const failoverDraft = drafts.failover
    const inferenceDraft = drafts.inference
    if (open === 'strategy') {
      onPoolChange({
        strategy: poolDraft.strategy,
        manual_schedule_wins: poolDraft.manual_schedule_wins,
      })
    } else if (open === 'seats') {
      onInferenceChange({ session_slots: inferenceDraft.session_slots })
      onPoolChange({
        seat_grace_ms: poolDraft.seat_grace_ms,
        seat_budget_reserve_pct: poolDraft.seat_budget_reserve_pct,
      })
    } else if (open === 'queue') {
      onPoolChange({
        queue_max: poolDraft.queue_max,
        sticky_wait_timeout_ms: poolDraft.sticky_wait_timeout_ms,
        fallback_wait_timeout_ms: poolDraft.fallback_wait_timeout_ms,
      })
    } else if (open === 'retry') {
      onFailoverChange({
        max_same_account_retries: failoverDraft.max_same_account_retries,
        same_account_retry_delay_ms: failoverDraft.same_account_retry_delay_ms,
        max_account_switches: failoverDraft.max_account_switches,
        max_total_attempts: failoverDraft.max_total_attempts,
        total_retry_deadline_ms: failoverDraft.total_retry_deadline_ms,
        oauth_401_cooldown_ms: failoverDraft.oauth_401_cooldown_ms,
        same_account_retry_max_hop_ms:
          failoverDraft.same_account_retry_max_hop_ms,
        signature_repair: failoverDraft.signature_repair,
        delivery_mode: failoverDraft.delivery_mode,
        stream_idle_timeout_ms: failoverDraft.stream_idle_timeout_ms,
        ...(Number.isFinite(Number(failoverDraft.max_request_mib))
          ? {
              max_request_mib: numOf(
                failoverDraft,
                'max_request_mib',
                FAILOVER_DEFAULTS.max_request_mib
              ),
            }
          : {}),
        eager_tool_streaming: failoverDraft.eager_tool_streaming !== false,
      })
    } else {
      onPoolChange({
        circuit_failure_threshold: poolDraft.circuit_failure_threshold,
        circuit_open_ms: poolDraft.circuit_open_ms,
      })
    }
    setOpen(null)
  }

  const poolDraft = drafts.pool
  const failoverDraft = drafts.failover
  const inferenceDraft = drafts.inference
  const dialogTitle =
    open === 'strategy'
      ? t('pool.seatStrategy')
      : open === 'seats'
        ? t('pool.seatCapacity')
        : open === 'queue'
          ? t('pool.queueWait')
          : open === 'retry'
            ? t('pool.retrySwitch')
            : t('pool.failureProtection')

  return (
    <div className='space-y-4'>
      <PoolLivePanel strategy={strategy} queueMax={queueMax} />
      <div className='grid grid-cols-1 gap-3 lg:grid-cols-3'>
        <SummaryButton
          icon={Layers}
          title={t('pool.allocation')}
          value={strategy === 'fill' ? t('pool.fill') : t('pool.balance')}
          desc={t('pool.allocationHelp')}
          pending={pending}
          disabled={saving}
          buttonRef={(node) => {
            triggerRefs.current.strategy = node
          }}
          onClick={() => begin('strategy')}
        />
        <SummaryButton
          icon={Armchair}
          title={t('pool.seatCapacity')}
          value={t('pool.seatsPerVm', { count: Number(seatCap) })}
          desc={t('pool.capacitySummary', {
            value1: fmtDuration(grace),
            value2: reservePct,
          })}
          pending={pending}
          disabled={saving}
          buttonRef={(node) => {
            triggerRefs.current.seats = node
          }}
          onClick={() => begin('seats')}
        />
        <SummaryButton
          icon={Hourglass}
          title={t('pool.queueWait')}
          value={t('pool.queueSummary', {
            count: Number(queueMax),
            value2: fmtDuration(Math.max(sticky, fallbackWait)),
          })}
          desc={t('pool.waitSummary', {
            value1: fmtDuration(sticky),
            value2: fmtDuration(fallbackWait),
          })}
          pending={pending}
          disabled={saving}
          buttonRef={(node) => {
            triggerRefs.current.queue = node
          }}
          onClick={() => begin('queue')}
        />
      </div>
      <div className='flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border px-3 py-2 text-xs'>
        <span className='font-medium'>{t('pool.additional')}</span>
        <button
          type='button'
          disabled={saving}
          ref={(node) => {
            triggerRefs.current.retry = node
          }}
          className='inline-flex min-h-11 items-center gap-1 text-primary hover:underline disabled:cursor-not-allowed disabled:opacity-50'
          onClick={() => begin('retry')}
        >
          <ArrowRightLeft className='size-3.5' aria-hidden />{' '}
          {t('pool.retrySwitch')}
        </button>
        <button
          type='button'
          disabled={saving}
          ref={(node) => {
            triggerRefs.current.circuit = node
          }}
          className='inline-flex min-h-11 items-center gap-1 text-primary hover:underline disabled:cursor-not-allowed disabled:opacity-50'
          onClick={() => begin('circuit')}
        >
          <ShieldAlert className='size-3.5' aria-hidden />{' '}
          {t('pool.failureProtection')}
        </button>
        <a
          className='inline-flex min-h-11 items-center gap-1 text-primary hover:underline'
          href='/console/#/vm'
        >
          <Link2 className='size-3.5' aria-hidden /> {t('pool.vmScheduling')}
        </a>
        <a
          className='inline-flex min-h-11 items-center gap-1 text-primary hover:underline'
          href='/console/#/settings/sticky'
        >
          <Link2 className='size-3.5' aria-hidden />{' '}
          {t('pool.affinitySettings')}
        </a>
      </div>
      <Dialog
        open={open !== null}
        onOpenChange={(next) => {
          if (!next && !saving) close()
        }}
      >
        <DialogContent
          showCloseButton={!saving}
          className='flex max-h-[90dvh] flex-col overflow-hidden sm:max-w-2xl'
        >
          <DialogHeader>
            <DialogTitle>{dialogTitle}</DialogTitle>
            <DialogDescription>{t('pool.saveDraftHelp')}</DialogDescription>
          </DialogHeader>
          <fieldset
            disabled={saving}
            className='min-h-0 flex-1 space-y-4 overflow-y-auto pr-1'
          >
            {open === 'strategy' ? (
              <>
                <StrategyCards
                  value={poolDraft.strategy === 'fill' ? 'fill' : 'balanced'}
                  onChange={(next) => updateDraft('pool', { strategy: next })}
                />
                <div className='flex items-center justify-between gap-4 rounded-md border px-3 py-2.5'>
                  <div>
                    <Label htmlFor='pool-manual-wins'>
                      {t('pool.manualPriority')}
                    </Label>
                    <p className='text-xs leading-5 text-muted-foreground'>
                      {t('pool.manualPriorityHelp')}
                    </p>
                  </div>
                  <Switch
                    id='pool-manual-wins'
                    checked={poolDraft.manual_schedule_wins !== false}
                    onCheckedChange={(value) =>
                      updateDraft('pool', { manual_schedule_wins: value })
                    }
                  />
                </div>
              </>
            ) : null}
            {open === 'seats' ? (
              <>
                <div className='space-y-2'>
                  <Label>{t('pool.maxSeats')}</Label>
                  <ChipGroup
                    label={t('pool.maxSeats')}
                    value={Math.min(
                      SEAT_CAP_MAX,
                      Math.max(
                        1,
                        numOf(inferenceDraft, 'session_slots', SEAT_CAP_MAX)
                      )
                    )}
                    options={withCurrent(
                      SEAT_CAP_STEPS.map((value): [number, string] => [
                        value,
                        String(value),
                      ]),
                      seatCap
                    )}
                    onChange={(value) =>
                      updateDraft('inference', { session_slots: value })
                    }
                  />
                  <SeatCells
                    used={0}
                    max={Math.min(
                      SEAT_CAP_MAX,
                      Math.max(
                        1,
                        numOf(inferenceDraft, 'session_slots', SEAT_CAP_MAX)
                      )
                    )}
                  />
                </div>
                <SliderSetting
                  id='pool-seat-grace'
                  label={t('pool.seatGrace')}
                  value={numOf(
                    poolDraft,
                    'seat_grace_ms',
                    POOL_DEFAULTS.seat_grace_ms
                  )}
                  min={0}
                  max={120000}
                  step={5000}
                  format={(ms) =>
                    ms ? fmtDuration(ms) : t('pool.noRetention')
                  }
                  fallback={POOL_DEFAULTS.seat_grace_ms}
                  presets={[0, 10000, 30000, 60000, 120000]}
                  onChange={(ms) => updateDraft('pool', { seat_grace_ms: ms })}
                />
                <SliderSetting
                  id='pool-seat-reserve'
                  label={t('pool.budgetReserve')}
                  value={
                    numOf(
                      poolDraft,
                      'seat_budget_reserve_pct',
                      POOL_DEFAULTS.seat_budget_reserve_pct
                    ) * 100
                  }
                  min={0}
                  max={50}
                  step={0.5}
                  format={(value) => `${value}%`}
                  fallback={POOL_DEFAULTS.seat_budget_reserve_pct * 100}
                  presets={[0, 1, 2, 5, 10]}
                  onChange={(value) =>
                    updateDraft('pool', {
                      seat_budget_reserve_pct: Math.round(value * 10) / 1000,
                    })
                  }
                />
                <BudgetStairs
                  reservePct={
                    numOf(
                      poolDraft,
                      'seat_budget_reserve_pct',
                      POOL_DEFAULTS.seat_budget_reserve_pct
                    ) * 100
                  }
                  cap={Math.min(
                    SEAT_CAP_MAX,
                    Math.max(
                      1,
                      numOf(inferenceDraft, 'session_slots', SEAT_CAP_MAX)
                    )
                  )}
                />
              </>
            ) : null}
            {open === 'queue' ? (
              <>
                <SliderSetting
                  id='pool-queue-max'
                  label={t('pool.maxQueued')}
                  value={numOf(poolDraft, 'queue_max', POOL_DEFAULTS.queue_max)}
                  min={1}
                  max={999}
                  format={(value) => t('pool.itemCount', { value1: value })}
                  fallback={POOL_DEFAULTS.queue_max}
                  presets={[10, 20, 50, 100, 200, 500]}
                  onChange={(value) =>
                    updateDraft('pool', { queue_max: value })
                  }
                />
                <SliderSetting
                  id='pool-sticky-wait'
                  label={t('pool.affinityWait')}
                  value={numOf(
                    poolDraft,
                    'sticky_wait_timeout_ms',
                    POOL_DEFAULTS.sticky_wait_timeout_ms
                  )}
                  min={1000}
                  max={120000}
                  step={1000}
                  format={fmtDuration}
                  fallback={POOL_DEFAULTS.sticky_wait_timeout_ms}
                  presets={[15000, 30000, 45000, 60000, 120000]}
                  onChange={(value) =>
                    updateDraft('pool', {
                      sticky_wait_timeout_ms: value,
                    })
                  }
                />
                <SliderSetting
                  id='pool-fallback-wait'
                  label={t('pool.globalWait')}
                  value={numOf(
                    poolDraft,
                    'fallback_wait_timeout_ms',
                    POOL_DEFAULTS.fallback_wait_timeout_ms
                  )}
                  min={1000}
                  max={120000}
                  step={1000}
                  format={fmtDuration}
                  fallback={POOL_DEFAULTS.fallback_wait_timeout_ms}
                  presets={[10000, 30000, 60000, 120000]}
                  onChange={(value) =>
                    updateDraft('pool', {
                      fallback_wait_timeout_ms: value,
                    })
                  }
                />
                <QueueTimeline
                  sticky={numOf(
                    poolDraft,
                    'sticky_wait_timeout_ms',
                    POOL_DEFAULTS.sticky_wait_timeout_ms
                  )}
                  fallback={numOf(
                    poolDraft,
                    'fallback_wait_timeout_ms',
                    POOL_DEFAULTS.fallback_wait_timeout_ms
                  )}
                  deadline={deadline}
                />
              </>
            ) : null}
            {open === 'retry' ? (
              <>
                <SliderSetting
                  id='failover-total-deadline'
                  label={t('pool.totalRetryDeadline')}
                  value={numOf(
                    failoverDraft,
                    'total_retry_deadline_ms',
                    FAILOVER_DEFAULTS.total_retry_deadline_ms
                  )}
                  min={10000}
                  max={600000}
                  step={5000}
                  format={fmtDuration}
                  fallback={FAILOVER_DEFAULTS.total_retry_deadline_ms}
                  presets={[60000, 120000, 300000, 600000]}
                  onChange={(value) =>
                    updateDraft('failover', {
                      total_retry_deadline_ms: value,
                    })
                  }
                />
                <SliderSetting
                  id='failover-stream-idle'
                  label={t('pool.streamIdleTimeout')}
                  desc={t('pool.streamIdleHelp')}
                  value={numOf(
                    failoverDraft,
                    'stream_idle_timeout_ms',
                    FAILOVER_DEFAULTS.stream_idle_timeout_ms
                  )}
                  min={30000}
                  max={3600000}
                  step={30000}
                  format={fmtDuration}
                  fallback={FAILOVER_DEFAULTS.stream_idle_timeout_ms}
                  presets={[180000, 300000, 600000, 900000, 1800000]}
                  onChange={(value) =>
                    updateDraft('failover', {
                      stream_idle_timeout_ms: value,
                    })
                  }
                />
                <SliderSetting
                  id='failover-max-request'
                  label={t('pool.bodyLimit')}
                  desc={t('pool.bodyLimitHelp')}
                  value={numOf(
                    failoverDraft,
                    'max_request_mib',
                    FAILOVER_DEFAULTS.max_request_mib
                  )}
                  min={8}
                  max={128}
                  step={8}
                  format={(value) => `${value} MiB`}
                  fallback={FAILOVER_DEFAULTS.max_request_mib}
                  presets={[32, 64, 128]}
                  onChange={(value) =>
                    updateDraft('failover', { max_request_mib: value })
                  }
                />
                <div className='flex items-center justify-between gap-4 rounded-md border px-3 py-2.5'>
                  <div>
                    <Label htmlFor='failover-eager-tool-streaming'>
                      {t('pool.toolStreaming')}
                    </Label>
                    <p className='text-xs leading-5 text-muted-foreground'>
                      {t('pool.toolStreamingHelp')}
                    </p>
                  </div>
                  <Switch
                    id='failover-eager-tool-streaming'
                    checked={failoverDraft.eager_tool_streaming !== false}
                    onCheckedChange={(value) =>
                      updateDraft('failover', { eager_tool_streaming: value })
                    }
                  />
                </div>
                <SliderSetting
                  id='failover-oauth-cooldown'
                  label={t('pool.oauthCooldown')}
                  value={numOf(
                    failoverDraft,
                    'oauth_401_cooldown_ms',
                    FAILOVER_DEFAULTS.oauth_401_cooldown_ms
                  )}
                  min={5000}
                  max={600000}
                  step={5000}
                  format={fmtDuration}
                  fallback={FAILOVER_DEFAULTS.oauth_401_cooldown_ms}
                  presets={[30000, 60000, 120000, 300000, 600000]}
                  onChange={(value) =>
                    updateDraft('failover', {
                      oauth_401_cooldown_ms: value,
                    })
                  }
                />
                <StepperSetting
                  id='failover-same-retries'
                  label={t('pool.sameVmRetries')}
                  value={numOf(
                    failoverDraft,
                    'max_same_account_retries',
                    FAILOVER_DEFAULTS.max_same_account_retries
                  )}
                  min={0}
                  max={5}
                  unit={t('times')}
                  fallback={FAILOVER_DEFAULTS.max_same_account_retries}
                  onChange={(value) =>
                    updateDraft('failover', {
                      max_same_account_retries: value,
                    })
                  }
                />
                <SliderSetting
                  id='failover-same-delay'
                  label={t('pool.sameVmInterval')}
                  value={numOf(
                    failoverDraft,
                    'same_account_retry_delay_ms',
                    FAILOVER_DEFAULTS.same_account_retry_delay_ms
                  )}
                  min={0}
                  max={5000}
                  step={100}
                  format={(ms) => (ms ? fmtDuration(ms) : t('immediately'))}
                  fallback={FAILOVER_DEFAULTS.same_account_retry_delay_ms}
                  presets={[0, 250, 500, 1000, 2000]}
                  onChange={(value) =>
                    updateDraft('failover', {
                      same_account_retry_delay_ms: value,
                    })
                  }
                />
                <SliderSetting
                  id='failover-same-hop'
                  label={t('pool.sameVmOccupancy')}
                  value={numOf(
                    failoverDraft,
                    'same_account_retry_max_hop_ms',
                    FAILOVER_DEFAULTS.same_account_retry_max_hop_ms
                  )}
                  min={0}
                  max={30000}
                  step={500}
                  format={(ms) => (ms ? fmtDuration(ms) : t('unlimited'))}
                  fallback={FAILOVER_DEFAULTS.same_account_retry_max_hop_ms}
                  presets={[0, 5000, 10000, 20000, 30000]}
                  onChange={(value) =>
                    updateDraft('failover', {
                      same_account_retry_max_hop_ms: value,
                    })
                  }
                />
                <StepperSetting
                  id='failover-switches'
                  label={t('pool.switchLimit')}
                  value={numOf(
                    failoverDraft,
                    'max_account_switches',
                    FAILOVER_DEFAULTS.max_account_switches
                  )}
                  min={0}
                  max={50}
                  unit={t('times')}
                  fallback={FAILOVER_DEFAULTS.max_account_switches}
                  onChange={(value) =>
                    updateDraft('failover', {
                      max_account_switches: value,
                    })
                  }
                />
                <StepperSetting
                  id='failover-total'
                  label={t('pool.totalAttempts')}
                  value={numOf(
                    failoverDraft,
                    'max_total_attempts',
                    FAILOVER_DEFAULTS.max_total_attempts
                  )}
                  min={1}
                  max={50}
                  unit={t('times')}
                  fallback={FAILOVER_DEFAULTS.max_total_attempts}
                  onChange={(value) =>
                    updateDraft('failover', {
                      max_total_attempts: value,
                    })
                  }
                />
                <ChipGroup
                  label={t('pool.streamDelivery')}
                  value={
                    failoverDraft.delivery_mode === 'verified'
                      ? 'verified'
                      : 'realtime'
                  }
                  options={
                    [
                      ['realtime', t('pool.realtime')],
                      ['verified', t('pool.verified')],
                    ] as ['realtime' | 'verified', string][]
                  }
                  onChange={(value) =>
                    updateDraft('failover', { delivery_mode: value })
                  }
                />
                <div className='flex items-center justify-between gap-4 rounded-md border px-3 py-2.5'>
                  <div>
                    <Label htmlFor='failover-signature-repair'>
                      {t('pool.signatureRepair')}
                    </Label>
                    <p className='text-xs leading-5 text-muted-foreground'>
                      {t('pool.signatureRepairHelp')}
                    </p>
                  </div>
                  <Switch
                    id='failover-signature-repair'
                    checked={failoverDraft.signature_repair === true}
                    onCheckedChange={(value) =>
                      updateDraft('failover', { signature_repair: value })
                    }
                  />
                </div>
              </>
            ) : null}
            {open === 'circuit' ? (
              <>
                <StepperSetting
                  id='pool-circuit-threshold'
                  label={t('pool.circuitThreshold')}
                  value={numOf(
                    poolDraft,
                    'circuit_failure_threshold',
                    POOL_DEFAULTS.circuit_failure_threshold
                  )}
                  min={1}
                  max={20}
                  unit={t('times')}
                  fallback={POOL_DEFAULTS.circuit_failure_threshold}
                  onChange={(value) =>
                    updateDraft('pool', {
                      circuit_failure_threshold: value,
                    })
                  }
                />
                <SliderSetting
                  id='pool-circuit-open'
                  label={t('pool.circuitOpenDuration')}
                  value={numOf(
                    poolDraft,
                    'circuit_open_ms',
                    POOL_DEFAULTS.circuit_open_ms
                  )}
                  min={1000}
                  max={600000}
                  step={1000}
                  format={fmtDuration}
                  fallback={POOL_DEFAULTS.circuit_open_ms}
                  presets={[10000, 30000, 60000, 120000, 300000]}
                  onChange={(value) =>
                    updateDraft('pool', { circuit_open_ms: value })
                  }
                />
                <CircuitFlow
                  threshold={numOf(
                    poolDraft,
                    'circuit_failure_threshold',
                    POOL_DEFAULTS.circuit_failure_threshold
                  )}
                  openMs={numOf(
                    poolDraft,
                    'circuit_open_ms',
                    POOL_DEFAULTS.circuit_open_ms
                  )}
                />
              </>
            ) : null}
          </fieldset>
          <DialogFooter>
            <Button
              type='button'
              variant='outline'
              disabled={saving}
              className='min-h-11'
              onClick={close}
            >
              {t('cancel')}
            </Button>
            <Button
              type='button'
              disabled={saving}
              className='min-h-11'
              onClick={apply}
            >
              {t('applyDraft')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
