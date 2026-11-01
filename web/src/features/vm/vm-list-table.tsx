import { useState, type KeyboardEvent, type ReactNode } from 'react'
import { t as tVm } from '@/i18n'
import type { UsageAccountRow } from '@/types/panel-usage'
import type { Vm } from '@/types/panel-vm'
import type { StatusTone } from '@/types/status'
import { GripVertical, RotateCcw } from 'lucide-react'
import { useTranslation, Trans } from 'react-i18next'
import { expiresAtToMs, fmtResetClock } from '@/lib/fable-status'
import { fmtNum } from '@/lib/format'
import { subscriptionListLabel } from '@/lib/subscription-expiry'
import { tierVisual } from '@/lib/tier-visual'
import { cn } from '@/lib/utils'
import { isCodexVm, slotNameLabel } from '@/lib/vm-kind'
import {
  credentialStatus,
  fleetGroup,
  poolStatus,
  restrictionCopy,
  seatTitle,
  vmCircuitTitle,
  vmCooldownTitle,
  vmRestrictionRecovery,
} from '@/lib/vm-status'
import { vmTodayStats, vmWeekOutcome, type VmWeekOutcome } from '@/lib/vm-usage'
import { useNow } from '@/hooks/use-now'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { CredLaneChip, SlotIdentity } from '@/components/platform-chip'
import { StatusMark } from '@/components/status-mark'
import { ProxyChip } from '@/features/proxies/proxy-chip'
import { ActiveVmBadge } from '@/features/vm/active-vm-badge'
import { NodeChip } from '@/features/vm/node-chip'
import { OpenaiPlanBadge } from '@/features/vm/openai-plan-badge'
import { RuntimeChip } from '@/features/vm/runtime-chip'
import {
  SchedulableSwitch,
  vmSchedulableProps,
} from '@/features/vm/schedulable-switch'
import {
  StatusBarOptions,
  useStatusBarShow,
  type StatusBarShow,
} from '@/features/vm/status-bar-options'
import {
  METRIC_ROW,
  VmCostLedger,
  VmUsageWindows,
} from '@/features/vm/usage-windows'
import {
  useVmColumnOrder,
  type VmColumnKey,
} from '@/features/vm/use-vm-column-order'
import { VmActionMenu } from '@/features/vm/vm-action-menu'
import { useVmActions } from '@/features/vm/vm-actions-context'
import { VmGroupLabels } from '@/features/vm/vm-groups'
import { useVmPerms } from './vm-perms'

/** 列的宽度与弹性；顺序由 `useVmColumnOrder` 决定，不写死在这里。 */
const COL_CLS: Record<VmColumnKey | 'actions', string> = {
  groups: 'min-w-[130px] flex-[0.8]',
  vm: 'min-w-[170px] flex-[1.15]',
  sched: 'min-w-[62px] flex-[0.3]',
  type: 'min-w-[120px] flex-[0.75]',
  status: 'min-w-[180px] flex-[1.1]',
  req: 'min-w-[124px] flex-[0.7]',
  usage: 'min-w-[248px] flex-[1.4]',
  cost: 'min-w-[212px] flex-[1.1]',
  actions: 'w-[44px] shrink-0 pr-2',
}

type DotTone = 'ok' | 'caution' | 'warn' | 'bad' | 'none'

const DOT_BG: Record<DotTone, string> = {
  ok: 'var(--status-ok-solid)',
  caution: 'var(--status-caution-solid)',
  warn: 'var(--status-warn-solid)',
  bad: 'var(--status-bad-solid)',
  none: 'transparent',
}

const DOT_FG: Record<DotTone, string> = {
  ok: 'text-[color:var(--status-ok)]',
  caution: 'text-[color:var(--status-caution)]',
  warn: 'text-[color:var(--status-warn)]',
  bad: 'text-[color:var(--status-bad)]',
  none: 'text-muted-foreground',
}

function credDot(cls: string): DotTone {
  if (cls === 'ok') return 'ok'
  if (cls === 'caution') return 'caution'
  if (cls === 'warn') return 'warn'
  if (cls === 'bad') return 'bad'
  return 'none'
}

/** 状态条只回答这张票现在能不能用，不把请求成败画成可用性。 */
function healthModel(vm: Vm): { dots: DotTone[]; text: string; tone: DotTone } {
  const cred = credentialStatus(vm)
  const tone = credDot(cred.cls)
  return {
    dots: Array.from({ length: 16 }, () => tone),
    text:
      cred.text ||
      (tone === 'none'
        ? tVm('vm:detailStatusBoard.noCredentials')
        : tVm('vm:vmListTable.available')),
    tone,
  }
}

