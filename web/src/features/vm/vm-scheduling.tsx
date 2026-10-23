import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { t as tVm } from '@/i18n'
import type { Vm, VmQuotaOverride, VmQuotaView } from '@/types/panel-vm'
import { SlidersHorizontal } from 'lucide-react'
import { useTranslation, Trans } from 'react-i18next'
import { toast } from 'sonner'
import { patchVm, type VmPatch } from '@/lib/api'
import { cn } from '@/lib/utils'
import { isCodexVm } from '@/lib/vm-kind'
import { seatTitle } from '@/lib/vm-status'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SEAT_CAP_MAX, SeatCells } from '@/components/scheduler-viz'
import { dashboardQueryOptions } from '@/features/overview/queries'
import { ChipGroup } from '@/features/settings/scheduler-controls'
import { vmQueryOptions, vmsListQueryOptions } from '@/features/vm/queries'
import {
  CONC_STEPS,
  RATIO_STEPS,
  RPM_STEPS,
  SEAT_CAP_STEPS,
  withCurrent,
} from '@/features/vm/scheduling-steps'
import { useVmPerms } from '@/features/vm/vm-perms'

type Knob<T> = { own: boolean; value: T }
type QuotaKey = keyof VmQuotaView
type Draft = {
  seats: Knob<number>
  conc: Knob<number>
  rpm: Knob<number>
  sessions: Knob<number>
  /** 'auto' = 按 7D 重置倒计时自动算；数字 = 手动 1–10。 */
  level: 'auto' | number
  quota: Record<QuotaKey, Knob<number | boolean>>
  /** 工作时段；own=false = 跟随全局（24h 接单）。timezone 是已钉住的值，面板不改但要原样带回。 */
  hours: {
    own: boolean
    start: string
    end: string
    days: number[]
    timezone?: string
  }
}

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6]
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/
function dayLabels() {
  return [
    tVm('vm:vmScheduling.sun'),
    tVm('vm:vmScheduling.mon'),
    tVm('vm:vmScheduling.tue'),
    tVm('vm:vmScheduling.wed'),
    tVm('vm:vmScheduling.thu'),
    tVm('vm:vmScheduling.fri'),
    tVm('vm:vmScheduling.sat'),
  ]
}

const QUOTA_FIELDS: { key: QuotaKey; label: string; desc: string }[] = [
  {
    key: 'limit_5h',
    get label() {
      return tVm('vm:vmScheduling.5HourGate')
    },
    get desc() {
      return tVm(
        'vm:vmScheduling.restrictAndSwitchAccountsWhen5HourUsageReaches'
      )
    },
  },
  {
    key: 'limit_7d',
    get label() {
      return tVm('vm:vmScheduling.7DayGate')
    },
    get desc() {
      return tVm(
        'vm:vmScheduling.restrictAndSwitchAccountsWhen7DayUsageReaches'
      )
    },
  },
  {
    key: 'block_on_5h',
    get label() {
      return tVm('vm:vmScheduling.enable5HourGate')
    },
    get desc() {
      return tVm('vm:vmScheduling.whenDisabled5HourUsageDoesNotBlockRequests')
    },
  },
  {
    key: 'block_on_7d',
    get label() {
      return tVm('vm:vmScheduling.enable7DayGate')
    },
    get desc() {
      return tVm('vm:vmScheduling.whenDisabled7DayUsageDoesNotBlockRequests')
    },
  },
  {
    key: 'weekly_split',
    get label() {
      return tVm('vm:vmScheduling.splitWeeklyQuota')
    },
    get desc() {
      return tVm('vm:vmScheduling.reserveHalfOfThe7DayQuotaForFable')
    },
  },
]

const LEVELS = Array.from({ length: 10 }, (_, i) => i + 1)

function isRatio(key: QuotaKey) {
  return key === 'limit_5h' || key === 'limit_7d'
}

function fmtQuota(key: QuotaKey, value: unknown): string {
  if (isRatio(key)) return `${Math.round(Number(value) * 100)}%`
  return value
    ? tVm('vm:seedPolicyCard.on')
    : tVm('vm:seedPolicyCard.offSwitch')
}

