import { useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { Vm, VmKernelSnapshot } from '@/types/panel-vm'
import { useTranslation, Trans } from 'react-i18next'
import { toast } from 'sonner'
import { activateVmCragLicense, isApiError, patchVm } from '@/lib/api'
import { isCodexVm } from '@/lib/vm-kind'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { dashboardQueryOptions } from '@/features/overview/queries'
import {
  CragLicenseEditor,
  CragLicenseSummary,
  cragLicenseErrorMessage,
} from '@/features/vm/crag-license-editor'
import {
  dataplaneHint,
  HOP_TRANSPORT_LABEL,
} from '@/features/vm/dataplane-contract'
import {
  DEFAULT_RESOLVED_ENGINE,
  inferenceEngineLabel,
  inferenceEnginePatchValue,
  normalizeInferenceEngine,
} from '@/features/vm/engine-contract'
import { isRemoteVm, remoteUnsupportedText } from '@/features/vm/placement'
import {
  vmCragLicenseQueryOptions,
  vmQueryOptions,
} from '@/features/vm/queries'
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
  const canEdit = useVmPerms().edit
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
          value={isCodexVm(vm) ? '—' : kernelLabel(vm)}
        />
      </div>
      <p className='mt-3 text-xs leading-relaxed text-muted-foreground'>
        <Trans
          ns='vm'
          i18nKey='engineEditor.kernelHint'
          values={{
            HOP_TRANSPORT_LABEL: HOP_TRANSPORT_LABEL,
            DATAPLANE_HINT: dataplaneHint(),
          }}
          components={{
            part0: <Link to='/wrap' className='underline underline-offset-4' />,
          }}
        />
      </p>
      {canEdit && !isCodexVm(vm) ? (
        <SlotKernelSwitch key={id} id={id} vm={vm} remote={remote} />
      ) : null}
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

function kernelLabel(vm: Vm) {
  if (
    vm.resolved_dataplane === 'crag' &&
    vm.resolved_crag_kernel_version === 'v2'
  )
    return 'CRAG v2'
  if (vm.resolved_dataplane === 'crag') return 'crag legacy'
  if (vm.resolved_dataplane === 'cc') return 'cc-node'
  return 'cli-node'
}

function SlotKernelSwitch({
  id,
  vm,
  remote,
}: {
  id: string
  vm: Vm
  remote: boolean
}) {
  const { t: tVm } = useTranslation('vm')
  const qc = useQueryClient()
  const [pending, setPending] = useState<'wrap' | 'v2' | null>(null)
  const [licenseOpen, setLicenseOpen] = useState(false)
  const [switchAfterActivation, setSwitchAfterActivation] = useState(false)
  const [checkingLicense, setCheckingLicense] = useState(false)
  const [registrationCode, setRegistrationCode] = useState('')
  const kvm = vm.runtime_type === 'kvm'
  const blocked = remote || kvm
  const onV2 =
    vm.resolved_dataplane === 'crag' && vm.resolved_crag_kernel_version === 'v2'
  const onCli =
    vm.resolved_dataplane == null || vm.resolved_dataplane === 'wrap'
  const licenseQuery = useQuery({
    ...vmCragLicenseQueryOptions(id),
    enabled: !blocked,
  })
  const activateLicense = useMutation({
    // Keep the registration code out of cached mutation variables.
    mutationFn: () => activateVmCragLicense(id, registrationCode.trim()),
    onSuccess: async (data) => {
      qc.setQueryData(vmCragLicenseQueryOptions(id).queryKey, data)
      setRegistrationCode('')
      if (!data.license.valid || data.license.status !== 'valid') {
        toast.error(tVm('vm:engineEditor.licenseNotActive'))
        return
      }
      toast.success(tVm('vm:engineEditor.licenseActivated'))
      if (switchAfterActivation && !onV2) setPending('v2')
      await Promise.all([
        qc.invalidateQueries({ queryKey: vmQueryOptions(id).queryKey }),
        qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
      ])
    },
  })

  async function requestV2() {
    setSwitchAfterActivation(true)
    setCheckingLicense(true)
    try {
      const data = await qc.fetchQuery(vmCragLicenseQueryOptions(id))
      if (data.license.valid && data.license.status === 'valid') {
        setPending('v2')
      } else {
        setLicenseOpen(true)
      }
    } catch {
      setLicenseOpen(true)
    } finally {
      setCheckingLicense(false)
    }
  }
  const switchKernel = useMutation({
    mutationFn: (next: 'wrap' | 'v2') =>
      patchVm(
        id,
        next === 'v2'
          ? { dataplane: 'crag', crag_kernel_version: 'v2' }
          : { dataplane: 'wrap', crag_kernel_version: '' }
      ),
    onSuccess: async (_data, next) => {
      toast.success(
        next === 'v2'
          ? tVm('vm:engineEditor.switchedToV2')
          : tVm('vm:engineEditor.switchedToCli')
      )
      setPending(null)
      await Promise.all([
        qc.invalidateQueries({ queryKey: vmQueryOptions(id).queryKey }),
        qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
      ])
    },
    onError: (error: Error) => {
      if (isApiError(error) && error.code.startsWith('license_')) {
        toast.error(cragLicenseErrorMessage(error))
        setLicenseOpen(true)
        setSwitchAfterActivation(true)
        void qc.invalidateQueries({
          queryKey: vmCragLicenseQueryOptions(id).queryKey,
        })
      } else {
        toast.error(error.message)
      }
      setPending(null)
    },
  })
  const busy =
    checkingLicense || switchKernel.isPending || activateLicense.isPending
  return (
    <div className='mt-3 space-y-2'>
      <div className='flex flex-wrap gap-2'>
        <Button
          variant='outline'
          disabled={blocked || busy || onCli}
          onClick={() => setPending('wrap')}
        >
          {tVm('vm:engineEditor.switchToCli')}
        </Button>
        <Button
          variant='outline'
          disabled={blocked || busy || onV2}
          onClick={() => void requestV2()}
        >
          {checkingLicense
            ? tVm('vm:engineEditor.checkingLicense')
            : tVm('vm:engineEditor.switchToV2')}
        </Button>
        {!blocked ? (
          <Button
            variant='outline'
            disabled={busy}
            aria-expanded={licenseOpen}
            aria-controls={`crag-license-${id}`}
            onClick={() => {
              setSwitchAfterActivation(false)
              setLicenseOpen(!licenseOpen)
              setRegistrationCode('')
              activateLicense.reset()
            }}
          >
            {tVm('vm:engineEditor.licenseRenew')}
          </Button>
        ) : null}
      </div>
      <p className='text-xs text-muted-foreground'>
        {tVm('vm:engineEditor.slotKernelNote', { kernel: kernelLabel(vm) })}
      </p>
      {blocked ? (
        <p className='text-xs text-muted-foreground'>
          {remote
            ? tVm('vm:engineEditor.v2RemoteUnsupported', {
                REMOTE_UNSUPPORTED_TEXT: remoteUnsupportedText(),
              })
            : tVm('vm:engineEditor.kvmNoV2')}
        </p>
      ) : null}
      {!blocked ? (
        <div id={`crag-license-${id}`} className='min-w-0 pt-2'>
          {licenseOpen ? (
            <CragLicenseEditor
              data={licenseQuery.data}
              loading={licenseQuery.isFetching}
              loadError={licenseQuery.error}
              activationError={activateLicense.error}
              registrationCode={registrationCode}
              activating={activateLicense.isPending}
              onChange={(code) => {
                setRegistrationCode(code)
                activateLicense.reset()
              }}
              onRefresh={() => {
                void licenseQuery.refetch()
              }}
              onActivate={() => activateLicense.mutate()}
              onClose={() => {
                setLicenseOpen(false)
                setRegistrationCode('')
                setSwitchAfterActivation(false)
                activateLicense.reset()
              }}
            />
          ) : licenseQuery.isError ? (
            <p role='alert' className='text-sm text-destructive'>
              {tVm('vm:engineEditor.licenseLoadRetry', {
                message: cragLicenseErrorMessage(licenseQuery.error),
              })}
            </p>
          ) : licenseQuery.data ? (
            <CragLicenseSummary license={licenseQuery.data.license} />
          ) : (
            <p role='status' className='text-sm text-muted-foreground'>
              {tVm('vm:engineEditor.loadingLicense')}
            </p>
          )}
        </div>
      ) : null}
      <ConfirmDialog
        open={pending != null}
        onOpenChange={(open) => {
          if (!open && !switchKernel.isPending) setPending(null)
        }}
        title={
          pending === 'v2'
            ? tVm('vm:engineEditor.confirmV2Title')
            : tVm('vm:engineEditor.confirmCliTitle')
        }
        desc={
          pending === 'v2'
            ? tVm('vm:engineEditor.confirmV2Desc')
            : tVm('vm:engineEditor.confirmCliDesc')
        }
        cancelBtnText={tVm('common:cancel')}
        confirmText={tVm('vm:engineEditor.confirmSwitch')}
        isLoading={switchKernel.isPending}
        handleConfirm={() => {
          if (pending) switchKernel.mutate(pending)
        }}
      />
    </div>
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
