import { useTranslation } from 'react-i18next'
import { useAuthStore } from '@/stores/auth-store'
import { getDisplayNameInitials } from '@/lib/utils'
import useDialogState from '@/hooks/use-dialog-state'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { AccountMenuItems } from '@/components/account-menu-items'
import { SignOutDialog } from '@/components/sign-out-dialog'

export function ProfileDropdown() {
  const [open, setOpen] = useDialogState()
  const user = useAuthStore((s) => s.me?.display_name || s.user) || ''
  const { t } = useTranslation('common')
  const role = useAuthStore((s) => s.me?.role) || ''
  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button variant='ghost' className='relative h-8 w-8 rounded-full'>
            <Avatar className='h-8 w-8'>
              <AvatarFallback>{getDisplayNameInitials(user)}</AvatarFallback>
            </Avatar>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className='w-56' align='end' forceMount>
          <DropdownMenuLabel className='font-normal'>
            <div className='flex flex-col gap-1.5'>
              <p className='text-sm leading-none font-medium'>{user}</p>
              <p className='text-xs leading-none text-muted-foreground'>
                {role === 'super_admin'
                  ? t('common:superAdmin')
                  : role === 'admin'
                    ? t('common:administrator')
                    : t('common:user')}
              </p>
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <AccountMenuItems />
          <DropdownMenuSeparator />
          <DropdownMenuItem variant='destructive' onClick={() => setOpen(true)}>
            {t('common:signOut')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <SignOutDialog open={!!open} onOpenChange={setOpen} />
    </>
  )
}
