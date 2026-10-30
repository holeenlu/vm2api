import { QueryClient, onlineManager } from '@tanstack/react-query'
import type { MeResponse } from '@/types/panel-auth'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/api'
import { LS_TOKEN, LS_USER } from '@/lib/session'
import {
  VendorAccessCard,
  vendorAccessQueryOptions,
  vendorAccessState,
  vendorReturnPath,
  switchVendorAccount,
} from './access-state'
import type { Vendor } from './portal-model'

// Locale resources are merged separately; test the requested key contract.
vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>()
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  }
})

const vendor: Vendor = {
  id: 'supplier-1',
  name: 'Private supplier',
  tier: 1,
  views: ['accounts'],
  capabilities: [],
  child_limit: 0,
  account_limit: 0,
  proxy_limit: 0,
}

const clients: QueryClient[] = []
function client() {
  const value = new QueryClient({
    defaultOptions: { queries: { gcTime: Infinity } },
  })
  clients.push(value)
  return value
}

function session() {
  const values = new Map([
    [LS_TOKEN, 'old-token'],
    [LS_USER, 'old-user'],
  ])
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => values.delete(key),
    setItem: (key: string, value: string) => values.set(key, value),
  })
  vi.stubGlobal('location', { hostname: 'localhost' })
  vi.stubGlobal('document', { cookie: '' })
  return values
}

afterEach(() => {
  for (const value of clients.splice(0)) value.clear()
  onlineManager.setOnline(true)
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('supplier identity access state', () => {
  it('distinguishes initial loading, success, and a completed empty response', () => {
    expect(vendorAccessState({ isPending: true, error: null })).toBe('loading')
    expect(
      vendorAccessState({ isPending: false, error: null, data: { vendor } })
    ).toBe('ready')
    expect(
      vendorAccessState({ isPending: false, error: null, data: undefined })
    ).toBe('error')
    for (const data of [null, {}, { vendor: null }]) {
      expect(vendorAccessState({ isPending: false, error: null, data })).toBe(
        'denied'
      )
    }
  })

  it.each([
    [401, 'expired'],
    [403, 'denied'],
    [0, 'unavailable'],
    [408, 'unavailable'],
    [429, 'unavailable'],
    [500, 'unavailable'],
    [503, 'unavailable'],
    [400, 'error'],
    [404, 'error'],
  ])('classifies HTTP %s even with cached supplier data', (status, state) => {
    expect(
      vendorAccessState({
        isPending: false,
        error: new ApiError('Private server details', status as number),
        data: { vendor },
      })
    ).toBe(state)
  })

  it('offers recovery for network failures but not arbitrary application errors', () => {
    for (const error of [
      new TypeError('Failed to fetch'),
      new DOMException('Aborted', 'AbortError'),
      new DOMException('Timed out', 'TimeoutError'),
    ]) {
      expect(vendorAccessState({ isPending: false, error })).toBe('unavailable')
    }
    expect(
      vendorAccessState({ isPending: false, error: new Error('Unexpected') })
    ).toBe('error')
  })

  it('settles offline instead of remaining paused in loading', async () => {
    session()
    onlineManager.setOnline(false)
    const fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    vi.stubGlobal('fetch', fetch)
    const queryClient = client()
    await expect(
      queryClient.fetchQuery(vendorAccessQueryOptions())
    ).rejects.toThrow()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(queryClient.getQueryState(['vendor', 'me'])?.fetchStatus).toBe(
      'idle'
    )
  })

  it('aborts a stalled identity request after 15 seconds', async () => {
    session()
    vi.useFakeTimers()
    const fetch = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(init.signal?.reason)
          )
        })
    )
    vi.stubGlobal('fetch', fetch)
    const request = client().fetchQuery(vendorAccessQueryOptions())
    const rejected = expect(request).rejects.toMatchObject({
      name: 'AbortError',
    })
    await vi.advanceTimersByTimeAsync(15_000)
    await rejected
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels the network request when its query is cancelled', async () => {
    session()
    let signal: AbortSignal | null | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) => {
        signal = init.signal
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal?.reason))
        })
      })
    )
    const queryClient = client()
    const request = queryClient.fetchQuery(vendorAccessQueryOptions())
    const rejected = expect(request).rejects.toThrow()
    await queryClient.cancelQueries()
    await rejected
    expect(signal?.aborted).toBe(true)
  })

  it('does not retry or poll denial, and polls only a successful identity', async () => {
    session()
    const fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 403 }))
    vi.stubGlobal('fetch', fetch)
    const queryClient = client()
    const options = vendorAccessQueryOptions()
    const interval = options.refetchInterval
    if (typeof interval !== 'function')
      throw new Error('Missing interval policy')
    await expect(queryClient.fetchQuery(options)).rejects.toMatchObject({
      status: 403,
    })
    expect(fetch).toHaveBeenCalledTimes(1)
    const query = queryClient
      .getQueryCache()
      .build<
        { vendor: Vendor },
        Error,
        { vendor: Vendor },
        readonly ['vendor', 'me']
      >(queryClient, options)
    expect(interval(query)).toBe(false)
    queryClient.setQueryData(options.queryKey, { vendor })
    expect(interval(query)).toBe(30_000)
    queryClient.setQueryData(['vendor', 'me'], {})
    expect(interval(query)).toBe(false)
  })
})

