import { useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { UsageAccountRow } from '@/types/panel-usage'
import type { Vm } from '@/types/panel-vm'
import {
  BarChart3,
  ExternalLink,
  Link2,
  Play,
  RefreshCw,
  RotateCcw,
  UserRoundPlus,
} from 'lucide-react'
import { useTranslation, Trans } from 'react-i18next'
import { credTypeLabel, credTypeOf } from '@/lib/cred-type'
import { fmtExpiresAt, fmtNum, fmtUsd } from '@/lib/format'
import { cn } from '@/lib/utils'
import { compactEmail, isCodexVm, slotNameLabel } from '@/lib/vm-kind'
import {
  accountStatus,
  claudeTier,
  credExpiry,
  poolStatus,
  restrictionCopy,
  seatTitle,
  vmRunning,
} from '@/lib/vm-status'
import { fmtHitPct, vmTodayStats, vmWeekOutcome } from '@/lib/vm-usage'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  CredLaneChip,
  PlatformChip,
  SlotIdentity,
} from '@/components/platform-chip'
import { StatusMark } from '@/components/status-mark'
import { meQueryOptions } from '@/features/auth/queries'
import { ProxyChip } from '@/features/proxies/proxy-chip'
import { ActiveVmBadge } from '@/features/vm/active-vm-badge'
import { restrictionTitle } from '@/features/vm/clear-restriction'
import { Field } from '@/features/vm/detail-section-primitives'
import { NodeChip } from '@/features/vm/node-chip'
import { OpenaiPlanBadge } from '@/features/vm/openai-plan-badge'
import { RuntimeChip } from '@/features/vm/runtime-chip'
import {
  SchedulableSwitch,
  vmSchedulableProps,
} from '@/features/vm/schedulable-switch'
import { VmUsagePanel } from '@/features/vm/usage-windows'
import { refreshBlockedReason } from '@/features/vm/vm-action-menu'
import { useVmActions } from '@/features/vm/vm-actions-context'
import { VmGroupLabels } from '@/features/vm/vm-groups'
import { VmMemoryBlock } from '@/features/vm/vm-memory-block'
import { useVmPerms } from '@/features/vm/vm-perms'
import { VmSchedulingBlock } from '@/features/vm/vm-scheduling'

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  useTranslation('vm')

  return (
    <section className='min-w-0 rounded-lg border px-3 py-2.5'>
      <h3 className='mb-1 text-xs font-medium text-muted-foreground'>
        {title}
      </h3>
      {children}
    </section>
  )
}

