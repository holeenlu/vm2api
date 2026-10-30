import { useState, type ReactNode } from 'react'
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
} from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { t as tVm } from '@/i18n'
import type { PreflightCheck } from '@/types/panel-cluster'
import type { RuntimeType } from '@/types/panel-vm'
import { ChevronRight } from 'lucide-react'
import { useTranslation, Trans } from 'react-i18next'
import { toast } from 'sonner'
import { api, isApiError } from '@/lib/api'
import { importErrorMessage } from '@/lib/import-errors'
import { cn } from '@/lib/utils'
import { vmIdOf } from '@/lib/vm-name'
import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ChoiceTiles, Segmented } from '@/components/choice-tiles'
import { PlatformChip } from '@/components/platform-chip'
import { meQueryOptions } from '@/features/auth/queries'
import { dashboardQueryOptions } from '@/features/overview/queries'
import {
  CreateExitField,
  useCreateExit,
  type CreateExit,
} from '@/features/vm/create-exit-field'
import {
  KERNELS,
  VM_CREATE_AFTER,
  VM_LOCALES,
  VM_REGION_AUTO,
  VM_REGIONS,
  kernelProfile,
} from '@/features/vm/create-options'
import {
  tcgWarning,
  VM_DISK_GB_MAX,
  VM_DISK_GB_MIN,
  VM_MEMORY_LABELS,
  VM_MEMORY_OPTIONS,
  VM_VCPU_OPTIONS,
  createMachinePayload,
  isMemoryOption,
  kvmAvailabilityFromLocal,
  kvmAvailabilityFromPreflight,
  normalizeVmConfig,
  type KvmAvailability,
  type VmMemoryOption,
} from '@/features/vm/machine-spec'
import { preflightChecksFromError } from '@/features/vm/placement'
import {
  PlacementField,
  PreflightCheckList,
  usePlacement,
  type Placement,
} from '@/features/vm/placement-field'
import {
  vmCreateOptionsQueryOptions,
  vmsListQueryOptions,
} from '@/features/vm/queries'

/** 「之后」的 5 档，对齐 index.html `createVmFromPage()` 的派生逻辑。 */
export type CreateVmAfter = 'idle' | 'start' | 'proxy' | 'active' | 'full'

type Platform = 'anthropic' | 'openai'

type CreateVmResponse = {
  id?: string
  vm_id?: string
  vm?: { id?: string }
  start_error?: string
  /** 指定出口在创建瞬间没绑上（被别处占满等）。 */
  proxy_error?: string
}

/**
 * 「之后」→ 三个布尔的派生。index.html `createVmFromPage()`:
 *   start = after !== 'idle'
 *   auto_allocate_proxy = after === 'proxy' || after === 'full'
 *   activate = after === 'active' || after === 'full'
 */
function deriveAfter(after: string) {
  return {
    start: after !== 'idle',
    auto_allocate_proxy: after === 'proxy' || after === 'full',
    activate: after === 'active' || after === 'full',
  }
}

const MEMORY_SHORT: Record<VmMemoryOption, string> = {
  '256m': '256M',
  '512m': '512M',
  '1g': '1G',
  '2g': '2G',
  '4g': '4G',
  '8g': '8G',
  '16g': '16G',
}

type CreateVmResult = { id: string; startError: string; proxyError: string }