function StatusReason({
  vm,
  tone,
  now,
}: {
  vm: Vm
  tone: StatusTone
  now: number
}) {
  useTranslation('vm')

  const recovery = vmRestrictionRecovery(vm, now)
  const mark = <StatusMark tone={tone} variant='pill' className='text-xs' />
  const title =
    tone.key === 'circuit'
      ? vmCircuitTitle(vm, now)
      : tone.key === 'unschedulable' ||
          tone.key === 'revoke' ||
          tone.key === 'bad'
        ? restrictionCopy(vm)
        : recovery?.description ||
          (tone.key === 'cool' ? vmCooldownTitle(vm) : undefined)
  if (!title) return mark
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className='grid gap-1' title={title}>
          {mark}
          {recovery && (
            <span className='text-[11px] whitespace-nowrap text-muted-foreground tabular-nums'>
              {recovery.remaining}
            </span>
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent className='max-w-sm whitespace-normal'>
        {title}
      </TooltipContent>
    </Tooltip>
  )
}

function PriorityChip({ vm }: { vm: Vm }) {
  const { t: tVm } = useTranslation('vm')

  const level = Number(vm.schedule_level)
  const valid = Number.isInteger(level) && level >= 0
  const text = valid
    ? tVm('vm:vmListTable.priority', { level: level })
    : tVm('vm:vmListTable.priorityAlternative')
  const mode =
    vm.schedule_level_mode === 'manual'
      ? tVm('vm:vmListTable.manual')
      : tVm('vm:createOptions.automatic')
  const title = tVm('vm:vmListTable.schedulingLevel', { mode: mode })
  return (
    <span
      className='inline-flex rounded border border-border/70 px-1.5 py-0.5 font-mono text-[11px] leading-none font-semibold text-muted-foreground tabular-nums'
      title={title}
    >
      {text}
    </span>
  )
}

/**
 * 类型列：调用形式（console / oauth / api）+ 调度优先级，下一行是周窗口重置时刻。
 * 平台（Claude / GPT）与 pro / max 等级都在「账号」列，不在这里重复。
 */
function TypeCell({ vm, now }: { vm: Vm; now: number }) {
  const { t: tVm } = useTranslation('vm')

  const hasToken = Boolean(vm.has_token)
  const resetAt = vm.reset_7d || vm.reset_7d_oi
  const clock = hasToken ? fmtResetClock(resetAt) : null
  const resetMs = clock ? expiresAtToMs(resetAt) : 0
  const dueCls =
    resetMs > 0 && resetMs <= now
      ? 'text-[color:var(--status-bad)]'
      : 'text-muted-foreground'
  return (
    <div className='min-w-0 space-y-1'>
      <div className='flex flex-wrap items-center gap-x-1.5 gap-y-1'>
        {hasToken ? (
          <CredLaneChip vm={vm} />
        ) : (
          <span className='text-xs text-muted-foreground'>
            <Trans ns='vm' i18nKey='detailStatusBoard.noCredentials' />
          </span>
        )}
        <PriorityChip vm={vm} />
      </div>
      {clock ? (
        <div
          className={cn('font-mono text-[11px] tabular-nums', dueCls)}
          title={tVm('vm:vmListTable.weeklyWindowResetTime')}
        >
          <Trans
            ns='vm'
            i18nKey='vmListTable.resets'
            values={{ value: clock.slice(0, 11) }}
          />
        </div>
      ) : null}
    </div>
  )
}

function CountPill({ tone, n }: { tone: 'ok' | 'bad'; n: number }) {
  useTranslation('vm')

  return (
    <span
      className={cn(
        'inline-flex min-w-7 items-center justify-center rounded-full px-1.5 py-0.5 text-xs font-semibold tabular-nums',
        tone === 'ok'
          ? 'bg-[color:var(--status-ok-bg)] text-[color:var(--status-ok)]'
          : 'bg-[color:var(--status-bad-bg)] text-[color:var(--status-bad)]'
      )}
    >
      {fmtNum(n)}
    </span>
  )
}

/** 实时席位占用（预调度席位簿）；Codex 行没有席位。 */
function SeatTag({ vm }: { vm: Vm }) {
  const { t: tVm } = useTranslation('vm')

  if (vm.seats_max == null) return null
  const used = Number(vm.seats_used) || 0
  const queued = Number(vm.queue_depth) || 0
  if (!used && !queued) return null
  return (
    <span
      className={cn(
        'shrink-0 text-[11px] text-muted-foreground tabular-nums',
        queued > 0 && 'text-[color:var(--status-warn)]'
      )}
      title={seatTitle(vm)}
    >
      <Trans
        ns='vm'
        i18nKey='vmListTable.seats'
        values={{
          used: used,
          seats_max: vm.seats_max,
          value: queued
            ? tVm('vm:vmDetailCard.queued', { queued: queued })
            : '',
        }}
      />
    </span>
  )
}

function StatusCell({
  vm,
  show,
  now,
}: {
  vm: Vm
  show: StatusBarShow
  now: number
}) {
  const { t: tVm } = useTranslation('vm')

  const tone = poolStatus(vm)
  const inflight = Number(vm.inflight) || 0
  const health = healthModel(vm)
  const showInflight =
    inflight > 0 &&
    tone.cls !== 'bad' &&
    tone.cls !== 'none' &&
    tone.cls !== 'off'
  return (
    <div className='min-w-0 space-y-1'>
      {show.label ? (
        <div className='flex flex-wrap items-center gap-1.5'>
          <StatusReason vm={vm} tone={tone} now={now} />
          {showInflight ? (
            <span
              className='inline-flex size-5 items-center justify-center rounded-full bg-[color:var(--tier-pro-solid)] text-[11px] font-semibold text-[color:var(--tier-pro-solid-fg)] tabular-nums'
              title={tVm('vm:vmListTable.inFlight', { inflight: inflight })}
            >
              {inflight}
            </span>
          ) : null}
          <SeatTag vm={vm} />
        </div>
      ) : null}
      {show.bar ? (
        <div className='flex items-center gap-1.5' title={health.text}>
          <div
            className='flex h-1.5 min-w-0 flex-1 gap-px overflow-hidden rounded-full track-recessed'
            aria-hidden
          >
            {health.dots.map((dot, i) => (
              <span
                key={i}
                className='h-full flex-1'
                style={{ backgroundColor: DOT_BG[dot] }}
              />
            ))}
          </div>
          <span
            className={cn(
              'max-w-[6rem] shrink-0 truncate text-xs font-medium',
              DOT_FG[health.tone]
            )}
          >
            {health.text}
          </span>
        </div>
      ) : null}
      {show.proxy ? <ProxyChip vm={vm} compact /> : null}
    </div>
  )
}

/** 只放次数：今日请求与 7D 成功 / 失败。行高与用量窗口、成本账逐行对齐。 */
function RequestCell({
  vm,
  accounts,
  week,
}: {
  vm: Vm
  accounts?: UsageAccountRow[]
  week: VmWeekOutcome
}) {
  const { t: tVm } = useTranslation('vm')

  const s = vmTodayStats(vm, accounts)
  return (
    <div className='grid min-w-0 gap-1'>
      <div
        className={cn(
          'flex items-center gap-1.5 font-mono text-xs tabular-nums',
          METRIC_ROW
        )}
      >
        <span className='w-7 shrink-0 font-sans text-xs font-medium text-muted-foreground'>
          <Trans ns='vm' i18nKey='detailAccountTab.today' />
        </span>
        {s.req > 0 ? (
          <span className='font-medium'>
            {fmtNum(s.req)}
            <span className='font-normal text-muted-foreground'>
              {' '}
              <Trans ns='vm' i18nKey='units.requestsShort' />
            </span>
          </span>
        ) : (
          <span className='text-[color:var(--text-tertiary)]'>—</span>
        )}
      </div>
      <div
        className={cn('flex items-center gap-1.5', METRIC_ROW)}
        title={tVm('vm:vmListTable.7DayWindowSucceededFailed')}
      >
        <span className='w-7 shrink-0 text-xs font-medium text-muted-foreground'>
          <Trans ns='vm' i18nKey='units.sevenDays' />
        </span>
        <WeekPills week={week} />
      </div>
    </div>
  )
}

function WeekPills({ week }: { week: VmWeekOutcome }) {
  useTranslation('vm')

  if (!week.known) {
    return week.req <= 0 ? (
      <>
        <CountPill tone='ok' n={0} />
        <CountPill tone='bad' n={0} />
      </>
    ) : (
      <>
        <CountPill tone='ok' n={week.req} />
        <span className='text-xs text-muted-foreground'>
          <Trans ns='vm' i18nKey='vmListTable.failures' />
        </span>
      </>
    )
  }
  return (
    <>
      <CountPill tone='ok' n={week.success} />
      <CountPill tone='bad' n={week.fail} />
    </>
  )
}

/** pro / max（GPT 为套餐名）跟着账号走，放在账号名同一行。 */
function TierBadge({ vm }: { vm: Vm }) {
  useTranslation('vm')

  if (isCodexVm(vm)) return <OpenaiPlanBadge vm={vm} />
  const skin = tierVisual(vm)
  if (skin.key !== 'pro' && skin.key !== 'max' && skin.key !== 'unknown') {
    return null
  }
  return (
    <span
      className={cn(
        'shrink-0 rounded px-1.5 py-0.5 text-[10px] leading-none font-bold tracking-[0.03em] uppercase',
        skin.badge
      )}
    >
      {skin.label}
    </span>
  )
}

function SlotCell({ vm, now }: { vm: Vm; now: number }) {
  useTranslation('vm')

  const name = slotNameLabel(vm)
  const email = String(vm.email || '').trim()
  const sub = subscriptionListLabel(vm, now)
  return (
    <div className='min-w-0 space-y-0.5 overflow-hidden'>
      <SlotIdentity vm={vm} compact className='text-sm font-medium' />
      <div className='flex min-w-0 items-center gap-1.5'>
        <ActiveVmBadge vm={vm} />
        <TierBadge vm={vm} />
        <RuntimeChip vm={vm} />
        <NodeChip nodeId={vm.node_id} />
        <span
          className='min-w-0 truncate text-[11px] text-muted-foreground'
          title={email ? name : undefined}
        >
          {name}
        </span>
      </div>
      <div
        className={cn(
          'truncate font-mono text-[11px] tabular-nums',
          sub.tone === 'bad' && 'text-[color:var(--status-bad)]',
          sub.tone === 'warn' && 'text-[color:var(--status-warn)]',
          sub.tone === 'muted' && 'text-muted-foreground'
        )}
        title={sub.title}
      >
        {sub.text}
      </div>
      <VmGroupLabels
        vm={vm}
        className='truncate text-[10.5px] text-muted-foreground'
      />
    </div>
  )
}

type CellCtx = {
  vm: Vm
  accounts?: UsageAccountRow[]
  now: number
  week: VmWeekOutcome
  statusShow: StatusBarShow
}

const COLUMNS: Record<
  VmColumnKey,
  { label: string; cell: (ctx: CellCtx) => ReactNode }
> = {
  groups: {
    get label() {
      return tVm('vm:vmListTable.groups')
    },
    cell: ({ vm }) => <VmGroupLabels vm={vm} />,
  },
  vm: {
    get label() {
      return tVm('vm:detailAccountTab.account')
    },
    cell: ({ vm, now }) => <SlotCell vm={vm} now={now} />,
  },
  sched: {
    get label() {
      return tVm('vm:vmListTable.scheduling')
    },
    cell: ({ vm }) => (
      <div onClick={(e) => e.stopPropagation()}>
        <SchedulableSwitch {...vmSchedulableProps(vm)} />
      </div>
    ),
  },
  type: {
    get label() {
      return tVm('vm:detailAccountTab.type')
    },
    cell: ({ vm, now }) => <TypeCell vm={vm} now={now} />,
  },
  status: {
    get label() {
      return tVm('vm:detailAccountTab.status')
    },
    cell: ({ vm, statusShow, now }) => (
      <StatusCell vm={vm} show={statusShow} now={now} />
    ),
  },
  req: {
    get label() {
      return tVm('vm:vmListTable.today7DayRequests')
    },
    cell: ({ vm, accounts, week }) => (
      <RequestCell vm={vm} accounts={accounts} week={week} />
    ),
  },
  usage: {
    get label() {
      return tVm('vm:usageWindows.usageWindows')
    },
    cell: ({ vm, now }) => (
      <VmUsageWindows vm={vm} now={now} quiet quotaActions />
    ),
  },
  cost: {
    get label() {
      return tVm('vm:vmListTable.costTotal')
    },
    cell: ({ vm, accounts }) => <VmCostLedger vm={vm} accounts={accounts} />,
  },
}

export function VmTable({
  vms,
  accounts,
}: {
  vms: Vm[]
  accounts?: UsageAccountRow[]
}) {
  const { t: tVm } = useTranslation('vm')

  const actions = useVmActions()
  const now = useNow()
  const statusBar = useStatusBarShow()
  const columns = useVmColumnOrder()
  const canSeeMoney = useVmPerms().admin
  const [dragKey, setDragKey] = useState<VmColumnKey | null>(null)
  const [overKey, setOverKey] = useState<VmColumnKey | null>(null)
  const onRowKey = (e: KeyboardEvent<HTMLDivElement>, vm: Vm) => {
    if (e.target !== e.currentTarget) return
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    actions.openDetail(vm)
  }
  const endDrag = () => {
    setDragKey(null)
    setOverKey(null)
  }
  // 拖动只靠指针；Alt+←/→ 给键盘用户同样的能力。
  const onHeaderKey = (e: KeyboardEvent<HTMLDivElement>, key: VmColumnKey) => {
    if (!e.altKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return
    const i = columns.order.indexOf(key)
    const target = columns.order[i + (e.key === 'ArrowLeft' ? -1 : 1)]
    if (!target) return
    e.preventDefault()
    columns.move(key, target)
  }
  return (
    <div className='overflow-x-auto rounded-lg border border-border/60'>
      <div className='min-w-[1300px]'>
        <div className='sticky top-0 z-10 flex h-8 items-center border-b bg-muted/30 pl-1.5 text-xs font-medium tracking-wide text-muted-foreground'>
          {columns.order
            .filter((k) => canSeeMoney || k !== 'cost')
            .map((key) => {
              const dragging = dragKey === key
              const target = overKey === key && dragKey && dragKey !== key
              const forward =
                dragKey != null &&
                columns.order.indexOf(dragKey) < columns.order.indexOf(key)
              return (
                <div
                  key={key}
                  draggable
                  tabIndex={0}
                  title={tVm('vm:vmListTable.dragToReorderColumnsAlt')}
                  className={cn(
                    'group/col flex cursor-grab items-center gap-0.5 px-1.5 py-1 select-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring active:cursor-grabbing',
                    COL_CLS[key],
                    dragging && 'opacity-40',
                    target &&
                      (forward
                        ? 'shadow-[inset_-2px_0_0_0_var(--ring)]'
                        : 'shadow-[inset_2px_0_0_0_var(--ring)]')
                  )}
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = 'move'
                    e.dataTransfer.setData('text/plain', key)
                    setDragKey(key)
                  }}
                  onDragOver={(e) => {
                    if (!dragKey) return
                    e.preventDefault()
                    e.dataTransfer.dropEffect = 'move'
                    if (overKey !== key) setOverKey(key)
                  }}
                  onDrop={(e) => {
                    e.preventDefault()
                    if (dragKey) columns.move(dragKey, key)
                    endDrag()
                  }}
                  onDragEnd={endDrag}
                  onKeyDown={(e) => onHeaderKey(e, key)}
                >
                  <GripVertical
                    className='size-3 shrink-0 opacity-0 transition-opacity group-hover/col:opacity-60'
                    aria-hidden
                  />
                  <span className='truncate'>{COLUMNS[key].label}</span>
                  {key === 'status' ? (
                    <StatusBarOptions
                      show={statusBar.show}
                      onToggle={statusBar.toggle}
                    />
                  ) : null}
                </div>
              )
            })}
          <div className={cn(COL_CLS.actions, 'flex justify-end')}>
            {columns.isDefault ? null : (
              <Button
                type='button'
                size='icon'
                variant='ghost'
                className='size-6 text-muted-foreground'
                title={tVm('vm:vmListTable.restoreDefaultColumnOrder')}
                aria-label={tVm('vm:vmListTable.restoreDefaultColumnOrder')}
                onClick={columns.reset}
              >
                <RotateCcw className='size-3.5' />
              </Button>
            )}
          </div>
        </div>
        {vms.map((vm) => {
          const week = vmWeekOutcome(vm, accounts)
          const group = fleetGroup(vm)
          const muted = group === 'off' || group === 'none'
          const ctx: CellCtx = {
            vm,
            accounts,
            now,
            week,
            statusShow: statusBar.show,
          }
          return (
            <div
              key={vm.id}
              role='button'
              tabIndex={0}
              aria-label={tVm('vm:vmListTable.viewDetailsFor', { id: vm.id })}
              className={cn(
                'group flex cursor-pointer items-start border-b border-border/40 py-2 pl-1.5 transition-colors duration-150 last:border-b-0 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
                // 等级色只走行首 2px，不染整行底色：行是密集数字，底色一染就没对比空间了。
                tierVisual(vm).row || 'hover:bg-accent/40',
                muted && 'opacity-60'
              )}
              onClick={() => actions.openDetail(vm)}
              onKeyDown={(e) => onRowKey(e, vm)}
            >
              {columns.order
                .filter((k) => canSeeMoney || k !== 'cost')
                .map((key) => (
                  <div key={key} className={cn('px-1.5', COL_CLS[key])}>
                    {COLUMNS[key].cell(ctx)}
                  </div>
                ))}
              <div
                className={cn(COL_CLS.actions, 'flex justify-end')}
                onClick={(e) => e.stopPropagation()}
              >
                <VmActionMenu vm={vm} />
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
