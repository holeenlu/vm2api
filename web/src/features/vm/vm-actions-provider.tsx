import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { t as tr } from '@/i18n'
import type { UsageAccountRow } from '@/types/panel-usage'
import type { Vm } from '@/types/panel-vm'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { meQueryOptions } from '@/features/auth/queries'
import { dashboardQueryOptions } from '@/features/overview/queries'
import { clearVmRestriction } from '@/features/vm/clear-restriction'
import { vmQueryOptions, vmsListQueryOptions } from '@/features/vm/queries'
import {
  VmActionsContext,
  type VmActions,
} from '@/features/vm/vm-actions-context'
import { VmDetailCard } from '@/features/vm/vm-detail-card'
import { VmAssignGroupsDialog } from '@/features/vm/vm-groups'
import { VmReauthDialog } from '@/features/vm/vm-reauth-dialog'
import { VmRecoveryDialog } from '@/features/vm/vm-recovery-dialog'
import { VmStatsDialog } from '@/features/vm/vm-stats-dialog'
import { VmTestDialog } from '@/features/vm/vm-test-dialog'
import { patchVmGroups } from './vm-group-actions'

/**
 * 持有详情卡与测试 / 统计 / 重新授权 / 恢复服务弹窗的开关，行与卡片只发「打开哪台」。
 * 弹窗内的 Vm 始终从列表缓存里按 id 取，轮询刷新后卡面数据同步更新。
 */
export function VmActionsProvider({
  accounts,
  onReset,
  onDelete,
  children,
}: {
  accounts?: UsageAccountRow[]
  onReset?: (vm: Vm) => void
  onDelete?: (vm: Vm) => void
  children: React.ReactNode
}) {
  const { t: tVm } = useTranslation('vm')

  const qc = useQueryClient()
  const me = useQuery(meQueryOptions())
  const isAdmin = me.data?.role === 'super_admin'
  const list = useQuery(vmsListQueryOptions())
  const [detailId, setDetailId] = useState<string | null>(null)
  const [testId, setTestId] = useState<string | null>(null)
  const [statsId, setStatsId] = useState<string | null>(null)
  const [reauthId, setReauthId] = useState<string | null>(null)
  const [recoveryId, setRecoveryId] = useState<string | null>(null)
  const [assignId, setAssignId] = useState<string | null>(null)
  const items = list.data?.items
  const byId = (id: string | null) =>
    (id && items?.find((vm) => vm.id === id)) || null

  const invalidate = (vm: Vm) =>
    Promise.all([
      qc.invalidateQueries({ queryKey: vmsListQueryOptions().queryKey }),
      qc.invalidateQueries({ queryKey: vmQueryOptions(vm.id).queryKey }),
      qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
    ])

  const {
    mutate: refreshToken,
    isPending: refreshPending,
    variables: refreshVars,
  } = useMutation({
    mutationFn: (vm: Vm) =>
      api(`/api/panel/vms/${encodeURIComponent(vm.id)}/oauth/refresh`, {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    onSuccess: async (_data, vm) => {
      toast.success(
        tVm('vm:vmActionsProvider.tokenRefreshedFor', { id: vm.id })
      )
      await invalidate(vm)
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const {
    mutate: recoverState,
    isPending: recoverPending,
    variables: recoverVars,
  } = useMutation({
    mutationFn: (vm: Vm) => clearVmRestriction(vm),
    onSuccess: async (_data, vm) => {
      toast.success(
        tVm(
          'vm:vmActionsProvider.cooldownAndCircuitBreakerClearedStatusRefreshed'
        )
      )
      await invalidate(vm)
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const {
    mutate: activateVm,
    isPending: activatePending,
    variables: activateVars,
  } = useMutation({
    mutationFn: (vm: Vm) =>
      api(`/api/panel/vms/${encodeURIComponent(vm.id)}/activate`, {
        method: 'POST',
      }),
    onSuccess: async (_data, vm) => {
      toast.success(tr('vm:sync14008ActiveSlotSetId', { value1: vm.id }))
      await invalidate(vm)
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const {
    mutate: setGroups,
    isPending: groupsPending,
    variables: groupsVars,
  } = useMutation({
    mutationFn: ({
      vm,
      group_ids,
      version,
    }: {
      vm: Vm
      group_ids: number[]
      version: number
    }) => patchVmGroups(vm, group_ids, version),
    onSuccess: async (_data, { vm }) => {
      toast.success(tVm('vm:vmActionsProvider.groupAssignmentsUpdated'))
      setAssignId(null)
      await invalidate(vm)
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const groupsBusyId = groupsPending ? (groupsVars?.vm.id ?? null) : null

  const actions = useMemo<VmActions>(
    () => ({
      openDetail: (vm) => setDetailId(vm.id),
      openTest: (vm) => setTestId(vm.id),
      openStats: (vm) => setStatsId(vm.id),
      openReauth: (vm) => setReauthId(vm.id),
      openRecovery: (vm) => setRecoveryId(vm.id),
      refreshToken,
      recover: recoverState,
      refreshingId: refreshPending ? (refreshVars?.id ?? null) : null,
      recoveringId: recoverPending ? (recoverVars?.id ?? null) : null,
      reset: onReset,
      remove: onDelete,
      activate: activateVm,
      activatingId: activatePending ? (activateVars?.id ?? null) : null,
      ...(isAdmin
        ? {
            openAssignGroups: (vm: Vm) => setAssignId(vm.id),
            groupsBusyId,
          }
        : {}),
    }),
    [
      refreshToken,
      recoverState,
      refreshPending,
      refreshVars,
      recoverPending,
      recoverVars,
      onReset,
      onDelete,
      activateVm,
      activatePending,
      activateVars,
      isAdmin,
      groupsBusyId,
    ]
  )

  return (
    <VmActionsContext.Provider value={actions}>
      {children}
      <VmDetailCard
        vm={byId(detailId)}
        accounts={accounts}
        onOpenChange={(open) => !open && setDetailId(null)}
      />
      <VmTestDialog
        vm={byId(testId)}
        onOpenChange={(open) => !open && setTestId(null)}
      />
      <VmStatsDialog
        vm={byId(statsId)}
        accounts={accounts}
        onOpenChange={(open) => !open && setStatsId(null)}
      />
      <VmReauthDialog
        vm={byId(reauthId)}
        onOpenChange={(open) => !open && setReauthId(null)}
      />
      <VmRecoveryDialog
        vm={byId(recoveryId)}
        open={recoveryId != null}
        onOpenChange={(open) => !open && setRecoveryId(null)}
      />
      {isAdmin ? (
        <VmAssignGroupsDialog
          key={assignId || 'closed'}
          vm={byId(assignId)}
          open={assignId != null}
          pending={groupsPending}
          onOpenChange={(open) => !open && setAssignId(null)}
          onConfirm={(group_ids, version) => {
            const vm = byId(assignId)
            if (vm) setGroups({ vm, group_ids, version })
          }}
        />
      ) : null}
    </VmActionsContext.Provider>
  )
}
