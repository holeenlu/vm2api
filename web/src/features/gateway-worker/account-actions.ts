import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import {
  accountBase,
  accountQueryKey,
  type GatewayAccount,
} from './accounts-model'

export type AccountActionName =
  'pause' | 'resume' | 'refresh' | 'recover' | 'archive'

/**
 * 列表与详情页共用的账号操作：同一时间只跑一个。`quiet` 时不弹成功 / 失败提示并抛出错误，
 * 由调用方（如调度开关）自己提示；投影未同步的警告始终提示。
 */
export function useAccountAction() {
  const { t } = useTranslation('common')
  const qc = useQueryClient()
  const [busyId, setBusyId] = useState<string | null>(null)
  const refresh = () => qc.invalidateQueries({ queryKey: accountQueryKey })
  async function run(
    account: GatewayAccount,
    name: AccountActionName,
    { quiet = false }: { quiet?: boolean } = {}
  ): Promise<boolean> {
    if (busyId != null) return false
    setBusyId(account.id)
    try {
      const result = await api<{
        projection_pending?: boolean
        ok?: boolean
        data?: { error?: { message?: string } }
      }>(
        `${accountBase}/${account.id}${name === 'archive' ? '' : `/${name}`}`,
        {
          method: name === 'archive' ? 'PATCH' : 'POST',
          ...(name === 'archive'
            ? { body: JSON.stringify({ status: 'archived' }) }
            : {}),
        }
      )
      if (result.ok === false)
        throw new Error(result.data?.error?.message || t('codexActionFailed'))
      if (result.projection_pending) toast.warning(t('codexProjectionPending'))
      else if (!quiet) toast.success(t('codexActionDone'))
      await refresh()
      return true
    } catch (error) {
      if (quiet) throw error
      toast.error((error as Error).message)
      return false
    } finally {
      setBusyId(null)
    }
  }
  return { busyId, run, refresh }
}
