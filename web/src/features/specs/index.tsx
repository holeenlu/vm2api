import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { VIEW_TITLES } from '@/config/nav'
import { t } from '@/i18n'
import type { VmRoutingConfig } from '@/types/panel-routing'
import type { StatusTone } from '@/types/status'
import { ChevronRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
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
import { Switch } from '@/components/ui/switch'
import { ChoiceTiles, Segmented } from '@/components/choice-tiles'
import { PageHeader } from '@/components/page-header'
import { SectionSkeleton } from '@/components/page-skeletons'
import { QueryGate } from '@/components/query-gate'
import { SettingRow } from '@/components/setting-row'
import { StatusMark } from '@/components/status-mark'
import { routingQueryOptions } from '@/features/settings/queries'
import { SaveBar } from '@/features/settings/save-bar'
import {
  tcgWarning,
  VM_CPU_MODEL_LABELS,
  VM_CPU_MODELS,
  VM_DISK_GB_MAX,
  VM_DISK_GB_MIN,
  VM_MEMORY_LABELS,
  VM_MEMORY_OPTIONS,
  VM_VCPU_OPTIONS,
  isCpuModel,
  isMemoryOption,
  normalizeVmConfig,
  vmConfigFieldErrors,
  type VmMemoryOption,
} from '@/features/vm/machine-spec'
import { vmCreateOptionsQueryOptions } from '@/features/vm/queries'

/*
THESIS: 规格 is the factory sheet every new slot is stamped from; the guest's own view of its hardware proves it.
OWN-WORLD: Graphite Operate console. Teal only on the save action. StatusMark is the only health language.
FIRST VIEWPORT: form groups left in decision order; right rail = host KVM state + the DMI readout the guest will see.
ANTI-PATTERN: settings soup in one card, decorative chips, hero metrics.
*/

type Draft = Record<string, unknown>

const SMBIOS_FIELDS = [
  ['manufacturer', 'specs:manufacturer', 'Manufacturer'],
  ['product', 'specs:model', 'Product Name'],
  ['version', 'specs:version', 'Version'],
  ['family', 'specs:family', 'Family'],
] as const

function Group({
  title,
  desc,
  summary,
  forceOpen = false,
  children,
}: {
  title: string
  desc?: ReactNode
  summary: ReactNode
  /** 这一组有校验错误时展开，避免错误藏在收起的配置里。 */
  forceOpen?: boolean
  children: ReactNode
}) {
  useTranslation('specs')

  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (forceOpen) setOpen(true)
  }, [forceOpen])
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className='border-t first:border-t-0'
    >
      <CollapsibleTrigger className='flex w-full cursor-pointer items-baseline gap-1.5 rounded-sm py-3 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-select-border/40 data-[state=open]:[&_svg]:rotate-90'>
        <ChevronRight className='size-3.5 shrink-0 translate-y-px text-muted-foreground transition-transform duration-150' />
        <span className='text-sm font-semibold'>{title}</span>
        <span
          className={cn(
            'min-w-0 truncate text-sm font-normal text-muted-foreground tabular-nums',
            open && 'sr-only'
          )}
        >
          {summary}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className='space-y-4 pb-6'>
        {desc ? (
          <p className='max-w-[60ch] text-xs leading-relaxed text-muted-foreground'>
            {desc}
          </p>
        ) : null}
        {children}
      </CollapsibleContent>
    </Collapsible>
  )
}

function FieldError({ text }: { text?: string }) {
  useTranslation('specs')

  if (!text) return null
  return <p className='text-xs text-[color:var(--status-bad)]'>{text}</p>
}

/** 宿主 KVM 的一句话状态：create-options 的探测是按已保存配置跑的。 */
function hostTone(
  kvm: { ok: boolean; accel: 'kvm' | 'tcg' | null } | undefined
): StatusTone {
  if (!kvm) return { key: 'kvm', text: t('specs:probing'), cls: 'none' }
  if (kvm.ok && kvm.accel === 'kvm')
    return { key: 'kvm', text: t('specs:kvmAvailable'), cls: 'ok' }
  if (kvm.ok)
    return { key: 'kvm', text: t('specs:emulationOnly'), cls: 'caution' }
  return { key: 'kvm', text: t('specs:unavailable'), cls: 'bad' }
}

