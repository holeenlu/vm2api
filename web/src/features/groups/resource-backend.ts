import type { CommercialGroup } from './queries'

export type ResourceKind = 'vm' | 'api_endpoint'

/**
 * Execution backend a group already uses. Gateway Worker accounts run on the VM
 * backend (server `isVmBackendKind`), so they never lock the VM tab.
 */
export function groupBackendKind(
  resources: CommercialGroup['resources']
): ResourceKind | undefined {
  if (!resources?.length) return undefined
  return resources.some((r) => r.resource_kind === 'api_endpoint')
    ? 'api_endpoint'
    : 'vm'
}
