import { vmGroupType } from './key-scope.mjs'
import { relayError } from './relay-common.mjs'

export function validateVmGroups(groups, vm, ids) {
  const platform = vmGroupType(vm)
  for (const id of ids) {
    const group = groups.getById(id)
    if (!group) throw relayError('group_not_found', '分组不存在', 404)
    if (!['mixed', platform, platform === 'anthropic' ? 'claude' : platform].includes(group.platform))
      throw relayError('group_platform_mismatch', 'VM 与分组平台不兼容')
    if (groups.resources(id).some((r) => r.resource_kind !== 'vm'))
      throw relayError('group_backend_mismatch', '一个分组只能使用一种执行后端，请分别创建 VM 与 API 分组')
  }
}