/** 用户机里 dmidecode / ip link 会读到的值。每槽随机的部分如实标出。 */
function GuestReadout({ cfg }: { cfg: VmRoutingConfig }) {
  const { t } = useTranslation('specs')

  const rows: [string, string, boolean?][] = [
    ...SMBIOS_FIELDS.map(
      ([key, , dmi]) => [dmi, cfg.smbios[key] || '—'] as [string, string]
    ),
    [
      /* i18n-exempt "Serial Number" -- Guest dmidecode field name or machine readout; mirrors the guest command output. */ 'Serial Number',
      t('specs:randomPerSlot'),
      true,
    ],
    ['UUID', t('specs:randomPerSlot'), true],
    ['CPU', cfg.cpu_model],
    [
      /* i18n-exempt "Memory" -- Guest dmidecode field name or machine readout; mirrors the guest command output. */ 'Memory',
      /* i18n-exempt "{{expression}} · {{expression}} vCPU" -- Guest dmidecode field name or machine readout; mirrors the guest command output. */ `${VM_MEMORY_LABELS[cfg.memory as VmMemoryOption] || cfg.memory} · ${cfg.vcpus} vCPU`,
    ],
    [
      /* i18n-exempt "Disk" -- Guest dmidecode field name or machine readout; mirrors the guest command output. */ 'Disk',
      t('specs:diskSummary', { size: cfg.disk_gb }),
    ],
    ['MAC', `${cfg.mac_oui || '??:??:??'}:xx:xx:xx`],
  ]
  return (
    <dl className='grid grid-cols-[7.5rem_minmax(0,1fr)] gap-x-2 gap-y-1.5 font-mono text-xs leading-5 tabular-nums'>
      {rows.map(([k, v, random]) => (
        <div key={k} className='contents'>
          <dt className='text-muted-foreground'>{k}</dt>
          <dd
            className={cn(
              'min-w-0 break-all',
              random && 'font-sans text-muted-foreground'
            )}
          >
            {v}
          </dd>
        </div>
      ))}
    </dl>
  )
}