function draftOf(vm: Vm): Draft {
  const inherited = vm.scheduling_inherited
  const override = vm.quota_override || {}
  const quotaBase = vm.quota_inherited
  const quota = Object.fromEntries(
    QUOTA_FIELDS.map(({ key }) => {
      const own = override[key] != null
      const raw = own ? override[key] : quotaBase?.[key]
      const value = isRatio(key)
        ? Math.round(Number(raw ?? 0.85) * 100)
        : Boolean(raw)
      return [key, { own, value }]
    })
  ) as Draft['quota']
  return {
    seats: {
      own: vm.session_slots_override === true,
      value: Number(
        vm.session_slots ?? inherited?.session_slots ?? SEAT_CAP_MAX
      ),
    },
    conc: {
      own: vm.concurrency_override === true,
      value: Number(vm.max_concurrency ?? inherited?.max_concurrency ?? 2),
    },
    rpm: {
      own: vm.rpm_override === true,
      value: Number(vm.max_rpm ?? inherited?.max_rpm ?? 0),
    },
    sessions: {
      own: vm.max_sessions_override === true,
      value: Number(vm.max_sessions ?? inherited?.max_sessions ?? 0),
    },
    level:
      vm.schedule_level_mode === 'manual' && Number(vm.schedule_level) >= 1
        ? Number(vm.schedule_level)
        : 'auto',
    quota,
    hours: {
      own: !!vm.active_hours,
      start: vm.active_hours?.start || '08:00',
      end: vm.active_hours?.end || '22:00',
      days: vm.active_hours?.days?.length
        ? [...vm.active_hours.days]
        : ALL_DAYS,
      timezone: vm.active_hours?.timezone,
    },
  }
}

function sortedDays(days: number[]): number[] {
  return [...days].sort((a, b) => a - b)
}

function sameDays(a: number[], b: number[]): boolean {
  const x = sortedDays(a)
  const y = sortedDays(b)
  return x.length === y.length && x.every((v, i) => v === y[i])
}

function sameHours(a: Draft['hours'], b: Draft['hours']): boolean {
  if (a.own !== b.own) return false
  if (!a.own) return true
  return a.start === b.start && a.end === b.end && sameDays(a.days, b.days)
}

type DayPreset = 'all' | 'weekday' | 'weekend' | 'custom'

function dayPreset(days: number[]): DayPreset {
  if (sameDays(days, ALL_DAYS)) return 'all'
  if (sameDays(days, [1, 2, 3, 4, 5])) return 'weekday'
  if (sameDays(days, [0, 6])) return 'weekend'
  return 'custom'
}

const DAY_PRESET_DAYS: Record<Exclude<DayPreset, 'custom'>, number[]> = {
  all: ALL_DAYS,
  weekday: [1, 2, 3, 4, 5],
  weekend: [0, 6],
}

/** 只发生变化的字段；null = 去掉本槽覆盖。 */
function patchOf(vm: Vm, draft: Draft): VmPatch {
  const body: VmPatch = {}
  const before = draftOf(vm)
  const knob = (
    key: 'session_slots' | 'max_concurrency' | 'max_rpm' | 'max_sessions',
    next: Knob<number>,
    prev: Knob<number>
  ) => {
    if (next.own && (!prev.own || next.value !== prev.value)) {
      body[key] = next.value
    } else if (!next.own && prev.own) {
      body[key] = null
    }
  }
  if (!isCodexVm(vm)) knob('session_slots', draft.seats, before.seats)
  knob('max_concurrency', draft.conc, before.conc)
  knob('max_rpm', draft.rpm, before.rpm)
  if (isCodexVm(vm)) knob('max_sessions', draft.sessions, before.sessions)
  if (draft.level !== before.level) {
    body.schedule_level = draft.level === 'auto' ? null : draft.level
  }
  if (!sameHours(draft.hours, before.hours)) {
    body.active_hours = draft.hours.own
      ? {
          start: draft.hours.start,
          end: draft.hours.end,
          ...(draft.hours.timezone ? { timezone: draft.hours.timezone } : {}),
          ...(sameDays(draft.hours.days, ALL_DAYS)
            ? {}
            : { days: sortedDays(draft.hours.days) }),
        }
      : null
  }
  if (!isCodexVm(vm)) {
    const next: VmQuotaOverride = {}
    for (const { key } of QUOTA_FIELDS) {
      const k = draft.quota[key]
      if (!k.own) continue
      ;(next as Record<string, unknown>)[key] = isRatio(key)
        ? Number(k.value) / 100
        : k.value
    }
    const prev = vm.quota_override || {}
    const same = QUOTA_FIELDS.every(
      ({ key }) => (prev[key] ?? null) === (next[key] ?? null)
    )
    if (!same) body.quota_override = Object.keys(next).length ? next : null
  }
  return body
}

