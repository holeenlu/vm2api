import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { firstAllowedPath } from '@/config/nav'
import { DOCS_URL } from '@/config/repo'
import { Eye, EyeOff, LogIn } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Logo } from '@/assets/logo'
import { useAuthStore } from '@/stores/auth-store'
import { loginRequest } from '@/lib/api'
import { apiBase, sameOriginPanel, setApiBase } from '@/lib/session'
import { useBranding } from '@/context/branding-provider'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { LanguageSelect } from '@/components/language-select'
import { ThemeSwitch } from '@/components/theme-switch'
import { meQueryOptions } from './queries'

/** Standalone sign-in page; layout follows the newapi /sign-in screen. */
export function LoginPage() {
  const brand = useBranding()
  const { t } = useTranslation('auth')
  const search = useSearch({ from: '/login' })
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const signIn = useAuthStore((s) => s.signIn)
  const [username, setUsername] = useState('admin')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [base, setBase] = useState(apiBase())
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const hideBase = sameOriginPanel()

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    setPending(true)
    try {
      if (hideBase) setApiBase('')
      else setApiBase(base)
      const result = await loginRequest({
        username: username.trim(),
        password,
        base: hideBase ? '' : base.trim().replace(/\/$/, '') || apiBase(),
      })
      queryClient.clear()
      signIn(result.token, result.user)
      const me = await queryClient.fetchQuery(meQueryOptions())
      toast.success(t('loginSuccess'))
      // `redirect` is a router href (`/vm/x?tab=y`); never bounce back into the public pages.
      const next = search.redirect
      if (
        next &&
        next.startsWith('/') &&
        !next.startsWith('//') &&
        !/^\/(welcome|login)\b/.test(next)
      ) {
        await navigate({ href: next })
        return
      }
      await navigate({ href: firstAllowedPath(me.views) })
    } catch (err) {
      setError(err instanceof Error ? err.message : '')
    } finally {
      setPending(false)
    }
  }

  return (
    <div className='welcome-theme relative flex min-h-svh flex-col overflow-hidden bg-background text-foreground'>
      <div
        aria-hidden
        className='pointer-events-none absolute inset-0 opacity-20 dark:opacity-[0.08]'
        style={{
          background: [
            'radial-gradient(ellipse 50% 45% at 30% 30%, oklch(0.72 0.18 250 / 70%) 0%, transparent 70%)',
            'radial-gradient(ellipse 40% 40% at 75% 70%, oklch(0.70 0.12 280 / 50%) 0%, transparent 70%)',
          ].join(', '),
        }}
      />

      <header className='relative flex h-16 items-center justify-between px-6'>
        <Link
          to='/welcome'
          className='group flex items-center gap-2.5 rounded-lg focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'
        >
          <span className='grid size-7 place-items-center rounded-lg bg-foreground text-background transition-transform duration-300 group-hover:scale-105'>
            <Logo aria-hidden className='size-4' />
          </span>
          <span className='text-sm font-semibold tracking-tight'>
            {brand.name}
          </span>
        </Link>
        <div className='flex items-center gap-2'>
          <LanguageSelect />
          <ThemeSwitch />
        </div>
      </header>

      <main className='relative flex flex-1 items-center justify-center px-6 pb-20'>
        <div className='welcome-fade-up w-full max-w-[22rem]'>
          <h1 className='text-xl font-semibold tracking-tight'>{t('title')}</h1>
          <p className='mt-2 text-sm text-muted-foreground'>
            <a
              href={`${DOCS_URL}guide/install`}
              target='_blank'
              rel='noreferrer'
              className='text-foreground underline underline-offset-4'
            >
              {t('installDocs')}
            </a>
            {' · '}
            <Link
              to='/welcome'
              className='text-foreground underline underline-offset-4'
            >
              {t('welcome')}
            </Link>
          </p>

          <form className='mt-8 space-y-4' onSubmit={onSubmit}>
            <div className='space-y-2'>
              <Label htmlFor='login-username'>{t('username')}</Label>
              <Input
                id='login-username'
                className='h-10 rounded-lg'
                autoComplete='username'
                placeholder={t('usernamePlaceholder')}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </div>
            <div className='space-y-2'>
              <Label htmlFor='login-password'>{t('password')}</Label>
              <div className='relative'>
                <Input
                  id='login-password'
                  type={showPassword ? 'text' : 'password'}
                  className='h-10 rounded-lg pe-10'
                  autoComplete='current-password'
                  placeholder={t('passwordPlaceholder')}
                  autoFocus
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <button
                  type='button'
                  aria-label={t(showPassword ? 'hidePassword' : 'showPassword')}
                  onClick={() => setShowPassword((v) => !v)}
                  className='absolute inset-y-0 end-0 flex w-10 items-center justify-center rounded-e-lg text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'
                >
                  {showPassword ? (
                    <EyeOff aria-hidden className='size-4' />
                  ) : (
                    <Eye aria-hidden className='size-4' />
                  )}
                </button>
              </div>
            </div>
            {hideBase ? null : (
              <div className='space-y-2'>
                <Label htmlFor='login-api-base'>{t('apiBase')}</Label>
                <Input
                  id='login-api-base'
                  placeholder='http://127.0.0.1:8787'
                  className='h-10 rounded-lg'
                  value={base}
                  onChange={(e) => setBase(e.target.value)}
                />
              </div>
            )}
            {error !== null ? (
              <p className='text-sm text-destructive' role='alert'>
                {error || t('loginFailed')}
              </p>
            ) : null}
            <Button
              className='mt-2 h-10 w-full rounded-lg font-medium'
              type='submit'
              disabled={pending}
            >
              <LogIn aria-hidden className='size-4' />
              {t(pending ? 'signingIn' : 'signIn')}
            </Button>
          </form>
        </div>
      </main>
    </div>
  )
}