export function SpecsPage() {
  const { t } = useTranslation('specs')

  const routing = useQuery(routingQueryOptions())
  const options = useQuery(vmCreateOptionsQueryOptions())
  const qc = useQueryClient()
  const server = (routing.data?.vm as Draft | undefined) ?? null
  const [draft, setDraft] = useState<Draft | null>(null)
  const hydrated = useRef(false)

  // 首次拿到服务端值时落草稿；之后只在保存成功后重新对齐。
  useEffect(() => {
    if (hydrated.current || !routing.data) return
    hydrated.current = true
    setDraft(server ? { ...server } : {})
  }, [routing.data, server])

  const value = draft ?? server ?? {}
  const cfg = normalizeVmConfig(value)
  const errors = vmConfigFieldErrors({
    ...cfg,
    mac_oui: 'mac_oui' in value ? value.mac_oui : cfg.mac_oui,
    vcpus: 'vcpus' in value ? value.vcpus : cfg.vcpus,
    disk_gb: 'disk_gb' in value ? value.disk_gb : cfg.disk_gb,
  })
  const macValue =
    typeof value.mac_oui === 'string' ? value.mac_oui : cfg.mac_oui
  const diskValue =
    'disk_gb' in value && value.disk_gb != null
      ? String(value.disk_gb)
      : String(cfg.disk_gb)
  const firstError = Object.values(errors)[0]
  // 比较原始输入（MAC、磁盘可能处在非法的中间态），不比较归一后的值。
  const serverCfg = normalizeVmConfig(server)
  const dirty =
    draft !== null &&
    JSON.stringify({ ...cfg, mac_oui: macValue, disk_gb: diskValue }) !==
      JSON.stringify({ ...serverCfg, disk_gb: String(serverCfg.disk_gb) })

  function set(patch: Draft) {
    const smbiosPatch = patch.smbios
    setDraft({
      ...cfg,
      ...value,
      ...patch,
      smbios: {
        ...cfg.smbios,
        ...(typeof smbiosPatch === 'object' && smbiosPatch
          ? (smbiosPatch as Draft)
          : {}),
      },
    })
  }

  const save = useMutation({
    mutationFn: () =>
      api('/api/panel/routing', {
        method: 'PUT',
        body: JSON.stringify({ vm: { ...cfg, mac_oui: macValue.trim() } }),
      }),
    onSuccess: async () => {
      toast.success(t('specs:saved'))
      hydrated.current = false
      setDraft(null)
      await Promise.all([
        qc.invalidateQueries({ queryKey: routingQueryOptions().queryKey }),
        qc.invalidateQueries({
          queryKey: vmCreateOptionsQueryOptions().queryKey,
        }),
      ])
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const kvm = options.data?.kvm
  const tone = hostTone(kvm)

  return (
    <PageHeader title={VIEW_TITLES.specs} description={t('specs:description')}>
      <QueryGate
        loading={routing.isLoading}
        error={routing.error}
        skeleton={<SectionSkeleton titleWidth='w-24' rows={10} />}
      >
        <div className='grid max-w-6xl items-start gap-x-12 gap-y-8 lg:grid-cols-[minmax(0,1fr)_20rem]'>
          <div className='min-w-0 space-y-0'>
            <Group
              title={t('specs:defaultRuntime')}
              summary={
                cfg.default_runtime === 'kvm'
                  ? t('specs:kvm')
                  : t('specs:docker')
              }
              forceOpen={!!errors.default_runtime}
              desc={t('specs:runtimeHelp')}
            >
              <ChoiceTiles
                label={t('specs:defaultRuntime')}
                value={cfg.default_runtime}
                onChange={(next) => set({ default_runtime: next })}
                choices={[
                  {
                    value: 'docker',
                    title: t('specs:docker'),
                    detail: t('specs:dockerHelp'),
                  },
                  {
                    value: 'kvm',
                    title: t('specs:kvm'),
                    detail: t('specs:kvmHelp'),
                  },
                ]}
              />
            </Group>

            <Group
              title={t('specs:resources')}
              summary={`${VM_MEMORY_LABELS[cfg.memory as VmMemoryOption] || cfg.memory} · ${cfg.vcpus} vCPU · ${diskValue || '—'} GB`}
              forceOpen={!!(errors.memory || errors.vcpus || errors.disk_gb)}
              desc={t('specs:resourceHelp')}
            >
              <div className='divide-y'>
                <SettingRow
                  label={t('specs:memory')}
                  desc={
                    cfg.memory === '256m' || cfg.memory === '512m' ? (
                      <span className='text-[color:var(--status-caution)]'>
                        {t('specs:lowMemory')}
                      </span>
                    ) : (
                      t('specs:memoryHelp')
                    )
                  }
                >
                  <Segmented
                    label={t('specs:defaultMemory')}
                    value={cfg.memory as VmMemoryOption}
                    onChange={(next) => {
                      if (isMemoryOption(next)) set({ memory: next })
                    }}
                    options={VM_MEMORY_OPTIONS.map((id) => ({
                      value: id,
                      label: VM_MEMORY_LABELS[id].replace(/ ?([MG])B$/, '$1'),
                    }))}
                  />
                </SettingRow>
                <SettingRow label='vCPU' desc='1–16。'>
                  <div className='space-y-1'>
                    <Select
                      value={String(cfg.vcpus)}
                      onValueChange={(next) => set({ vcpus: Number(next) })}
                    >
                      <SelectTrigger
                        className='w-28'
                        aria-label={t('specs:defaultVcpu')}
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
                    <FieldError text={errors.vcpus} />
                  </div>
                </SettingRow>
                <SettingRow
                  label={t('specs:disk')}
                  desc={t('specs:diskRange', {
                    min: VM_DISK_GB_MIN,
                    max: VM_DISK_GB_MAX,
                  })}
                >
                  <div className='space-y-1'>
                    <div className='flex items-center gap-1.5'>
                      <Input
                        className='w-28 tabular-nums'
                        type='number'
                        min={VM_DISK_GB_MIN}
                        max={VM_DISK_GB_MAX}
                        value={diskValue}
                        onChange={(e) => {
                          const raw = e.target.value
                          set({ disk_gb: raw === '' ? raw : Number(raw) })
                        }}
                        aria-invalid={!!errors.disk_gb}
                        aria-label={t('specs:defaultDisk')}
                      />
                      <span className='text-sm text-muted-foreground'>GB</span>
                    </div>
                    <FieldError text={errors.disk_gb} />
                  </div>
                </SettingRow>
              </div>
            </Group>

            <Group
              title={t('specs:fingerprint')}
              summary={`${isCpuModel(cfg.cpu_model) ? VM_CPU_MODEL_LABELS[cfg.cpu_model] : cfg.cpu_model} · ${macValue || '—'}`}
              forceOpen={!!(errors.cpu_model || errors.mac_oui)}
              desc={t('specs:fingerprintHelp')}
            >
              <div className='divide-y'>
                <SettingRow
                  label={t('specs:cpuModel')}
                  desc={t('specs:cpuHelp')}
                >
                  <Select
                    value={cfg.cpu_model}
                    onValueChange={(next) => {
                      if (isCpuModel(next)) set({ cpu_model: next })
                    }}
                  >
                    <SelectTrigger
                      className='w-56'
                      aria-label={t('specs:cpuModel')}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {VM_CPU_MODELS.map((id) => (
                        <SelectItem key={id} value={id}>
                          {VM_CPU_MODEL_LABELS[id]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </SettingRow>
                <SettingRow
                  label={t('specs:macPrefix')}
                  desc={t('specs:macHelp')}
                >
                  <div className='space-y-1'>
                    <Input
                      className='w-36 font-mono tabular-nums'
                      placeholder='52:54:00'
                      value={macValue}
                      onChange={(e) => set({ mac_oui: e.target.value })}
                      aria-invalid={!!errors.mac_oui}
                      aria-label={t('specs:macPrefix')}
                    />
                    <FieldError text={errors.mac_oui} />
                  </div>
                </SettingRow>
              </div>
              <div className='grid gap-3 pt-1 sm:grid-cols-2'>
                {SMBIOS_FIELDS.map(([key, label]) => (
                  <div key={key} className='space-y-1.5'>
                    <Label htmlFor={`spec-smbios-${key}`}>
                      SMBIOS {t(label)}
                    </Label>
                    <Input
                      id={`spec-smbios-${key}`}
                      value={cfg.smbios[key]}
                      maxLength={64}
                      onChange={(e) =>
                        set({ smbios: { [key]: e.target.value } })
                      }
                    />
                  </div>
                ))}
              </div>
            </Group>

            <Group
              title={t('specs:emulation')}
              summary={cfg.allow_tcg ? t('specs:allowTcg') : t('specs:off')}
            >
              <div className='divide-y'>
                <SettingRow
                  label={t('specs:allowTcg')}
                  desc={t('specs:tcgHelp')}
                >
                  <Switch
                    checked={cfg.allow_tcg}
                    onCheckedChange={(checked) => set({ allow_tcg: checked })}
                    aria-label={t('specs:allowSoftwareTcg')}
                  />
                </SettingRow>
              </div>
              {cfg.allow_tcg ? (
                <p className='text-xs text-[color:var(--status-caution)]'>
                  {tcgWarning()}
                </p>
              ) : null}
            </Group>
          </div>

          <aside className='space-y-6 lg:sticky lg:top-20'>
            <section className='space-y-2'>
              <h4 className='text-xs font-medium text-muted-foreground'>
                {t('specs:localHost')}
              </h4>
              <div className='flex items-center gap-2'>
                <StatusMark tone={tone} variant='pill' />
              </div>
              <p className='text-xs leading-relaxed text-muted-foreground'>
                {!kvm
                  ? t('specs:checkingKvm')
                  : kvm.ok && kvm.accel === 'kvm'
                    ? t('specs:hardwareAcceleration')
                    : kvm.ok
                      ? t('specs:tcgAvailable')
                      : kvm.error || t('specs:containersOnly')}
              </p>
              <p className='text-xs leading-relaxed text-muted-foreground'>
                {t('specs:clusterPreflight')}
              </p>
            </section>
            <section className='space-y-3 border-t pt-5'>
              <div className='space-y-0.5'>
                <h4 className='text-xs font-medium text-muted-foreground'>
                  {t('specs:guestHardware')}
                </h4>
                <p className='text-xs text-muted-foreground'>
                  {t('specs:previewHelp')}
                </p>
              </div>
              <GuestReadout cfg={{ ...cfg, mac_oui: macValue }} />
            </section>
          </aside>
        </div>
      </QueryGate>
      {dirty ? (
        <SaveBar
          blockedReason={firstError}
          saving={save.isPending}
          onSave={() => save.mutate()}
          onDiscard={() => setDraft(server ? { ...server } : {})}
        />
      ) : null}
    </PageHeader>
  )
}
