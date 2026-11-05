import type { QueryClient } from '@tanstack/react-query'
import { panelQueryKeys } from './query-keys'

export function invalidatePanel(client: QueryClient) {
  return client.invalidateQueries({ queryKey: panelQueryKeys.root() })
}

export function invalidateVendor(client: QueryClient) {
  return client.invalidateQueries({ queryKey: panelQueryKeys.vendor() })
}

export function invalidateSupplierAdmin(client: QueryClient) {
  return client.invalidateQueries({ queryKey: panelQueryKeys.supplierAdmin() })
}

/** Shared cache invalidation relationships for panel and supplier mutations. */
export function invalidateVm(client: QueryClient, id?: string) {
  return Promise.all([
    client.invalidateQueries({ queryKey: panelQueryKeys.vms() }),
    id
      ? client.invalidateQueries({ queryKey: panelQueryKeys.vm(id) })
      : Promise.resolve(),
    client.invalidateQueries({ queryKey: panelQueryKeys.dashboard() }),
    id
      ? client.invalidateQueries({ queryKey: panelQueryKeys.vmSeed(id) })
      : Promise.resolve(),
    id
      ? client.invalidateQueries({ queryKey: panelQueryKeys.vmCredential(id) })
      : Promise.resolve(),
  ])
}

export function invalidateProxyBinding(client: QueryClient) {
  return Promise.all([
    client.invalidateQueries({ queryKey: panelQueryKeys.proxies() }),
    invalidateVm(client),
  ])
}

export function invalidateVendorResources(client: QueryClient) {
  return Promise.all([
    client.invalidateQueries({ queryKey: panelQueryKeys.vendor() }),
    client.invalidateQueries({ queryKey: panelQueryKeys.supplierAdmin() }),
    client.invalidateQueries({ queryKey: panelQueryKeys.vms() }),
    client.invalidateQueries({ queryKey: panelQueryKeys.usage() }),
  ])
}

export function invalidateUsageViews(client: QueryClient) {
  return Promise.all([
    client.invalidateQueries({ queryKey: panelQueryKeys.usage() }),
    client.invalidateQueries({ queryKey: panelQueryKeys.requestLogs() }),
    client.invalidateQueries({ queryKey: panelQueryKeys.usageLogs() }),
  ])
}
