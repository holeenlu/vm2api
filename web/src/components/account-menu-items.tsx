import { Link } from '@tanstack/react-router'
import { Info, KeyRound, Settings, UserRound, Users } from 'lucide-react'
import { useAuthStore } from '@/stores/auth-store'
import { useLocale } from '@/context/locale-provider'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'

export function AccountMenuItems() {
  const me = useAuthStore((s) => s.me)
  const { t } = useLocale()
  const can = (view: string) => !!me?.views?.includes(view)
  return (
    <>
      {can('profile') && (
        <DropdownMenuItem asChild>
          <Link to='/profile'>
            <UserRound />
            {t('个人资料')}
          </Link>
        </DropdownMenuItem>
      )}
      {can('keys') && (
        <DropdownMenuItem asChild>
          <Link to='/keys'>
            <KeyRound />
            {t('API 密钥')}
          </Link>
        </DropdownMenuItem>
      )}
      {can('settings') && (
        <>
          <DropdownMenuItem asChild>
            <Link to='/settings/$tab' params={{ tab: 'sticky' }}>
              <Settings />
              {t('设置')}
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link to='/settings/$tab' params={{ tab: 'about' }}>
              <Info />
              {t('关于 / 更新')}
            </Link>
          </DropdownMenuItem>
        </>
      )}
      {can('users') && (
        <DropdownMenuItem asChild>
          <Link to='/users'>
            <Users />
            {t('用户')}
          </Link>
        </DropdownMenuItem>
      )}
    </>
  )
}
