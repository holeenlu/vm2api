import { vmGroupType } from './key-scope.mjs'
import { relayError } from './relay-common.mjs'

/** VM groups may also hold Gateway Worker accounts; API endpoints stay a separate backend. */
export function isVmBackendKind(kind) {
  return kind === 'vm' || kind === 'gateway_worker_account'
}

/** 分组平台是否接纳该平台的资源（mixed 接纳全部；claude 是 anthropic 的旧写法）。 */
export function groupAcceptsPlatform(groupPlatform, platform) {
  const normalize = (value) => (value === 'claude' ? 'anthropic' : value)
  return groupPlatform === 'mixed' || normalize(groupPlatform) === normalize(platform)
}

export async function validateVmGroups(groups, vm, ids) {
  const platform = vmGroupType(vm)
  for (const id of ids) {
    const group = await groups.getById(id)
    if (!group) throw relayError('group_not_found', '分组不存在', 404)
    if (!groupAcceptsPlatform(group.platform, platform))
      throw relayError('group_platform_mismatch', 'VM 与分组平台不兼容')
    if ((await groups.resources(id)).some((r) => !isVmBackendKind(r.resource_kind)))
      throw relayError('group_backend_mismatch', '一个分组只能使用一种执行后端，请分别创建 VM 与 API 分组')
  }
}
