import { useQuery } from '@tanstack/react-query'
import type { LocalProxyLabelOpts } from '@/lib/vm-status'
import { meQueryOptions } from '@/features/auth/queries'
import { clusterNodesQueryOptions } from '@/features/cluster/queries'

/**
 * Placement label for a local proxy that is not yet stamped with `node_name`
 * (create / import pickers). Admin reads the cluster node label; tenants stay
 * on the generic `local代理` copy.
 */
export function useLocalProxyLabelOpts(
  nodeId: string | null | undefined
): LocalProxyLabelOpts {
  const me = useQuery(meQueryOptions())
  const revealNode = me.data?.role === 'super_admin'
  const nodes = useQuery({
    ...clusterNodesQueryOptions(),
    refetchInterval: false,
    enabled: revealNode && !!nodeId,
  })
  if (!revealNode) return { revealNode: false }
  if (!nodeId) return { revealNode: true, nodeName: null }
  const node = nodes.data?.find((n) => n.id === nodeId)
  return {
    revealNode: true,
    nodeName: node?.label || null,
    nodeId,
  }
}
