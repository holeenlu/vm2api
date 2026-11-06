import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import type {
  OpenaiQuotaPayload,
  VmActions,
} from '@/features/vm/vm-actions-context'
import {
  accountBase,
  accountQueryKey,
  type GatewayAccount,
  type GatewayQuotaResult,
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

/**
 * 券查询 / 重置券（VmActions.openaiQuota）：上游重置券只在查询时返回，不随账号列表持久化，
 * 按账号保存最近一次结果；重置结果不明时保留幂等键，再次点击用同一个键重试，不会重复消费。
 */
export function useGatewayQuota() {
  const qc = useQueryClient()
  const [results, setResults] = useState<Record<string, GatewayQuotaResult>>({})
  const [redeemIds, setRedeemIds] = useState<Record<string, string>>({})
  const refresh = () => qc.invalidateQueries({ queryKey: accountQueryKey })
  const keep = (vm: Vm, next: GatewayQuotaResult) => {
    setResults((current) => ({ ...current, [vm.id]: next }))
    return { reset_credits: next.reset_credits } satisfies OpenaiQuotaPayload
  }
  const openaiQuota: NonNullable<VmActions['openaiQuota']> = {
    refresh: async (vm) => {
      const next = await api<GatewayQuotaResult>(
        `${accountBase}/${vm.id}/quota`,
        { method: 'POST' }
      )
      await refresh()
      return keep(vm, next)
    },
    reset: async (vm) => {
      const redeemId = redeemIds[vm.id]
      try {
        const next = await api<GatewayQuotaResult>(
          `${accountBase}/${vm.id}/reset-credits`,
          {
            method: 'POST',
            body: JSON.stringify({
              credit_id: results[vm.id]?.reset_credits?.credits[0]?.id,
              ...(redeemId ? { redeem_request_id: redeemId } : {}),
            }),
          }
        )
        setRedeemIds(({ [vm.id]: _done, ...rest }) => rest)
        await refresh()
        return keep(vm, next)
      } catch (error) {
        const data = (
          error as { data?: { redeem_request_id?: string; outcome?: string } }
        ).data
        if (data?.outcome === 'unknown' && data.redeem_request_id) {
          const id = data.redeem_request_id
          setRedeemIds((current) => ({ ...current, [vm.id]: id }))
        }
        throw error
      }
    },
  }
  return { openaiQuota, results }
}
