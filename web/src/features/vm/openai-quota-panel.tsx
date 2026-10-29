import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { t as tVm } from '@/i18n'
import type { Vm } from '@/types/panel-vm'
import { useTranslation, Trans } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { fmtUsd } from '@/lib/format'
import { formatWindowSpend } from '@/lib/vm-usage'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { ResetCreditExpiries } from './reset-credit-expiries'
import { dashboardQueryOptions } from '@/features/overview/queries'
import { Meter, ResetAt } from '@/features/vm/detail-section-primitives'
import { vmQueryOptions } from '@/features/vm/queries'
import { useVmPerms } from '@/features/vm/vm-perms'

type QuotaPayload = {
  reset_credits?: {
    available_count?: number
    credits?: Array<{ expires_at?: string }>
    fetched_at?: string
  } | null
  warning?: string
}

export function OpenaiQuotaPanel({
  vm,
  u5,
  u7,
  now,
  cost5 = 0,
  cost7 = 0,
}: {
  vm: Vm
  u5: number
  u7: number
  now: number
  cost5?: number
  cost7?: number
}) {
  const { t: tVm } = useTranslation('vm')

  const qc = useQueryClient()
  const [confirm, setConfirm] = useState(false)
  const canUse = useVmPerms().credential
  const credits = vm.reset_credits
  const available = Math.max(0, Number(credits?.available_count) || 0)

  const refreshAll = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: vmQueryOptions(vm.id).queryKey }),
      qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
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

  const busy = queryQuota.isPending || resetQuota.isPending

  return (
    <div className='grid gap-3'>
      <p className='m-0 text-xs text-muted-foreground'>
        <Trans ns='vm' i18nKey='openaiQuotaPanel.codexQuotaShortWindow' />
      </p>
      <Meter
        label={tVm('vm:detailStatusBoard.5HourUsage')}
        value={u5}
        hint={quotaHint(vm.status_5h, cost5, vm.estimate_5h)}
      />
      <div className='text-[11px] text-muted-foreground'>
        <Trans
          ns='vm'
          i18nKey='openaiQuotaPanel.5HourReset'
          components={{ part0: <ResetAt value={vm.reset_5h} now={now} /> }}
        />
      </div>
      <Meter
        label={tVm('vm:detailStatusBoard.7DayUsage')}
        value={u7}
        hint={quotaHint(vm.status_7d, cost7, vm.estimate_7d)}
      />
      <div className='text-[11px] text-muted-foreground'>
        <Trans
          ns='vm'
          i18nKey='openaiQuotaPanel.7DayReset'
          components={{ part0: <ResetAt value={vm.reset_7d} now={now} /> }}
        />
      </div>
      {canUse ? (
        <div className='flex flex-wrap items-center gap-2'>
          <Button
            size='sm'
            variant='outline'
            disabled={busy}
            onClick={() => queryQuota.mutate()}
          >
            {queryQuota.isPending
              ? tVm('vm:openaiQuotaPanel.checking')
              : tVm('vm:openaiQuotaPanel.checkResetCredits', {
                  value1: credits ? ` ${available}` : '',
                })}
          </Button>
          <Button
            size='sm'
            variant='destructive'
            disabled={busy || available < 1}
            onClick={() => setConfirm(true)}
          >
            {resetQuota.isPending
              ? tVm('vm:openaiQuotaPanel.applying')
              : tVm('vm:openaiQuotaActions.useResetCredit')}
          </Button>
        </div>
      ) : null}
      <ResetCreditExpiries credits={credits?.credits} now={now} />
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

function quotaHint(
  status: unknown,
  cost: number,
  est: Vm['estimate_5h']
): string {
  const bits: string[] = []
  const text = String(status || '').trim()
  if (text) bits.push(text)
  const spend = formatWindowSpend(cost, est)
  if (spend.costText) bits.push(spend.costText)
  if (spend.remainText) bits.push(spend.remainText)
  if (!spend.costText)
    bits.push(tVm('vm:openaiQuotaPanel.total', { value1: fmtUsd(cost, 2) }))
  return bits.join(' · ')
}