/** 创建表单的草稿：表单与规格单读同一份。 */
export interface CreateVmDraft {
  isAdmin: boolean
  pinnedAfter?: CreateVmAfter
  platform: Platform
  setPlatform: (next: Platform) => void
  kernel: string
  setKernel: (next: string) => void
  name: string
  setName: (next: string) => void
  typedName: string
  after: string
  setAfter: (next: string) => void
  region: string
  setRegion: (next: string) => void
  locale: string
  setLocale: (next: string) => void
  runtimeType: RuntimeType
  setRuntime: (next: RuntimeType) => void
  memory: string
  setMemory: (next: string) => void
  vcpus: number
  setVcpus: (next: number) => void
  diskGb: number
  setDiskGb: (next: number) => void
  placement: Placement
  kvmAvail: KvmAvailability
  /** 本机不支持 KVM：选项禁用，草稿回落容器。 */
  kvmBlocked: boolean
  exit: CreateExit
  wantsExit: boolean
  create: UseMutationResult<CreateVmResult, Error, void>
  /** 预检未过 / KVM 仍在检测：提交按钮禁用。 */
  blocked: boolean
  placementChecks: PreflightCheck[]
}

/**
 * 创建槽位的全部草稿状态 + 提交。表单与规格单是同一份草稿的两种呈现，
 * 所以状态放在外层，导入流程把规格单放右栏，弹窗把它省掉。
 *
 * pinnedAfter：传入即固定「之后」档位（导入流程用 idle，出口在下一步手选）。
 */