function overrideCount(vm: Vm): number {
  const quota = Object.values(vm.quota_override || {}).filter(
    (v) => v != null
  ).length
  return (
    quota +
    Number(vm.session_slots_override === true) +
    Number(vm.concurrency_override === true) +
    Number(vm.rpm_override === true) +
    Number(vm.max_sessions_override === true) +
    Number(!!vm.active_hours)
  )
}

function Tile({
  label,
  value,
  own,
  title,
}: {
  label: string
  value: React.ReactNode
  own?: boolean
  title?: string
}) {
  useTranslation('vm')

  return (
    <div
      title={title}
      className={cn(
        'flex min-w-0 items-baseline justify-between gap-2 rounded border px-2 py-1 text-xs',
        own
          ? 'border-primary/40 bg-background'
          : 'border-border/70 bg-background/60'
      )}
    >
      <span className='truncate text-muted-foreground'>{label}</span>
      <span
        className={cn(
          'shrink-0 whitespace-nowrap tabular-nums',
          own && 'font-medium text-primary'
        )}
      >
        {value}
      </span>
    </div>
  )
}

/**
 * VM 内的「调度」块：席位、并发、RPM、调度等级与配额闸的生效值；
 * 本槽覆盖的项高亮，悬停看全局值，一个弹窗改全部。
 */
