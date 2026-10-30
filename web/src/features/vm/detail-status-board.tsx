import { t as tr } from '@/i18n'
import { t as tVm } from '@/i18n'
import type { Dashboard } from '@/types/panel-overview'
import type {
  Vm,
  VmClosedWindow,
  VmDetailPayload,
  VmKernelSnapshot,
  VmProxySnap,
} from '@/types/panel-vm'
import type { StatusTone } from '@/types/status'
import { useTranslation, Trans } from 'react-i18next'
import {
  fableCap,
  fableCardInfo,
  type ConcurrencyInfo,
  type RpmInfo,
  type VmCostSummary,
  type WeeklySplitSummary,
} from '@/lib/fable-status'
import { fmtNum, fmtUsd } from '@/lib/format'
import { isCodexVm } from '@/lib/vm-kind'
import {
  accountStatus,
  accountUsable,
  poolStatus,
  proxyNamedLabel,
  restrictionCopy,
  restrictionUntilOf,
  scheduleStateLabel,
  vmRunning,
} from '@/lib/vm-status'
import { closedWindowHint, formatWindowSpend } from '@/lib/vm-usage'
import {
  kernelHopReady,
  kernelProcessUp,
  wrapHealthLabel,
} from '@/lib/wrap-health'
import { SlotIdentity } from '@/components/platform-chip'
import { StatusMark } from '@/components/status-mark'
import { ClaudeResetActions } from '@/features/vm/claude-reset-actions'
import { CodexKernelHealthFields } from '@/features/vm/codex-kernel-health-card'
import { dataplaneLabel } from '@/features/vm/dataplane-contract'
import { CircuitField } from '@/features/vm/detail-circuit-field'
import {
  Field,
  Meter,
  quotaWindowHint,
  ResetAt,
} from '@/features/vm/detail-section-primitives'
import type { VmTodayCounts } from '@/features/vm/detail-today'
import { KernelFeatTags } from '@/features/vm/kernel-feat-tags'
import { OpenaiPlanBadge } from '@/features/vm/openai-plan-badge'
import { OpenaiQuotaPanel } from '@/features/vm/openai-quota-panel'
import { proxyHealthOf } from '@/features/vm/proxy-health'
import { RuntimeChip } from '@/features/vm/runtime-chip'
import { VmMemoryBlock } from '@/features/vm/vm-memory-block'
import { VmSchedulingBlock } from '@/features/vm/vm-scheduling'
import { telemetryStatusLabel } from './telemetry-status'

type Props = {
  vm: Vm
  kernel?: VmKernelSnapshot | null
  acc: Record<string, unknown>
  proxy: VmProxySnap
  dash: { data: Dashboard | undefined }
  u5: number
  u7: number
  tierKey: string
  now: number
  cost: VmCostSummary
  split: WeeklySplitSummary | null
  conc: ConcurrencyInfo
  rpm: RpmInfo | null
  today: VmTodayCounts
  billing?: VmDetailPayload['billing']
}

/** 上一个 5H 窗口结束时的已用比例与花费；窗口翻转前没有记录。 */
function PrevWindowMeter({ w }: { w: VmClosedWindow | null | undefined }) {
  if (!w) {
    return (
      <div className='flex items-baseline justify-between gap-2'>
        <span className='text-xs text-muted-foreground'>
          {tr('vm:sync14008Previous5hUsed')}
        </span>
        <span className='text-[11px] text-muted-foreground'>
          {tr('vm:sync14008NoPreviousWindow')}
        </span>
      </div>
    )
  }
  return (
    <Meter
      label={tr('vm:sync14008Previous5hUsed')}
      value={w.used_ratio * 100}
      hint={closedWindowHint(w)}
    />
  )
}

type Verdict = {
  tone: StatusTone
  notes: string[]
}

/**
 * 可服务跟账号 `availability` / 凭证死活走。
 * wrap `rust_health.reachable` 是 hop 就绪（process_up 且 ready_slots>=1），
 * 不能当成槽不可用。
 */
