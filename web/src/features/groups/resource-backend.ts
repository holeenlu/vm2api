import type { CommercialGroup } from './queries'

export type ResourceKind = 'vm' | 'gateway_worker_account' | 'api_endpoint'

/** 执行后端：账号池（VM 与 Codex 账号，可以同组）或 API 端点（独占）。 */
export type BackendFamily = 'pool' | 'api_endpoint'

export const backendFamily = (kind: ResourceKind): BackendFamily =>
  kind === 'api_endpoint' ? 'api_endpoint' : 'pool'

/** 分组当前使用的执行后端（空分组为 undefined）。 */
export function groupBackendKind(
  resources: CommercialGroup['resources']
): BackendFamily | undefined {
  if (!resources?.length) return undefined
  return resources.some((r) => r.resource_kind === 'api_endpoint')
    ? 'api_endpoint'
    : 'pool'
}

/** 选中的资源同时含账号池与 API 端点时不能保存（服务端按目标状态同样拒绝）。 */
export function mixesBackends(selections: Record<ResourceKind, string[]>) {
  return (
    selections.api_endpoint.length > 0 &&
    selections.vm.length + selections.gateway_worker_account.length > 0
  )
}