function CardBody({ vm, accounts }: { vm: Vm; accounts?: UsageAccountRow[] }) {
  const { t: tVm } = useTranslation('vm')

  const actions = useVmActions()
  const me = useQuery(meQueryOptions())
  const admin = me.data?.role === 'super_admin'
  const perms = useVmPerms()

  const today = vmTodayStats(vm, accounts)
  const week = vmWeekOutcome(vm, accounts)
  const codex = isCodexVm(vm)
  const credType = credTypeOf(vm)
  const tier = claudeTier(vm)
  const blocked = refreshBlockedReason(vm)
  const restricted = restrictionTitle(vm)
  const inflight = Number(vm.inflight) || 0
  const queued = Number(vm.queue_depth) || 0
  return (
    <>
      <div className='flex flex-wrap items-center gap-1.5'>
        <PlatformChip vm={vm} />
        <ActiveVmBadge vm={vm} />
        <StatusMark tone={accountStatus(vm)} variant='pill' />
        {tier.key !== 'none' ? <StatusMark tone={tier} variant='pill' /> : null}
        {poolStatus(vm).key !== accountStatus(vm).key ? (
          <StatusMark tone={poolStatus(vm)} variant='pill' />
        ) : null}
        <span className='text-xs text-muted-foreground'>
          {vmRunning(vm)
            ? tVm('vm:detailPage.running')
            : tVm('vm:detailPage.stop')}
          {inflight > 0
            ? tVm('vm:vmDetailCard.inFlight', { inflight: inflight })
            : ''}
        </span>
        {vm.seats_max != null ? (
          <span
            className={cn(
              'text-xs text-muted-foreground tabular-nums',
              queued > 0 && 'text-[color:var(--status-warn)]'
            )}
            title={seatTitle(vm)}
          >
            <Trans
              ns='vm'
              i18nKey='vmDetailCard.seats'
              values={{
                value: Number(vm.seats_used) || 0,
                seats_max: vm.seats_max,
                value1:
                  queued > 0
                    ? tVm('vm:vmDetailCard.queued', { queued: queued })
                    : '',
              }}
            />
          </span>
        ) : null}
        <div className='ms-auto flex items-center gap-1.5 text-xs text-muted-foreground'>
          <Trans
            ns='vm'
            i18nKey='detailPage.scheduling'
            components={{
              part0: <SchedulableSwitch {...vmSchedulableProps(vm)} />,
            }}
          />
        </div>
      </div>
      <p className='text-xs text-muted-foreground'>{restrictionCopy(vm)}</p>

      <section className='min-w-0 rounded-lg border px-3 py-2.5'>
        <VmUsagePanel vm={vm} accounts={accounts} />
      </section>

      <VmSchedulingBlock vm={vm} />
      <VmMemoryBlock vm={vm} />

      <div className='grid gap-2 sm:grid-cols-2'>
        <Section title={tVm('vm:detailAccountTab.today')}>
          <div className='flex items-baseline justify-between'>
            <span className='text-lg leading-tight font-semibold tabular-nums'>
              {fmtUsd(today.today, 2)}
            </span>
            <span className='font-mono text-xs text-muted-foreground tabular-nums'>
              {fmtNum(today.req)}{' '}
              <Trans ns='vm' i18nKey='units.requestsShort' /> ·{' '}
              {fmtNum(today.tok)} <Trans ns='vm' i18nKey='units.tokensShort' />
            </span>
          </div>
          <div className='mt-1 font-mono text-[11px] text-muted-foreground tabular-nums'>
            <Trans
              ns='vm'
              i18nKey='vmDetailCard.inputOutputCacheHit'
              values={{
                formattedNum: fmtNum(today.inn),
                formattedNum1: fmtNum(today.out),
                formattedNum2: fmtNum(today.read),
                formattedNum3: fmtNum(today.write),
                formattedHitPct: fmtHitPct(today.hit),
              }}
            />
          </div>
        </Section>
        <Section title={tVm('vm:vmDetailCard.7DayRequests')}>
          <div className='flex items-baseline justify-between'>
            <span className='text-lg leading-tight font-semibold tabular-nums'>
              {fmtNum(week.known ? week.success + week.fail : week.req)}
            </span>
            <span className='font-mono text-xs tabular-nums'>
              <span className='text-[color:var(--status-ok)]'>
                {week.known ? fmtNum(week.success) : '—'}
              </span>
              {' / '}
              <span className='text-[color:var(--status-bad)]'>
                {week.known ? fmtNum(week.fail) : '—'}
              </span>
            </span>
          </div>
          <div className='mt-1 text-[11px] text-muted-foreground'>
            <Trans ns='vm' i18nKey='vmDetailCard.7DayWindowSucceededFailed' />
          </div>
        </Section>
      </div>

      <div className='grid gap-2 sm:grid-cols-2'>
        <Section title={tVm('vm:detailAccountTab.account')}>
          <div className='divide-y'>
            <Field label={tVm('vm:detailAccountTab.type')} compact>
              {credType === 'none' ? (
                '-'
              ) : (
                <span className='flex flex-wrap items-center gap-1.5'>
                  <CredLaneChip vm={vm} />
                  <span className='text-xs text-muted-foreground'>
                    <Trans
                      ns='vm'
                      i18nKey='vmDetailCard.credentials'
                      values={{ credTypeLabel: credTypeLabel(credType) }}
                    />
                  </span>
                  {codex ? <OpenaiPlanBadge vm={vm} /> : null}
                </span>
              )}
            </Field>
            <Field label={tVm('vm:detailStatusBoard.email')} compact>
              <span className='text-xs' title={String(vm.email || '')}>
                {vm.email ? compactEmail(String(vm.email), 30) : '-'}
              </span>
            </Field>
            <Field label={tVm('vm:detailAccountTab.expiry')} compact>
              <div className='flex flex-wrap items-center gap-x-1.5 gap-y-1 break-normal'>
                <StatusMark tone={credExpiry(vm)} variant='pill' />
                <span className='text-xs text-muted-foreground'>
                  {fmtExpiresAt(vm.expires_at)}
                </span>
              </div>
            </Field>
            <Field label={tVm('vm:vmDetailCard.token')} compact>
              <span className='text-xs'>
                {tVm('vm:messages.credentialPresence', {
                  access: vm.has_token
                    ? tVm('vm:detailAccountTab.written')
                    : '—',
                  refresh: vm.has_refresh
                    ? tVm('vm:detailAccountTab.bound')
                    : '—',
                })}
              </span>
            </Field>
          </div>
        </Section>
        <Section title={tVm('vm:testChatTypes.slot')}>
          <div className='divide-y'>
            <Field label={tVm('vm:createVmForm.name')} compact>
              <span className='text-xs'>{slotNameLabel(vm)}</span>
            </Field>
            <Field label='ID' compact>
              <span className='font-mono text-xs'>{vm.id}</span>
            </Field>
            <Field label={tVm('vm:detailPage.proxy')} compact>
              <ProxyChip vm={vm} compact />
            </Field>
            {admin ? (
              <Field label={tVm('vm:vmDetailCard.assignedGroups')} compact>
                <VmGroupLabels vm={vm} />
              </Field>
            ) : null}
          </div>
        </Section>
      </div>

      <div className='flex flex-wrap gap-1.5 border-t pt-3'>
        {perms.test ? (
          <Button
            size='sm'
            variant='outline'
            onClick={() => actions.openTest(vm)}
          >
            <Trans
              ns='vm'
              i18nKey='vmDetailCard.testConnection'
              components={{ part0: <Play /> }}
            />
          </Button>
        ) : null}
        <Button
          size='sm'
          variant='outline'
          onClick={() => actions.openStats(vm)}
        >
          <Trans
            ns='vm'
            i18nKey='vmDetailCard.viewStatistics'
            components={{ part0: <BarChart3 /> }}
          />
        </Button>
        {perms.credential ? (
          <>
            <Button
              size='sm'
              variant='outline'
              onClick={() => actions.openReauth(vm)}
            >
              <Trans
                ns='vm'
                i18nKey='vmDetailCard.reauthorize'
                components={{ part0: <Link2 /> }}
              />
            </Button>
            <Button
              size='sm'
              variant='outline'
              disabled={Boolean(blocked) || actions.refreshingId === vm.id}
              title={blocked || undefined}
              onClick={() => actions.refreshToken(vm)}
            >
              <Trans
                ns='vm'
                i18nKey='vmDetailCard.refreshToken'
                components={{ part0: <RefreshCw /> }}
              />
            </Button>
          </>
        ) : null}
        <Button
          size='sm'
          variant='outline'
          disabled={!restricted || actions.recoveringId === vm.id}
          title={restricted ?? tVm('vm:vmActionMenu.noCooldownOrOpenCircuit')}
          onClick={() => actions.recover(vm)}
        >
          <Trans
            ns='vm'
            i18nKey='vmDetailCard.restoreStatus'
            components={{ part0: <RotateCcw /> }}
          />
        </Button>
        {actions.openAssignGroups ? (
          <Button
            size='sm'
            variant='outline'
            disabled={actions.groupsBusyId === vm.id}
            onClick={() => actions.openAssignGroups?.(vm)}
          >
            <Trans
              ns='vm'
              i18nKey='vmDetailCard.assignGroups'
              components={{ part0: <UserRoundPlus /> }}
            />
          </Button>
        ) : null}

        <Button size='sm' variant='ghost' className='ms-auto' asChild>
          <Link to='/vm/$id' params={{ id: vm.id }}>
            <Trans
              ns='vm'
              i18nKey='vmDetailCard.fullPage'
              components={{ part0: <ExternalLink /> }}
            />
          </Link>
        </Button>
      </div>
    </>
  )
}