export function useCreateVmDraft({
  pinnedAfter,
  onCreated,
}: {
  pinnedAfter?: CreateVmAfter
  onCreated?: (id: string) => void
} = {}): CreateVmDraft {
  const { t: tVm } = useTranslation('vm')

  const qc = useQueryClient()
  const [platform, setPlatform] = useState<Platform>('anthropic')
  const [kernel, setKernel] = useState<string>(KERNELS[0].id)
  const [name, setName] = useState('')
  const [after, setAfter] = useState<string>(pinnedAfter || 'start')
  const [region, setRegion] = useState<string>(VM_REGION_AUTO)
  const [locale, setLocale] = useState<string>(VM_LOCALES[0][0])
  const [runtimeOverride, setRuntimeOverride] = useState<RuntimeType | null>(
    null
  )
  const [memoryOverride, setMemoryOverride] = useState<string | null>(null)
  const [vcpusOverride, setVcpusOverride] = useState<number | null>(null)
  const [diskOverride, setDiskOverride] = useState<number | null>(null)

  const me = useQuery(meQueryOptions())
  const createOptions = useQuery(vmCreateOptionsQueryOptions())
  const vmCfg = normalizeVmConfig(createOptions.data?.vm)
  const preferredRuntime = runtimeOverride ?? vmCfg.default_runtime
  const memory = memoryOverride ?? vmCfg.memory
  const vcpus = vcpusOverride ?? vmCfg.vcpus
  const diskGb = diskOverride ?? vmCfg.disk_gb

  const typedName = name.trim()
  const placement = usePlacement(kernel, preferredRuntime)
  const kvmAvail: KvmAvailability = placement.nodeId
    ? kvmAvailabilityFromPreflight({
        fetching: placement.preflight.isFetching,
        error: placement.preflight.error,
        data: placement.preflight.data,
      })
    : kvmAvailabilityFromLocal({
        fetching: createOptions.isFetching,
        error: createOptions.error,
        kvm: createOptions.data?.kvm,
      })
  const kvmBlocked =
    !placement.nodeId &&
    (kvmAvail.status === 'disabled' || kvmAvail.status === 'unknown')
  // 宿主不支持时静默回落容器，不提交一个必然 409 的形态。
  const runtimeType: RuntimeType =
    preferredRuntime === 'kvm' && kvmBlocked ? 'docker' : preferredRuntime
  const kvmPending =
    runtimeType === 'kvm' && !placement.nodeId && kvmAvail.status === 'loading'
  const exit = useCreateExit(placement.nodeId)
  const wantsExit = after !== 'idle'

  const create = useMutation({
    mutationFn: async () => {
      // 纯非 ASCII 名称（如「测试槽」）清洗后为空：不发 id，让后端自动编号。
      const id = typedName ? vmIdOf(typedName) || undefined : undefined
      const nodeId = placement.nodeId
      const data = await api<CreateVmResponse>('/api/panel/vms/create', {
        method: 'POST',
        body: JSON.stringify({
          id,
          ...(typedName ? { name: typedName } : {}),
          kernel,
          locale,
          // 「自动」是纯 UI 哨兵值，不发给后端。
          region: region === VM_REGION_AUTO ? undefined : region,
          // 并发、权重不在创建时定：后端按设置里的全局默认（Claude / OpenAI 各自）填。
          ...deriveAfter(after),
          platform,
          family: platform === 'openai' ? 'codex' : 'claude',
          ...(nodeId ? { node_id: nodeId } : {}),
          ...(wantsExit && exit.proxyId ? { proxy_id: exit.proxyId } : {}),
          ...createMachinePayload({ runtimeType, memory, vcpus, diskGb }),
        }),
      })
      return {
        id: data.id || data.vm_id || data.vm?.id || id || '',
        startError: data.start_error || '',
        proxyError: data.proxy_error || '',
      }
    },
    onSuccess: async (created) => {
      if (created.proxyError) {
        toast.warning(
          tVm('vm:createVmForm.egressNotBound', {
            proxyError: created.proxyError,
          })
        )
      }
      if (created.startError) {
        toast.warning(
          created.id
            ? tVm('vm:createVmForm.createdButStartupFailed', {
                id: created.id,
                startError: created.startError,
              })
            : tVm('vm:createVmForm.createdButStartupFailedAlternative', {
                startError: created.startError,
              })
        )
      } else {
        toast.success(
          created.id
            ? tVm('vm:createVmForm.created', { id: created.id })
            : tVm('vm:createVmForm.createdAlternative')
        )
      }
      setName('')
      await Promise.all([
        qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
        qc.invalidateQueries({ queryKey: vmsListQueryOptions().queryKey }),
      ])
      // 拿不到 id 时不回调：导入流程会把空 id 当成取消选中。
      if (created.id) onCreated?.(created.id)
    },
    onError: (error: Error) => {
      toast.error(importErrorMessage(error))
      // 预检在提交前后可能变了（节点掉线 / 镜像被删），刷新一次让检查项同步。
      if (isApiError(error) && error.code === 'placement_preflight_failed') {
        void placement.preflight.refetch()
      }
    },
  })

  return {
    isAdmin: me.data?.role === 'super_admin',
    pinnedAfter,
    platform,
    setPlatform,
    kernel,
    setKernel,
    name,
    setName,
    typedName,
    after,
    setAfter,
    region,
    setRegion,
    locale,
    setLocale,
    runtimeType,
    setRuntime: (next: RuntimeType) => setRuntimeOverride(next),
    memory,
    setMemory: (next: string) => {
      if (isMemoryOption(next)) setMemoryOverride(next)
    },
    vcpus,
    setVcpus: (n: number) => setVcpusOverride(n),
    diskGb,
    setDiskGb: (n: number) =>
      setDiskOverride(
        Math.min(VM_DISK_GB_MAX, Math.max(VM_DISK_GB_MIN, Math.round(n)))
      ),
    placement,
    kvmAvail,
    kvmBlocked,
    exit,
    wantsExit,
    create,
    blocked: placement.blocked || kvmPending,
    placementChecks: preflightChecksFromError(create.error),
  }
}

/** 规格的一句话：容器只读内存；KVM 带 vCPU 与磁盘。 */
export function machineLine(
  runtime: RuntimeType,
  memory?: string,
  vcpus?: number,
  diskGb?: number
): string {
  const mem = memory
    ? VM_MEMORY_LABELS[memory as VmMemoryOption] || memory
    : tVm('vm:createVmForm.defaultMemory')
  if (runtime !== 'kvm')
    return [mem, vcpus ? `${vcpus} CPU` : null].filter(Boolean).join(' · ')
  return [mem, vcpus ? `${vcpus} vCPU` : null, diskGb ? `${diskGb} GB` : null]
    .filter(Boolean)
    .join(' · ')
}

