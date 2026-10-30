import { useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { t as tVm } from '@/i18n'
import type { Vm } from '@/types/panel-vm'
import { RefreshCw, RotateCcw } from 'lucide-react'
import { useTranslation, Trans } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/confirm-dialog'
import {
  dashboardQueryOptions,
  usageQueryOptions,
} from '@/features/overview/queries'
import { ExpiryAt, ResetAt } from '@/features/vm/detail-section-primitives'
import { vmQueryOptions, vmsListQueryOptions } from '@/features/vm/queries'
import { useVmPerms } from '@/features/vm/vm-perms'

type ResetCredit = {
  label?: string
  resets_left?: number
  expires_at?: string
  clears?: string[]
  redeemable?: boolean
}

type ResetSnapshot = {
  eligible?: boolean
  available_count?: number
  credits?: ResetCredit[]
  cooldown_until?: string
  fetched_at?: string
}

type ResetPayload = {
  outcome?: string
  reason?: string
  usage_refreshed?: boolean
  claude_reset_credits?: ResetSnapshot | null
}

const WINDOW_LABEL: Record<string, string> = {
  get five_hour() {
    return tVm('vm:claudeResetActions.5Hours')
  },
  get seven_day() {
    return tVm('vm:claudeResetActions.7Days')
  },
  seven_day_overage_included: 'Fable',
}

const OUTCOME_TEXT: Record<string, string> = {
  get reset() {
    return tVm('vm:claudeResetActions.oneQuotaResetUsed')
  },
  get already_used() {
    return tVm('vm:claudeResetActions.thisResetHasAlreadyBeenUsed')
  },
  get not_limited() {
    return tVm('vm:claudeResetActions.quotaIsNotFullNoResetConsumed')
  },
  get cooldown() {
    return tVm('vm:claudeResetActions.stillCoolingDownNoResetConsumed')
  },
  get ineligible() {
    return tVm('vm:claudeResetActions.thisAccountCannotRedeemResets')
  },
  get unknown() {
    return tVm(
      'vm:claudeResetActions.resultUnconfirmedFurtherRedemptionsPausedForThisOrganization'
    )
  },
}

function windowText(clears: string[] | undefined) {
  return (clears || []).map((item) => WINDOW_LABEL[item] || item).join('、')
}

function useClaudeResetActions(vm: Vm) {
  const { t: tVm } = useTranslation('vm')

  const qc = useQueryClient()
  const [confirm, setConfirm] = useState(false)
  const keyRef = useRef('')
  const credits = vm.claude_reset_credits
  const available = Math.max(0, Number(credits?.available_count) || 0)
  const redeemable =
    credits?.credits?.find((credit) => credit.redeemable) ||
    credits?.credits?.[0]
  const clears = windowText(redeemable?.clears)

  const refreshAll = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: vmQueryOptions(vm.id).queryKey }),
      qc.invalidateQueries({ queryKey: vmsListQueryOptions().queryKey }),
      qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
      qc.invalidateQueries({ queryKey: usageQueryOptions().queryKey }),
    ])
  }

  const queryCredits = useMutation({
    mutationFn: () =>
      api<ResetPayload>(
        `/api/panel/vms/${encodeURIComponent(vm.id)}/claude-reset/query`,
        { method: 'POST' }
      ),
    onSuccess: async (data) => {
      await refreshAll()
      if (data.usage_refreshed === false) {
        toast.warning(tVm('vm:claudeResetActions.usageRefreshFailed'))
        return
      }
      const count = Number(data?.claude_reset_credits?.available_count)
      toast.success(
        Number.isFinite(count)
          ? tVm('vm:claudeResetActions.checkedResetsAvailable', {
              count: count,
            })
          : tVm('vm:claudeResetActions.quotaResetsChecked')
      )
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const redeem = useMutation({
    mutationFn: () =>
      api<ResetPayload>(
        `/api/panel/vms/${encodeURIComponent(vm.id)}/claude-reset/redeem`,
        {
          method: 'POST',
          headers: { 'Idempotency-Key': keyRef.current },
          signal: AbortSignal.timeout(90_000),
        }
      ),
    onSuccess: async (data) => {
      setConfirm(false)
      keyRef.current = ''
      await refreshAll()
      if (data.usage_refreshed === false) {
        toast.warning(tVm('vm:claudeResetActions.usageRefreshFailed'))
        return
      }
      const text =
        OUTCOME_TEXT[data?.outcome || ''] ||
        tVm('vm:claudeResetActions.quotaResetResponseReceived')
      if (data?.outcome === 'reset') toast.success(text)
      else if (data?.outcome === 'unknown') toast.error(text)
      else toast.warning(text)
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const openConfirm = () => {
    if (!keyRef.current) {
      keyRef.current = `claude-reset-${vm.id}-${crypto.randomUUID()}`
    }
    setConfirm(true)
  }

  return {
    available,
    busy: queryCredits.isPending || redeem.isPending,
    clears,
    confirm,
    credits,
    openConfirm,
    queryCredits,
    redeem,
    setConfirm,
  }
}

export function ClaudeResetActions({
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
    clears,
    confirm,
    credits,
    openConfirm,
    queryCredits,
    redeem,
    setConfirm,
  } = useClaudeResetActions(vm)
  const canUse = useVmPerms().credential
  const held = (credits?.credits || []).reduce(
    (sum, credit) => sum + Math.max(0, Number(credit.resets_left) || 0),
    0
  )

  if (!canUse) return null

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-1',
        !compact && 'grid gap-2'
      )}
      data-row-actions
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div
        className={cn(
          'flex flex-wrap items-center',
          compact ? 'gap-1' : 'gap-2'
        )}
      >
        <Button
          size='sm'
          variant={compact ? 'ghost' : 'outline'}
          disabled={busy}
          title={tVm(
            'vm:claudeResetActions.checkNativeClaudeQuotaResetsReadOnlyDoesNot'
          )}
          className={
            compact
              ? 'h-6 gap-1 px-1.5 text-[11px] text-muted-foreground'
              : undefined
          }
          onClick={() => queryCredits.mutate()}
        >
          <RefreshCw
            className={cn('size-3', queryCredits.isPending && 'animate-spin')}
          />
          {queryCredits.isPending
            ? tVm('vm:claudeResetActions.checking')
            : tVm('vm:claudeResetActions.quotaResets', {
                value1: credits ? ` ${available}` : '',
              })}
        </Button>
        <Button
          size='sm'
          variant={compact ? 'ghost' : 'destructive'}
          disabled={busy || available < 1}
          title={
            available < 1
              ? tVm('vm:claudeResetActions.checkClaudeQuotaResetsFirst')
              : tVm('vm:claudeResetActions.use1OfClaudeQuotaResets', {
                  available: available,
                })
          }
          className={
            compact
              ? 'h-6 gap-1 px-1.5 text-[11px] text-muted-foreground disabled:text-muted-foreground/50'
              : undefined
          }
          onClick={openConfirm}
        >
          <RotateCcw
            className={cn('size-3', redeem.isPending && 'animate-spin')}
          />
          {redeem.isPending
            ? tVm('vm:claudeResetActions.applying')
            : tVm('vm:claudeResetActions.quotaReset')}
        </Button>
      </div>
      {credits ? (
        <div
          className={cn(
            'grid min-w-0 gap-1 text-muted-foreground',
            compact ? 'max-w-full text-[10px]' : 'text-[11px]'
          )}
        >
          {(credits.credits || []).map((credit, index) =>
            credit.expires_at ? (
              <p
                className={cn('m-0 truncate', compact && 'max-w-[15rem]')}
                key={`${credit.expires_at}-${index}`}
              >
                <Trans
                  ns='vm'
                  i18nKey='claudeResetActions.creditExpiry'
                  values={{ value1: index + 1 }}
                  components={{
                    part0: <ExpiryAt value={credit.expires_at} />,
                  }}
                />
              </p>
            ) : null
          )}
          {credits.cooldown_until ? (
            <p className='m-0'>
              <Trans
                ns='vm'
                i18nKey='claudeResetActions.cooldownUntil'
                components={{
                  part0: <ResetAt value={credits.cooldown_until} now={now} />,
                }}
              />
            </p>
          ) : null}
          {credits.eligible === false ? (
            <p className='m-0'>
              <Trans
                ns='vm'
                i18nKey='claudeResetActions.thisAccountIsNotEligibleForRedemption'
              />
            </p>
          ) : null}
          {credits.eligible !== false && held > 0 && available < 1 ? (
            <p className='m-0'>
              <Trans
                ns='vm'
                i18nKey='claudeResetActions.resetsRemainButAreCurrentlyUnavailable'
              />
            </p>
          ) : null}
        </div>
      ) : null}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={tVm('vm:claudeResetActions.useOneQuotaReset')}
        desc={tVm(
          clears
            ? 'vm:messages.confirmResetClears'
            : 'vm:messages.confirmReset',
          { available, clears }
        )}
        confirmText={tVm('vm:claudeResetActions.confirmUse')}
        destructive
        isLoading={redeem.isPending}
        handleConfirm={() => redeem.mutate()}
      />
    </div>
  )
}
