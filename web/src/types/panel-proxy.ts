import type { VmProxySnap } from './panel-vm'

export type ProxyPoolPayload = {
  proxies?: VmProxySnap[]
  totals?: Record<string, unknown>
  config?: Record<string, unknown>
  vendors?: { id: string; name: string; tier: number }[]
  error?: string
}
