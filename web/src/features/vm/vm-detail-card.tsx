import { useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { UsageAccountRow } from '@/types/panel-usage'
import type { Vm } from '@/types/panel-vm'
import {
  BarChart3,
  ExternalLink,
  Link2,
  Pencil,
  Play,
  RefreshCw,
  RotateCcw,
  UserRoundPlus,
} from 'lucide-react'
import { useTranslation, Trans } from 'react-i18next'
import { billingChannelLabel } from '@/lib/account-identity'
import { credTypeLabel, credTypeOf } from '@/lib/cred-type'
import { fmtDateMinute, fmtExpiresAt, fmtNum, fmtUsd } from '@/lib/format'
import { cn } from '@/lib/utils'
import { isCodexVm, slotNameLabel } from '@/lib/vm-kind'
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
import { runtimeTypeOf } from '@/features/vm/machine-spec'
import { NodeChip } from '@/features/vm/node-chip'
import { OpenaiPlanBadge } from '@/features/vm/openai-plan-badge'
import { RuntimeChip } from '@/features/vm/runtime-chip'
import {
  SchedulableSwitch,
  vmSchedulableProps,
} from '@/features/vm/schedulable-switch'
import { SharedQuotaBadge } from '@/features/vm/shared-quota-badge'
import { VmUsagePanel } from '@/features/vm/usage-windows'
import { refreshBlockedReason } from '@/features/vm/vm-action-menu'
import { useVmActions } from '@/features/vm/vm-actions-context'
import { VmGroupLabels } from '@/features/vm/vm-groups'
import { VmMemoryBlock } from '@/features/vm/vm-memory-block'
import { useVmPerms, vmPermsFor } from '@/features/vm/vm-perms'
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

/** 账号、槽位两张窄卡片的标签只有两到四个字，收窄标签列给值留空间。 */
const LABEL_W = '4.5rem'

function statusText(tone: { label?: string; text?: string }) {
  return tone.label || tone.text || ''
}

/** 邮箱只在「@」处折行，不在域名中间断开，也不截断。 */
function EmailText({ value }: { value: string }) {
  const at = value.indexOf('@')
  if (at < 0) return <>{value}</>
  return (
    <span className='break-normal'>
      {value.slice(0, at)}
      <wbr />
      {value.slice(at)}
    </span>
  )
}

/** 今日明细：标签左对齐、数值右对齐，两列逐行对齐。 */
function TodayStat({ label, value }: { label: string; value: string }) {
  return (
    <div className='flex min-w-0 items-baseline justify-between gap-2'>
      <dt className='shrink-0 text-muted-foreground'>{label}</dt>
      <dd className='font-mono whitespace-nowrap tabular-nums'>{value}</dd>
    </div>
  )
}

/** 详情卡正文（不含弹窗外壳），由 VmActions 上下文驱动。 */
export function VmDetailCardBody({
  vm,
  accounts,
}: {
  vm: Vm
  accounts?: UsageAccountRow[]
}) {
  const { t: tVm } = useTranslation('vm')

  const actions = useVmActions(vm)
  const me = useQuery(meQueryOptions())
  const admin = vmPermsFor(me.data).read
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
  // Gateway Worker 账号没有槽位调度与内存，相应区块由账号编辑负责。
  const gateway = runtimeTypeOf(vm) === 'gateway'
  const channel = billingChannelLabel(vm.billing_type)
  const subscriptionAt = codex ? vm.chatgpt_subscription_active_until : null
  const expiryAt = subscriptionAt || vm.expires_at
  const expiryTitle = subscriptionAt
    ? `${tVm('vm:vmDetailCard.subscription')} ${fmtExpiresAt(subscriptionAt)}${
        vm.expires_at
          ? ` · ${tVm('vm:vmDetailCard.token')} ${fmtExpiresAt(vm.expires_at)}`
          : ''
      }`
    : vm.expires_at
      ? `${tVm('vm:vmDetailCard.token')} ${fmtExpiresAt(vm.expires_at)}`
      : undefined
  return (
    <>
      <div className='flex flex-wrap items-center gap-1.5'>
        <PlatformChip vm={vm} />
        <ActiveVmBadge vm={vm} />
        <SharedQuotaBadge vm={vm} />
        <StatusMark tone={accountStatus(vm)} variant='pill' />
        {tier.key !== 'none' ? <StatusMark tone={tier} variant='pill' /> : null}
        {/* 池状态与账号状态文案相同（都是「可用」）时只显示一个 */}
        {statusText(poolStatus(vm)) !== statusText(accountStatus(vm)) ? (
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
              part0: (
                <SchedulableSwitch
                  {...vmSchedulableProps(vm)}
                  onToggle={
                    actions.setSchedulable
                      ? (next) => actions.setSchedulable!(vm, next)
                      : undefined
                  }
                />
              ),
            }}
          />
        </div>
      </div>
      <p className='text-xs text-muted-foreground'>{restrictionCopy(vm)}</p>

      <section className='min-w-0 rounded-lg border px-3 py-2.5'>
        <VmUsagePanel vm={vm} accounts={accounts} />
      </section>

      {gateway ? null : <VmSchedulingBlock vm={vm} />}
      <VmMemoryBlock vm={vm} />

      <div className='grid gap-2 sm:grid-cols-2'>
        <Section title={tVm('vm:detailAccountTab.today')}>
          <div className='flex items-baseline justify-between gap-2'>
            <span className='text-lg leading-tight font-semibold tabular-nums'>
              {fmtUsd(today.today, 2)}
            </span>
            <span className='font-mono text-xs whitespace-nowrap tabular-nums'>
              <span className='font-sans text-muted-foreground'>
                {tVm('vm:vmDetailCard.todayHit')}{' '}
              </span>
              {fmtHitPct(today.hit)}
            </span>
          </div>
          <dl className='mt-1.5 grid grid-cols-2 gap-x-4 gap-y-0.5 text-[11px]'>
            <TodayStat
              label={tVm('vm:vmDetailCard.todayRequests')}
              value={fmtNum(today.req)}
            />
            <TodayStat label='Token' value={fmtNum(today.tok)} />
            <TodayStat
              label={tVm('vm:vmDetailCard.todayInput')}
              value={fmtNum(today.inn)}
            />
            <TodayStat
              label={tVm('vm:vmDetailCard.todayOutput')}
              value={fmtNum(today.out)}
            />
            <TodayStat
              label={tVm('vm:vmDetailCard.todayCacheRead')}
              value={fmtNum(today.read)}
            />
            <TodayStat
              label={tVm('vm:vmDetailCard.todayCacheWrite')}
              value={fmtNum(today.write)}
            />
          </dl>
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
            <Field
              label={tVm('vm:detailAccountTab.type')}
              compact
              labelWidth={LABEL_W}
            >
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
            <Field
              label={tVm('vm:detailStatusBoard.email')}
              compact
              labelWidth={LABEL_W}
            >
              <span className='text-xs'>
                {vm.email ? <EmailText value={String(vm.email)} /> : '-'}
              </span>
            </Field>
            {channel ? (
              <Field
                label={tVm('vendor:identity.channel')}
                compact
                labelWidth={LABEL_W}
              >
                <span className='text-xs'>{channel}</span>
              </Field>
            ) : null}
            <Field
              label={tVm('vm:detailAccountTab.expiry')}
              compact
              labelWidth={LABEL_W}
            >
              {/* GPT 显示订阅到期，Claude 显示令牌到期，紧跟在状态后面 */}
              <div className='flex items-center gap-2 break-normal'>
                <StatusMark tone={credExpiry(vm)} variant='pill' />
                {expiryAt ? (
                  <span
                    className='text-xs whitespace-nowrap text-muted-foreground tabular-nums'
                    title={expiryTitle}
                  >
                    {fmtDateMinute(expiryAt)}
                  </span>
                ) : null}
              </div>
            </Field>
            <Field
              label={tVm('vm:vmDetailCard.token')}
              compact
              labelWidth={LABEL_W}
            >
              <div className='grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs break-normal'>
                <span className='text-muted-foreground'>
                  {tVm('vm:labels.accessToken')}
                </span>
                <span>
                  {vm.has_token ? tVm('vm:detailAccountTab.written') : '—'}
                </span>
                <span className='text-muted-foreground'>
                  {tVm('vm:labels.refreshToken')}
                </span>
                <span>
                  {vm.has_refresh ? tVm('vm:detailAccountTab.bound') : '—'}
                </span>
              </div>
            </Field>
          </div>
        </Section>
        <Section title={tVm('vm:testChatTypes.slot')}>
          <div className='divide-y'>
            <Field
              label={tVm('vm:createVmForm.name')}
              compact
              labelWidth={LABEL_W}
            >
              <span className='text-xs'>
                <EmailText value={slotNameLabel(vm)} />
              </span>
            </Field>
            <Field label='ID' compact labelWidth={LABEL_W}>
              <span className='font-mono text-xs'>{vm.id}</span>
            </Field>
            <Field
              label={tVm('vm:detailPage.proxy')}
              compact
              labelWidth={LABEL_W}
            >
              <ProxyChip vm={vm} compact />
            </Field>
            {admin ? (
              <Field
                label={tVm('vm:vmDetailCard.assignedGroups')}
                compact
                labelWidth={LABEL_W}
              >
                <VmGroupLabels vm={vm} />
              </Field>
            ) : null}
          </div>
        </Section>
      </div>

      <div className='flex flex-wrap gap-1.5 border-t pt-3'>
        {actions.openEdit ? (
          <Button
            size='sm'
            variant='outline'
            onClick={() => actions.openEdit?.(vm)}
          >
            <Trans
              ns='vm'
              i18nKey='vmDetailCard.editAccount'
              components={{ part0: <Pencil /> }}
            />
          </Button>
        ) : null}
        {perms.edit ? (
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
        {perms.edit ? (
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
        {perms.edit ? (
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
        ) : null}
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
          <Link to={actions.detailRoute ?? '/vm/$id'} params={{ id: vm.id }}>
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
            {vm ? <VmDetailCardBody vm={vm} accounts={accounts} /> : null}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
