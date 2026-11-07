import type { Vm } from '@/types/panel-vm'
import { isActiveVmPointer, planDeleteActiveVm } from '@/features/vm/active-vm'
import { isGatewayRow } from './account-overview-model'

export type BulkDeleteStep = {
  vm: Vm
  kind: 'vm' | 'gateway'
  /** 删除前先把活跃指针切到这台槽位（与单台删除同一规则）。 */
  switchTo?: string
}

export type BulkDeletePlan = {
  /** 实际执行顺序：活跃槽位排最后，其余保持原顺序。 */
  steps: BulkDeleteStep[]
  /** 活跃槽位且没有可接管的槽，本次跳过（与单台删除的 blocked 同一判定）。 */
  skipped: Vm[]
  vmCount: number
  gatewayCount: number
}

/**
 * 批量删除的执行计划。逐条调用各自的删除接口，不新增批量接口：
 * 权限、审计与清理逻辑与单条删除完全一致。
 *
 * 活跃槽位（active.json）放到最后删，接管候选只在本次不删的槽位里挑，
 * 否则候选可能先一步被删掉。没有候选时跳过它，其余照删。
 */
export function planBulkDelete(targets: Vm[], vms: Vm[]): BulkDeletePlan {
  const ids = new Set(targets.map((vm) => vm.id))
  const survivors = vms.filter((vm) => !ids.has(vm.id))
  const ordered = targets
    .map((vm, index) => ({ vm, index }))
    .sort(
      (a, b) =>
        Number(isActiveVmPointer(a.vm)) - Number(isActiveVmPointer(b.vm)) ||
        a.index - b.index
    )
    .map((item) => item.vm)
  const steps: BulkDeleteStep[] = []
  const skipped: Vm[] = []
  for (const vm of ordered) {
    if (isGatewayRow(vm)) {
      steps.push({ vm, kind: 'gateway' })
      continue
    }
    const plan = planDeleteActiveVm(vm, [...survivors, vm])
    if (plan.kind === 'blocked') {
      skipped.push(vm)
      continue
    }
    steps.push({
      vm,
      kind: 'vm',
      switchTo: plan.kind === 'switch' ? plan.replacement.id : undefined,
    })
  }
  return {
    steps,
    skipped,
    vmCount: steps.filter((step) => step.kind === 'vm').length,
    gatewayCount: steps.filter((step) => step.kind === 'gateway').length,
  }
}
