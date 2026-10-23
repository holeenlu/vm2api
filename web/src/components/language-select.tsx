import { LOCALES, type Locale } from '@/i18n'
import { Languages } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useLocale } from '@/context/locale-provider'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

export function LanguageSelect() {
  const { locale, setLocale } = useLocale()
  const { t } = useTranslation('common')
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant='ghost'
          size='icon'
          className='rounded-full'
          aria-label={t('language')}
        >
          <Languages />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align='end'>
        <DropdownMenuRadioGroup
          value={locale}
          onValueChange={(v) => setLocale(v as Locale)}
        >
          {LOCALES.map((l) => (
            <DropdownMenuRadioItem key={l.id} value={l.id}>
              {l.name}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
