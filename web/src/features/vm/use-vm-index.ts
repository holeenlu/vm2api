import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { indexVms } from '@/lib/vm-kind'
import { meQueryOptions } from '@/features/auth/queries'
import { dashboardQueryOptions } from '@/features/overview/queries'

/**
 * 站长和运维复用总览缓存；普通用户不请求或持有基础设施列表。
 */
export function useVmIndex() {
  const me = useQuery(meQueryOptions())
  const role = me.data?.role
  const fromDashboard = role === 'admin' || role === 'super'
  const dash = useQuery({ ...dashboardQueryOptions(), enabled: fromDashboard })
  const list: Vm[] = useMemo(
    () => (fromDashboard ? dash.data?.vms : []) || [],
    [fromDashboard, dash.data?.vms]
  )
  const vms = useMemo(() => indexVms(list), [list])
  const isLoading = me.isLoading || (fromDashboard && dash.isLoading)
  return { vms, list, isLoading }
}
