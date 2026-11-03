import { type ReactNode } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { Vm, VmKernelSnapshot } from '@/types/panel-vm'
import { useTranslation, Trans } from 'react-i18next'
import { toast } from 'sonner'
import { patchVm } from '@/lib/api'
import { isCodexVm } from '@/lib/vm-kind'
import { Button } from '@/components/ui/button'
import { dashboardQueryOptions } from '@/features/overview/queries'
import {
  dataplaneHint,
  HOP_TRANSPORT_LABEL,
  dataplaneLabel,
} from '@/features/vm/dataplane-contract'
import {
  DEFAULT_RESOLVED_ENGINE,
  inferenceEngineLabel,
  inferenceEnginePatchValue,
  normalizeInferenceEngine,
} from '@/features/vm/engine-contract'
import { isRemoteVm, remoteUnsupportedText } from '@/features/vm/placement'
import { vmQueryOptions } from '@/features/vm/queries'
import { useVmPerms } from '@/features/vm/vm-perms'

export function VmEngineEditor({
  id,
  vm,
  kernel,
}: {
  id: string
  vm: Vm
  kernel?: VmKernelSnapshot | null
}) {
  const { t: tVm } = useTranslation('vm')

  const qc = useQueryClient()
  const configured = normalizeInferenceEngine(
    kernel?.configured_engine ?? vm.inference_engine,
    'auto'
  )
  const resolved = normalizeInferenceEngine(
    kernel?.resolved_engine ?? vm.resolved_inference_engine,
    DEFAULT_RESOLVED_ENGINE
  )
  const active = normalizeInferenceEngine(
    kernel?.active_engine ?? vm.runtime?.engine,
    resolved
  )
  const inherits = configured === 'auto'
  const canEdit = useVmPerms().admin
  const remote = isRemoteVm(vm)
  const status = {
    configured: inferenceEngineLabel(configured),
    resolved: inferenceEngineLabel(resolved),
    active: inferenceEngineLabel(active),
  }
  const inherit = useMutation({
    mutationFn: () =>
      patchVm(id, { inference_engine: inferenceEnginePatchValue('auto') }),
    onSuccess: async () => {
      toast.success(
        tVm('vm:engineEditor.inferenceKernelNowFollowsGlobalSettings')
      )
      await Promise.all([
        qc.invalidateQueries({ queryKey: vmQueryOptions(id).queryKey }),
        qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
      ])
    },
    onError: (error: Error) =>
      toast.error(
        tVm('vm:engineEditor.failedToRestoreGlobalSettings', {
          message: error.message,
        })
      ),
  })

  return (
    <CardSection title={tVm('vm:engineEditor.inferenceKernel')}>
      <div className='grid gap-2 text-sm sm:grid-cols-3'>
        <EngineValue
          label={tVm('vm:codexKernelHealthCard.configured')}
          value={status.configured}
        />
        <EngineValue
          label={tVm('vm:engineEditor.resolved')}
          value={status.resolved}
        />
        <EngineValue
          label={tVm('vm:engineEditor.currentlyRunning')}
          value={status.active}
        />
      </div>
      <div className='mt-3 grid gap-2 text-sm sm:grid-cols-2'>
        <EngineValue
          label={tVm('vm:engineEditor.dataPlane')}
          value={isCodexVm(vm) ? '—' : dataplaneLabel(vm.resolved_dataplane)}
        />
      </div>
      <p className='mt-3 text-xs leading-relaxed text-muted-foreground'>
        <Trans
          ns='vm'
          i18nKey='engineEditor.transportIsFixedToSwitchDataPlanesOnThe'
          values={{
            HOP_TRANSPORT_LABEL: HOP_TRANSPORT_LABEL,
            DATAPLANE_HINT: dataplaneHint(),
          }}
          components={{
            part0: <Link to='/wrap' className='underline underline-offset-4' />,
          }}
        />
      </p>
      {inherits || !canEdit ? null : (
        <Button
          className='mt-3'
          variant='outline'
          disabled={inherit.isPending || remote}
          onClick={() => inherit.mutate()}
        >
          {inherit.isPending
            ? tVm('vm:engineEditor.restoring')
            : tVm('vm:engineEditor.followGlobalSettings')}
        </Button>
      )}
      {remote && canEdit ? (
        <p className='mt-2 text-xs text-muted-foreground'>
          <Trans
            ns='vm'
            i18nKey='engineEditor.switchInferenceKernel'
            values={{ REMOTE_UNSUPPORTED_TEXT: remoteUnsupportedText() }}
          />
        </p>
      ) : null}
    </CardSection>
  )
}

function CardSection({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  useTranslation('vm')

  return (
    <section className='rounded-md border p-4'>
      <h3 className='mb-3 text-sm font-medium'>{title}</h3>
      {children}
    </section>
  )
}

function EngineValue({ label, value }: { label: string; value: string }) {
  useTranslation('vm')

  return (
    <div>
      <div className='text-xs text-muted-foreground'>{label}</div>
      <div className='mt-1 font-medium'>{value}</div>
    </div>
  )
}
