import { t } from '@/i18n'
import { useTranslation } from 'react-i18next'
import { Reveal } from './reveal'

// Product facts, not traffic metrics: the page never shows numbers it cannot back.
const FACTS = [
  {
    value: '3',
    get label() {
      return t('welcome:protocolCount')
    },
  },
  {
    value: '1 : 1',
    get label() {
      return t('welcome:oneToOneEgress')
    },
  },
  {
    value: '5h · 7d',
    get label() {
      return t('welcome:quotaAligned')
    },
  },
  {
    value: '2',
    get label() {
      return t('welcome:platforms')
    },
  },
] as const

export function WelcomeStats() {
  useTranslation('welcome')

  return (
    <section className='relative z-10 border-y border-border/40 bg-muted/20 px-6 py-14 md:py-16'>
      <div className='mx-auto grid max-w-6xl grid-cols-2 gap-y-10 md:grid-cols-4'>
        {FACTS.map((f, i) => (
          <Reveal
            key={f.value}
            delay={i * 80}
            className='flex flex-col items-center px-2 text-center'
          >
            <span className='text-3xl font-bold tracking-tight tabular-nums md:text-4xl'>
              {f.value}
            </span>
            <span className='mt-2 max-w-[14rem] text-xs leading-relaxed text-muted-foreground md:text-sm'>
              {f.label}
            </span>
          </Reveal>
        ))}
      </div>
    </section>
  )
}
