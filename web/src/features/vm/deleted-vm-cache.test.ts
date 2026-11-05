import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import { panelQueryKeys } from '@/lib/query-keys'
import { removeDeletedVmFromCache } from './queries'

describe('deleted VM cache', () => {
  it('removes cached picker rows and detail credentials, and refreshes groups and capacity', async () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    qc.setQueryData(panelQueryKeys.vms(), {
      items: [{ id: 'gone' }, { id: 'live' }],
      pool_queue: { queued: 1 },
    })
    qc.setQueryData(panelQueryKeys.vm('gone'), { id: 'gone' })
    qc.setQueryData(panelQueryKeys.vmCredential('gone'), { value: 'test' })
    qc.setQueryData(panelQueryKeys.vm('live'), { id: 'live' })
    qc.setQueryData(panelQueryKeys.groups(), { items: [] })
    qc.setQueryData(panelQueryKeys.dashboard(), { slots: 2 })
    await removeDeletedVmFromCache(qc, 'gone')
    expect(qc.getQueryData(panelQueryKeys.vms())).toEqual({
      items: [{ id: 'live' }],
      pool_queue: { queued: 1 },
    })
    expect(qc.getQueryData(panelQueryKeys.vm('gone'))).toBeUndefined()
    expect(qc.getQueryData(panelQueryKeys.vmCredential('gone'))).toBeUndefined()
    expect(qc.getQueryData(panelQueryKeys.vm('live'))).toEqual({ id: 'live' })
    for (const key of [
      panelQueryKeys.vms(),
      panelQueryKeys.groups(),
      panelQueryKeys.dashboard(),
    ])
      expect(qc.getQueryState(key)?.isInvalidated).toBe(true)
    qc.clear()
  })

  it('cancels an older VM response so it cannot restore the deleted row', async () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    let resolve!: (value: { items: { id: string }[] }) => void
    const pending = qc
      .fetchQuery({
        queryKey: panelQueryKeys.vms(),
        queryFn: () =>
          new Promise<{ items: { id: string }[] }>((done) => {
            resolve = done
          }),
      })
      .catch(() => undefined)
    await removeDeletedVmFromCache(qc, 'gone')
    resolve({ items: [{ id: 'gone' }] })
    await pending
    expect(qc.getQueryData(panelQueryKeys.vms())).toBeUndefined()
    qc.clear()
  })
})
