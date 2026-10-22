import { Link } from '@tanstack/react-router'
import { REPO_URL } from '@/config/repo'
import { ArrowRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Reveal } from './reveal'
import { docsHref } from './steps'

export function WelcomeCta({ signedIn }: { signedIn: boolean }) {
  const { t } = useTranslation('welcome')

  return (
    <section className='relative z-10 overflow-hidden px-6 py-24 md:py-32'>
      <div
        aria-hidden
        className='pointer-events-none absolute inset-0 -z-10 opacity-20 dark:opacity-[0.08]'
        style={{
          background: [
            'radial-gradient(ellipse 50% 50% at 30% 50%, oklch(0.7 0.15 250 / 70%) 0%, transparent 70%)',
            'radial-gradient(ellipse 40% 40% at 70% 40%, oklch(0.65 0.12 200 / 50%) 0%, transparent 70%)',
          ].join(', '),
        }}
      />
      <Reveal animation='scale-in' className='mx-auto max-w-2xl text-center'>
        <h2 className='text-2xl leading-tight font-bold tracking-tight md:text-4xl'>
          {signedIn ? t('welcome:afterSetup') : t('welcome:ready')}
          <br />
          <span className='bg-gradient-to-r from-blue-400 via-violet-400 to-purple-500 bg-clip-text text-transparent'>
            {signedIn
              ? t('welcome:firstRequestTitle')
              : t('welcome:signInToSetup')}
          </span>
        </h2>
        <p className='mx-auto mt-5 max-w-md text-sm leading-relaxed text-muted-foreground md:text-base'>
          {t('welcome:consoleHelp')}
        </p>
        <div className='mt-8 flex items-center justify-center gap-3'>
          {signedIn ? (
            <Button asChild className='group rounded-lg'>
              <Link to='/'>
                {t('welcome:openConsole')}
                <ArrowRight
                  aria-hidden
                  className='size-3.5 transition-transform group-hover:translate-x-0.5'
                />
              </Link>
            </Button>
          ) : (
            <Button asChild className='group rounded-lg'>
              <Link to='/login'>
                {t('welcome:signInConsole')}
                <ArrowRight
                  aria-hidden
                  className='size-3.5 transition-transform group-hover:translate-x-0.5'
                />
              </Link>
            </Button>
          )}
          <Button
            asChild
            variant='outline'
            className='rounded-lg border-border/50 hover:border-border hover:bg-muted/50'
          >
            <a
              href={docsHref('guide/install')}
              target='_blank'
              rel='noreferrer'
            >
              {t('welcome:installDocs')}
            </a>
          </Button>
        </div>
      </Reveal>
    </section>
  )
}

export function WelcomeFooter() {
  const { t } = useTranslation('welcome')

  return (
    <footer className='relative z-10 px-6 pb-10'>
      <div className='mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 border-t border-border/40 pt-6 text-xs text-muted-foreground'>
        <span className='font-medium text-foreground/80'>tapmodels</span>
        <span>
          {t('welcome:personalNoncommercial')}{' '}
          <a
            href={REPO_URL}
            target='_blank'
            rel='noreferrer'
            className='underline-offset-4 hover:text-foreground hover:underline'
          >
            GitHub
          </a>
        </span>
      </div>
    </footer>
  )
}
