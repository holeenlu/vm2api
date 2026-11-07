import type { QueryClient } from '@tanstack/react-query'
import { redirect, type ParsedLocation } from '@tanstack/react-router'
import { canOpenPath, firstAllowedPath } from '@/config/nav'
import { t } from '@/i18n'
import type { MeResponse } from '@/types/panel-auth'
import { toast } from 'sonner'
import { ApiError } from '@/lib/api'
import { meQueryOptions } from './queries'

// Welcome, the sidebar logo and the error pages all link here as the console
// entry, so roles without 总览 are sent to their own home without a warning.
const CONSOLE_ENTRY = '/overview'

/**
 * Runs before every page under `_authenticated`. Pages stay unmounted until
 * `/api/panel/me` resolves (shared cache with the layout, so one request);
 * a page outside the role's `views` redirects to the role's home.
 */
export async function guardPanelRoute({
  queryClient,
  location,
  preload,
}: {
  queryClient: QueryClient
  location: Pick<ParsedLocation, 'pathname' | 'href'>
  preload: boolean
}): Promise<MeResponse> {
  let me: MeResponse
  try {
    me = await queryClient.ensureQueryData(meQueryOptions())
  } catch (error) {
    // panelFetch already cleared the expired session on 401.
    if (error instanceof ApiError && error.status === 401) {
      throw redirect({ to: '/login', search: { redirect: location.href } })
    }
    throw error
  }
  if (canOpenPath(me.views, location.pathname)) return me
  if (!preload && location.pathname !== CONSOLE_ENTRY) {
    toast.error(t('common:pageForbidden'), { id: 'panel-route-forbidden' })
  }
  throw redirect({ to: firstAllowedPath(me.views), replace: true })
}