export type SpecRow = { label: string; value: ReactNode }

/** 右栏规格单：标签左、值右，数值等宽对齐。 */
export function SpecSheet({
  rows,
  className,
}: {
  rows: SpecRow[]
  className?: string
}) {
  useTranslation('vm')

  return (
    <dl
      className={cn('grid grid-cols-[4.5rem_minmax(0,1fr)] gap-y-2', className)}
    >
      {rows.map((r) => (
        <div key={r.label} className='contents'>
          <dt className='text-xs leading-5 text-muted-foreground'>{r.label}</dt>
          <dd className='min-w-0 text-sm leading-5 break-words tabular-nums'>
            {r.value}
          </dd>
        </div>
      ))}
    </dl>
  )
}

export function draftSpecRows(d: CreateVmDraft): SpecRow[] {
  const node = d.placement.nodeId
    ? d.placement.nodes.find((n) => n.id === d.placement.nodeId)
    : null
  return [
    {
      label: tVm('vm:createVmForm.platform'),
      value: (
        <PlatformChip kind={d.platform === 'openai' ? 'codex' : 'claude'} />
      ),
    },
    {
      label: tVm('vm:createVmForm.runtime'),
      value:
        d.runtimeType === 'kvm'
          ? d.kvmAvail.status === 'ok' && d.kvmAvail.accel === 'tcg'
            ? tVm('vm:createVmForm.virtualMachineKVMTCG')
            : tVm('vm:createVmForm.virtualMachineKVM')
          : tVm('vm:createVmForm.containerDocker'),
    },
    {
      label: tVm('vm:createVmForm.operatingSystem'),
      value: kernelProfile(d.kernel)?.name || d.kernel,
    },
    {
      label: tVm('vm:createVmForm.specifications'),
      value: machineLine(d.runtimeType, d.memory, d.vcpus, d.diskGb),
    },
    {
      label: tVm('vm:createVmForm.placement'),
      value: node
        ? node.label || node.host
        : tVm('vm:createExitField.localMachine'),
    },
    {
      label: tVm('vm:createVmForm.name'),
      value: d.typedName || (
        <span className='text-muted-foreground'>
          <Trans ns='vm' i18nKey='createVmForm.automaticID' />
        </span>
      ),
    },
  ]
}

function Section({
  title,
  hint,
  action,
  summary,
  summaryCaution = false,
  children,
}: {
  title: string
  hint?: ReactNode
  action?: ReactNode
  /** 传入后该节默认收起，标题旁显示这一行；点标题再展开配置。 */
  summary?: ReactNode
  summaryCaution?: boolean
  children: ReactNode
}) {
  useTranslation('vm')

  const [open, setOpen] = useState(summary == null)
  const head = (
    <div className='flex items-baseline justify-between gap-3'>
      {summary == null ? (
        <h4 className='text-sm font-semibold'>{title}</h4>
      ) : (
        <CollapsibleTrigger className='flex min-w-0 flex-1 cursor-pointer items-baseline gap-1.5 rounded-sm text-left outline-none focus-visible:ring-[3px] focus-visible:ring-select-border/40 data-[state=open]:[&_svg]:rotate-90'>
          <ChevronRight className='size-3.5 shrink-0 translate-y-px text-muted-foreground transition-transform duration-150' />
          <span className='text-sm font-semibold'>{title}</span>
          <span
            className={cn(
              'min-w-0 truncate text-sm font-normal tabular-nums',
              open && 'sr-only',
              summaryCaution
                ? 'text-[color:var(--status-caution)]'
                : 'text-muted-foreground'
            )}
          >
            {summary}
          </span>
        </CollapsibleTrigger>
      )}
      {action}
    </div>
  )
  const body = (
    <>
      {hint ? (
        <p className='text-xs leading-relaxed text-muted-foreground'>{hint}</p>
      ) : null}
      {children}
    </>
  )
  if (summary == null) {
    return (
      <section className='space-y-3 border-t pt-5 first:border-t-0 first:pt-0'>
        <div className='space-y-0.5'>
          {head}
          {hint ? (
            <p className='text-xs leading-relaxed text-muted-foreground'>
              {hint}
            </p>
          ) : null}
        </div>
        {children}
      </section>
    )
  }
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className='space-y-3 border-t pt-5 first:border-t-0 first:pt-0'
    >
      {head}
      <CollapsibleContent className='space-y-3'>{body}</CollapsibleContent>
    </Collapsible>
  )
}

