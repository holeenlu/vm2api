import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { i18n, t as tr } from '@/i18n'
import type { ScheduleState, Vm } from '@/types/panel-vm'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { expiresAtToMs } from '@/lib/fable-status'
import {
  backendStatusLabel,
  isRestrictedSchedule,
  restrictionUntilOf,
} from '@/lib/vm-status'
import { Switch } from '@/components/ui/switch'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { dashboardQueryOptions } from '@/features/overview/queries'
import { vmQueryOptions, vmsListQueryOptions } from '@/features/vm/queries'

function formatRestrictionUntil(until: number | null | undefined): string {
  const ms = expiresAtToMs(until)
  if (!ms) return ''
  return new Date(ms).toLocaleString(i18n.language)
}

export function vmSchedulableProps(vm: Vm) {
  const scheduleState: ScheduleState | undefined = isRestrictedSchedule(vm)
    ? 'restricted'
    : vm.schedule_state
  const vendorControlledOff = [
    'vendor_paused',
    'vendor_disabled',
    'vendor_archived',
  ].includes(
    String(vm.schedule_disabled_reason || vm.restriction_reason || '').trim()
  )
  return {
    vmId: vm.id,
    // 自动受限（额度 / 冷却 / 维护）仍是「开」；供应商暂停由供应商开关控制。
    schedulable: vendorControlledOff
      ? false
      : scheduleState === 'restricted'
        ? true
        : scheduleState
          ? scheduleState === 'on'
          : vm.schedulable !== false,
    vendorControlledOff,
    scheduleState,
    restrictionUntil: restrictionUntilOf(vm),
    restrictionReason: vm.restriction_reason,
    unschedulableText:
      backendStatusLabel(
        vm.unschedulable_text || vm.unschedulable_reason || ''
      ) || null,
  }
}

export function SchedulableSwitch({
  vmId,
  schedulable,
  scheduleState,
  restrictionUntil,
  unschedulableText,
  vendorControlledOff = false,
  className,
}: {
  vmId: string
  schedulable: boolean
  scheduleState?: ScheduleState
  restrictionUntil?: number | null
  restrictionReason?: string | null
  unschedulableText?: string | null
  vendorControlledOff?: boolean
  className?: string
}) {
  const { t: tVm } = useTranslation('vm')

  const qc = useQueryClient()
  const restricted = scheduleState === 'restricted'
  const [optimistic, setOptimistic] = useState<boolean | null>(null)
  const checked = optimistic ?? schedulable
  const mutation = useMutation({
    mutationFn: (next: boolean) =>
      api(`/api/panel/vms/${encodeURIComponent(vmId)}/schedulable`, {
        method: 'POST',
        body: JSON.stringify({ schedulable: next }),
      }),
    onMutate: (next) => setOptimistic(next),
    onSuccess: async (_data, next) => {
      toast.success(
        next
          ? tVm('vm:schedulableSwitch.schedulingEnabled')
          : tVm('vm:schedulableSwitch.schedulingDisabled')
      )
      await Promise.all([
        qc.invalidateQueries({ queryKey: vmsListQueryOptions().queryKey }),
        qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
        qc.invalidateQueries({ queryKey: vmQueryOptions(vmId).queryKey }),
      ])
    },
    onError: (error: Error) => {
      setOptimistic(null)
      toast.error(error.message)
    },
    onSettled: () => setOptimistic(null),
  })

  const untilText = formatRestrictionUntil(restrictionUntil)
  const tooltip = vendorControlledOff
    ? tVm('vm:schedulableSwitch.vendorControlledOff')
    : scheduleState === 'unschedulable' && !checked
      ? tr('vm:sync14008UnschedulableHelp', {
          value1: unschedulableText || tr('lib:status.unavailable'),
        })
      : restricted && checked
        ? untilText
          ? tr('vm:sync14008RestrictedUntil', { value1: untilText })
          : tr('vm:schedulableSwitch.schedulingEnabledCurrentlyRestricted')
        : checked
          ? tr('vm:schedulableSwitch.clickToDisableScheduling')
          : tr('vm:schedulableSwitch.clickToEnableScheduling')

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={className}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <Switch
            checked={checked}
            disabled={mutation.isPending || vendorControlledOff}
            onCheckedChange={(next) => mutation.mutate(next)}
            aria-label={tooltip}
          />
        </span>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  )
}
