import type { Vm } from '@/types/panel-vm'
import { isCodexVm, slotNameLabel } from '@/lib/vm-kind'

/** Canonical VM display and runtime model helpers for feature components. */
export const vmDisplayName = (vm: Vm) => slotNameLabel(vm)
/**
 * 列表与机架里的槽位短标识。Gateway 新账号编号为 `gw-01`，原样显示；
 * 早期账号为 `account_<uuid>`，只取 uuid 首段；生产按 docs/GATEWAY_ACCOUNT_ID_RENAME.md 改名后删除此分支。
 */
export const vmSlotId = (vm: Pick<Vm, 'id' | 'runtime_type'>) =>
  vm.runtime_type === 'gateway' && vm.id.startsWith('account_')
    ? vm.id.slice('account_'.length).split('-')[0]
    : vm.id
export const vmRuntimeKind = (vm: Vm): 'docker' | 'kvm' =>
  vm.runtime_type === 'kvm' ? 'kvm' : 'docker'
export const vmIsCodex = (vm: Vm) => isCodexVm(vm)
export const vmIsSchedulable = (vm: Vm) => vm.schedulable !== false
