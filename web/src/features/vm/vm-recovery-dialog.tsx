import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { Check, CircleAlert, Loader2, Minus, X } from 'lucide-react'
import { useTranslation, Trans } from 'react-i18next'
import { toast } from 'sonner'
import { api, isApiError } from '@/lib/api'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { SlotIdentity } from '@/components/platform-chip'
import { dashboardQueryOptions } from '@/features/overview/queries'
import { vmQueryOptions, vmsListQueryOptions } from '@/features/vm/queries'
import { vmDiagnoseQueryOptions } from '@/features/vm/use-vm-recovery'
import {
  diagnosisCheckLabel,
  recoveryStepLabel,
  firstFailingCheck,
  firstRecoverFailure,
  type CheckStatus,
  type Diagnosis,
  type DiagnosisCheck,
  type RecoverReport,
  type RecoverStep,
} from '@/features/vm/vm-recovery-types'

const CHECK_TONE: Record<CheckStatus, { icon: typeof Check; color: string }> = {
  ok: { icon: Check, color: 'var(--status-ok)' },
  warn: { icon: CircleAlert, color: 'var(--status-warn)' },
  error: { icon: X, color: 'var(--status-bad)' },
  skip: { icon: Minus, color: 'var(--status-none)' },
}

function toastApiError(error: Error) {
  const code = isApiError(error) ? error.code : ''
  toast.error(code ? `${error.message} [${code}]` : error.message)
}

function CheckRow({ check }: { check: DiagnosisCheck }) {
  useTranslation('vm')

  const tone = CHECK_TONE[check.status] ?? CHECK_TONE.skip
  const Icon = tone.icon
  return (
    <li className='flex min-w-0 items-start gap-2 text-sm'>
      <Icon
        className='mt-0.5 size-3.5 shrink-0'
        style={{ color: tone.color }}
        aria-hidden='true'
      />
      <div className='min-w-0 flex-1'>
        <div className='flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5'>
          <span className='font-medium'>{diagnosisCheckLabel(check)}</span>
          {check.code ? (
            <span className='font-mono text-xs text-muted-foreground'>
              {check.code}
            </span>
          ) : null}
        </div>
        <p className='text-xs break-words text-muted-foreground'>
          {check.message}
        </p>
      </div>
    </li>
  )
}

function DiagnosisList({ diagnosis }: { diagnosis: Diagnosis }) {
  useTranslation('vm')

  return (
    <ul className='space-y-2'>
      {diagnosis.checks.map((check) => (
        <CheckRow key={check.id} check={check} />
      ))}
    </ul>
  )
}

function StepRow({ step }: { step: RecoverStep }) {
  useTranslation('vm')

  const Icon = step.ok ? Check : X
  const color = step.ok ? 'var(--status-ok)' : 'var(--status-bad)'
  return (
    <li className='flex min-w-0 items-start gap-2 text-sm'>
      <Icon
        className='mt-0.5 size-3.5 shrink-0'
        style={{ color }}
        aria-hidden='true'
      />
      <div className='min-w-0 flex-1'>
        <div className='flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5'>
          <span className='font-medium'>{recoveryStepLabel(step)}</span>
          {step.code ? (
            <span className='font-mono text-xs text-muted-foreground'>
              {step.code}
            </span>
          ) : null}
          <span className='ms-auto shrink-0 text-xs text-muted-foreground tabular-nums'>
            {step.ms}ms
          </span>
        </div>
        <p className='text-xs break-words text-muted-foreground'>
          {step.message}
        </p>
      </div>
    </li>
  )
}

