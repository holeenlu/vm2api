import { useNavigate } from '@tanstack/react-router'
import { useAuthStore } from '@/stores/auth-store'
import { useLocale } from '@/context/locale-provider'
import { ConfirmDialog } from '@/components/confirm-dialog'

interface SignOutDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function SignOutDialog({ open, onOpenChange }: SignOutDialogProps) {
  const navigate = useNavigate()
  const { t } = useLocale()
  const signOut = useAuthStore((s) => s.signOut)

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('退出登录')}
      desc={t('退出后需要重新登录。')}
      confirmText={t('退出')}
      cancelBtnText={t('取消')}
      destructive
      handleConfirm={() => {
        signOut()
        navigate({
          to: '/welcome',
          search: {},
          replace: true,
        })
      }}
      className='sm:max-w-sm'
    />
  )
}