function slotVerdict(
  vm: Vm,
  kernel: VmKernelSnapshot | null | undefined,
  proxy: VmProxySnap
): Verdict {
  const acc = accountStatus(vm)
  const proxyH = proxyHealthOf(vm, proxy)
  const hop = kernel?.rust_health || kernel?.go_health
  const notes: string[] = []
  const proxyFailClosed =
    !!vm.has_token && proxyH.score === 0 && proxyH.tone.cls === 'bad'

  if (acc.cls === 'none') {
    return {
      tone: {
        key: 'none',
        text: tVm('vm:detailStatusBoard.noCredentials'),
        cls: 'none',
        label: acc.text,
      },
      notes: [acc.text],
    }
  }
  if (acc.cls === 'bad' || proxyFailClosed) {
    const why = acc.cls === 'bad' ? acc.text : proxyH.tone.text
    return {
      tone: {
        key: 'bad',
        text: tVm('vm:detailStatusBoard.unavailableForRequests'),
        cls: 'bad',
        label: why,
      },
      notes: [why],
    }
  }
  if (acc.cls === 'off') {
    return {
      tone: {
        key: 'off',
        text: tVm('vm:detailStatusBoard.notScheduled'),
        cls: 'off',
        label: acc.text,
      },
      notes: [acc.text],
    }
  }
  if (acc.cls === 'warn' || acc.cls === 'caution') notes.push(acc.text)
  if (hop && kernelProcessUp(hop) && !kernelHopReady(hop)) {
    notes.push(tVm('vm:detailStatusBoard.cLINotReady'))
  }
  return {
    tone: {
      key: 'ok',
      text: accountUsable(vm)
        ? tVm('vm:detailStatusBoard.readyForRequests')
        : acc.text,
      cls: acc.cls === 'ok' ? 'ok' : acc.cls,
      label: notes.join(' · ') || tVm('vm:detailStatusBoard.validCredentials'),
    },
    notes,
  }
}

function workerLabel(value: unknown) {
  const raw = String(value || '').trim()
  if (raw === 'go' || raw === 'rust') return 'Rust · cli-hop'
  return raw || '—'
}

function topologyLabel(
  topology: VmKernelSnapshot['process_topology'] | undefined
) {
  if (topology?.rust_pid1) return 'kernel PID1'
  if (topology?.go_worker_pid1)
    return tVm('vm:detailStatusBoard.legacyTopology')
  return tVm('vm:detailAccountTab.unknown')
}

