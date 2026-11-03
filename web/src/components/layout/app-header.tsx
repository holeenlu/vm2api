import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { LanguageSelect } from '@/components/language-select'
import { Header } from '@/components/layout/header'
import { ProfileDropdown } from '@/components/profile-dropdown'
import { Search } from '@/components/search'
import { ThemeSwitch } from '@/components/theme-switch'

type AppHeaderProps = {
  actions?: ReactNode
}

export function AppHeader({ actions }: AppHeaderProps) {
  const { t } = useTranslation('common')
  return (
    <Header
      fixed
      className='h-auto min-h-16 xl:h-16 [&>div]:flex-wrap xl:[&>div]:flex-nowrap'
    >
      <Search placeholder={t('common:searchPages')} />
      <div className='ms-auto flex min-w-0 flex-wrap items-center justify-end gap-2 [&>div]:flex-wrap'>
        {actions}
        <LanguageSelect />
        <ThemeSwitch />
        <ProfileDropdown />
      </div>
    </Header>
  )
}
