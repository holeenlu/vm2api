import { QueryClient } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import {
  refreshVersionStatus,
  versionQueryOptions,
  type ReleaseStatus,
} from './queries'

vi.mock('@/lib/api', () => ({ api: vi.fn() }))

const clients: QueryClient[] = []
function client() {
  const value = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  clients.push(value)
  return value
}

function status(tag: string): ReleaseStatus {
  return {
    current: '1.3.222.0',
    current_tag: 'v1.3.222.0',
    latest: tag.slice(1),
    latest_tag: tag,
    update_available: tag !== 'v1.3.222.0',
    check_status: 'ok',
    html_url: '',
    published_at: null,
    name: null,
    notes: '',
    changelog: [],
    needs_wrap_cli_sync: false,
    upgrade_command: '',
    check_command: '',
    repo: 'holeenlu/vm2api',
    source_error: null,
  }
}

afterEach(() => {
  for (const value of clients.splice(0)) value.clear()
  vi.resetAllMocks()
})

describe('manual version refresh', () => {
  it('checks the server even while the displayed version query is fresh', async () => {
    const qc = client()
    const old = status('v1.3.222.0')
    const latest = status('v1.3.222.1')
    vi.mocked(api).mockResolvedValueOnce(old).mockResolvedValueOnce(latest)
    await qc.fetchQuery(versionQueryOptions())
    await qc.fetchQuery(versionQueryOptions())
    expect(api).toHaveBeenCalledTimes(1)
    expect(await refreshVersionStatus(qc)).toEqual(latest)
    expect(api).toHaveBeenLastCalledWith('/api/panel/version?force=1', {
      cache: 'no-store',
      signal: expect.any(AbortSignal),
    })
    expect(qc.getQueryData(versionQueryOptions().queryKey)).toEqual(latest)
  })

  it('cancels older background reads so they cannot restore the old release', async () => {
    const qc = client()
    let finishOld!: (value: ReleaseStatus) => void
    vi.mocked(api).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve
        })
    )
    const background = qc
      .fetchQuery(versionQueryOptions())
      .catch(() => undefined)
    const oldSignal = vi.mocked(api).mock.calls[0][1]?.signal
    const latest = status('v1.3.222.1')
    vi.mocked(api).mockResolvedValueOnce(latest)
    await refreshVersionStatus(qc)
    expect(oldSignal?.aborted).toBe(true)
    finishOld(status('v1.3.222.0'))
    await background
    expect(qc.getQueryData(versionQueryOptions().queryKey)).toEqual(latest)
  })

  it('records refresh failures as errors and allows an immediate manual retry', async () => {
    const qc = client()
    qc.setQueryData(versionQueryOptions().queryKey, status('v1.3.222.0'))
    vi.mocked(api).mockRejectedValueOnce(new Error('offline'))
    await expect(refreshVersionStatus(qc)).rejects.toThrow('offline')
    expect(qc.getQueryState(versionQueryOptions().queryKey)?.status).toBe(
      'error'
    )
    const latest = status('v1.3.222.1')
    vi.mocked(api).mockResolvedValueOnce(latest)
    expect(await refreshVersionStatus(qc)).toEqual(latest)
    expect(qc.getQueryState(versionQueryOptions().queryKey)?.status).toBe(
      'success'
    )
  })
})
