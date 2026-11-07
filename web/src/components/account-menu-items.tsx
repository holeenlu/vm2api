import { Link } from '@tanstack/react-router'
import { KeyRound, UserRound } from 'lucide-react'
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
    </>
  )
}
