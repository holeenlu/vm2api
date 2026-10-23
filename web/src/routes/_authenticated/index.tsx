import { createFileRoute, redirect } from '@tanstack/react-router'
import { hasSession } from '@/lib/session'
import { meQueryOptions } from '@/features/auth/queries'
import { onboardingQueryOptions } from '@/features/welcome/queries'

export const Route = createFileRoute('/_authenticated/')({
  beforeLoad: async ({ context }) => {
    // The router can still reach this hook after the layout redirect; a sessionless
    // fetch would 401 and the global handler would bounce to the sign-in page.
    if (!hasSession()) throw redirect({ to: '/welcome' })
    const me = await context.queryClient.ensureQueryData(meQueryOptions())
    if (me.role === 'user') throw redirect({ to: '/statistics' })
    let needsWelcome = false
    try {
      const data = await context.queryClient.ensureQueryData(
        onboardingQueryOptions()
      )
      needsWelcome = Boolean(data.needs_welcome)
    } catch {
      throw redirect({ to: '/overview' })
    }
    throw redirect({ to: needsWelcome ? '/welcome' : '/overview' })
  },
})
