import type {
  ClusterNodePatch,
  ClusterNodeUpdateProbe,
  ClusterApiNode,
  ClusterLocalStatus,
  DockerContainer,
  DockerInfo,
  NodePreflight,
  SlotImageJob,
} from '@/types/panel-cluster'
import type { RuntimeType } from '@/types/panel-vm'
import { api } from '@/lib/api'
import { panelQueryKeys } from '@/lib/query-keys'
import { queryOptions } from '@/lib/query-options'

export const CLUSTER_NODES_KEY = panelQueryKeys.clusterNodes()

export function clusterNodesQueryOptions(refetchInterval = 5000) {
  return queryOptions({
    queryKey: CLUSTER_NODES_KEY,
    queryFn: () =>
      api<{ items: ClusterApiNode[] }>('/api/panel/cluster/nodes').then(
        (d) => d.items
      ),
    refetchInterval,
    refetchOnWindowFocus: false,
  })
}

export const CLUSTER_LOCAL_KEY = panelQueryKeys.clusterLocal()

/** 服务端缓存 30s；`refresh` 强制重新观测（两次远端 exec）。 */
export function clusterLocalQueryOptions() {
  return queryOptions({
    queryKey: CLUSTER_LOCAL_KEY,
    queryFn: () => api<ClusterLocalStatus>('/api/panel/cluster/local'),
    refetchInterval: 30_000,
    refetchOnWindowFocus: false,
    retry: false,
  })
}

export function dockerInfoQueryOptions(nodeId: string, enabled: boolean) {
  return queryOptions({
    queryKey: panelQueryKeys.clusterDockerInfo(nodeId),
    queryFn: () =>
      api<DockerInfo>(`/api/panel/cluster/nodes/${nodeId}/docker/info`),
    enabled,
    retry: false,
  })
}

export function dockerContainersQueryOptions(nodeId: string, enabled: boolean) {
  return queryOptions({
    queryKey: panelQueryKeys.clusterContainers(nodeId),
    queryFn: () =>
      api<{ items: DockerContainer[] }>(
        `/api/panel/cluster/nodes/${nodeId}/docker/containers`
      ).then((d) => d.items),
    enabled,
    refetchInterval: enabled ? 5000 : false,
    refetchOnWindowFocus: false,
    retry: false,
  })
}

function nodePath(nodeId: string) {
  return `/api/panel/cluster/nodes/${encodeURIComponent(nodeId)}`
}

export function probeNodeUpdate(
  nodeId: string,
  body: ClusterNodePatch,
  signal: AbortSignal
) {
  return api<ClusterNodeUpdateProbe>(`${nodePath(nodeId)}/probe`, {
    ...jsonBody(body),
    signal,
  })
}

export function updateClusterNode(
  nodeId: string,
  body: ClusterNodePatch,
  signal: AbortSignal
) {
  return api<ClusterApiNode>(nodePath(nodeId), {
    method: 'PATCH',
    body: JSON.stringify(body),
    signal,
  })
}

/**
 * 放置预检。服务端是 POST（要实际 SSH 过去跑检查），但语义是只读观测，
 * 按 节点 + 内核 + 运行时 + 单槽内存缓存成 query；不自动轮询，由调用方手动 refetch。
 */
export function nodePreflightQueryOptions(
  nodeId: string,
  kernel: string,
  runtimeType: RuntimeType = 'docker',
  memory?: string
) {
  return queryOptions({
    queryKey: panelQueryKeys.clusterPreflight(
      nodeId,
      kernel,
      runtimeType,
      memory
    ),
    queryFn: () =>
      api<NodePreflight>(
        `${nodePath(nodeId)}/preflight`,
        jsonBody({ kernel, runtime_type: runtimeType, memory })
      ),
    enabled: !!nodeId && !!kernel,
    staleTime: 0,
    refetchOnWindowFocus: false,
    retry: false,
  })
}

/** 构建中每 3s 轮询一次；done / failed / 无任务时停。 */
export function slotImageJobQueryOptions(
  nodeId: string,
  kernel: string,
  enabled: boolean
) {
  return queryOptions({
    queryKey: panelQueryKeys.clusterSlotImage(nodeId, kernel),
    queryFn: () =>
      api<SlotImageJob | null>(
        `${nodePath(nodeId)}/slot-image?kernel=${encodeURIComponent(kernel)}`
      ),
    enabled: enabled && !!nodeId && !!kernel,
    refetchInterval: (query) =>
      query.state.data?.status === 'running' ? 3000 : false,
    refetchOnWindowFocus: false,
    retry: false,
  })
}

export function startSlotImageBuild(
  nodeId: string,
  kernel: string,
  runtimeType: RuntimeType = 'docker'
) {
  return api<SlotImageJob>(
    `${nodePath(nodeId)}/slot-image`,
    jsonBody({ kernel, runtime_type: runtimeType })
  )
}

export function jsonBody(body: unknown): RequestInit {
  return { method: 'POST', body: JSON.stringify(body) }
}
