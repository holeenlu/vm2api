import { useMemo, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { Vm } from '@/types/panel-vm'
import { useTranslation, Trans } from 'react-i18next'
import { toast } from 'sonner'
import { fmtBytes } from '@/lib/format'
import { cn } from '@/lib/utils'
import { isCodexVm } from '@/lib/vm-kind'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { EmptyState } from '@/components/empty-state'
import { PageHeader } from '@/components/page-header'
import { CardGridSkeleton } from '@/components/page-skeletons'
import { QueryGate } from '@/components/query-gate'
import { SearchSelect } from '@/components/search-select'
import { dashboardQueryOptions } from '@/features/overview/queries'
import { dataplaneLabel } from '@/features/vm/dataplane-contract'
import {
  inferenceEngineLabel,
  normalizeInferenceEngine,
} from '@/features/vm/engine-contract'
import {
  installReleaseKernel,
  makeWrapSample,
  promoteWrapSample,
  setKernelDataplane,
  syncWrapSample,
  uploadCragKernelBinary,
  uploadKernelBinary,
  wrapSampleQueryOptions,
  type WrapKernelPayload,
  type WrapSyncReport,
} from '@/features/wrap/queries'
import {
  slotFailureLabel,
  syncItemFailed,
  syncReportFromError,
  syncReportSummary,
} from './sync-report'

const MAX_KERNEL_UPLOAD_BYTES = 32 * 1024 * 1024

function sampleDirLabel(dir?: string) {
  if (!dir) return 'share/wrap-cli'
  const parts = dir.replace(/\\/g, '/').split('/')
  const i = parts.lastIndexOf('share')
  if (i >= 0) return parts.slice(i).join('/')
  return parts.slice(-2).join('/')
}

function kernelPathLabel(p?: string) {
  if (!p) return '—'
  const parts = p.replace(/\\/g, '/').split('/')
  const i = Math.max(
    parts.lastIndexOf('bin'),
    parts.lastIndexOf('wrap-cli'),
    parts.lastIndexOf('crag')
  )
  if (i >= 0) return parts.slice(i).join('/')
  return parts.slice(-2).join('/')
}

function osOf(vm: Vm) {
  const runtime = vm.runtime && typeof vm.runtime === 'object' ? vm.runtime : {}
  const os = String(runtime.os || runtime.image || vm.kernel || '').trim()
  return os || '—'
}

function engineOf(vm: Vm) {
  return vm.resolved_inference_engine || vm.inference_engine || 'auto'
}

function selectedDataplane(
  value: string | null | undefined
): 'wrap' | 'cc' | 'crag' {
  return value === 'cc' || value === 'crag' ? value : 'wrap'
}

function dataplaneOf(vm: Vm): 'wrap' | 'cc' | 'crag' | '—' {
  if (isCodexVm(vm)) return '—'
  return selectedDataplane(vm.resolved_dataplane)
}

function DataplaneOption({
  value,
  title,
  desc,
  current,
  disabled,
  children,
}: {
  value: 'wrap' | 'cc' | 'crag'
  title: string
  desc: string
  current: boolean
  disabled?: boolean
  children?: ReactNode
}) {
  const { t } = useTranslation('wrap')

  return (
    <div
      className={cn(
        'rounded-lg border border-border/60 transition-colors',
        current && 'border-primary/50 bg-primary/5',
        disabled && 'opacity-60'
      )}
    >
      <Label
        className={cn(
          'flex items-start gap-3 p-4 font-normal',
          disabled ? 'cursor-not-allowed' : 'cursor-pointer'
        )}
      >
        <RadioGroupItem value={value} className='mt-0.5' disabled={disabled} />
        <span className='min-w-0 flex-1 space-y-2'>
          <span className='flex items-center justify-between gap-2'>
            <span className='text-sm leading-none font-medium'>{title}</span>
            {current ? (
              <span className='text-xs text-muted-foreground'>
                {t('wrap:current')}
              </span>
            ) : null}
          </span>
          <span className='block text-xs leading-snug text-muted-foreground'>
            {desc}
          </span>
        </span>
      </Label>
      <div className='space-y-3 px-4 pb-4'>{children}</div>
    </div>
  )
}

type HopJob = {
  phase: 'download' | 'slots' | 'done'
  done: number
  total: number
  current: string
  failed: string[]
}

function hopProgressValue(job: HopJob) {
  if (job.phase === 'download') return 8
  if (!job.total) return 0
  return Math.round((job.done / job.total) * 100)
}

function slotSyncFailed(report: WrapSyncReport, id: string) {
  const item = report.items?.find((row) => row.id === id) || report.items?.[0]
  if (!item) return report.ok === false
  return syncItemFailed(item)
}

function slotFailure(report: WrapSyncReport, id: string) {
  const item = report.items?.find((row) => row.id === id) || report.items?.[0]
  return item ? slotFailureLabel({ ...item, id }) : id
}

function HopProgress({ job }: { job: HopJob }) {
  const { t } = useTranslation('wrap')

  const label =
    job.phase === 'download'
      ? t('wrap:fetchProgress')
      : job.phase === 'done'
        ? job.failed.length
          ? t('wrap:reinstallDoneFailed', { count: job.failed.length })
          : t('wrap:reinstallDone', { done: job.done, count: job.total })
        : t('wrap:reinstallProgress', { slot: job.current || t('wrap:slot') })
  return (
    <div className='space-y-1.5'>
      <div className='flex items-center justify-between gap-3 text-xs text-muted-foreground'>
        <span>{label}</span>
        <span>
          {job.phase === 'download'
            ? t('wrap:downloading')
            : `${job.done}/${job.total}`}
        </span>
      </div>
      <Progress
        value={hopProgressValue(job)}
        className='h-2'
        indicatorClassName={job.phase === 'done' ? undefined : 'animate-pulse'}
      />
      {job.failed.length ? (
        <p className='text-xs text-destructive'>
          {t('wrap:failedSlots', { slots: job.failed.join(', ') })}
        </p>
      ) : null}
    </div>
  )
}

function Flag({ ok, label }: { ok?: boolean; label: string }) {
  const { t } = useTranslation('wrap')

  return (
    <div className='flex items-center justify-between gap-2 text-sm'>
      <span className='text-muted-foreground'>{label}</span>
      <span className={ok ? 'text-foreground' : 'text-destructive'}>
        {ok ? t('wrap:present') : t('wrap:missing')}
      </span>
    </div>
  )
}

function KernelPayload({
  payload,
  kind = 'kernel',
}: {
  payload?: WrapKernelPayload | null
  kind?: 'kernel' | 'cli'
}) {
  const { t } = useTranslation('wrap')

  const label =
    payload?.source === 'configured'
      ? t('wrap:repositoryKernel')
      : payload?.source === 'sample'
        ? kind === 'cli'
          ? t('wrap:repositoryCli')
          : t('wrap:sampleKernel')
        : kind === 'cli'
          ? t('wrap:cliNotFound')
          : t('wrap:kernelNotFound')
  return (
    <div className='space-y-2 text-sm'>
      <div className='flex items-center justify-between gap-2'>
        <span className='text-muted-foreground'>{t('wrap:source')}</span>
        <span className='font-medium'>{label}</span>
      </div>
      <div className='flex items-center justify-between gap-2'>
        <span className='text-muted-foreground'>{t('wrap:file')}</span>
        <code className='text-xs'>{kernelPathLabel(payload?.path)}</code>
      </div>
      <div className='flex items-center justify-between gap-2'>
        <span className='text-muted-foreground'>{t('wrap:size')}</span>
        <span className='font-mono text-xs'>
          {payload?.size ? fmtBytes(payload.size) : '—'}
        </span>
      </div>
      <div className='flex items-center justify-between gap-2'>
        <span className='text-muted-foreground'>mtime</span>
        <span className='font-mono text-xs'>{payload?.mtime || '—'}</span>
      </div>
    </div>
  )
}

export function WrapSamplePage() {
  const { t } = useTranslation('wrap')

  const qc = useQueryClient()
  const sample = useQuery(wrapSampleQueryOptions())
  const dash = useQuery(dashboardQueryOptions())
  const vms = useMemo<Vm[]>(() => dash.data?.vms || [], [dash.data?.vms])
  const [restart, setRestart] = useState(true)
  const [selected, setSelected] = useState<string[]>([])
  const [pendingDataplane, setPendingDataplane] = useState<
    'wrap' | 'cc' | 'crag' | null
  >(null)
  const [promoteId, setPromoteId] = useState<string | null>(null)
  const [makeOpen, setMakeOpen] = useState(false)
  const [glibcVm, setGlibcVm] = useState('')
  const [uploadFile, setUploadFile] = useState<File | null>(null)
  const [releaseOpen, setReleaseOpen] = useState(false)
  const [hopOpen, setHopOpen] = useState(false)
  const [hopIds, setHopIds] = useState<string[]>([])
  const [pullLatest, setPullLatest] = useState(true)
  const [hopJob, setHopJob] = useState<HopJob | null>(null)
  const [hopBusy, setHopBusy] = useState(false)
  const hopToken = useRef(0)
  const fileRef = useRef<HTMLInputElement>(null)

  const rustVms = useMemo(
    () => vms.filter((vm) => engineOf(vm) === 'rust'),
    [vms]
  )
  const reinstallIds = selected.length ? selected : vms.map((vm) => vm.id)

  const invalidate = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: wrapSampleQueryOptions().queryKey }),
      qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
    ])
  }

  const openHop = (ids: string[], pull: boolean) => {
    setHopIds(ids)
    setPullLatest(pull)
    setHopOpen(true)
  }

  const runHop = async (ids: string[], pull: boolean) => {
    if (!ids.length || hopBusy) return
    const token = hopToken.current + 1
    hopToken.current = token
    const alive = () => hopToken.current === token
    setHopBusy(true)
    setHopJob({
      phase: pull ? 'download' : 'slots',
      done: 0,
      total: ids.length,
      current: ids[0] || '',
      failed: [],
    })
    const failed: string[] = []
    try {
      if (pull) {
        await installReleaseKernel({ ids: [], restart: false })
        if (!alive()) return
      }
      for (let i = 0; i < ids.length; i++) {
        if (!alive()) return
        const id = ids[i]
        setHopJob({
          phase: 'slots',
          done: i,
          total: ids.length,
          current: id,
          failed: [...failed],
        })
        try {
          const report = await syncWrapSample({ ids: [id], restart })
          if (slotSyncFailed(report, id)) failed.push(slotFailure(report, id))
        } catch (error) {
          const report = syncReportFromError(error)
          failed.push(
            report
              ? slotFailure(report, id)
              : t('wrap:slotFailure', {
                  id,
                  reason:
                    error instanceof Error ? error.message : t('wrap:failed'),
                })
          )
        }
      }
      if (!alive()) return
      setHopJob({
        phase: 'done',
        done: ids.length,
        total: ids.length,
        current: '',
        failed: [...failed],
      })
      if (failed.length) {
        toast.error(
          t('wrap:reinstalledCount', {
            done: ids.length - failed.length,
            count: ids.length,
          })
        )
      } else {
        toast.success(
          t('wrap:reinstalledCount', { done: ids.length, count: ids.length })
        )
      }
      await invalidate()
    } catch (error) {
      if (!alive()) return
      toast.error(
        error instanceof Error ? error.message : t('wrap:reinstallFailed')
      )
      setHopJob((cur) =>
        cur
          ? {
              ...cur,
              phase: 'done',
              failed: failed.length ? failed : [t('wrap:download')],
            }
          : cur
      )
    } finally {
      if (alive()) setHopBusy(false)
    }
  }

  const promote = useMutation({
    mutationFn: (id: string) => promoteWrapSample(id),
    onSuccess: async (_data, id) => {
      toast.success(t('wrap:promoted', { id }))
      setPromoteId(null)
      await invalidate()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const make = useMutation({
    mutationFn: () => makeWrapSample({ glibc_vm: glibcVm || undefined }),
    onSuccess: async () => {
      toast.success(t('wrap:wrapRebuilt'))
      setMakeOpen(false)
      await invalidate()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const upload = useMutation({
    mutationFn: (file: File) => uploadKernelBinary(file),
    onSuccess: async () => {
      toast.success(t('wrap:wrapUploaded'))
      setUploadFile(null)
      await invalidate()
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const releaseUpdate = useMutation({
    mutationFn: () => installReleaseKernel({ ids: [], restart: false }),
    onSuccess: async (result) => {
      setReleaseOpen(false)
      const tag = result.release?.tag || 'Release'
      const cli = result.release?.cli_node_size
        ? `, cli-node ${fmtBytes(result.release.cli_node_size)}`
        : ''
      const cc = result.release?.cc_node_size
        ? `, cc-node ${fmtBytes(result.release.cc_node_size)}`
        : ''
      const crag = result.release?.crag_size
        ? `, crag ${fmtBytes(result.release.crag_size)}`
        : ''
      toast.success(
        t('wrap:downloadedRelease', { release: tag + cli + cc + crag })
      )
      await invalidate()
    },
    onError: async (error: Error) => {
      const report = syncReportFromError(error)
      toast.error(
        report
          ? `${error.message}：${syncReportSummary(report)}`
          : error.message
      )
      if (report) {
        setReleaseOpen(false)
        await invalidate()
      }
    },
  })
  const dataplane = useMutation({
    mutationFn: (next: 'wrap' | 'cc' | 'crag') => {
      const ids = selected.filter((id) => {
        const vm = vms.find((item) => item.id === id)
        return Boolean(vm && !isCodexVm(vm))
      })
      if (selected.length && !ids.length) {
        return Promise.reject(new Error(t('wrap:onlyCodexSelected')))
      }
      return setKernelDataplane({
        dataplane: next,
        ids: ids.length ? ids : undefined,
        all: ids.length === 0,
        restart,
      })
    },
    onSuccess: async (report, next) => {
      setPendingDataplane(null)
      const failed = Number(report.failed_count || 0)
      if (failed) {
        toast.error(
          t('wrap:switchedSummary', {
            dataplane: next,
            summary: syncReportSummary(report),
          })
        )
      } else {
        toast.success(
          next === 'crag'
            ? t('wrap:switchedCrag')
            : next === 'cc'
              ? t('wrap:switchedCc')
              : t('wrap:switchedWrap')
        )
      }
    },
    onError: (error: Error, next) => {
      // 部分槽失败时网关回 400/503，正文仍带逐槽结果；数据面已经写入，按部分成功处理。
      const report = syncReportFromError(error)
      if (report) {
        setPendingDataplane(null)
        toast.error(
          t('wrap:switchedSummary', {
            dataplane: next,
            summary: syncReportSummary(report),
          })
        )
      } else {
        toast.error(error.message)
      }
    },
    onSettled: () => invalidate(),
  })
  const uploadCrag = useMutation({
    mutationFn: (file: File) => uploadCragKernelBinary(file),
    onSuccess: async () => {
      toast.success(t('wrap:cragUploaded'))
      await invalidate()
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const cragFileRef = useRef<HTMLInputElement>(null)

  const toggle = (id: string, on: boolean) => {
    setSelected((cur) =>
      on ? Array.from(new Set([...cur, id])) : cur.filter((x) => x !== id)
    )
  }

  const pickKernelFile = (file?: File) => {
    if (!file) return
    if (file.size > MAX_KERNEL_UPLOAD_BYTES) {
      toast.error(t('wrap:uploadTooLarge'))
      return
    }
    if (!file.size) {
      toast.error(t('wrap:emptyKernel'))
      return
    }
    setUploadFile(file)
  }

  const data = sample.data
  const complete = data?.ok === true

  return (
    <PageHeader
      title={t('wrap:title')}
      description={t('wrap:description')}
      extra={
        <div className='flex flex-wrap gap-2'>
          <input
            ref={fileRef}
            type='file'
            className='hidden'
            onChange={(event) => {
              pickKernelFile(event.target.files?.[0])
              event.target.value = ''
            }}
          />
          <Button
            size='sm'
            variant='outline'
            disabled={releaseUpdate.isPending || hopBusy}
            loading={releaseUpdate.isPending}
            onClick={() => setReleaseOpen(true)}
          >
            {t('wrap:fetchKernels')}
          </Button>
          <Button
            size='sm'
            variant='outline'
            disabled={upload.isPending || hopBusy}
            loading={upload.isPending}
            onClick={() => fileRef.current?.click()}
          >
            {t('wrap:localUpload')}
          </Button>
          <Button
            size='sm'
            variant='outline'
            disabled={make.isPending || hopBusy}
            loading={make.isPending}
            onClick={() => setMakeOpen(true)}
          >
            {t('wrap:rebuildSample')}
          </Button>
          <Button
            size='sm'
            disabled={!complete || !reinstallIds.length || hopBusy}
            loading={hopBusy && hopIds.length !== 1}
            onClick={() => openHop(reinstallIds, true)}
          >
            {selected.length
              ? t('wrap:reinstallSelected', { count: selected.length })
              : t('wrap:reinstallCurrent')}
          </Button>
        </div>
      }
    >
      <QueryGate
        loading={sample.isLoading || dash.isLoading}
        error={sample.error || dash.error}
        skeleton={
          <CardGridSkeleton cards={2} className='grid gap-4 lg:grid-cols-2' />
        }
      >
        <p className='mb-4 max-w-3xl text-sm leading-relaxed text-muted-foreground'>
          <Trans
            t={t}
            i18nKey='wrap:dataplaneDescription'
            components={{ wrap: <code />, cc: <code />, crag: <code /> }}
          />
        </p>
        <Card className='mb-4'>
          <CardHeader>
            <CardTitle>{t('wrap:kernel')}</CardTitle>
          </CardHeader>
          <CardContent className='space-y-3'>
            <RadioGroup
              value={selectedDataplane(data?.dataplane)}
              onValueChange={(value) => {
                if (value !== 'wrap' && value !== 'cc' && value !== 'crag')
                  return
                if (value === selectedDataplane(data?.dataplane)) return
                setPendingDataplane(value)
              }}
              disabled={dataplane.isPending || hopBusy}
              className='grid gap-3 lg:grid-cols-3'
            >
              <DataplaneOption
                value='wrap'
                title='cli-node + kernel'
                desc={t('wrap:wrapOptionHint')}
                current={data?.dataplane !== 'cc' && data?.dataplane !== 'crag'}
                disabled={!data?.ok}
              >
                <KernelPayload payload={data?.kernel} />
                <div className='pt-1 text-xs font-medium text-muted-foreground'>
                  cli-node
                </div>
                <KernelPayload payload={data?.cli_node} kind='cli' />
                <Flag ok={Boolean(data?.cli_node?.size)} label='cli-node' />
                <Flag ok={data?.kernel_bin} label='kernel.bin' />
              </DataplaneOption>
              <DataplaneOption
                value='cc'
                title='cc-node + kernel'
                desc={t('wrap:ccOptionHint')}
                current={data?.dataplane === 'cc'}
                disabled={!data?.cc_node?.size}
              >
                <KernelPayload payload={data?.kernel} />
                <div className='pt-1 text-xs font-medium text-muted-foreground'>
                  cc-node
                </div>
                <KernelPayload payload={data?.cc_node} kind='cli' />
                <Flag ok={Boolean(data?.cc_node?.size)} label='cc-node' />
                <Flag ok={data?.kernel_bin} label='kernel.bin' />
              </DataplaneOption>
              <DataplaneOption
                value='crag'
                title='crag + cc-node'
                desc={t('wrap:cragOptionHint')}
                current={data?.dataplane === 'crag'}
                disabled={!data?.crag?.ok || !data?.cc_node?.size}
              >
                <KernelPayload payload={data?.crag || undefined} />
                <Flag
                  ok={Boolean(data?.crag?.ok)}
                  label='share/crag/kin-kernel'
                />
                <Flag ok={Boolean(data?.cc_node?.size)} label='cc-node' />
                <input
                  ref={cragFileRef}
                  type='file'
                  className='hidden'
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    event.target.value = ''
                    if (!file) return
                    if (file.size > MAX_KERNEL_UPLOAD_BYTES) {
                      toast.error(t('wrap:uploadTooLarge'))
                      return
                    }
                    uploadCrag.mutate(file)
                  }}
                />
                <Button
                  size='sm'
                  variant='outline'
                  disabled={uploadCrag.isPending || hopBusy}
                  loading={uploadCrag.isPending}
                  onClick={(event) => {
                    event.preventDefault()
                    cragFileRef.current?.click()
                  }}
                >
                  {t('wrap:uploadCrag')}
                </Button>
              </DataplaneOption>
            </RadioGroup>
            <div className='flex items-center gap-2 text-sm'>
              <Checkbox
                checked={restart}
                onCheckedChange={(v) => setRestart(v === true)}
              />
              <label>{t('wrap:restartAfterSwitch')}</label>
            </div>
          </CardContent>
        </Card>

        <div className='grid gap-4 lg:grid-cols-2'>
          <Card>
            <CardHeader>
              <CardTitle>{t('wrap:wrapFiles')}</CardTitle>
            </CardHeader>
            <CardContent className='space-y-2'>
              {data?.meta?.release_tag ? (
                <div className='flex items-center justify-between gap-2 text-sm'>
                  <span className='text-muted-foreground'>GitHub</span>
                  <span className='font-mono text-xs'>
                    {data.meta.release_tag}
                  </span>
                </div>
              ) : null}
              <div className='flex items-center justify-between gap-2 text-sm'>
                <span className='text-muted-foreground'>
                  {t('wrap:directory')}
                </span>
                <code className='text-xs'>{sampleDirLabel(data?.dir)}</code>
              </div>
              <Flag ok={data?.wrapper} label='kernel wrapper' />
              <Flag ok={data?.glibc_shim} label='glibc 2.39 shim' />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t('wrap:reinstallKernel')}</CardTitle>
            </CardHeader>
            <CardContent className='space-y-3 text-sm leading-relaxed text-muted-foreground'>
              <p>{t('wrap:reinstallDescription')}</p>
              <Button
                size='sm'
                disabled={!complete || vms.length === 0 || hopBusy}
                loading={hopBusy && hopIds.length > 1}
                onClick={() =>
                  openHop(
                    vms.map((vm) => vm.id),
                    true
                  )
                }
              >
                {t('wrap:reinstallAllLatest')}
              </Button>
              {hopJob ? <HopProgress job={hopJob} /> : null}
            </CardContent>
          </Card>
        </div>

        <Card className='mt-4'>
          <CardHeader>
            <CardTitle>{t('wrap:slots')}</CardTitle>
          </CardHeader>
          <CardContent>
            {vms.length === 0 ? (
              <EmptyState
                reason={t('wrap:noSlots')}
                actionLabel={t('wrap:goToVms')}
                to='/vm'
              />
            ) : (
              <div className='overflow-x-auto'>
                <table className='w-full text-sm'>
                  <thead className='text-left text-muted-foreground'>
                    <tr>
                      <th className='w-8 py-2 font-medium'>
                        {t('wrap:select')}
                      </th>
                      <th className='py-2 font-medium'>{t('wrap:slot')}</th>
                      <th className='py-2 font-medium'>OS</th>
                      <th className='py-2 font-medium'>{t('wrap:engine')}</th>
                      <th className='py-2 font-medium'>{t('wrap:kernel')}</th>
                      <th className='py-2 font-medium'>
                        {t('wrap:baseSample')}
                      </th>
                      <th className='py-2 text-right font-medium'>
                        {t('wrap:actions')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {vms.map((vm) => {
                      const engine = engineOf(vm)
                      const rust = engine === 'rust'
                      const source = data?.meta?.source_vm === vm.id
                      return (
                        <tr key={vm.id} className='border-b last:border-0'>
                          <td className='py-2'>
                            <Checkbox
                              checked={selected.includes(vm.id)}
                              onCheckedChange={(v) => toggle(vm.id, v === true)}
                              aria-label={t('wrap:selectSlot', { id: vm.id })}
                            />
                          </td>
                          <td className='py-2 font-mono text-xs'>
                            <Link
                              to='/vm/$id'
                              params={{ id: vm.id }}
                              className='underline underline-offset-4'
                            >
                              {vm.id}
                            </Link>
                          </td>
                          <td className='py-2 text-muted-foreground'>
                            {osOf(vm)}
                          </td>
                          <td className='py-2'>
                            {inferenceEngineLabel(
                              normalizeInferenceEngine(engine, 'auto')
                            )}
                          </td>
                          <td className='py-2 font-mono text-xs'>
                            {dataplaneOf(vm) === '—'
                              ? '—'
                              : dataplaneLabel(dataplaneOf(vm))}
                          </td>
                          <td className='py-2 text-muted-foreground'>
                            {source
                              ? t('wrap:currentSample')
                              : rust
                                ? t('wrap:canPromote')
                                : t('wrap:filesOnly')}
                          </td>
                          <td className='py-2'>
                            <div className='flex justify-end gap-2'>
                              <Button
                                size='sm'
                                variant='outline'
                                disabled={!rust || promote.isPending || hopBusy}
                                onClick={() => setPromoteId(vm.id)}
                              >
                                {t('wrap:promoteSample')}
                              </Button>
                              <Button
                                size='sm'
                                variant='outline'
                                disabled={!complete || hopBusy}
                                loading={
                                  hopBusy &&
                                  hopIds.length === 1 &&
                                  hopIds[0] === vm.id
                                }
                                onClick={() => openHop([vm.id], false)}
                              >
                                {t('wrap:replaceSlot')}
                              </Button>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {rustVms.length === 0 ? (
              <p className='mt-3 text-xs text-muted-foreground'>
                {t('wrap:noRustSlotHint')}
              </p>
            ) : null}
          </CardContent>
        </Card>
      </QueryGate>
      <ConfirmDialog
        open={pendingDataplane != null}
        onOpenChange={(open) => {
          if (!open) setPendingDataplane(null)
        }}
        title={
          pendingDataplane === 'crag'
            ? t('wrap:confirmCrag')
            : pendingDataplane === 'cc'
              ? t('wrap:confirmCc')
              : t('wrap:confirmWrap')
        }
        desc={
          pendingDataplane === 'crag'
            ? t('wrap:switchCragDescription', {
                scope: selected.length
                  ? t('wrap:selectedClaudeSlots', { count: selected.length })
                  : t('wrap:allClaudeSlots'),
              })
            : pendingDataplane === 'cc'
              ? t('wrap:switchCcDescription', {
                  scope: selected.length
                    ? t('wrap:selectedClaudeSlots', { count: selected.length })
                    : t('wrap:allClaudeSlots'),
                })
              : t('wrap:switchWrapDescription', {
                  scope: selected.length
                    ? t('wrap:selectedClaudeSlots', { count: selected.length })
                    : t('wrap:allClaudeSlots'),
                })
        }
        confirmText={t('wrap:switch')}
        cancelBtnText={t('wrap:cancel')}
        isLoading={dataplane.isPending}
        handleConfirm={() => {
          if (pendingDataplane) dataplane.mutate(pendingDataplane)
        }}
      />

      <ConfirmDialog
        open={!!promoteId}
        onOpenChange={(open) => {
          if (!open) setPromoteId(null)
        }}
        title={t('wrap:confirmPromote')}
        desc={t('wrap:promoteDescription', {
          id: promoteId || t('wrap:thisSlot'),
        })}
        confirmText={t('wrap:promote')}
        cancelBtnText={t('wrap:cancel')}
        isLoading={promote.isPending}
        handleConfirm={() => {
          if (promoteId) promote.mutate(promoteId)
        }}
      />
      <ConfirmDialog
        open={makeOpen}
        onOpenChange={setMakeOpen}
        title={t('wrap:confirmRebuild')}
        desc={t('wrap:rebuildDescription')}
        confirmText={t('wrap:rebuild')}
        cancelBtnText={t('wrap:cancel')}
        isLoading={make.isPending}
        handleConfirm={() => make.mutate()}
      >
        <div className='space-y-1'>
          <p className='text-sm'>{t('wrap:shimSourceOptional')}</p>
          <SearchSelect
            label={t('wrap:shimSource')}
            value={glibcVm}
            options={vms.map((v) => ({
              id: v.id,
              name: `${v.id} · ${osOf(v)}`,
            }))}
            allLabel={t('wrap:noShimCopy')}
            searchPlaceholder={t('wrap:searchSourceSlots')}
            onChange={(id) => setGlibcVm(id || '')}
          />
        </div>
      </ConfirmDialog>
      <ConfirmDialog
        open={!!uploadFile}
        onOpenChange={(open) => {
          if (!open) setUploadFile(null)
        }}
        title={t('wrap:confirmUpload')}
        desc={t('wrap:uploadDescription', {
          name: uploadFile?.name || t('wrap:selectedFile'),
          size: fmtBytes(uploadFile?.size || 0),
        })}
        confirmText={t('wrap:upload')}
        cancelBtnText={t('wrap:cancel')}
        isLoading={upload.isPending}
        handleConfirm={() => {
          if (uploadFile) upload.mutate(uploadFile)
        }}
      />
      <ConfirmDialog
        open={releaseOpen}
        onOpenChange={setReleaseOpen}
        title={t('wrap:confirmFetch')}
        desc={t('wrap:fetchDescription')}
        confirmText={t('wrap:download')}
        cancelBtnText={t('wrap:cancel')}
        isLoading={releaseUpdate.isPending}
        handleConfirm={() => releaseUpdate.mutate()}
      />
      <ConfirmDialog
        open={hopOpen}
        onOpenChange={(open) => {
          if (!open) setHopOpen(false)
        }}
        title={
          hopIds.length === 1
            ? t('wrap:confirmReplaceSlot', { id: hopIds[0] })
            : hopIds.length === vms.length
              ? t('wrap:confirmReinstallAll')
              : t('wrap:confirmReinstallSelected', { count: hopIds.length })
        }
        desc={
          hopIds.length === 1
            ? t('wrap:replaceDescription')
            : pullLatest
              ? t('wrap:reinstallLatestDescription')
              : t('wrap:reinstallSelectedDescription')
        }
        confirmText={
          hopIds.length === 1
            ? t('wrap:replace')
            : hopIds.length === vms.length
              ? t('wrap:reinstallAll')
              : t('wrap:startReinstall')
        }
        cancelBtnText={t('wrap:cancel')}
        isLoading={hopBusy}
        handleConfirm={() => {
          const ids = hopIds
          const pull = ids.length === 1 ? false : pullLatest
          setHopOpen(false)
          void runHop(ids, pull)
        }}
      >
        {hopIds.length === 1 ? null : (
          <label className='flex items-center gap-2 text-sm'>
            <Checkbox
              checked={pullLatest}
              onCheckedChange={(v) => setPullLatest(v === true)}
            />
            {t('wrap:fetchLatestFirst')}
          </label>
        )}
      </ConfirmDialog>
    </PageHeader>
  )
}