describe('supplier access card', () => {
  it.each(['loading', 'expired', 'denied', 'unavailable', 'error'] as const)(
    'renders a branded, accessible %s card with only suitable actions',
    (state) => {
      const html = renderToStaticMarkup(
        <VendorAccessCard
          state={state}
          onRetry={vi.fn()}
          onSwitchAccount={vi.fn()}
          onReturn={vi.fn()}
        />
      )
      expect(html).toContain('tapmodels')
      expect(html).toContain('min-h-svh')
      expect(html).toContain('max-w-md')
      expect(html).toContain(`access.${state}.title`)
      expect(html).toContain(`access.${state}.description`)
      expect(html).toContain(
        state === 'loading' ? 'role="status"' : 'role="alert"'
      )
      expect(html.includes('access.switchAccount')).toBe(state !== 'loading')
      expect(html.includes('access.returnToPortal')).toBe(state !== 'loading')
      expect(html.includes('>retry<')).toBe(state === 'unavailable')
      expect(html).not.toContain('Private supplier')
      expect(html).not.toContain('Private server details')
    }
  )

  it('disables retry during a recovery request', () => {
    const html = renderToStaticMarkup(
      <VendorAccessCard
        state='unavailable'
        retrying
        onRetry={vi.fn()}
        onSwitchAccount={vi.fn()}
        onReturn={vi.fn()}
      />
    )
    expect(html).toMatch(/<button[^>]*disabled=""/)
  })
})

describe('supplier access recovery', () => {
  it.each([
    [{ role: 'super_admin', views: ['overview', 'users'] }, '/overview'],
    [{ role: 'admin', views: ['users'] }, '/users'],
    [{ role: 'user', views: ['keys'] }, '/keys'],
    [{ role: 'vendor', views: ['overview'] }, '/welcome'],
    [{ role: 'user', views: ['vendor', '//evil.example'] }, '/welcome'],
    [{ role: 'user', views: [] }, '/welcome'],
    [null, '/welcome'],
  ])(
    'returns only an accessible non-supplier destination for %j',
    (me, path) => {
      expect(vendorReturnPath(me as MeResponse | null)).toBe(path)
    }
  )

  it('clears actual session, auth state and all cached data before login navigation', async () => {
    const values = session()
    const fetch = vi.fn().mockResolvedValue(new Response('{}'))
    vi.stubGlobal('fetch', fetch)
    const { useAuthStore } = await import('@/stores/auth-store')
    useAuthStore.setState({
      token: 'old-token',
      user: 'old-user',
      me: { user: 'old-user', role: 'user', views: ['keys'] },
    })
    const queryClient = client()
    queryClient.setQueryData(['vendor', 'me'], { vendor })
    queryClient.setQueryData(['panel', 'me'], useAuthStore.getState().me)
    const navigate = vi.fn(() => {
      expect(values.has(LS_TOKEN)).toBe(false)
      expect(values.has(LS_USER)).toBe(false)
      expect(useAuthStore.getState()).toMatchObject({
        token: '',
        user: '',
        me: null,
      })
      expect(queryClient.getQueryCache().getAll()).toHaveLength(0)
    })
    switchVendorAccount(queryClient, useAuthStore.getState().signOut, navigate)
    expect(navigate).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledWith(
      '/api/panel/logout',
      expect.objectContaining({ method: 'POST' })
    )
  })
})
