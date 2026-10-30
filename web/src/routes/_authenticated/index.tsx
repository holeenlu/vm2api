import { createFileRoute, redirect } from '@tanstack/react-router'
import { firstAllowedPath } from '@/config/nav'
import { hasSession } from '@/lib/session'
import { meQueryOptions } from '@/features/auth/queries'

export const Route = createFileRoute('/_authenticated/')({
  beforeLoad: async ({ context }) => {
    if (!hasSession()) throw redirect({ to: '/welcome' })
    const me = await context.queryClient.ensureQueryData(meQueryOptions())
    if (me.vendor) throw redirect({ to: '/vendor' })
    throw redirect({ href: firstAllowedPath(me.views) })
  },
})