export function VmSchedulingBlock({
  vm,
  conc,
  rpm,
}: {
  vm: Vm
  conc?: { inf: number; max: number }
  rpm?: { n: number; max: number } | null
}) {
  const { t: tVm } = useTranslation('vm')

  const codex = isCodexVm(vm)
  const inherited = vm.scheduling_inherited
  const inf = conc?.inf ?? (Number(vm.inflight) || 0)
  const concMax = conc?.max ?? Number(vm.max_concurrency ?? 0)
  const rpmMax = rpm?.max ?? Number(vm.max_rpm ?? 0)
  const rpmNow = rpm?.n ?? (Number(vm.rpm) || 0)
  const seatsMax = Number(vm.seats_max ?? vm.session_slots ?? 0)
  const seatsUsed = Number(vm.seats_used) || 0
  const queued = Number(vm.queue_depth) || 0
  const custom = overrideCount(vm)
  const policy = vm.quota_policy
  const quotaOverride = vm.quota_override || {}
  const level = Number(vm.schedule_level)
  const canEdit = useVmPerms().admin

  return (
    <div className='space-y-2 rounded-md border border-primary/30 bg-primary/5 px-2.5 py-2'>
      <div className='flex items-center justify-between gap-2'>
        <div className='min-w-0'>
          <div className='text-xs font-medium'>
            <Trans ns='vm' i18nKey='vmListTable.scheduling' />
          </div>
          <div
            className={cn(
              'text-[11px]',
              custom ? 'text-primary' : 'text-muted-foreground'
            )}
          >
            {custom
              ? tVm('vm:vmScheduling.slotOverrides', {
                  custom: custom,
                  count: custom,
                })
              : tVm('vm:vmScheduling.allSettingsFollowGlobalDefaults')}
          </div>
        </div>
        {canEdit ? <VmSchedulingEditor vm={vm} /> : null}
      </div>

      {codex ? null : (
        <div className='space-y-1' title={seatTitle(vm)}>
          <div className='flex items-baseline justify-between gap-2 text-xs'>
            <span className='text-muted-foreground'>
              <Trans ns='vm' i18nKey='vmRackBlade.seats' />
            </span>
            <span className='tabular-nums'>
              {seatsUsed}/{seatsMax}
              {vm.seats_grace
                ? tVm('vm:vmScheduling.grace', { seats_grace: vm.seats_grace })
                : ''}
              {queued ? (
                <span className='text-[color:var(--status-warn)]'>
                  <Trans
                    ns='vm'
                    i18nKey='vmScheduling.queued'
                    values={{
                      queued: queued,
                      value: vm.conc_waiting
                        ? tVm('vm:vmScheduling.waitingForConcurrency', {
                            conc_waiting: vm.conc_waiting,
                          })
                        : '',
                    }}
                  />
                </span>
              ) : null}
            </span>
          </div>
          <SeatCells
            used={seatsUsed}
            grace={Number(vm.seats_grace) || 0}
            max={seatsMax}
            size='sm'
          />
        </div>
      )}

      <div className='grid grid-cols-2 gap-1.5'>
        <Tile
          label={tVm('vm:vmScheduling.concurrency')}
          value={tVm('vm:vmScheduling.summary', {
            inf: inf,
            value1: concMax || tVm('vm:schedulingSteps.unlimited'),
          })}
          own={vm.concurrency_override}
          title={
            vm.concurrency_override
              ? tVm('vm:vmScheduling.slotOverrideValue', {
                  value1: codex
                    ? tVm('vm:vmScheduling.openAIGlobal')
                    : tVm('vm:vmScheduling.tierDefaults'),
                  value2: inherited?.max_concurrency ?? '—',
                })
              : codex
                ? tVm('vm:vmScheduling.followOpenAIGlobalDefaults')
                : tVm('vm:vmScheduling.followTierDefaults')
          }
        />
        <Tile
          label='RPM'
          value={
            rpmMax ? `${rpmNow}/${rpmMax}` : tVm('vm:schedulingSteps.unlimited')
          }
          own={vm.rpm_override}
          title={
            vm.rpm_override
              ? tVm('vm:vmScheduling.slotOverrideValue', {
                  value1: codex
                    ? tVm('vm:vmScheduling.openAIGlobal')
                    : tVm('vm:vmScheduling.tierDefaults'),
                  value2:
                    inherited?.max_rpm || tVm('vm:schedulingSteps.unlimited'),
                })
              : codex
                ? tVm('vm:vmScheduling.followOpenAIGlobalDefaults')
                : tVm('vm:vmScheduling.followTierDefaults')
          }
        />
        {codex ? null : (
          <Tile
            label={tVm('vm:vmScheduling.seatLimit')}
            value={vm.session_slots ?? '—'}
            own={vm.session_slots_override}
            title={
              vm.session_slots_override
                ? tVm('vm:vmScheduling.slotOverrideGlobalValue', {
                    value1: inherited?.session_slots ?? '—',
                  })
                : tVm('vm:personaContract.followGlobal')
            }
          />
        )}
        {codex ? (
          <Tile
            label={tVm('vm:vmScheduling.sessionCapacity')}
            value={
              vm.max_sessions
                ? vm.max_sessions
                : tVm('vm:schedulingSteps.unlimited')
            }
            own={vm.max_sessions_override}
            title={
              vm.max_sessions_override
                ? tVm('vm:vmScheduling.slotOverrideGlobalValue', {
                    value1:
                      inherited?.max_sessions ??
                      tVm('vm:schedulingSteps.unlimited'),
                  })
                : tVm('vm:vmScheduling.followOpenAIGlobalDefaults')
            }
          />
        ) : null}
        {!codex ? (
          <Tile
            label={tVm('vm:vmScheduling.schedulingLevel')}
            value={
              Number.isInteger(level)
                ? tVm('vm:vmScheduling.level', {
                    level: level,
                    value1:
                      vm.schedule_level_mode === 'manual'
                        ? tVm('vm:vmListTable.manual')
                        : tVm('vm:createOptions.automatic'),
                  })
                : '—'
            }
            own={vm.schedule_level_mode === 'manual'}
            title={tVm(
              'vm:vmScheduling.higherLevelVMsOpenSeatsFirstAutomaticModeUses'
            )}
          />
        ) : null}
        <Tile
          label={tVm('vm:vmScheduling.workingHours')}
          value={
            vm.active_hours_active === false
              ? tVm('vm:vmScheduling.resting')
              : vm.active_hours
                ? `${vm.active_hours.start}–${vm.active_hours.end}`
                : tVm('vm:vmScheduling.allDay')
          }
          own={!!vm.active_hours}
          title={
            vm.active_hours
              ? tVm(
                  vm.active_hours_active === false
                    ? 'vm:messages.workingHoursOutside'
                    : 'vm:messages.workingHoursInside',
                  {
                    timezone: vm.active_hours_timezone || vm.timezone || 'UTC',
                    days: vm.active_hours.days?.length
                      ? vm.active_hours.days
                          .map((day) => dayLabels()[day])
                          .join(', ')
                      : tVm('vm:vmScheduling.everyDayAlternative'),
                  }
                )
              : tVm('vm:vmScheduling.followGlobalAcceptRequests24HoursADay')
          }
        />
        {codex || !policy
          ? null
          : QUOTA_FIELDS.map(({ key, label }) => (
              <Tile
                key={key}
                label={label}
                value={fmtQuota(key, policy[key])}
                own={quotaOverride[key] != null}
                title={
                  quotaOverride[key] != null
                    ? tVm('vm:vmScheduling.global', {
                        value1: fmtQuota(key, vm.quota_inherited?.[key]),
                      })
                    : tVm('vm:personaContract.followGlobal')
                }
              />
            ))}
      </div>
    </div>
  )
}

