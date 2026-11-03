import { t } from '@/i18n'
import { useTranslation } from 'react-i18next'
import { ApiError } from '@/lib/api'
import { handleServerError } from '@/lib/handle-server-error'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Skeleton } from '@/components/ui/skeleton'

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message
  if (error instanceof Error) return error.message
  return t('common:loadFailed')
}

export function QueryGate({
  loading,
  error,
  skeleton,
  children,
}: {
  loading: boolean
  error: unknown
  /**
   * 与本页结构匹配的骨架屏。不传则回落到通用两块灰条 ——
   * 那个默认值跟任何真实页面都不像，会造成「白屏 → 灰条 → 内容」三段跳，
   * 各页应传入 `components/page-skeletons.tsx` 里的原语组合。
   */
  skeleton?: React.ReactNode
  children: React.ReactNode
}) {
  useTranslation('common')
  if (loading) {
    if (skeleton) return skeleton
    return (
      <div className='space-y-3'>
        <Skeleton className='h-24 w-full' />
        <Skeleton className='h-64 w-full' />
      </div>
    )
  }
  if (error) {
    if (error instanceof ApiError && error.status === 401) return null
    return (
      <Alert variant='destructive'>
        <AlertTitle>{t('common:loadFailed')}</AlertTitle>
        <AlertDescription>{errorMessage(error)}</AlertDescription>
      </Alert>
    )
  }
  return children
}

export function toastQueryError(error: unknown) {
  handleServerError(error)
}
