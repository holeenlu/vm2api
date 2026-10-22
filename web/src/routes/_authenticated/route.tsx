import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  createFileRoute,
  redirect,
  useNavigate,
  useLocation,
} from '@tanstack/react-router'
import { useAuthStore } from '@/stores/auth-store'
import { ApiError } from '@/lib/api'
import { hasSession } from '@/lib/session'
import { AuthenticatedLayout } from '@/components/layout/authenticated-layout'
import { meQueryOptions } from '@/features/auth/queries'
import { FleetActions } from '@/features/fleet/fleet-actions'
import { onboardingQueryOptions } from '@/features/welcome/queries'

export const Route = createFileRoute('/_authenticated')({
  beforeLoad: ({ location }) => {
    if (!hasSession()) {
      // Bare console entry is the public welcome; deep links go to the sign-in page.
      if (location.pathname === '/') throw redirect({ to: '/welcome' })
      throw redirect({ to: '/login', search: { redirect: location.href } })
    }
  },
  component: Authenticated,
})

function Authenticated() {
  const navigate = useNavigate()
  const location = useLocation()
  const meQuery = useQuery(meQueryOptions())
  const isAdmin = meQuery.data?.role === 'admin'
  const onboarding = useQuery(onboardingQueryOptions(isAdmin))
  const needsWelcome = isAdmin && onboarding.data?.guide_used === false
  const setMe = useAuthStore((s) => s.setMe)
  const signOut = useAuthStore((s) => s.signOut)
  useEffect(() => {
    if (needsWelcome)
      void navigate({ to: '/welcome', search: { setup: true }, replace: true })
  }, [needsWelcome, navigate])
  useEffect(() => {
    if (meQuery.data) setMe(meQuery.data)
  }, [meQuery.data, setMe])
  useEffect(() => {
    if (meQuery.error instanceof ApiError && meQuery.error.status === 401) {
      signOut()
      navigate({ to: '/login' })
    }
  }, [meQuery.error, signOut, navigate])
  useEffect(() => {
    const view = location.pathname.split('/')[1]
    if (meQuery.data && view && !meQuery.data.views?.includes(view))
      navigate({
        to: meQuery.data.role === 'user' ? '/statistics' : '/overview',
        replace: true,
      })
  }, [meQuery.data, location.pathname, navigate])
  if (meQuery.error instanceof ApiError && meQuery.error.status === 401) {
    return null
  }
  const view = location.pathname.split('/')[1]
  if (!meQuery.data || (view && !meQuery.data.views?.includes(view)))
    return null
  return <AuthenticatedLayout headerActions={<FleetActions />} />
}
