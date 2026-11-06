import type { Vm } from '@/types/panel-vm'
import { api } from '@/lib/api'

export function patchVmGroups(
  vm: Vm,
  group_ids: number[],
  expected_version: number
) {
  return api('/api/panel/vms/' + encodeURIComponent(vm.id) + '/groups', {
    method: 'PUT',
    body: JSON.stringify({ group_ids, expected_version }),
  })
}
