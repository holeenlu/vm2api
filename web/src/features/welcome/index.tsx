/**
 * Public TapModels marketing landing page. The authenticated setup checklist
 * remains available below the public content after sign-in.
 */
import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useSearch } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '@/stores/auth-store'
import { useBranding } from '@/context/branding-provider'
import { meQueryOptions } from '@/features/auth/queries'
import { WelcomeChecklist } from './checklist'
import { MarketingHome } from './marketing-home'
import { WelcomeModuleGuide } from './module-guide'
import { onboardingQueryOptions } from './queries'
import { scrollToSection } from './scroll'
import { WelcomeUsageMode } from './usage-mode'

export function WelcomePage() {
  const search = useSearch({ from: '/welcome' })
  const token = useAuthStore((s) => s.token)
  const signedIn = Boolean(token)
  const brand = useBranding()
  const { t } = useTranslation('welcome')

  const onboarding = useQuery(onboardingQueryOptions(signedIn))
  const me = useQuery(meQueryOptions(signedIn))

  // Sign-in lands here with `?setup=1`. The router resets scroll right after the
  // navigation commits, so the jump waits a beat to not be overwritten.
  useEffect(() => {
    if (!search.setup || !onboarding.data) return
    const timer = window.setTimeout(() => scrollToSection('welcome-setup'), 120)
    return () => window.clearTimeout(timer)
  }, [search.setup, onboarding.data])

  const base =
    (onboarding.data?.base_url || '').replace(/\/$/, '') || location.origin

  return (
    <div className='min-h-svh bg-background text-foreground'>
      <main>
        <MarketingHome signedIn={signedIn} baseUrl={base} />
        {signedIn && onboarding.data ? (
          <>
            {me.data?.role === 'super_admin' ? (
              <WelcomeUsageMode profile={onboarding.data.profile ?? null} />
            ) : null}
            <WelcomeChecklist
              payload={onboarding.data}
              views={me.data?.views}
            />
            <WelcomeModuleGuide views={me.data?.views} />
          </>
        ) : null}
      </main>
      <footer className='border-t bg-background px-4 py-6 text-center text-xs text-muted-foreground sm:px-6'>
        © 2026 {brand.name}. {t('welcome:marketingFooter')}
      </footer>
    </div>
  )
}
