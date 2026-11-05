import { queryOptions, type QueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { panelQueryKeys } from '@/lib/query-keys'
import { meQueryOptions } from '@/features/auth/queries'
import {
  accountCatalogQueryOptions,
  accountsQueryOptions,
} from '@/features/gateway-worker/accounts-model'
import { groupsQueryOptions } from '@/features/groups/queries'
import { usageQueryOptions } from '@/features/overview/queries'
import { proxiesQueryOptions } from '@/features/proxies/queries'
import type { Supplier } from '@/features/supplier-admin/model'
import { vmsListQueryOptions } from '@/features/vm/queries'
import type { LiveSnapshot } from './account-overview-model'

/**
 * 只放查询定义与预取，不引入工作台组件：路由 loader 打在主包里，
 * 这里要保持轻量。
 */
export type ResourcePreset = 'vm' | 'codex' | 'supplier'

/** 分组、归属筛选用的供应商列表（获授权 admin 只拿到 id/name 等少量字段）。 */
export const suppliersListQueryOptions = () =>
  queryOptions({
    queryKey: panelQueryKeys.supplierList(),
    queryFn: () => api<Supplier[]>('/api/admin/vendors'),
  })

/** 账号实时指标（内存窗口，服务端不查库）；概览展开时每 5 秒刷新。 */
export const liveStatsQueryOptions = () =>
  queryOptions({
    queryKey: [...panelQueryKeys.vms(), 'live-stats'] as const,
    queryFn: () => api<LiveSnapshot>('/api/panel/vms/live-stats'),
    refetchInterval: 5000,
    refetchOnWindowFocus: false,
  })

/**
 * 导航一开始（含悬停侧栏链接的预加载）就并行拉取工作台首屏数据，
 * 不必等路由代码下载、/me 返回、组件挂载之后才发请求。
 * 已有缓存时不重复请求；失败交给组件自己的查询处理。
 */
export function prefetchResourceWorkbench(
  qc: QueryClient,
  preset: ResourcePreset
) {
  const me = qc.getQueryData(meQueryOptions().queryKey)
  // 已知没有查看权限时不发请求，路由守卫会把用户送走。
  if (me && !me.resource_permissions?.includes('resources.read')) return
  const tasks: Promise<unknown>[] = []
  if (preset !== 'codex') tasks.push(qc.ensureQueryData(vmsListQueryOptions()))
  if (preset !== 'vm')
    tasks.push(
      qc.ensureQueryData(accountsQueryOptions(false)),
      qc.ensureQueryData(accountCatalogQueryOptions()),
      qc.ensureQueryData(proxiesQueryOptions())
    )
  tasks.push(
    qc.ensureQueryData(groupsQueryOptions()),
    qc.ensureQueryData(suppliersListQueryOptions())
  )
  // 用量概览只给 super_admin；角色未知时由组件按权限再取。
  if (me?.role === 'super_admin' && preset !== 'codex')
    tasks.push(qc.ensureQueryData(usageQueryOptions()))
  for (const task of tasks) void task.catch(() => {})
}