/** 点击槽位弹出的详情卡：身份、状态、用量窗口、账号信息与常用操作。 */
export function VmDetailCard({
  vm,
  accounts,
  onOpenChange,
}: {
  vm: Vm | null
  accounts?: UsageAccountRow[]
  onOpenChange: (open: boolean) => void
}) {
  const { t: tVm } = useTranslation('vm')

  const contentRef = useRef<HTMLDivElement>(null)
  return (
    <Dialog open={vm != null} onOpenChange={onOpenChange}>
      <DialogContent
        className='flex max-h-[90vh] flex-col gap-3 sm:max-w-2xl'
        // 首个可聚焦元素是调度开关，自动聚焦会弹出它的 tooltip 并有误触风险；
        // 改为聚焦弹窗本身，Esc 与焦点陷阱照常工作。
        ref={contentRef}
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          contentRef.current?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle className='flex min-w-0 items-center gap-1.5 text-base'>
            {vm ? (
              <SlotIdentity vm={vm} compact />
            ) : (
              tVm('vm:vmDetailCard.slotDetails')
            )}
            {vm ? <RuntimeChip vm={vm} /> : null}
            {vm ? <NodeChip nodeId={vm.node_id} /> : null}
          </DialogTitle>
          <DialogDescription className='sr-only'>
            <Trans ns='vm' i18nKey='vmDetailCard.slotDetails' />
          </DialogDescription>
        </DialogHeader>
        <div className='-me-3 min-h-0 flex-1 overflow-y-auto pe-3'>
          <div className='space-y-2.5 pb-1'>
            {vm ? <CardBody vm={vm} accounts={accounts} /> : null}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
