import { t } from '@/i18n'
import { toast } from 'sonner'
import { ApiError } from '@/lib/api'

export function handleServerError(error: unknown) {
  const message =
    error instanceof ApiError
      ? error.message
      : error instanceof Error
        ? error.message
        : t('lib:api.requestFailed')
  toast.error(message)
}
