import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { CragLicenseStatus, Vm } from '@/types/panel-vm'
import {
  CheckCircle2,
  Download,
  KeyRound,
  Loader2,
  Power,
  RefreshCw,
  Terminal,
  TriangleAlert,
  X,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { isApiError } from '@/lib/api'
import { panelQueryKeys } from '@/lib/query-keys'
import { cn } from '@/lib/utils'
import { isCodexVm } from '@/lib/vm-kind'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { PageHeader } from '@/components/page-header'
import { QueryGate } from '@/components/query-gate'
import { meQueryOptions } from '@/features/auth/queries'
import { dashboardQueryOptions } from '@/features/overview/queries'
import { isRemoteVm } from '@/features/vm/placement'
import { KernelLicenseDialog } from './license-dialog'
import {
  installKernelTargets,
  kernelCatalogQueryOptions,
  pullKernelRelease,
  type KernelId,
  type KernelInstallItem,
  type KernelTarget,
} from './queries'

const KERNEL_NAMES = {
  'cli-node': 'cli-node',
  crag: /* i18n-exempt "CRAG" -- Licensed kernel product name, identical in every locale. */ 'CRAG',
} as const
const LICENSE_STATUS_KEYS: Record<CragLicenseStatus['status'], string> = {
  valid: 'wrap:licenseValid',
  unlicensed: 'wrap:licenseUnlicensed',
  expired: 'wrap:licenseExpired',
  not_yet_valid: 'wrap:licenseNotYetValid',
  invalid: 'wrap:licenseInvalid',
  unconfigured: 'wrap:licenseUnconfigured',
}
const VM_STATUS_KEYS: Record<string, string> = {
  running: 'wrap:vmRunning',
  stopped: 'wrap:vmStopped',
  created: 'wrap:vmCreated',
  unknown: 'wrap:vmUnknown',
  error: 'wrap:vmError',
}

type InstallProgress = {
  total: number
  completed: number
  activeId: string | null
  results: Record<string, KernelInstallItem>
}

export function WrapSamplePage() {
  const { t } = useTranslation('wrap')
  const qc = useQueryClient()
  const catalog = useQuery(kernelCatalogQueryOptions())
  const dashboard = useQuery(dashboardQueryOptions())
  const me = useQuery(meQueryOptions())
  // /api/panel/kernels* is super_admin-only in the local capability ACL.
  const canEdit = me.data?.role === 'super_admin'
  const [drafts, setDrafts] = useState<Record<string, KernelId>>({})
  const [confirm, setConfirm] = useState<KernelTarget[] | null>(null)
  const [licenseVm, setLicenseVm] = useState<Vm | null>(null)
  const [installing, setInstalling] = useState(false)
  const [job, setJob] = useState<InstallProgress | null>(null)
  const licenseLabel = (status: CragLicenseStatus['status']) =>
    LICENSE_STATUS_KEYS[status]
      ? t(LICENSE_STATUS_KEYS[status])
      : t('wrap:statusUnknown')
  const vmStatusLabel = (status?: string) =>
    status && VM_STATUS_KEYS[status]
      ? t(VM_STATUS_KEYS[status])
      : status || t('wrap:vmUnknown')
  const [pullError, setPullError] = useState<{
    kernel: KernelId
    message: string
  } | null>(null)
  const rows = useMemo<{ vm: Vm; kernel: KernelId }[]>(
    () =>
      (dashboard.data?.vms || [])
        .filter((vm) => !isCodexVm(vm))
        .map((vm) => ({
          vm,
          kernel:
            drafts[vm.id] ??
            (vm.resolved_dataplane === 'crag' ? 'crag' : 'cli-node'),
        })),
    [dashboard.data?.vms, drafts]
  )
  const vmById = useMemo(
    () => new Map(rows.map(({ vm }) => [vm.id, vm])),
    [rows]
  )
  const pull = useMutation({
    mutationFn: (kernel: KernelId) => pullKernelRelease({ kernel }),
    onMutate: () => setPullError(null),
    onSuccess: async (_data, kernel) => {
      await qc.invalidateQueries({
        queryKey: kernelCatalogQueryOptions().queryKey,
      })
      toast.success(t('wrap:packageUpdated', { kernel: KERNEL_NAMES[kernel] }))
    },
    onError: (error: Error, kernel) => {
      const message =
        isApiError(error) && error.code === 'crag_v2_asset_missing'
          ? t('wrap:cragAssetMissing')
          : error.message
      setPullError({ kernel, message })
    },
  })
  const busy = installing || pull.isPending
  const allTargets = rows.map(({ vm, kernel }) => ({ id: vm.id, kernel }))
  const failedCount = job
    ? Object.values(job.results).filter((item) => !item.ok).length
    : 0
  const succeededCount = job
    ? Object.values(job.results).filter((item) => item.ok).length
    : 0
  const missingLicenses = (confirm || []).filter(
    (target) =>
      target.kernel === 'crag' && !catalog.data?.licenses[target.id]?.valid
  )

  function requestInstall(targets: KernelTarget[]) {
    if (!canEdit || busy || !targets.length) return
    const missingPackage = targets.find(
      (target) =>
        !catalog.data?.kernels.some((p) => p.id === target.kernel && p.ready)
    )
    if (missingPackage) {
      toast.error(
        t('wrap:downloadPackageFirst', {
          kernel: KERNEL_NAMES[missingPackage.kernel],
        })
      )
      return
    }
    const unsupported = targets.find((target) => {
      const vm = vmById.get(target.id)
      return (
        target.kernel === 'crag' &&
        vm &&
        (isRemoteVm(vm) || vm.runtime_type === 'kvm')
      )
    })
    if (unsupported) {
      toast.error(
        t('wrap:defaultKernelOnly', {
          name: vmById.get(unsupported.id)?.name || unsupported.id,
        })
      )
      return
    }
    const unlicensed = targets.find(
      (target) =>
        target.kernel === 'crag' && !catalog.data?.licenses[target.id]?.valid
    )
    if (unlicensed && targets.length === 1) {
      const vm = vmById.get(unlicensed.id)
      toast.error(
        t('wrap:cragLicenseRequired', { name: vm?.name || unlicensed.id })
      )
      if (vm) setLicenseVm(vm)
      return
    }
    setConfirm(targets)
  }

  async function runInstall(targets: KernelTarget[]) {
    setConfirm(null)
    setInstalling(true)
    setJob({
      total: targets.length,
      completed: 0,
      activeId: targets[0].id,
      results: {},
    })
    let failures = 0
    try {
      for (let index = 0; index < targets.length; index++) {
        const target = targets[index]
        setJob((previous) =>
          previous ? { ...previous, activeId: target.id } : previous
        )
        let result: KernelInstallItem
        try {
          const report = await installKernelTargets([target])
          const item = report.items.find(
            (entry) => entry.id === target.id && entry.kernel === target.kernel
          )
          result = item || {
            ...target,
            ok: false,
            stopped: false,
            error: t('wrap:noInstallResult'),
          }
          if (result.ok && !result.stopped)
            result = {
              ...result,
              ok: false,
              error: t('wrap:stopNotConfirmed'),
            }
        } catch (error) {
          const data = isApiError(error)
            ? (error.data as { items?: KernelInstallItem[] } | undefined)
            : undefined
          const item = Array.isArray(data?.items)
            ? data.items.find((entry) => entry.id === target.id)
            : undefined
          result = {
            ...target,
            ok: false,
            stopped: item?.stopped === true,
            code: item?.code || (isApiError(error) ? error.code : undefined),
            error:
              item?.error ||
              (error instanceof Error
                ? error.message
                : t('wrap:installFailed')),
          }
        }
        if (!result.ok) failures++
        setJob((previous) =>
          previous
            ? {
                ...previous,
                completed: index + 1,
                results: { ...previous.results, [target.id]: result },
              }
            : previous
        )
      }
      if (failures)
        toast.error(
          t('wrap:installPartial', {
            ok: targets.length - failures,
            total: targets.length,
          })
        )
      else toast.success(t('wrap:installDone', { total: targets.length }))
    } finally {
      setJob((previous) =>
        previous ? { ...previous, activeId: null } : previous
      )
      await Promise.all([
        qc.invalidateQueries({
          queryKey: kernelCatalogQueryOptions().queryKey,
        }),
        qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
        qc.invalidateQueries({ queryKey: panelQueryKeys.vms() }),
      ])
      setInstalling(false)
    }
  }

  return (
    <PageHeader
      title={t('wrap:title')}
      description={t('wrap:description')}
      extra={
        <Button
          variant='ghost'
          className='h-11'
          disabled={busy}
          onClick={() => {
            void catalog.refetch()
            void dashboard.refetch()
          }}
        >
          <RefreshCw aria-hidden='true' />
          {t('wrap:refresh')}
        </Button>
      }
    >
      <QueryGate
        loading={catalog.isLoading || dashboard.isLoading}
        error={catalog.error || dashboard.error}
        skeleton={
          <div className='space-y-6'>
            <Skeleton className='h-48 rounded-xl' />
            <Skeleton className='h-80 rounded-xl' />
          </div>
        }
      >
        <div className='space-y-7 motion-reduce:[&_svg]:animate-none'>
          <section
            aria-label={t('wrap:availableKernels')}
            className='divide-y rounded-xl border bg-card'
          >
            {catalog.data?.kernels.map((product) => (
              <div
                key={product.id}
                className='grid gap-3 p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:px-5'
              >
                <div className='min-w-0'>
                  <div className='flex flex-wrap items-center gap-2.5'>
                    {product.paid ? (
                      <KeyRound
                        aria-hidden='true'
                        className='size-5 text-muted-foreground'
                      />
                    ) : (
                      <Terminal
                        aria-hidden='true'
                        className='size-5 text-muted-foreground'
                      />
                    )}
                    <h3 className='text-lg font-semibold'>
                      {KERNEL_NAMES[product.id]}
                    </h3>
                    <Badge variant='secondary'>
                      {product.paid ? t('wrap:paidBadge') : t('wrap:freeBadge')}
                    </Badge>
                  </div>
                  <div className='mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-base sm:text-sm'>
                    <span
                      className={cn(
                        'inline-flex items-center gap-1.5',
                        product.ready ? 'text-primary' : 'text-muted-foreground'
                      )}
                    >
                      {product.ready ? (
                        <CheckCircle2 aria-hidden='true' className='size-4' />
                      ) : (
                        <TriangleAlert aria-hidden='true' className='size-4' />
                      )}
                      {product.ready
                        ? t('wrap:downloaded')
                        : t('wrap:notReady')}
                    </span>
                    <span className='text-muted-foreground'>
                      {product.version || t('wrap:versionUnknown')}
                    </span>
                  </div>
                  {product.error && !product.ready ? (
                    <p className='mt-2 text-base break-words text-destructive sm:text-sm'>
                      {product.error}
                    </p>
                  ) : null}
                  {pullError?.kernel === product.id ? (
                    <p
                      role='alert'
                      className='mt-2 flex items-start gap-2 text-base text-destructive sm:text-sm'
                    >
                      <TriangleAlert
                        aria-hidden='true'
                        className='mt-0.5 size-4 shrink-0'
                      />
                      <span className='min-w-0 break-words'>
                        {pullError.message}
                      </span>
                    </p>
                  ) : null}
                </div>
                <Button
                  variant='outline'
                  className='h-11'
                  aria-label={t('wrap:pullLatestLabel', {
                    kernel: KERNEL_NAMES[product.id],
                  })}
                  disabled={!canEdit || busy}
                  loading={pull.isPending && pull.variables === product.id}
                  onClick={() => pull.mutate(product.id)}
                >
                  <Download aria-hidden='true' />
                  {t('wrap:pullLatest')}
                </Button>
              </div>
            ))}
          </section>

          <section aria-labelledby='kernel-vms-heading' className='space-y-3'>
            <div className='flex flex-wrap items-end justify-between gap-3'>
              <div>
                <h3 id='kernel-vms-heading' className='text-lg font-semibold'>
                  {t('wrap:vmInstall')}
                </h3>
                <p className='mt-1 text-base text-muted-foreground sm:text-sm'>
                  {t('wrap:vmInstallHint')}
                </p>
              </div>
              <Button
                variant='destructive'
                className='h-11'
                disabled={!canEdit || busy || !rows.length}
                loading={installing && (job?.total || 0) > 1}
                onClick={() => requestInstall(allTargets)}
              >
                <Power aria-hidden='true' />
                {rows.length
                  ? t('wrap:reinstallAllStopCount', { total: rows.length })
                  : t('wrap:reinstallAllStop')}
              </Button>
            </div>

            {job ? (
              <div
                role='status'
                aria-live='polite'
                className='space-y-2 rounded-lg bg-muted/60 p-3'
              >
                <div className='flex flex-wrap items-center justify-between gap-2 text-base sm:text-sm'>
                  <span className='inline-flex items-center gap-2'>
                    {installing ? (
                      <Loader2
                        aria-hidden='true'
                        className='size-4 animate-spin motion-reduce:animate-none'
                      />
                    ) : failedCount ? (
                      <TriangleAlert
                        aria-hidden='true'
                        className='size-4 text-destructive'
                      />
                    ) : (
                      <CheckCircle2
                        aria-hidden='true'
                        className='size-4 text-primary'
                      />
                    )}
                    {installing
                      ? t('wrap:installingProgress', {
                          done: Math.min(
                            job.completed + (job.activeId ? 1 : 0),
                            job.total
                          ),
                          total: job.total,
                        })
                      : failedCount
                        ? t('wrap:finishedSummaryFailed', {
                            ok: succeededCount,
                            failed: failedCount,
                          })
                        : t('wrap:finishedSummary', { ok: succeededCount })}
                  </span>
                  {!installing ? (
                    <Button
                      variant='ghost'
                      className='size-11 p-0'
                      aria-label={t('wrap:dismissResults')}
                      onClick={() => setJob(null)}
                    >
                      <X aria-hidden='true' />
                    </Button>
                  ) : null}
                </div>
                <Progress
                  aria-label={t('wrap:installProgress')}
                  value={(job.completed / job.total) * 100}
                  className='h-1.5'
                />
              </div>
            ) : null}

            {!rows.length ? (
              <div className='rounded-xl border border-dashed py-12 text-center text-muted-foreground'>
                {t('wrap:noClaudeVms')}
                <Link to='/vm' className='ml-2 underline underline-offset-4'>
                  {t('wrap:goCreate')}
                </Link>
              </div>
            ) : (
              <div
                role='table'
                aria-label={t('wrap:vmKernelTable')}
                aria-colcount={4}
                className='overflow-hidden rounded-xl border bg-card'
              >
                <div
                  role='row'
                  className='hidden grid-cols-[minmax(160px,1fr)_minmax(180px,230px)_minmax(160px,1fr)_120px] gap-4 border-b bg-muted/40 px-5 py-3 text-sm text-muted-foreground xl:grid'
                >
                  <div role='columnheader'>{t('wrap:colVm')}</div>
                  <div role='columnheader'>{t('wrap:colKernel')}</div>
                  <div role='columnheader'>{t('wrap:colLicense')}</div>
                  <div role='columnheader' className='text-right'>
                    {t('wrap:colActions')}
                  </div>
                </div>
                <div role='rowgroup' className='divide-y'>
                  {rows.map(({ vm, kernel }) => {
                    const license = catalog.data?.licenses[vm.id]
                    const installed = catalog.data?.installations?.[vm.id]
                    const result = job?.results[vm.id]
                    const active = installing && job?.activeId === vm.id
                    const nativeUnsupported =
                      isRemoteVm(vm) || vm.runtime_type === 'kvm'
                    const currentKernel =
                      vm.resolved_dataplane === 'crag' &&
                      vm.resolved_crag_kernel_version === 'v2'
                        ? 'crag'
                        : vm.resolved_dataplane === 'wrap'
                          ? 'cli-node'
                          : null
                    const changed = kernel !== currentKernel
                    return (
                      <div
                        role='row'
                        key={vm.id}
                        className='grid min-w-0 gap-3 p-4 sm:grid-cols-2 sm:gap-4 xl:grid-cols-[minmax(160px,1fr)_minmax(180px,230px)_minmax(160px,1fr)_120px] xl:items-center xl:px-5'
                      >
                        <div role='cell' className='min-w-0'>
                          <Link
                            to='/vm/$id'
                            params={{ id: vm.id }}
                            className='inline-block min-h-11 max-w-full content-center truncate font-medium underline-offset-4 hover:underline'
                          >
                            {vm.name || vm.id}
                          </Link>
                          <div className='flex flex-wrap items-center gap-2 text-base text-muted-foreground sm:text-sm'>
                            <span
                              className={cn(
                                'size-1.5 rounded-full',
                                vm.status === 'running'
                                  ? 'bg-primary'
                                  : 'bg-muted-foreground/60'
                              )}
                              aria-hidden='true'
                            />
                            {result?.stopped
                              ? t('wrap:vmStopped')
                              : vmStatusLabel(vm.status)}
                            {installed?.version &&
                            installed.kernel === currentKernel ? (
                              <span>{installed.version}</span>
                            ) : null}
                          </div>
                          {result ? (
                            <p
                              className={cn(
                                'mt-2 flex min-w-0 items-start gap-2 text-base break-words sm:text-sm',
                                result.ok ? 'text-primary' : 'text-destructive'
                              )}
                            >
                              {result.ok ? (
                                <CheckCircle2
                                  aria-hidden='true'
                                  className='mt-0.5 size-4 shrink-0'
                                />
                              ) : (
                                <TriangleAlert
                                  aria-hidden='true'
                                  className='mt-0.5 size-4 shrink-0'
                                />
                              )}
                              <span>
                                {result.ok
                                  ? t('wrap:installedStopped')
                                  : result.stopped
                                    ? t('wrap:failedStopped', {
                                        error:
                                          result.error ||
                                          t('wrap:installFailed'),
                                      })
                                    : result.error || t('wrap:installFailed')}
                              </span>
                            </p>
                          ) : null}
                        </div>
                        <div role='cell' className='min-w-0 space-y-1.5'>
                          <span className='text-sm text-muted-foreground xl:hidden'>
                            {t('wrap:colKernel')}
                          </span>
                          <Select
                            value={kernel}
                            disabled={!canEdit || busy}
                            onValueChange={(value) => {
                              if (value === 'cli-node' || value === 'crag')
                                setDrafts((previous) => ({
                                  ...previous,
                                  [vm.id]: value,
                                }))
                            }}
                          >
                            <SelectTrigger
                              className='w-full text-base data-[size=default]:h-11 sm:text-sm'
                              aria-label={t('wrap:kernelSelectLabel', {
                                name: vm.name || vm.id,
                              })}
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent className='motion-reduce:animate-none [&_[role=option]]:min-h-11'>
                              <SelectItem value='cli-node'>
                                {t('wrap:optionCli')}
                              </SelectItem>
                              <SelectItem
                                value='crag'
                                disabled={nativeUnsupported}
                              >
                                {t('wrap:optionCrag')}
                              </SelectItem>
                            </SelectContent>
                          </Select>
                          {changed ? (
                            <span className='text-sm text-muted-foreground'>
                              {t('wrap:pendingInstall')}
                            </span>
                          ) : null}
                        </div>
                        <div
                          role='cell'
                          className='flex min-w-0 flex-wrap items-center gap-2 sm:content-center'
                        >
                          {kernel === 'crag' ? (
                            <>
                              <div className='min-w-0 space-y-1 text-base sm:text-sm'>
                                <div
                                  className={
                                    license?.valid
                                      ? 'text-primary'
                                      : 'text-destructive'
                                  }
                                >
                                  {nativeUnsupported
                                    ? t('wrap:localDockerOnly')
                                    : license
                                      ? licenseLabel(license.status)
                                      : t('wrap:statusUnknown')}
                                </div>
                                {license?.valid && license.expires_at ? (
                                  <div className='text-sm text-muted-foreground tabular-nums'>
                                    {new Date(license.expires_at * 1000)
                                      .toISOString()
                                      .slice(0, 10)}{' '}
                                    UTC
                                  </div>
                                ) : null}
                              </div>
                              <Button
                                variant='ghost'
                                className='h-11'
                                disabled={!canEdit || busy || nativeUnsupported}
                                onClick={() => setLicenseVm(vm)}
                                aria-label={t('wrap:manageLicense', {
                                  name: vm.name || vm.id,
                                })}
                              >
                                <KeyRound aria-hidden='true' />
                                {license?.valid
                                  ? t('wrap:renew')
                                  : t('wrap:activate')}
                              </Button>
                            </>
                          ) : (
                            <span className='text-base text-muted-foreground sm:text-sm'>
                              {t('wrap:noLicenseNeeded')}
                            </span>
                          )}
                        </div>
                        <div
                          role='cell'
                          className='flex items-center justify-end'
                        >
                          <Button
                            variant='outline'
                            className='h-11 w-full sm:w-auto'
                            disabled={
                              !canEdit ||
                              busy ||
                              (kernel === 'crag' && nativeUnsupported)
                            }
                            loading={active}
                            aria-label={t(
                              changed
                                ? 'wrap:installAndStopLabel'
                                : 'wrap:reinstallAndStopLabel',
                              { name: vm.name || vm.id }
                            )}
                            onClick={() =>
                              requestInstall([{ id: vm.id, kernel }])
                            }
                          >
                            <Power aria-hidden='true' />
                            {changed ? t('wrap:install') : t('wrap:reinstall')}
                          </Button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
            {!canEdit ? (
              <p className='text-sm text-muted-foreground'>
                {t('wrap:superAdminOnly')}
              </p>
            ) : null}
          </section>
        </div>
      </QueryGate>
      <ConfirmDialog
        open={confirm != null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null)
        }}
        title={
          confirm?.length === 1
            ? t('wrap:confirmReinstallOne', {
                name: vmById.get(confirm[0].id)?.name || confirm[0].id,
              })
            : t('wrap:confirmReinstallAllVms', { total: confirm?.length || 0 })
        }
        desc={t('wrap:confirmReinstallDescription')}
        confirmText={t('wrap:reinstallAndStop')}
        cancelBtnText={t('wrap:cancel')}
        disabled={missingLicenses.length > 0}
        destructive
        className='motion-reduce:animate-none [&_button]:min-h-11'
        handleConfirm={() => {
          if (confirm) void runInstall(confirm)
        }}
      >
        <ul className='max-h-56 space-y-2 overflow-y-auto rounded-lg bg-muted/50 p-3 text-sm'>
          {confirm?.map((target) => (
            <li
              key={target.id}
              className='flex items-center justify-between gap-3'
            >
              <span className='min-w-0 truncate'>
                {vmById.get(target.id)?.name || target.id}
              </span>
              <span className='shrink-0 font-medium'>
                {target.kernel === 'crag' &&
                !catalog.data?.licenses[target.id]?.valid
                  ? t('wrap:kernelPendingLicense', {
                      kernel: KERNEL_NAMES[target.kernel],
                    })
                  : KERNEL_NAMES[target.kernel]}
              </span>
            </li>
          ))}
        </ul>
        {missingLicenses.length ? (
          <p role='alert' className='text-sm text-destructive'>
            {t('wrap:missingLicenses', { total: missingLicenses.length })}
          </p>
        ) : null}
      </ConfirmDialog>
      {licenseVm ? (
        <KernelLicenseDialog
          key={licenseVm.id}
          vm={licenseVm}
          onClose={() => setLicenseVm(null)}
        />
      ) : null}
    </PageHeader>
  )
}
