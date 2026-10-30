import { queryOptions, type QueryClient } from '@tanstack/react-query'
import { firstAllowedPath } from '@/config/nav'
import type { MeResponse } from '@/types/panel-auth'
import { LoaderCircle, ShieldCheck, ShieldX, WifiOff } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { api, ApiError } from '@/lib/api'
import { useBranding } from '@/context/branding-provider'
import { Button } from '@/components/ui/button'
import type { Vendor } from './portal-model'

export type VendorAccessState =
  'loading' | 'expired' | 'denied' | 'unavailable' | 'error' | 'ready'

export function vendorAccessState({
  isPending,
  error,
  data,
}: {
  isPending: boolean
  error: unknown
  data?: { vendor?: Vendor | null } | null
}): VendorAccessState {
  // An error during revalidation takes precedence over cached identity.
  if (error instanceof ApiError) {
    if (error.status === 401) return 'expired'
    if (error.status === 403) return 'denied'
    if (
      error.status === 0 ||
      error.status === 408 ||
      error.status === 429 ||
      error.status >= 500
    )
      return 'unavailable'
    return 'error'
  }
  if (error instanceof TypeError) return 'unavailable'
  if (
    error instanceof DOMException &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  )
    return 'unavailable'
  if (error) return 'error'
  if (isPending) return 'loading'
  // A successful response without a supplier identity is an access denial.
  return data?.vendor ? 'ready' : data !== undefined ? 'denied' : 'error'
}

export function vendorAccessQueryOptions() {
  return queryOptions({
    queryKey: ['vendor', 'me'] as const,
    queryFn: async ({ signal }) => {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 15_000)
      try {
        const result = await api<{ vendor: Vendor }>('/api/vendor/me', {
          signal: AbortSignal.any([signal, controller.signal]),
        })
        if (controller.signal.aborted) throw new ApiError('', 408)
        return result
      } finally {
        clearTimeout(timeout)
      }
    },
    retry: false,
    // Offline requests should settle into an error, not stay paused forever.
    networkMode: 'always',
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: (query) =>
      query.state.status === 'success' && query.state.data?.vendor
        ? 30_000
        : false,
  })
}

export function vendorReturnPath(me?: MeResponse | null): string {
  // A denied supplier identity must never be routed back to /vendor.
  if (!me || me.role === 'vendor' || me.vendor) return '/welcome'
  return firstAllowedPath(me.views)
}

export function switchVendorAccount(
  queryClient: QueryClient,
  signOut: () => void,
  goToLogin: () => void
) {
  // signOut clears the auth store, local session and server-side session.
  signOut()
  void queryClient.cancelQueries()
  queryClient.clear()
  goToLogin()
}

export function VendorAccessCard({
  state,
  retrying = false,
  onRetry,
  onSwitchAccount,
  onReturn,
}: {
  state: Exclude<VendorAccessState, 'ready'>
  retrying?: boolean
  onRetry: () => void
  onSwitchAccount: () => void
  onReturn: () => void
}) {
  const { t } = useTranslation('vendor')
  const brand = useBranding()
  const loading = state === 'loading'
  const Icon = loading
    ? LoaderCircle
    : state === 'denied'
      ? ShieldX
      : state === 'expired'
        ? ShieldCheck
        : WifiOff

  return (
    <main className='grid min-h-svh place-items-center bg-muted/20 px-4 py-10'>
      <section
        aria-labelledby='vendor-access-title'
        className='w-full max-w-md rounded-2xl border bg-card p-6 text-center shadow-sm sm:p-10'
      >
        <div className='mb-8 flex items-center justify-center gap-3'>
          <img
            src={brand.logo_url || '/favicon.svg'}
            alt=''
            className='size-9 rounded-lg'
          />
          <span className='font-semibold'>{brand.name}</span>
        </div>
        <div role={loading ? 'status' : 'alert'} aria-live='polite'>
          <div className='mx-auto mb-5 grid size-14 place-items-center rounded-2xl bg-primary/10 text-primary'>
            <Icon
              aria-hidden='true'
              className={loading ? 'size-7 animate-spin' : 'size-7'}
            />
          </div>
          <p className='mb-2 text-sm text-muted-foreground'>{t('portal')}</p>
          <h1 id='vendor-access-title' className='text-xl font-semibold'>
            {t(`access.${state}.title`)}
          </h1>
          <p className='mt-3 text-sm leading-6 text-muted-foreground'>
            {t(`access.${state}.description`)}
          </p>
        </div>
        {!loading && (
          <div className='mt-7 flex flex-col gap-3'>
            {state === 'unavailable' && (
              <Button onClick={onRetry} loading={retrying}>
                {t('retry')}
              </Button>
            )}
            <Button
              variant={state === 'unavailable' ? 'outline' : 'default'}
              onClick={onSwitchAccount}
            >
              {t('access.switchAccount')}
            </Button>
            <Button variant='ghost' onClick={onReturn}>
              {t('access.returnToPortal')}
            </Button>
          </div>
        )}
      </section>
    </main>
  )
}