function money(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

export function VmStatusBoard(props: Props) {
  const { t: tVm } = useTranslation('vm')

  const {
    vm,
    kernel,
    acc,
    proxy,
    dash,
    u5,
    u7,
    tierKey,
    now,
    cost,
    split,
    conc,
    rpm,
    today,
    billing,
  } = props
  const verdict = slotVerdict(vm, kernel, proxy)
  const proxyH = proxyHealthOf(vm, proxy)
  const fable = fableCardInfo(vm, tierKey, fableCap(dash.data))
  const reset5 = acc.reset_5h ?? vm.reset_5h
  const reset7 = acc.reset_7d ?? vm.reset_7d
  const cost5 = money(acc.window_5h_cost ?? vm.window_5h_cost ?? cost.w)
  const cost7 = money(acc.window_7d_cost ?? vm.window_7d_cost)
  const fableCost = money(acc.window_fable_cost ?? vm.window_fable_cost)
  const live5 = formatWindowSpend(cost5, vm.estimate_5h)
  const proj5 = billing?.window_5h_projection
  // 本窗口用量太低算不出时，总额度借上个窗口的「花费 ÷ 结束时已用」。
  const spend5 =
    proj5?.source === 'previous' &&
    proj5.total_usd != null &&
    proj5.remaining_usd != null
      ? {
          costText: `${fmtUsd(cost5, 2)} / ≈${fmtUsd(proj5.total_usd, 2)}`,
          remainText: `余 ${fmtUsd(proj5.remaining_usd, 2)}（按上个窗口）`,
        }
      : live5
  const spend7 = formatWindowSpend(cost7, vm.estimate_7d)
  const spendFable = formatWindowSpend(fableCost, vm.estimate_fable)
  const topology = kernel?.process_topology
  const rust = wrapHealthLabel(kernel?.rust_health)

  return (
    <section className='rounded-lg border bg-card'>
      <div className='grid xl:grid-cols-[minmax(0,1.05fr)_minmax(0,1.15fr)_minmax(0,0.95fr)]'>
        <div className='min-w-0 p-4 xl:pr-5'>
          <div className='flex items-start justify-between gap-3'>
            <div className='min-w-0'>
              <h2 className='text-lg leading-none font-semibold'>
                <Trans ns='vm' i18nKey='detailStatusBoard.currentState' />
              </h2>
              <p className='mt-1.5 text-xs text-muted-foreground'>
                {verdict.notes.length
                  ? verdict.notes.join(' · ')
                  : tVm(
                      'vm:detailStatusBoard.thisSlotCanCurrentlyAcceptInferenceRequests'
                    )}
              </p>
            </div>
            <StatusMark tone={verdict.tone} variant='pill' />
          </div>
          <div className='mt-4 flex flex-wrap items-center gap-1.5'>
            {isCodexVm(vm) ? <OpenaiPlanBadge vm={vm} size='sm' /> : null}
            <StatusMark tone={accountStatus(vm)} variant='pill' />
            <StatusMark tone={poolStatus(vm)} variant='pill' />
            <StatusMark tone={proxyH.tone} variant='pill' />
            <StatusMark
              tone={{
                key: vmRunning(vm) ? 'ok' : 'off',
                text: vmRunning(vm)
                  ? tVm('vm:detailPage.running')
                  : tVm('vm:detailPage.stop'),
                cls: vmRunning(vm) ? 'ok' : 'off',
              }}
              variant='pill'
            />
          </div>
          <div className='mt-4 divide-y'>
            <Field label={tVm('vm:detailStatusBoard.email')} compact>
              <SlotIdentity
                vm={vm}
                email={
                  vm.email || (typeof acc.email === 'string' ? acc.email : null)
                }
                compact
              />
            </Field>
            {isCodexVm(vm) ? (
              <Field label={tVm('vm:createVmForm.platform')} compact>
                OpenAI / Codex
              </Field>
            ) : (
              <>
                <Field label={tVm('vm:detailStatusBoard.image')} compact>
                  <div className='space-y-1'>
                    <div className='flex flex-wrap items-center gap-1.5'>
                      <span>{String(vm.kernel || '—')}</span>
                      <RuntimeChip vm={vm} />
                    </div>
                    <KernelFeatTags kernel={vm.kernel} />
                  </div>
                </Field>
                <Field label={tVm('vm:labels.worker')} compact>
                  {workerLabel(
                    (vm.runtime as Record<string, unknown> | undefined)?.worker
                  )}
                </Field>
              </>
            )}
            <Field label={tVm('vm:detailStatusBoard.schedulingStatus')} compact>
              {scheduleStateLabel(vm)}
            </Field>
            <Field label={tVm('vm:detailStatusBoard.restrictedUntil')} compact>
              {restrictionUntilOf(vm) ? (
                <ResetAt value={restrictionUntilOf(vm)} now={now} />
              ) : (
                '—'
              )}
            </Field>
            <Field label={tVm('vm:detailStatusBoard.cooldown')} compact>
              {restrictionCopy(vm)}
            </Field>
            <CircuitField vm={vm} now={now} />
          </div>
        </div>

        <div className='min-w-0 border-t p-4 xl:border-t-0 xl:border-l xl:px-5'>
          <h3 className='text-sm font-medium'>
            <Trans ns='vm' i18nKey='detailStatusBoard.quota' />
          </h3>
          <div className='mt-3 grid gap-3'>
            {isCodexVm(vm) ? (
              <>
                <OpenaiQuotaPanel
                  vm={vm}
                  u5={u5}
                  u7={u7}
                  now={now}
                  cost5={cost5}
                  cost7={cost7}
                />
                <PrevWindowMeter w={billing?.prev_window_5h} />
              </>
            ) : (
              <>
                <Meter
                  label={tVm('vm:detailStatusBoard.5HourUsage')}
                  value={u5}
                  gate={
                    vm.quota_policy ? vm.quota_policy.limit_5h * 100 : undefined
                  }
                  hint={[
                    quotaWindowHint(u5, reset5, now),
                    spend5.costText,
                    spend5.remainText,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                />
                <PrevWindowMeter w={billing?.prev_window_5h} />
                <Meter
                  label={tVm('vm:detailStatusBoard.7DayUsage')}
                  value={u7}
                  gate={
                    vm.quota_policy ? vm.quota_policy.limit_7d * 100 : undefined
                  }
                  hint={[
                    quotaWindowHint(u7, reset7, now),
                    spend7.costText,
                    spend7.remainText,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                />
                {fable.usedPct != null ? (
                  <Meter
                    label={tVm('vm:detailStatusBoard.fableUsage')}
                    value={fable.usedPct}
                    gate={split ? split.share * 100 : undefined}
                    hint={[
                      ...fable.bits,
                      spendFable.costText,
                      spendFable.remainText,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  />
                ) : (
                  <div className='flex items-center justify-between gap-2 text-sm'>
                    <span className='text-xs text-muted-foreground'>Fable</span>
                    <span>{fable.badgeText}</span>
                  </div>
                )}
                <ClaudeResetActions vm={vm} now={now} />
              </>
            )}
          </div>
        </div>

        <div className='min-w-0 border-t p-4 xl:border-t-0 xl:border-l xl:pl-5'>
          <h3 className='text-sm font-medium'>
            <Trans ns='vm' i18nKey='detailPage.running' />
          </h3>
          <div className='mt-3 grid grid-cols-2 gap-3'>
            <div>
              <div className='text-xs text-muted-foreground'>
                <Trans ns='vm' i18nKey='detailAccountTab.today' />
              </div>
              <div className='mt-0.5 text-lg font-semibold tabular-nums'>
                {fmtUsd(
                  Number(acc.today_cost ?? vm.today_cost ?? cost.today),
                  2
                )}
              </div>
              <div className='text-[11px] text-muted-foreground'>
                {fmtNum(today.requests)}{' '}
                <Trans ns='vm' i18nKey='units.requestsShort' />
              </div>
            </div>
            <div>
              <div className='text-xs text-muted-foreground'>
                <Trans ns='vm' i18nKey='detailStatusBoard.5HourWindow' />
              </div>
              <div className='mt-0.5 text-lg font-semibold tabular-nums'>
                {fmtUsd(cost.w, 2)}
              </div>
              <div className='text-[11px] text-muted-foreground'>
                {fmtNum(cost.tok)} <Trans ns='vm' i18nKey='units.tokensShort' />
              </div>
            </div>
          </div>
          <div className='mt-3 divide-y'>
            <Field label={tVm('vm:detailPage.proxy')} compact>
              <span className='font-mono text-xs'>
                {proxyNamedLabel(proxy)}
              </span>
            </Field>
            <div className='space-y-2 py-2'>
              <VmSchedulingBlock vm={vm} conc={conc} rpm={rpm} />
              <VmMemoryBlock vm={vm} />
            </div>
            {isCodexVm(vm) ? null : (
              <>
                <Field label={tVm('vm:detailStatusBoard.5HourReset')} compact>
                  <ResetAt value={reset5} now={now} />
                </Field>
                <Field label={tVm('vm:detailStatusBoard.7DayReset')} compact>
                  <ResetAt value={reset7} now={now} />
                </Field>
              </>
            )}
            {isCodexVm(vm) ? (
              <CodexKernelHealthFields health={kernel?.codex_health} />
            ) : (
              <>
                <Field label='cli-hop' compact>
                  {rust}
                </Field>
                <Field label={tVm('vm:detailStatusBoard.kernel')} compact>
                  {isCodexVm(vm) ? '—' : dataplaneLabel(vm.resolved_dataplane)}
                </Field>
                <Field label={tVm('vm:detailStatusBoard.topology')} compact>
                  {topologyLabel(topology)}
                  {topology?.go_telemetry
                    ? ' · ' + tVm('common:goTelemetry')
                    : ''}
                </Field>
                <Field label={tVm('vm:detailStatusBoard.telemetry')} compact>
                  {telemetryStatusLabel(kernel?.telemetry)}
                </Field>
              </>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}
