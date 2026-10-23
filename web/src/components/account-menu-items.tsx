import { Link } from '@tanstack/react-router'
import { Info, KeyRound, Settings, UserRound, Users } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '@/stores/auth-store'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'

export function AccountMenuItems() {
  const me = useAuthStore((s) => s.me)
  const { t } = useTranslation('common')
  const can = (view: string) => !!me?.views?.includes(view)
  return (
    <>
      {can('profile') && (
        <DropdownMenuItem asChild>
          <Link to='/profile'>
            <UserRound />
            {t('common:myProfile')}
          </Link>
        </DropdownMenuItem>
      )}
      {can('keys') && (
        <DropdownMenuItem asChild>
          <Link to='/keys'>
            <KeyRound />
            {t('common:apiKeys')}
          </Link>
        </DropdownMenuItem>
      )}
      {can('settings') && (
        <>
          <DropdownMenuItem asChild>
            <Link to='/settings/$tab' params={{ tab: 'sticky' }}>
              <Settings />
              {t('common:settings')}
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link to='/settings/$tab' params={{ tab: 'about' }}>
              <Info />
              {t('common:aboutUpdate')}
            </Link>
          </DropdownMenuItem>
        </>
      )}
      {can('users') && (
        <DropdownMenuItem asChild>
          <Link to='/users'>
            <Users />
            {t('common:users')}
          </Link>
        </DropdownMenuItem>
      )}
    </>
  )
}