function KnobRow({
  label,
  desc,
  inheritedText,
  own,
  onOwnChange,
  children,
  disabled,
}: {
  label: string
  desc?: string
  inheritedText: string
  own: boolean
  onOwnChange: (own: boolean) => void
  children: React.ReactNode
  disabled?: boolean
}) {
  const { t: tVm } = useTranslation('vm')

  return (
    <div
      className={cn(
        'space-y-2 rounded-lg border p-3 transition-colors duration-150',
        own ? 'border-primary/50 bg-primary/5' : 'bg-muted/20'
      )}
    >
      <div className='flex flex-wrap items-start justify-between gap-2'>
        <div className='min-w-0 space-y-0.5'>
          <Label>{label}</Label>
          {desc ? (
            <p className='text-[11px] leading-4 text-muted-foreground'>
              {desc}
            </p>
          ) : null}
        </div>
        <ChipGroup
          label={tVm('vm:vmScheduling.source', { label: label })}
          value={own ? 'own' : 'inherit'}
          options={[
            [
              'inherit',
              tVm('vm:vmScheduling.inherit', { inheritedText: inheritedText }),
            ],
            ['own', tVm('vm:vmScheduling.thisSlot')],
          ]}
          onChange={(v) => onOwnChange(v === 'own')}
          disabled={disabled}
        />
      </div>
      {own ? children : null}
    </div>
  )
}