export function VmRecoveryDialog({
  vm,
  open,
  onOpenChange,
}: {
  vm: Vm | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t: tVm } = useTranslation('vm')

  const qc = useQueryClient()
  const vmId = vm?.id ?? ''
  const [report, setReport] = useState<RecoverReport | null>(null)
  const diagnose = useQuery(vmDiagnoseQueryOptions(vmId, open && !!vmId))

  useEffect(() => {
    setReport(null)
  }, [open, vmId])

  const recover = useMutation({
    mutationFn: (id: string) =>
      api<RecoverReport>(`/api/panel/vms/${encodeURIComponent(id)}/recover`, {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    onSuccess: async (data) => {
      if (data.vm_id === vmId) setReport(data)
      qc.setQueryData(
        vmDiagnoseQueryOptions(data.vm_id).queryKey,
        data.diagnosis
      )
      await Promise.all([
        qc.invalidateQueries({ queryKey: vmsListQueryOptions().queryKey }),
        qc.invalidateQueries({
          queryKey: vmQueryOptions(data.vm_id).queryKey,
        }),
        qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
      ])
      if (data.ok) {
        toast.success(
          tVm('vm:vmRecoveryDialog.serviceRecoveredMs', {
            duration_ms: data.duration_ms,
          })
        )
        return
      }
      const fail = firstRecoverFailure(data)
      toast.error(
        fail.code
          ? tVm('vm:vmRecoveryDialog.recoveryFailed', {
              code: fail.code,
              message: fail.message,
            })
          : tVm('vm:vmRecoveryDialog.recoveryFailedAlternative', {
              message: fail.message,
            })
      )
    },
    onError: (error: Error) => toastApiError(error),
  })

  const diagnosis = report?.diagnosis ?? diagnose.data
  const failing = diagnosis ? firstFailingCheck(diagnosis) : null
  const summary = !diagnosis
    ? null
    : diagnosis.ok
      ? tVm('vm:vmRecoveryDialog.healthy')
      : failing
        ? diagnosisCheckLabel(failing)
        : tVm('vm:proxyHealth.abnormal')
  const summaryColor = !diagnosis
    ? undefined
    : diagnosis.ok
      ? 'var(--status-ok)'
      : failing?.status === 'warn'
        ? 'var(--status-warn)'
        : 'var(--status-bad)'
  const pending = recover.isPending
  const busy = pending || diagnose.isFetching

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='flex max-h-[88vh] flex-col gap-3 sm:max-w-lg'>
        <DialogHeader>
          <DialogTitle className='flex items-center gap-2 text-base'>
            <Trans
              ns='vm'
              i18nKey='vmRecoveryDialog.recoverService'
              components={{
                part0: <>{vm ? <SlotIdentity vm={vm} compact /> : null}</>,
              }}
            />
          </DialogTitle>
          <DialogDescription>
            <Trans
              ns='vm'
              i18nKey='vmRecoveryDialog.checkTheSlotConnectionAndRestartServicesIfNeeded'
            />
          </DialogDescription>
        </DialogHeader>
        <div className='-me-3 min-h-0 flex-1 space-y-3 overflow-y-auto pe-3'>
          {summary ? (
            <p className='text-sm'>
              <Trans
                ns='vm'
                i18nKey='vmRecoveryDialog.checkResult'
                values={{ summary: summary }}
                components={{
                  part0: (
                    <span
                      className='font-medium'
                      style={{ color: summaryColor }}
                    />
                  ),
                }}
              />
            </p>
          ) : diagnose.isLoading ? (
            <p className='flex items-center gap-1.5 text-sm text-muted-foreground'>
              <Trans
                ns='vm'
                i18nKey='vmRecoveryDialog.checkingSlotService'
                components={{
                  part0: <Loader2 className='size-3.5 animate-spin' />,
                }}
              />
            </p>
          ) : null}
          {diagnose.isError ? (
            <p className='text-sm text-[color:var(--status-bad)]'>
              {(diagnose.error as Error).message}
            </p>
          ) : null}
          {diagnosis ? <DiagnosisList diagnosis={diagnosis} /> : null}
          {report ? (
            <div className='space-y-2'>
              <p className='text-xs font-medium text-muted-foreground'>
                <Trans
                  ns='vm'
                  i18nKey='vmRecoveryDialog.recoveryStepsMs'
                  values={{ duration_ms: report.duration_ms }}
                  components={{
                    part0: <span className='ms-2 font-normal tabular-nums' />,
                  }}
                />
              </p>
              <ul className='space-y-2'>
                {report.steps.map((step) => (
                  <StepRow key={step.id} step={step} />
                ))}
              </ul>
            </div>
          ) : null}
          {pending ? (
            <p className='flex items-center gap-1.5 text-sm text-muted-foreground'>
              <Trans
                ns='vm'
                i18nKey='vmRecoveryDialog.stoppingAndRestartingServicesThisTakesAbout3060'
                components={{
                  part0: <Loader2 className='size-3.5 animate-spin' />,
                }}
              />
            </p>
          ) : null}
          <p className='text-xs text-[color:var(--status-warn)]'>
            <Trans
              ns='vm'
              i18nKey='vmRecoveryDialog.recoveringTheServiceInterruptsOngoingConversationsOnThisSlot'
            />
          </p>
        </div>
        <DialogFooter>
          <Button
            variant='outline'
            disabled={!vmId || busy}
            onClick={() => {
              setReport(null)
              void diagnose.refetch()
            }}
          >
            <Trans ns='vm' i18nKey='vmRecoveryDialog.recheck' />
          </Button>
          <Button
            disabled={!vmId || pending}
            loading={pending}
            onClick={() => recover.mutate(vmId)}
          >
            <Trans ns='vm' i18nKey='vmRecoveryDialog.recoverServiceStopStart' />
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
