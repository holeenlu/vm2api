import { useState } from 'react'
import { t } from '@/i18n'
import { useTranslation } from 'react-i18next'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { useOnboardingAction } from './queries'
import type { UsageProfile } from './types'

const OPTIONS: { id: UsageProfile; title: string; body: string }[] = [
  {
    id: 'personal',
    get title() {
      return t('welcome:personal')
    },
    get body() {
      return t('welcome:personalHelp')
    },
  },
  {
    id: 'relay',
    get title() {
      return t('welcome:relay')
    },
    get body() {
      return t('welcome:relayHelp')
    },
  },
]

export function WelcomeUsageMode({
  profile,
}: {
  profile: UsageProfile | null
}) {
  const { t } = useTranslation('welcome')

  const action = useOnboardingAction()
  const [error, setError] = useState<string | null>(null)

  function choose(next: string) {
    if (next !== 'personal' && next !== 'relay') return
    if (next === profile || action.isPending) return
    setError(null)
    action.mutate(
      { action: 'profile', mode: next },
      {
        onError: (err) => {
          setError(err instanceof Error ? err.message : '')
        },
      }
    )
  }

  return (
    <section
      className='relative z-10 px-6 pb-4'
      aria-labelledby='welcome-usage'
    >
      <div className='mx-auto flex max-w-6xl flex-col gap-4 rounded-2xl border bg-card p-4 shadow-xs sm:p-6'>
        <div className='flex max-w-2xl flex-col gap-1'>
          <h2
            id='welcome-usage'
            className='text-xl font-semibold tracking-tight sm:text-2xl'
          >
            {t('welcome:usageTitle')}
          </h2>
          <p className='text-sm leading-relaxed text-muted-foreground'>
            {t('welcome:usageHelp')}
          </p>
        </div>
        <RadioGroup
          value={profile ?? ''}
          onValueChange={choose}
          disabled={action.isPending}
          aria-label={t('welcome:usageMode')}
          aria-describedby={error !== null ? 'welcome-usage-error' : undefined}
          aria-invalid={error !== null ? true : undefined}
          className='gap-0 overflow-hidden rounded-2xl border bg-background/70'
        >
          {OPTIONS.map((option) => (
            <div
              key={option.id}
              className='flex items-start gap-3 border-b px-3 py-3 last:border-b-0'
              data-checked={profile === option.id ? 'true' : undefined}
            >
              <RadioGroupItem
                id={`usage-${option.id}`}
                value={option.id}
                className='mt-1'
              />
              <label
                htmlFor={`usage-${option.id}`}
                className='flex min-w-0 flex-col gap-1'
              >
                <span className='text-sm font-medium'>{option.title}</span>
                <span className='text-xs leading-relaxed text-muted-foreground'>
                  {option.body}
                </span>
              </label>
            </div>
          ))}
        </RadioGroup>
        {error !== null ? (
          <p
            id='welcome-usage-error'
            className='text-sm text-destructive'
            role='alert'
          >
            {t('welcome:saveModeFailed', {
              message: error || t('welcome:saveFailed'),
            })}
          </p>
        ) : null}
      </div>
    </section>
  )
}
