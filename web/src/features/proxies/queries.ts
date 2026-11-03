import { queryOptions, useQueryClient } from '@tanstack/react-query'
import type { ProxyPoolPayload } from '@/types/panel-proxy'
import { api } from '@/lib/api'
import { invalidateProxyBinding } from '@/lib/query-invalidations'
import { panelQueryKeys } from '@/lib/query-keys'

export function proxiesQueryOptions(vendorId = '', platform = '') {
  return queryOptions({
    queryKey: panelQueryKeys.proxies(vendorId, platform),
    queryFn: () => {
      const params = new URLSearchParams()
      if (vendorId) params.set('vendor_id', vendorId)
      if (platform) params.set('platform', platform)
      const query = params.toString()
      return api<ProxyPoolPayload>(
        '/api/panel/proxies' + (query ? `?${query}` : '')
      )
    },
  })
}

/** 代理池写操作后同时刷新池与槽位：绑定关系两边都展示。 */
export function useRefreshProxies() {
  const qc = useQueryClient()
  return () => invalidateProxyBinding(qc)
}
