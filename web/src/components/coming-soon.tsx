import { t } from '@/i18n'
import { Telescope } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export function ComingSoon() {
  useTranslation('common')
  return (
    <div className='h-svh'>
      <div className='m-auto flex h-full w-full flex-col items-center justify-center gap-2'>
        <Telescope size={72} />
        <h1 className='text-4xl leading-tight font-bold'>
          {t('common:comingSoon')}
        </h1>
        <p className='text-center text-muted-foreground'>
          {t('common:comingSoonDescription')}
        </p>
      </div>
    </div>
  )
}