export function VmSchedulingEditor({ vm }: { vm: Vm }) {
  const { t: tVm } = useTranslation('vm')

  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(() => draftOf(vm))
  const codex = isCodexVm(vm)
  const inherited = vm.scheduling_inherited
  const quotaBase = vm.quota_inherited

  const save = useMutation({
    mutationFn: (body: VmPatch) => patchVm(vm.id, body),
    onSuccess: async () => {
      toast.success(tVm('vm:vmScheduling.schedulingConfigurationReloaded'))
      await Promise.all([
        qc.invalidateQueries({ queryKey: vmsListQueryOptions().queryKey }),
        qc.invalidateQueries({ queryKey: vmQueryOptions(vm.id).queryKey }),
        qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
      ])
      setOpen(false)
    },
    onError: (error: Error) =>
      toast.error(error.message || tVm('vm:authSchemeEditor.updateFailed')),
  })

  const submit = () => {
    // 退格清掉一段时 <input type=time> 给出 ''；草稿留空，到这里再拦。
    if (
      draft.hours.own &&
      !(HHMM.test(draft.hours.start) && HHMM.test(draft.hours.end))
    ) {
      toast.error(tVm('vm:vmScheduling.enterBothStartAndEndTimes'))
      return
    }
    if (draft.hours.own && draft.hours.start === draft.hours.end) {
      toast.error(tVm('vm:vmScheduling.startAndEndTimesCannotBeTheSame'))
      return
    }
    if (draft.hours.own && !draft.hours.days.length) {
      toast.error(tVm('vm:vmScheduling.keepAtLeastOneWorkingDay'))
      return
    }
    const body = patchOf(vm, draft)
    if (!Object.keys(body).length) {
      setOpen(false)
      return
    }
    save.mutate(body)
  }

  const setQuota = (key: QuotaKey, next: Partial<Knob<number | boolean>>) =>
    setDraft({
      ...draft,
      quota: { ...draft.quota, [key]: { ...draft.quota[key], ...next } },
    })

  const allInherit = () =>
    setDraft({
      ...draft,
      seats: { ...draft.seats, own: false },
      conc: { ...draft.conc, own: false },
      rpm: { ...draft.rpm, own: false },
      sessions: { ...draft.sessions, own: false },
      level: 'auto',
      hours: { ...draft.hours, own: false },
      quota: Object.fromEntries(
        QUOTA_FIELDS.map(({ key }) => [
          key,
          { ...draft.quota[key], own: false },
        ])
      ) as Draft['quota'],
    })

  const pending = save.isPending

  return (
    <>
      <Button
        size='sm'
        className='h-7 shrink-0 cursor-pointer gap-1 px-2.5 text-xs shadow-sm'
        onClick={() => {
          setDraft(draftOf(vm))
          setOpen(true)
        }}
      >
        <Trans
          ns='vm'
          i18nKey='vmScheduling.schedulingConfiguration'
          components={{
            part0: <SlidersHorizontal className='size-3.5' aria-hidden />,
          }}
        />
      </Button>
      <Dialog open={open} onOpenChange={(v) => !pending && setOpen(v)}>
        <DialogContent className='max-h-[88vh] overflow-y-auto sm:max-w-2xl'>
          <DialogHeader>
            <DialogTitle>
              <Trans
                ns='vm'
                i18nKey='vmScheduling.schedulingConfigurationAlternative'
                values={{ value: vm.name || vm.id }}
              />
            </DialogTitle>
            <DialogDescription>
              <Trans
                ns='vm'
                i18nKey='vmScheduling.appliesOnlyToThisSlotAndReloadsWithoutRestart'
              />
            </DialogDescription>
          </DialogHeader>

          <div className='space-y-4'>
            <section className='space-y-2'>
              <h4 className='text-xs font-medium text-muted-foreground'>
                <Trans ns='vm' i18nKey='vmScheduling.seatsAndTraffic' />
              </h4>
              {codex ? null : (
                <KnobRow
                  label={tVm('vm:vmScheduling.seatLimit')}
                  desc={tVm(
                    'vm:vmScheduling.maximumDevicesBoundToThisVMSimultaneouslyConcurrentRequests'
                  )}
                  inheritedText={String(inherited?.session_slots ?? '—')}
                  own={draft.seats.own}
                  onOwnChange={(own) =>
                    setDraft({ ...draft, seats: { ...draft.seats, own } })
                  }
                  disabled={pending}
                >
                  <ChipGroup
                    label={tVm('vm:vmScheduling.seatLimit')}
                    value={draft.seats.value}
                    options={withCurrent(
                      SEAT_CAP_STEPS.map((n): [number, string] => [
                        n,
                        String(n),
                      ]),
                      draft.seats.value
                    )}
                    onChange={(value) =>
                      setDraft({ ...draft, seats: { own: true, value } })
                    }
                    disabled={pending}
                  />
                  <SeatCells
                    used={Number(vm.seats_used) || 0}
                    grace={Number(vm.seats_grace) || 0}
                    max={draft.seats.value}
                  />
                </KnobRow>
              )}
              <KnobRow
                label={tVm('vm:vmScheduling.concurrencyLimit')}
                desc={
                  codex
                    ? tVm(
                        'vm:vmScheduling.simultaneousOpenAIRequestsWhenFullRequestsWaitOrBorrow'
                      )
                    : tVm(
                        'vm:vmScheduling.simultaneousInFlightRequestsWhenFullRequestsQueueOn'
                      )
                }
                inheritedText={
                  inherited
                    ? String(
                        inherited.max_concurrency ||
                          tVm('vm:schedulingSteps.unlimited')
                      )
                    : '—'
                }
                own={draft.conc.own}
                onOwnChange={(own) =>
                  setDraft({ ...draft, conc: { ...draft.conc, own } })
                }
                disabled={pending}
              >
                <ChipGroup
                  label={tVm('vm:vmScheduling.concurrencyLimit')}
                  value={draft.conc.value}
                  options={withCurrent(CONC_STEPS, draft.conc.value)}
                  onChange={(value) =>
                    setDraft({ ...draft, conc: { own: true, value } })
                  }
                  disabled={pending}
                />
              </KnobRow>
              {codex ? (
                <KnobRow
                  label={tVm('vm:vmScheduling.sessionCapacity')}
                  desc={tVm(
                    'vm:vmScheduling.activeConversationWindowsRetainedPerOpenAIAccount0Means'
                  )}
                  inheritedText={
                    inherited
                      ? String(
                          inherited.max_sessions ||
                            tVm('vm:schedulingSteps.unlimited')
                        )
                      : '—'
                  }
                  own={draft.sessions.own}
                  onOwnChange={(own) =>
                    setDraft({ ...draft, sessions: { ...draft.sessions, own } })
                  }
                  disabled={pending}
                >
                  <ChipGroup
                    label={tVm('vm:vmScheduling.sessionCapacity')}
                    value={draft.sessions.value}
                    options={withCurrent(
                      [0, 1, 2, 4, 8, 16, 32, 64, 128, 256].map(
                        (n): [number, string] => [
                          n,
                          n === 0
                            ? tVm('vm:schedulingSteps.unlimited')
                            : String(n),
                        ]
                      ),
                      draft.sessions.value
                    )}
                    onChange={(value) =>
                      setDraft({
                        ...draft,
                        sessions: { own: true, value },
                      })
                    }
                    disabled={pending}
                  />
                </KnobRow>
              ) : null}
              <KnobRow
                label={tVm('vm:vmScheduling.rPMLimit')}
                desc={tVm(
                  'vm:vmScheduling.requestsPerMinuteAtTheLimitQueueUntilThe'
                )}
                inheritedText={
                  inherited
                    ? String(
                        inherited.max_rpm || tVm('vm:schedulingSteps.unlimited')
                      )
                    : '—'
                }
                own={draft.rpm.own}
                onOwnChange={(own) =>
                  setDraft({ ...draft, rpm: { ...draft.rpm, own } })
                }
                disabled={pending}
              >
                <ChipGroup
                  label={tVm('vm:vmScheduling.rPMLimit')}
                  value={draft.rpm.value}
                  options={withCurrent(RPM_STEPS, draft.rpm.value)}
                  onChange={(value) =>
                    setDraft({ ...draft, rpm: { own: true, value } })
                  }
                  disabled={pending}
                />
              </KnobRow>
              {!codex ? (
                <div className='space-y-2 rounded-lg border p-3'>
                  <div className='space-y-0.5'>
                    <Label>
                      <Trans ns='vm' i18nKey='vmScheduling.schedulingLevel' />
                    </Label>
                    <p className='text-[11px] leading-4 text-muted-foreground'>
                      <Trans
                        ns='vm'
                        i18nKey='vmScheduling.higherLevelVMsOpenNewSeatsFirstSeatOpening'
                      />
                    </p>
                  </div>
                  <ChipGroup
                    label={tVm('vm:vmScheduling.schedulingLevel')}
                    value={draft.level}
                    options={[
                      [
                        'auto',
                        vm.schedule_level_mode === 'auto' &&
                        Number.isInteger(Number(vm.schedule_level))
                          ? tVm('vm:vmScheduling.automaticCurrently', {
                              schedule_level: vm.schedule_level,
                            })
                          : tVm('vm:createOptions.automatic'),
                      ] as ['auto' | number, string],
                      ...LEVELS.map((n): ['auto' | number, string] => [
                        n,
                        String(n),
                      ]),
                    ]}
                    onChange={(level) => setDraft({ ...draft, level })}
                    disabled={pending}
                  />
                </div>
              ) : null}
              <KnobRow
                label={tVm('vm:vmScheduling.workingHours')}
                desc={tVm(
                  'vm:vmScheduling.acceptsRequestsOnlyDuringTheseHoursOutsideTheWindow'
                )}
                inheritedText={tVm('vm:vmScheduling.allDay')}
                own={draft.hours.own}
                onOwnChange={(own) =>
                  setDraft({ ...draft, hours: { ...draft.hours, own } })
                }
                disabled={pending}
              >
                <div className='flex flex-wrap items-center gap-2'>
                  <Input
                    type='time'
                    aria-label={tVm('vm:vmScheduling.startTime')}
                    className='h-8 w-28'
                    value={draft.hours.start}
                    disabled={pending}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        hours: {
                          ...draft.hours,
                          start: event.target.value,
                        },
                      })
                    }
                  />
                  <span className='text-xs text-muted-foreground'>
                    <Trans ns='vm' i18nKey='vmScheduling.to' />
                  </span>
                  <Input
                    type='time'
                    aria-label={tVm('vm:vmScheduling.endTime')}
                    className='h-8 w-28'
                    value={draft.hours.end}
                    disabled={pending}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        hours: {
                          ...draft.hours,
                          end: event.target.value,
                        },
                      })
                    }
                  />
                  <span className='text-[11px] text-muted-foreground'>
                    {vm.active_hours_timezone || vm.timezone || 'UTC'}
                  </span>
                </div>
                <ChipGroup
                  label={tVm('vm:vmScheduling.workingDayPresets')}
                  value={dayPreset(draft.hours.days)}
                  options={[
                    ['all', tVm('vm:vmScheduling.everyDayAlternative')],
                    ['weekday', tVm('vm:vmScheduling.weekdays')],
                    ['weekend', tVm('vm:vmScheduling.weekends')],
                    ['custom', tVm('vm:seedPolicyCard.custom')],
                  ]}
                  onChange={(preset) => {
                    if (preset === 'custom') return
                    setDraft({
                      ...draft,
                      hours: { ...draft.hours, days: DAY_PRESET_DAYS[preset] },
                    })
                  }}
                  disabled={pending}
                />
                <div className='flex flex-wrap gap-1.5'>
                  {dayLabels().map((label, day) => {
                    const on = draft.hours.days.includes(day)
                    return (
                      <button
                        key={day}
                        type='button'
                        disabled={
                          pending || (on && draft.hours.days.length === 1)
                        }
                        onClick={() =>
                          setDraft({
                            ...draft,
                            hours: {
                              ...draft.hours,
                              days: on
                                ? draft.hours.days.filter((v) => v !== day)
                                : sortedDays([...draft.hours.days, day]),
                            },
                          })
                        }
                        className={cn(
                          'h-7 min-w-8 cursor-pointer rounded-md border px-2 text-xs transition-colors duration-150 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50',
                          on
                            ? 'border-primary bg-primary text-primary-foreground'
                            : 'border-border bg-background text-muted-foreground hover:border-primary/50 hover:text-foreground'
                        )}
                      >
                        {label}
                      </button>
                    )
                  })}
                </div>
              </KnobRow>
            </section>

            {codex || !quotaBase ? null : (
              <section className='space-y-2'>
                <h4 className='text-xs font-medium text-muted-foreground'>
                  <Trans ns='vm' i18nKey='vmScheduling.quotaGates' />
                </h4>
                <div className='grid gap-2 sm:grid-cols-2'>
                  {QUOTA_FIELDS.map(({ key, label, desc }) => {
                    const k = draft.quota[key]
                    return (
                      <KnobRow
                        key={key}
                        label={label}
                        desc={desc}
                        inheritedText={fmtQuota(key, quotaBase[key])}
                        own={k.own}
                        onOwnChange={(own) => setQuota(key, { own })}
                        disabled={pending}
                      >
                        {isRatio(key) ? (
                          <ChipGroup
                            label={label}
                            value={Number(k.value)}
                            options={withCurrent(
                              RATIO_STEPS.map((p): [number, string] => [
                                p,
                                `${p}%`,
                              ]),
                              Number(k.value)
                            )}
                            onChange={(value) => setQuota(key, { value })}
                            disabled={pending}
                          />
                        ) : (
                          <ChipGroup
                            label={label}
                            value={k.value ? 'on' : 'off'}
                            options={[
                              ['on', tVm('vm:seedPolicyCard.on')],
                              ['off', tVm('vm:seedPolicyCard.offSwitch')],
                            ]}
                            onChange={(v) =>
                              setQuota(key, { value: v === 'on' })
                            }
                            disabled={pending}
                          />
                        )}
                      </KnobRow>
                    )
                  })}
                </div>
              </section>
            )}
          </div>

          <DialogFooter className='sm:justify-between'>
            <Button
              size='sm'
              variant='outline'
              className='cursor-pointer'
              disabled={pending}
              onClick={allInherit}
            >
              <Trans ns='vm' i18nKey='vmScheduling.restoreAllInheritedValues' />
            </Button>
            <div className='flex gap-2'>
              <Button
                size='sm'
                variant='outline'
                className='cursor-pointer'
                disabled={pending}
                onClick={() => setOpen(false)}
              >
                <Trans ns='vm' i18nKey='authSchemeEditor.cancel' />
              </Button>
              <Button
                size='sm'
                className='cursor-pointer'
                disabled={pending}
                onClick={submit}
              >
                {pending
                  ? tVm('vm:allowedModelsCard.saving')
                  : tVm('vm:authSchemeEditor.save')}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
