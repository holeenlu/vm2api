import type { Vm } from '@/types/panel-vm'
import { isCodexVm, slotNameLabel } from '@/lib/vm-kind'

/** Canonical VM display and runtime model helpers for feature components. */
export const vmDisplayName = (vm: Vm) => slotNameLabel(vm)
export const vmRuntimeKind = (vm: Vm): 'docker' | 'kvm' => (vm.runtime_type === 'kvm' ? 'kvm' : 'docker')
export const vmIsCodex = (vm: Vm) => isCodexVm(vm)
export const vmIsSchedulable = (vm: Vm) => vm.schedulable !== false
