import { describe, expect, it, vi } from 'vitest'
import {
  invalidateProxyBinding,
  invalidateUsageViews,
  invalidateVendorResources,
  invalidateVm,
} from './query-invalidations'

function client() {
  return { invalidateQueries: vi.fn(() => Promise.resolve()) } as any
}

describe('query invalidation relationships', () => {
  it('refreshes vm detail, list and dashboard together', async () => {
    const qc = client()
    await invalidateVm(qc, 'vm-1')
    expect(qc.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['panel', 'vms'],
    })
    expect(qc.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['panel', 'vm', 'vm-1'],
    })
    expect(qc.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['panel', 'dashboard'],
    })
  })

  it('refreshes proxy binding dependents', async () => {
    const qc = client()
    await invalidateProxyBinding(qc)
    expect(qc.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['panel', 'proxies'],
    })
    expect(qc.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['panel', 'vms'],
    })
  })

  it('refreshes vendor and supplier projections together', async () => {
    const qc = client()
    await invalidateVendorResources(qc)
    expect(qc.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['vendor'] })
    expect(qc.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['supplier-admin'],
    })
  })

  it('refreshes usage views together', async () => {
    const qc = client()
    await invalidateUsageViews(qc)
    expect(qc.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['panel', 'usage'],
    })
    expect(qc.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['panel', 'usage-logs'],
    })
  })
})