function kvmDetail(avail: KvmAvailability, remote: boolean): ReactNode {
  if (avail.status === 'loading') return tVm('vm:createVmForm.checkingHostKVM')
  if (avail.status === 'disabled' || avail.status === 'unknown') {
    return remote
      ? tVm('vm:createVmForm.node', { reason: avail.reason })
      : avail.reason
  }
  if (avail.accel === 'tcg') {
    return (
      <span className='text-[color:var(--status-caution)]'>{tcgWarning()}</span>
    )
  }
  return tVm(
    'vm:createVmForm.dedicatedKernelAndHardwareIdentitySMBIOSMACDiskSerial'
  )
}

/**
 * 创建槽位的表单。顺序即决策顺序：先定账号平台与机器形态，
 * 再定系统与规格，最后才是放置与名称这类可以不管的项。
 *
 * variant=flow：导入流程第 1 步，规格单在页面右栏，按钮是「创建空槽」。
 * variant=dialog：槽位页快捷创建，多一节「创建后」，带取消。
 */
export function CreateVmForm({
  draft: d,
  variant,
  onCancel,
}: {
  draft: CreateVmDraft
  variant: 'flow' | 'dialog'
  onCancel?: () => void
}) {
  const { t: tVm } = useTranslation('vm')

  const remote = !!d.placement.nodeId
  const kvm = d.runtimeType === 'kvm'

  return (
    <div className='space-y-5'>
      <Section
        title={tVm('vm:createVmForm.platform')}
        hint={tVm(
          'vm:createVmForm.determinesTheAccountPlatformCannotBeChangedAfterCreation'
        )}
      >
        <ChoiceTiles
          label={tVm('vm:createVmForm.slotPlatform')}
          value={d.platform}
          onChange={d.setPlatform}
          choices={[
            {
              value: 'anthropic',
              title: <PlatformChip kind='claude' />,
              detail: tVm(
                'vm:createVmForm.oAuthSetupTokenOrConsoleKeySupportsOfficialSetup'
              ),
            },
            {
              value: 'openai',
              title: <PlatformChip kind='codex' />,
              detail: tVm(
                'vm:createVmForm.codexOAuthOrAuthJsonLocalPlacementOnly'
              ),
            },
          ]}
        />
      </Section>

      <Section
        title={tVm('vm:createVmForm.runtime')}
        hint={tVm(
          'vm:createVmForm.containersAreLightweightAndFastVirtualMachinesProvideA'
        )}
      >
        <ChoiceTiles
          label={tVm('vm:createVmForm.slotRuntime')}
          value={d.runtimeType}
          onChange={d.setRuntime}
          choices={[
            {
              value: 'docker',
              title: tVm('vm:createVmForm.containerDocker'),
              detail: tVm(
                'vm:createVmForm.sharesTheHostKernelAndStartsInSecondsOnly'
              ),
            },
            {
              value: 'kvm',
              title: tVm('vm:createVmForm.virtualMachineKVM'),
              detail: kvmDetail(d.kvmAvail, remote),
              disabled: d.kvmBlocked,
            },
          ]}
        />
      </Section>

      <Section
        title={tVm('vm:createVmForm.operatingSystem')}
        hint={tVm(
          'vm:createVmForm.guestOperatingSystemIncludingDistributionAndPackageManager'
        )}
      >
        <ChoiceTiles
          label={tVm('vm:createVmForm.guestOperatingSystem')}
          value={d.kernel}
          onChange={d.setKernel}
          className='grid-cols-2 lg:grid-cols-4'
          choices={KERNELS.map((k) => ({
            value: k.id,
            title: k.name,
            detail: k.feats.slice(0, 2).join(' · '),
          }))}
        />
      </Section>

      <Section
        title={tVm('vm:createVmForm.specifications')}
        summary={machineLine(d.runtimeType, d.memory, d.vcpus, d.diskGb)}
        summaryCaution={d.memory === '256m' || d.memory === '512m'}
        hint={
          kvm
            ? tVm('vm:createVmForm.fixedForThisSlotUnchangedAfterStartup')
            : tVm('vm:createVmForm.containersUseMemoryAndCpuLimits')
        }
        action={
          d.isAdmin ? (
            <Link
              to='/specs'
              className='text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline'
            >
              <Trans ns='vm' i18nKey='createVmForm.changeDefaults' />
            </Link>
          ) : null
        }
      >
        <div className='flex flex-wrap items-end gap-x-6 gap-y-3'>
          <div className='space-y-1.5'>
            <Label id='vm-memory-label'>
              <Trans ns='vm' i18nKey='createVmForm.memoryAlternative' />
            </Label>
            <Segmented
              label={tVm('vm:createVmForm.slotMemory')}
              value={d.memory as VmMemoryOption}
              onChange={d.setMemory}
              options={VM_MEMORY_OPTIONS.map((id) => ({
                value: id,
                label: MEMORY_SHORT[id],
              }))}
            />
          </div>
          <div className='space-y-1.5'>
            <Label htmlFor='vm-vcpus'>{kvm ? 'vCPU' : 'CPU'}</Label>
            <Select
              value={String(d.vcpus)}
              onValueChange={(v) => d.setVcpus(Number(v))}
            >
              <SelectTrigger
                id='vm-vcpus'
                className='w-24'
                aria-label={tVm('vm:createVmForm.slotVCPU')}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {VM_VCPU_OPTIONS.map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {n}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {kvm ? (
            <div className='space-y-1.5'>
              <Label htmlFor='vm-disk'>
                <Trans ns='vm' i18nKey='createVmForm.disk' />
              </Label>
              <div className='flex items-center gap-1.5'>
                <Input
                  id='vm-disk'
                  type='number'
                  className='w-24 tabular-nums'
                  min={VM_DISK_GB_MIN}
                  max={VM_DISK_GB_MAX}
                  value={d.diskGb}
                  onChange={(e) => {
                    const n = Number(e.target.value)
                    if (Number.isFinite(n)) d.setDiskGb(n)
                  }}
                />
                <span className='text-sm text-muted-foreground'>GB</span>
              </div>
            </div>
          ) : null}
        </div>
        {d.memory === '256m' || d.memory === '512m' ? (
          <p className='text-xs text-[color:var(--status-caution)]'>
            {tVm(kvm ? 'vm:messages.lowMemoryKvm' : 'vm:messages.lowMemory')}
          </p>
        ) : null}
      </Section>

      <Section
        title={tVm('vm:createVmForm.environment')}
        hint={tVm('vm:createVmForm.regionTagAndSystemLanguageLANGSavedToThe')}
      >
        <div className='space-y-4'>
          <div className='space-y-1.5'>
            <Label>
              <Trans ns='vm' i18nKey='createVmForm.region' />
            </Label>
            <Segmented
              label={tVm('vm:createVmForm.region')}
              value={d.region}
              onChange={d.setRegion}
              options={VM_REGIONS.map(([value, label]) => ({ value, label }))}
            />
          </div>
          <div className='space-y-1.5'>
            <Label>
              <Trans ns='vm' i18nKey='createVmForm.language' />
            </Label>
            <Segmented
              label={tVm('vm:createVmForm.language')}
              className='w-full gap-y-1'
              value={d.locale}
              onChange={d.setLocale}
              options={VM_LOCALES.map(([value, label]) => ({
                value,
                label: (
                  <span className='inline-flex shrink-0 items-baseline gap-1.5 whitespace-nowrap'>
                    {label}
                    <span className='font-mono text-[11px] opacity-70'>
                      {value.includes('_')
                        ? value.replace('.UTF-8', '')
                        : value}
                    </span>
                  </span>
                ),
              }))}
            />
          </div>
        </div>
      </Section>

      {d.placement.visible ? (
        <Section
          title={tVm('vm:createVmForm.placement')}
          hint={tVm('vm:createVmForm.clusterNodesAreCheckedBeforePlacement')}
        >
          <PlacementField
            placement={d.placement}
            kernel={d.kernel}
            runtimeType={d.runtimeType}
          />
        </Section>
      ) : null}

      <Section title={tVm('vm:createVmForm.name')}>
        <Input
          aria-label={tVm('vm:createVmForm.slotName')}
          value={d.name}
          onChange={(e) => d.setName(e.target.value)}
          placeholder={tVm(
            'vm:createVmForm.leaveBlankForAnAutomaticIDSuchAsVm'
          )}
          className='max-w-sm'
        />
        <p className='text-xs text-muted-foreground'>
          <Trans
            ns='vm'
            i18nKey='createVmForm.concurrencyFollowsGlobalSettingsYouCanOverrideItIn'
          />
        </p>
      </Section>

      {variant === 'dialog' && !d.pinnedAfter ? (
        <Section title={tVm('vm:createVmForm.afterCreation')}>
          <Field label={tVm('vm:createVmForm.nextAction')}>
            <Select value={d.after} onValueChange={d.setAfter}>
              <SelectTrigger aria-label={tVm('vm:createVmForm.afterCreation')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {VM_CREATE_AFTER.map(([v, l]) => (
                  <SelectItem key={v} value={v}>
                    {l}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {d.wantsExit ? (
            <CreateExitField exit={d.exit} remote={remote} />
          ) : null}
        </Section>
      ) : null}

      {d.placementChecks.length ? (
        <div className='space-y-1 rounded-lg border border-[color:var(--status-bad)]/40 p-3'>
          <p className='text-xs text-[color:var(--status-bad)]'>
            <Trans ns='vm' i18nKey='createVmForm.targetNodePreflightFailed' />
          </p>
          <PreflightCheckList checks={d.placementChecks} />
        </div>
      ) : null}

      {variant === 'flow' ? (
        <SpecSheet
          rows={draftSpecRows(d)}
          className='rounded-lg border bg-muted/30 p-3 lg:hidden'
        />
      ) : null}

      <div className='flex flex-wrap items-center justify-end gap-2 border-t pt-4'>
        {d.create.error ? (
          <p className='me-auto text-xs text-[color:var(--status-bad)]'>
            {importErrorMessage(d.create.error)}
          </p>
        ) : variant === 'flow' ? (
          <p className='me-auto text-xs text-muted-foreground'>
            <Trans
              ns='vm'
              i18nKey='createVmForm.bindAnEgressAndImportAnAccountBelowAfter'
            />
          </p>
        ) : null}
        {onCancel ? (
          <Button variant='outline' onClick={onCancel}>
            <Trans ns='vm' i18nKey='authSchemeEditor.cancel' />
          </Button>
        ) : null}
        <Button
          onClick={() => d.create.mutate()}
          disabled={d.create.isPending || d.blocked}
          loading={d.create.isPending}
        >
          {variant === 'flow'
            ? tVm('vm:createVmForm.createEmptySlot')
            : tVm('vm:createVmForm.create')}
        </Button>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  useTranslation('vm')

  return (
    <div className='space-y-1.5'>
      <Label>{label}</Label>
      {children}
    </div>
  )
}
