import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { RefreshCw, RotateCcw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { ResetCreditExpiries } from './reset-credit-expiries'
import { dashboardQueryOptions } from '@/features/overview/queries'
import { usageQueryOptions } from '@/features/overview/queries'
import { vmQueryOptions, vmsListQueryOptions } from '@/features/vm/queries'
import { useVmPerms } from '@/features/vm/vm-perms'

type QuotaPayload = {
  reset_credits?: {
    available_count?: number
    credits?: Array<{ expires_at?: string }>
  } | null
  warning?: string
}

function useOpenaiQuotaActions(vm: Vm) {
  const { t: tVm } = useTranslation('vm')

  const qc = useQueryClient()
  const [confirm, setConfirm] = useState(false)
  const credits = vm.reset_credits
  const available = Math.max(0, Number(credits?.available_count) || 0)

  const refreshAll = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: vmQueryOptions(vm.id).queryKey }),
      qc.invalidateQueries({ queryKey: vmsListQueryOptions().queryKey }),
      qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
      qc.invalidateQueries({ queryKey: usageQueryOptions().queryKey }),
    ])
  }

  const queryQuota = useMutation({
    mutationFn: () =>
      api<QuotaPayload>(
        `/api/panel/vms/${encodeURIComponent(vm.id)}/openai-quota/refresh`,
        { method: 'POST' }
      ),
    onSuccess: async (data) => {
      await refreshAll()
      const count = Number(data?.reset_credits?.available_count)
      toast.success(
        Number.isFinite(count)
          ? tVm('vm:openaiQuotaActions.checkedResetCreditsAvailable', {
              count: count,
            })
          : tVm('vm:openaiQuotaActions.gPTQuotaRefreshed')
      )
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const resetQuota = useMutation({
    mutationFn: () =>
      api<QuotaPayload>(
        `/api/panel/vms/${encodeURIComponent(vm.id)}/openai-quota/reset`,
        { method: 'POST', signal: AbortSignal.timeout(90_000) }
      ),
    onSuccess: async (data) => {
      setConfirm(false)
      await refreshAll()
      if (data?.warning === 'reset_credit_cache_refresh_failed') {
        toast.warning(
          tVm('vm:openaiQuotaActions.resetCreditConsumedButQuotaCouldNotBeRead')
        )
        return
      }
      toast.success(tVm('vm:openaiQuotaActions.oneResetCreditUsed'))
    },
    onError: (error: Error) => toast.error(error.message),
  })

  return {
    available,
    confirm,
    credits,
    queryQuota,
    resetQuota,
    setConfirm,
    busy: queryQuota.isPending || resetQuota.isPending,
  }
}

export function OpenaiQuotaActions({
  vm,
  compact = false,
  now = Date.now(),
}: {
  vm: Vm
  compact?: boolean
  now?: number
}) {
  const { t: tVm } = useTranslation('vm')

  const {
    available,
    busy,
    confirm,
    credits,
    queryQuota,
    resetQuota,
    setConfirm,
  } = useOpenaiQuotaActions(vm)
  const canUse = useVmPerms().credential

  if (!canUse) return null

  return (
    <div
      className={cn('flex flex-wrap items-center gap-1', !compact && 'gap-2')}
      data-row-actions
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <Button
        size='sm'
        variant={compact ? 'ghost' : 'outline'}
        disabled={busy}
        title={tVm('vm:openaiQuotaActions.checkUpstreamQuotaAndResetCredits')}
        className={
          compact
            ? 'h-6 gap-1 px-1.5 text-[11px] text-muted-foreground'
            : undefined
        }
        onClick={() => queryQuota.mutate()}
      >
        <RefreshCw
          className={cn('size-3', queryQuota.isPending && 'animate-spin')}
        />
        {queryQuota.isPending
          ? tVm('vm:claudeResetActions.checking')
          : tVm('vm:openaiQuotaActions.resetCredits', {
              value1: credits ? ` ${available}` : '',
            })}
      </Button>
      <ResetCreditExpiries credits={credits?.credits} now={now} />
      <Button
        size='sm'
        variant={compact ? 'ghost' : 'destructive'}
        disabled={busy || available < 1}
        title={
          available < 1
            ? tVm('vm:openaiQuotaActions.checkResetCreditsFirst')
            : tVm('vm:openaiQuotaActions.use1OfUpstreamResetCredits', {
                available: available,
              })
        }
        className={
          compact
            ? 'h-6 gap-1 px-1.5 text-[11px] text-muted-foreground disabled:text-muted-foreground/50'
            : undefined
        }
        onClick={() => setConfirm(true)}
      >
        <RotateCcw
          className={cn('size-3', resetQuota.isPending && 'animate-spin')}
        />
        {resetQuota.isPending
          ? tVm('vm:claudeResetActions.applying')
          : compact
            ? tVm('vm:openaiQuotaActions.resetCredit')
            : tVm('vm:openaiQuotaActions.useResetCredit')}
      </Button>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={tVm('vm:openaiQuotaActions.useOneResetCredit')}
        desc={tVm(
          'vm:openaiQuotaActions.thisConsumes1OfUpstreamResetCreditsItCannot',
          { available: available }
        )}
        confirmText={tVm('vm:claudeResetActions.confirmUse')}
        destructive
        isLoading={resetQuota.isPending}
        handleConfirm={() => resetQuota.mutate()}
      />
    </div>
  )
}
