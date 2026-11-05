import { useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { useAuthStore } from '@/stores/auth-store'
import { ConfirmDialog } from '@/components/confirm-dialog'

interface SignOutDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function SignOutDialog({ open, onOpenChange }: SignOutDialogProps) {
  const navigate = useNavigate()
  const { t } = useTranslation('common')
  const signOut = useAuthStore((s) => s.signOut)

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('common:signOut')}
      desc={t('common:youWillNeedToSignInAgain')}
      confirmText={t('common:signOut')}
      cancelBtnText={t('common:cancel')}
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
