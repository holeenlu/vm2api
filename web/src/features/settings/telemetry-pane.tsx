import { useState } from 'react'
import {
  useQueries,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { t as translate } from '@/i18n'
import type { Vm } from '@/types/panel-vm'
import { ArrowRight, ChevronRight, RefreshCw } from 'lucide-react'
import { useTranslation, Trans } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { isCodexVm, slotNameLabel } from '@/lib/vm-kind'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { dashboardQueryOptions } from '@/features/overview/queries'
import { routingQueryOptions } from '@/features/settings/queries'
import {
  ChipGroup,
  StepperSetting,
} from '@/features/settings/scheduler-controls'
import {
  amountIn,
  intervalLabel,
  secondsFrom,
  unitBounds,
  unitOf,
  getUploadIntervalPresets,
  type IntervalUnit,
} from '@/features/settings/telemetry-interval'
import {
  LIVE_ORDER,
  slotState,
  type LiveKey,
  type SlotState,
} from '@/features/settings/telemetry-slot-state'
import {
  relativeAgo,
  summarizeUploads,
  type UploadEntry,
} from '@/features/settings/telemetry-upload-log'
import {
  vmQueryOptions,
  vmSeedUploadLogQueryOptions,
} from '@/features/vm/queries'
import {
  telemetryEnabled,
  telemetrySeedFlags,
} from '@/features/vm/telemetry-policy'

function getLiveStates(): Record<
  LiveKey,
  { legend: string; swatch: string; text: string }
> {
  return {
    live: {
      legend: translate('settings:telemetry.uploading'),
      swatch: 'bg-primary',
      text: 'text-primary',
    },
    idle: {
      legend: translate('settings:telemetry.idle'),
      swatch: 'bg-[var(--status-caution-solid)]',
      text: 'text-[var(--status-caution)]',
    },
    blocked: {
      legend: translate('settings:telemetry.blocked'),
      swatch: 'bg-[var(--status-warn-solid)]',
      text: 'text-[var(--status-warn)]',
    },
    parked: {
      legend: translate('settings:telemetry.parked'),
      swatch: 'bg-[var(--ok-2)]',
      text: 'text-muted-foreground',
    },
    unknown: {
      legend: translate('settings:telemetry.unknown'),
      swatch: 'bg-[var(--status-none)]',
      text: 'text-muted-foreground',
    },
    off: {
      legend: translate('settings:telemetry.off'),
      swatch: 'bg-[var(--track)]',
      text: 'text-muted-foreground',
    },
  }
}

type SeedPutResult = {
  service?: {
    failed_count?: number
    items?: { error?: string }[]
  } | null
}

/** Returns the sidecar restart error, if the seed write itself succeeded but the restart did not. */
async function writeTelemetry(id: string, enabled: boolean) {
  const res = await api<SeedPutResult>(
    `/api/panel/vms/${encodeURIComponent(id)}/seed-settings`,
    { method: 'PUT', body: JSON.stringify(telemetrySeedFlags(enabled)) }
  )
  const svc = res?.service
  if (!svc?.failed_count) return null
  return (
    svc.items?.find((item) => item.error)?.error ||
    translate('settings:telemetry.restartFailed')
  )
}

async function refreshAfterWrite(qc: QueryClient, ids: string[]) {
  await Promise.all([
    qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
    qc.invalidateQueries({ queryKey: ['panel', 'vms'] }),
    ...ids.map((id) => qc.invalidateQueries({ queryKey: ['panel', 'vm', id] })),
  ])
}

function getContract(): {
  file: string
  key: string
  on: string
  off: string
}[] {
  return [
    {
      file: 'settings.json · env',
      key: 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
      on: '"1"',
      off: '"0"',
    },
    {
      file: 'settings.json · env',
      key: 'DISABLE_TELEMETRY',
      on: translate('settings:telemetry.omit'),
      off: '"1"',
    },
    {
      file: 'settings.json · env',
      key: 'DO_NOT_TRACK',
      on: translate('settings:telemetry.omit'),
      off: '"1"',
    },
    {
      file: 'settings.json · env',
      key: 'CLAUDE_CODE_USE_BEDROCK / VERTEX',
      on: '"0"',
      off: '"0"',
    },
    {
      file: 'settings.json',
      key: 'grove_enabled',
      on: 'false',
      off: 'false',
    },
    {
      file: 'kin-seed.json',
      key: 'telemetry',
      on: 'enabled',
      off: 'disabled',
    },
    {
      file: 'run/worker.json',
      key: 'telemetry.enabled',
      on: 'true',
      off: 'false',
    },
  ]
}

function pipeline(interval: number): { title: string; body: string }[] {
  return [
    {
      title: translate('settings:telemetry.seed'),
      body: translate('settings:telemetry.seedHelp'),
    },
    {
      title: translate('settings:telemetry.identity'),
      body: translate('settings:telemetry.identityHelp'),
    },
    {
      title: translate('settings:telemetry.upload'),
      body: translate('settings:telemetry.uploadHelp', {
        value1: intervalLabel(interval),
      }),
    },
    {
      title: translate('settings:telemetry.silent'),
      body: translate('settings:telemetry.silentHelp'),
    },
  ]
}

function IntervalSetting({
  value,
  onChange,
}: {
  value: number
  onChange: (seconds: number) => void
}) {
  const { t } = useTranslation('settings')

  const [unit, setUnit] = useState<IntervalUnit>(() => unitOf(value))
  const [min, max] = unitBounds(unit)
  const switchUnit = (next: IntervalUnit) => {
    setUnit(next)
    const seconds = secondsFrom(amountIn(value, next), next)
    if (seconds !== value) onChange(seconds)
  }
  return (
    <div className='space-y-3 border-t border-[var(--hairline)] pt-4'>
      <StepperSetting
        id='telemetry-upload-interval'
        label={t('telemetry.interval')}
        desc={
          <>
            {
              <>
                {t('telemetry.intervalHelp')}
                {value > 600 ? ' ' + t('telemetry.longInterval') : ''}
              </>
            }
          </>
        }
        value={amountIn(value, unit)}
        min={min}
        max={max}
        unit={unit === 'hour' ? t('hoursUnit') : t('minutesUnit')}
        onChange={(amount) => onChange(secondsFrom(amount, unit))}
      />
      <div className='flex flex-wrap items-center justify-between gap-x-4 gap-y-2'>
        <ChipGroup
          label={t('telemetry.intervalPresets')}
          value={value}
          options={getUploadIntervalPresets()}
          onChange={(seconds) => {
            setUnit(unitOf(seconds))
            onChange(seconds)
          }}
        />
        <ChipGroup<IntervalUnit>
          label={t('unit')}
          value={unit}
          options={[
            ['min', t('minutesUnit')],
            ['hour', t('hoursUnit')],
          ]}
          onChange={switchUnit}
        />
      </div>
    </div>
  )
}

export function TelemetryPane({
  interval,
  onIntervalChange,
}: {
  interval: number
  onIntervalChange: (seconds: number) => void
}) {
  const { t } = useTranslation('settings')

  const qc = useQueryClient()
  const dash = useQuery(dashboardQueryOptions())
  const routing = useQuery(routingQueryOptions())
  const vms: Vm[] = dash.data?.vms || []
  const claude = vms.filter((vm) => !isCodexVm(vm))
  const codexCount = vms.length - claude.length
  const probed = claude.filter(
    (vm) => vm.status === 'running' && telemetryEnabled(vm.seed_policy)
  )
  const details = useQueries({
    queries: probed.map((vm) => ({
      ...vmQueryOptions(vm.id),
      refetchInterval: 20_000,
      refetchOnWindowFocus: false,
    })),
  })
  const detailById = new Map(probed.map((vm, i) => [vm.id, details[i]]))
  const slots = claude.map((vm) => slotState(vm, detailById.get(vm.id)))

  const [busy, setBusy] = useState<Set<string>>(() => new Set())
  const [bulk, setBulk] = useState<{
    enabled: boolean
    done: number
    total: number
    current: string
  } | null>(null)
  const [confirm, setConfirm] = useState<boolean | null>(null)
  const [open, setOpen] = useState<string | null>(null)

  const setOne = async (vm: Vm, enabled: boolean) => {
    setBusy((cur) => new Set(cur).add(vm.id))
    try {
      const svcError = await writeTelemetry(vm.id, enabled)
      if (svcError) {
        toast.warning(
          t(
            enabled
              ? 'telemetry.enabledRestartFailed'
              : 'telemetry.disabledRestartFailed',
            { slot: vm.id, error: svcError }
          )
        )
      } else {
        toast.success(
          t(enabled ? 'telemetry.slotEnabled' : 'telemetry.slotDisabled', {
            slot: vm.id,
          })
        )
      }
    } catch (error) {
      toast.error(
        t('telemetry.slotWriteFailed', {
          value1: vm.id,
          value2: error instanceof Error ? error.message : String(error),
        })
      )
    } finally {
      await refreshAfterWrite(qc, [vm.id])
      setBusy((cur) => {
        const next = new Set(cur)
        next.delete(vm.id)
        return next
      })
    }
  }

  const runBulk = async (enabled: boolean) => {
    const targets = claude.filter(
      (vm) => telemetryEnabled(vm.seed_policy) !== enabled
    )
    setConfirm(null)
    if (!targets.length) return
    const failed: string[] = []
    const restartFailed: string[] = []
    for (const [index, vm] of targets.entries()) {
      setBulk({ enabled, done: index, total: targets.length, current: vm.id })
      try {
        if (await writeTelemetry(vm.id, enabled)) restartFailed.push(vm.id)
      } catch {
        failed.push(vm.id)
      }
    }
    setBulk(null)
    await refreshAfterWrite(
      qc,
      targets.map((vm) => vm.id)
    )
    const ok = targets.length - failed.length
    if (failed.length) {
      toast.error(
        t(
          enabled
            ? 'telemetry.batchEnableFailed'
            : 'telemetry.batchDisableFailed',
          { count: ok, failed: failed.length, errors: failed.join(', ') }
        )
      )
    } else if (restartFailed.length) {
      toast.warning(
        t(
          enabled
            ? 'telemetry.batchEnableRestartFailed'
            : 'telemetry.batchDisableRestartFailed',
          { count: ok, errors: restartFailed.join(', ') }
        )
      )
    } else {
      toast.success(
        t(enabled ? 'telemetry.batchEnabled' : 'telemetry.batchDisabled', {
          count: ok,
        })
      )
    }
  }

  const counts = LIVE_ORDER.map(
    (key) => [key, slots.filter((s) => s.live === key).length] as const
  )
  const onCount = slots.filter((s) => s.on).length
  const toEnable = claude.length - onCount
  const pendingTargets =
    confirm === null
      ? []
      : claude.filter((vm) => telemetryEnabled(vm.seed_policy) !== confirm)
  const pendingRunning = pendingTargets.filter(
    (vm) => vm.status === 'running'
  ).length
  const pendingRemote = pendingTargets.filter((vm) => vm.node_id).length
  const fetching = dash.isFetching || details.some((d) => d.isFetching)
  const steps = pipeline(interval)
  const official = routing.data?.official_cc as
    { sync_telemetry?: boolean } | undefined
  const codex = routing.data?.codex as
    { analytics?: { enabled?: boolean } } | undefined

  return (
    <div className='space-y-3'>
      <Card className='gap-5'>
        <CardHeader className='flex flex-wrap items-start justify-between gap-x-6 gap-y-3'>
          <div className='min-w-0 space-y-1.5'>
            <CardTitle className='text-base'>{t('nav.telemetry')}</CardTitle>
            <p className='max-w-[60ch] text-sm text-muted-foreground'>
              <>
                <Trans
                  t={t}
                  i18nKey='telemetry.description'
                  components={{
                    part1: (
                      <code className='font-mono text-xs text-foreground' />
                    ),
                  }}
                />
                {codexCount
                  ? ' ' + t('telemetry.gptExcluded', { count: codexCount })
                  : ''}
              </>
            </p>
          </div>
          <div className='flex items-center gap-2'>
            <Button
              size='sm'
              disabled={!!bulk || toEnable === 0}
              onClick={() => setConfirm(true)}
            >
              {
                <Trans
                  t={t}
                  i18nKey='telemetry.enableAll'
                  count={toEnable}
                  components={{
                    amount: (
                      <span className='font-mono text-xs tabular-nums opacity-80' />
                    ),
                  }}
                />
              }
            </Button>
            <Button
              size='sm'
              variant='outline'
              disabled={!!bulk || onCount === 0}
              onClick={() => setConfirm(false)}
            >
              {
                <Trans
                  t={t}
                  i18nKey='telemetry.disableAll'
                  count={onCount}
                  components={{
                    amount: (
                      <span className='font-mono text-xs tabular-nums opacity-80' />
                    ),
                  }}
                />
              }
            </Button>
            <Button
              size='icon'
              variant='ghost'
              className='size-8'
              aria-label={t('telemetry.reprobe')}
              disabled={fetching}
              onClick={() => {
                void dash.refetch()
                for (const d of details) void d.refetch()
              }}
            >
              <RefreshCw
                className={cn('size-4', fetching && 'motion-safe:animate-spin')}
              />
            </Button>
          </div>
        </CardHeader>
        <CardContent className='space-y-3'>
          <FleetBar counts={counts} total={slots.length} />
          <div className='flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs'>
            {counts.map(([key, n]) =>
              n ? (
                <span key={key} className='inline-flex items-center gap-1.5'>
                  <span
                    aria-hidden
                    className={cn(
                      'size-2 rounded-[2px]',
                      getLiveStates()[key].swatch
                    )}
                  />
                  <span className='text-muted-foreground'>
                    {getLiveStates()[key].legend}
                  </span>
                  <span className='font-mono text-foreground tabular-nums'>
                    {n}
                  </span>
                </span>
              ) : null
            )}
            <span className='ms-auto font-mono text-muted-foreground tabular-nums'>
              {t('telemetry.enabledRatio', {
                value1: onCount,
                value2: slots.length,
              })}
            </span>
          </div>
          {bulk ? (
            <div
              role='status'
              className='flex items-center gap-3 rounded-md bg-muted/60 px-3 py-2 text-xs'
            >
              <span className='text-muted-foreground'>
                {t(bulk.enabled ? 'telemetry.enabling' : 'telemetry.disabling')}
              </span>
              <span className='font-mono text-foreground'>{bulk.current}</span>
              <span className='relative h-1 flex-1 overflow-hidden rounded-full bg-[var(--track)]'>
                <span
                  className='absolute inset-y-0 left-0 rounded-full bg-primary motion-safe:transition-[width] motion-safe:duration-300'
                  style={{ width: `${(bulk.done / bulk.total) * 100}%` }}
                />
              </span>
              <span className='font-mono text-muted-foreground tabular-nums'>
                {bulk.done}/{bulk.total}
              </span>
            </div>
          ) : null}
          <IntervalSetting value={interval} onChange={onIntervalChange} />
        </CardContent>
      </Card>

      <Card className='gap-0 py-0'>
        {dash.isLoading ? (
          <p className='px-6 py-5 text-sm text-muted-foreground'>
            {t('telemetry.loadingSlots')}
          </p>
        ) : slots.length === 0 ? (
          <p className='px-6 py-5 text-sm text-muted-foreground'>
            {t('telemetry.noSlots')}
          </p>
        ) : (
          <ul className='divide-y divide-[var(--hairline)]'>
            {slots.map((slot) => (
              <SlotRow
                key={slot.vm.id}
                slot={slot}
                busy={busy.has(slot.vm.id) || bulk?.current === slot.vm.id}
                locked={!!bulk}
                open={open === slot.vm.id}
                onToggleOpen={() =>
                  setOpen((cur) => (cur === slot.vm.id ? null : slot.vm.id))
                }
                onSet={(enabled) => void setOne(slot.vm, enabled)}
              />
            ))}
          </ul>
        )}
      </Card>

      <Card className='gap-5'>
        <CardHeader>
          <CardTitle className='text-base'>
            {t('telemetry.seedContract')}
          </CardTitle>
          <p className='text-sm text-muted-foreground'>
            {t('telemetry.seedContractHelp')}
          </p>
        </CardHeader>
        <CardContent>
          <table className='w-full text-sm'>
            <thead>
              <tr className='text-left text-xs text-(--text-tertiary)'>
                <th className='hidden pb-2 font-medium sm:table-cell'>
                  {t('telemetry.file')}
                </th>
                <th className='pb-2 font-medium'>{t('telemetry.key')}</th>
                <th className='w-px pe-4 pb-2 font-medium'>{t('on')}</th>
                <th className='w-px pb-2 font-medium'>{t('telemetry.off')}</th>
              </tr>
            </thead>
            <tbody className='divide-y divide-[var(--hairline)]'>
              {getContract().map((row) => {
                const flips = row.on !== row.off
                return (
                  <tr key={`${row.file}:${row.key}`}>
                    <td className='hidden py-2 pe-4 text-xs whitespace-nowrap text-muted-foreground sm:table-cell'>
                      {row.file}
                    </td>
                    <td className='py-2 pe-4'>
                      <div className='font-mono text-xs break-all text-foreground'>
                        {row.key}
                      </div>
                      <div className='mt-0.5 text-[11px] text-(--text-tertiary) sm:hidden'>
                        {row.file}
                      </div>
                    </td>
                    <td className='py-2 pe-4'>
                      <ValueChip value={row.on} accent={flips} />
                    </td>
                    <td className='py-2'>
                      <ValueChip value={row.off} />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <ol className='mt-6 grid gap-px overflow-hidden rounded-lg bg-[var(--hairline)] sm:grid-cols-2 xl:grid-cols-4'>
            {steps.map((step, i) => (
              <li key={step.title} className='relative bg-card p-4'>
                <div className='flex items-center gap-2 text-sm font-medium'>
                  {step.title}
                  {i < steps.length - 1 ? (
                    <ArrowRight
                      aria-hidden
                      className='size-3.5 text-(--text-tertiary)'
                    />
                  ) : null}
                </div>
                <p className='mt-1.5 text-xs leading-5 text-muted-foreground'>
                  {step.body}
                </p>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>

      <Card className='gap-0 py-0'>
        <ul className='divide-y divide-[var(--hairline)]'>
          <RelatedRow
            label={t('telemetry.syncAfterToken')}
            detail={t('telemetry.syncAfterTokenHelp')}
            on={routing.isLoading ? null : official?.sync_telemetry === true}
            tab='init'
            tabLabel={t('nav.init')}
          />
          <RelatedRow
            label={t('telemetry.codexAnalytics')}
            detail={t('telemetry.gptHelp')}
            on={routing.isLoading ? null : codex?.analytics?.enabled === true}
            tab='openai'
            tabLabel='OpenAI'
          />
        </ul>
      </Card>

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(next) => !next && setConfirm(null)}
        title={
          confirm ? t('telemetry.confirmEnable') : t('telemetry.confirmDisable')
        }
        desc={
          <div className='space-y-2'>
            <p>
              {
                <>
                  {t('telemetry.confirmWrite', {
                    count: pendingTargets.length,
                  })}
                  {pendingRunning
                    ? ' ' +
                      t('telemetry.confirmRunning', { count: pendingRunning })
                    : ''}
                </>
              }
            </p>
            {confirm ? (
              <p>
                {
                  <>
                    {t('telemetry.confirmIdentity')}
                    {pendingRemote
                      ? ' ' +
                        t('telemetry.confirmRemote', { count: pendingRemote })
                      : ''}
                  </>
                }
              </p>
            ) : null}
          </div>
        }
        cancelBtnText={t('cancel')}
        confirmText={confirm ? t('telemetry.enableAction') : t('off')}
        destructive={confirm === false}
        handleConfirm={() => confirm !== null && void runBulk(confirm)}
      />
    </div>
  )
}

function FleetBar({
  counts,
  total,
}: {
  counts: (readonly [LiveKey, number])[]
  total: number
}) {
  useTranslation('settings')

  return (
    <div
      role='img'
      aria-label={counts
        .filter(([, n]) => n)
        .map(([key, n]) => `${getLiveStates()[key].legend} ${n}`)
        .join('，')}
      className='flex h-2.5 gap-0.5 overflow-hidden rounded-full bg-[var(--track)]'
    >
      {total
        ? counts.map(([key, n]) =>
            n ? (
              <span
                key={key}
                className={cn(
                  'h-full first:rounded-s-full last:rounded-e-full motion-safe:transition-[flex-grow] motion-safe:duration-500 motion-safe:[transition-timing-function:var(--ease-out-expo)]',
                  getLiveStates()[key].swatch
                )}
                style={{ flexGrow: n, flexBasis: 0 }}
              />
            ) : null
          )
        : null}
    </div>
  )
}

function Lamp({ live, probing }: { live: LiveKey; probing: boolean }) {
  useTranslation('settings')

  return (
    <span
      aria-hidden
      className={cn(
        'relative inline-flex size-2 shrink-0 rounded-full',
        getLiveStates()[live].swatch,
        live === 'off' && 'bg-muted-foreground/40',
        probing && 'motion-safe:animate-pulse'
      )}
    >
      {live === 'live' ? (
        <span className='absolute inset-0 rounded-full bg-primary/70 motion-safe:animate-ping' />
      ) : null}
    </span>
  )
}

function SlotRow({
  slot,
  busy,
  locked,
  open,
  onToggleOpen,
  onSet,
}: {
  slot: SlotState
  busy: boolean
  locked: boolean
  open: boolean
  onToggleOpen: () => void
  onSet: (enabled: boolean) => void
}) {
  const { t } = useTranslation('settings')

  const { vm, on, live, label, probing } = slot
  const name = slotNameLabel(vm)
  const panelId = `telemetry-log-${vm.id}`
  return (
    <li>
      <div className='grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 py-3 sm:grid-cols-[auto_minmax(0,1fr)_10rem_auto] sm:px-6'>
        <button
          type='button'
          aria-expanded={open}
          aria-controls={panelId}
          aria-label={t(
            open ? 'telemetry.collapseUploads' : 'telemetry.expandUploads',
            { slot: vm.id }
          )}
          onClick={onToggleOpen}
          className='-m-1 rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'
        >
          <ChevronRight
            className={cn(
              'size-4 motion-safe:transition-transform motion-safe:duration-200',
              open && 'rotate-90'
            )}
          />
        </button>
        <div className='min-w-0'>
          <div className='flex min-w-0 items-baseline gap-2'>
            <span className='truncate text-sm font-medium'>{name}</span>
            <span className='shrink-0 font-mono text-xs text-muted-foreground'>
              {vm.id}
            </span>
          </div>
          <div className='mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground sm:hidden'>
            <Lamp live={live} probing={probing} />
            <span className={getLiveStates()[live].text}>{label}</span>
          </div>
          {vm.node_name || vm.node_id ? (
            <div className='mt-0.5 truncate text-xs text-(--text-tertiary)'>
              {t('telemetry.node', { value1: vm.node_name || vm.node_id })}
            </div>
          ) : null}
        </div>
        <div
          className='hidden items-center gap-2 text-xs sm:flex'
          title={
            live === 'blocked'
              ? vm.node_id
                ? t('telemetry.clusterIdentityMissing')
                : t('telemetry.identityMissing')
              : live === 'idle'
                ? t('telemetry.processIdle')
                : undefined
          }
        >
          <Lamp live={live} probing={probing} />
          <span className={getLiveStates()[live].text}>{label}</span>
        </div>
        <div
          role='group'
          aria-label={t('telemetry.switchLabel', { value1: vm.id })}
          className={cn(
            'inline-flex rounded-md border border-[var(--hairline)] bg-muted/40 p-0.5',
            busy && 'opacity-70'
          )}
        >
          {([true, false] as const).map((value) => {
            const active = on === value
            return (
              <button
                key={String(value)}
                type='button'
                aria-pressed={active}
                aria-label={t(
                  value ? 'telemetry.enableSlot' : 'telemetry.disableSlot',
                  { slot: vm.id }
                )}
                disabled={busy || locked || active}
                onClick={() => onSet(value)}
                className={cn(
                  'min-w-9 rounded-[5px] px-2.5 py-1 text-xs font-medium transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-default',
                  active
                    ? value
                      ? 'bg-accent text-accent-foreground'
                      : 'bg-secondary text-foreground'
                    : 'text-muted-foreground enabled:hover:text-foreground'
                )}
              >
                {busy && !active ? '…' : value ? t('on') : t('telemetry.off')}
              </button>
            )
          })}
        </div>
      </div>
      {open ? (
        <UploadPanel
          id={vm.id}
          panelId={panelId}
          on={on}
          remote={!!vm.node_id}
        />
      ) : null}
    </li>
  )
}

function UploadPanel({
  id,
  panelId,
  on,
  remote,
}: {
  id: string
  panelId: string
  on: boolean
  remote: boolean
}) {
  const { t } = useTranslation('settings')

  const log = useQuery({
    ...vmSeedUploadLogQueryOptions(id),
    refetchInterval: 10_000,
  })
  const summary = summarizeUploads(log.data || [])
  const now = Date.now()
  return (
    <div
      id={panelId}
      className='animate-settings-pane-in space-y-3 border-t border-[var(--hairline)] bg-muted/25 px-4 py-4 sm:ps-13 sm:pe-6'
    >
      {log.isLoading ? (
        <p className='text-xs text-muted-foreground'>
          {t('telemetry.loadingUploads')}
        </p>
      ) : log.error ? (
        <p className='text-xs text-destructive'>
          {t('telemetry.uploadsFailed', {
            value1: (log.error as Error).message,
          })}
        </p>
      ) : summary.entries.length === 0 ? (
        <p className='text-xs text-muted-foreground'>
          {remote
            ? t('telemetry.clusterUploadsUnavailable')
            : on
              ? t('telemetry.noUploads')
              : t('telemetry.disabledNoUploads')}
        </p>
      ) : (
        <>
          <dl className='flex flex-wrap gap-x-6 gap-y-1 text-xs'>
            <Stat label={t('telemetry.lastUpload')}>
              {summary.last ? relativeAgo(summary.last, now) : '—'}
            </Stat>
            <Stat label={t('telemetry.batches')}>{summary.batch}</Stat>
            <Stat label='GrowthBook'>{summary.evals}</Stat>
            <Stat label={t('failed')} tone={summary.failed ? 'bad' : undefined}>
              {summary.failed}
            </Stat>
            <span className='text-(--text-tertiary)'>
              {t('telemetry.recentEntries', {
                count: Number(summary.entries.length),
              })}
            </span>
          </dl>
          <Timeline
            entries={summary.entries}
            first={summary.first}
            last={summary.last}
          />
          <details className='group'>
            <summary className='inline-flex cursor-pointer items-center gap-1 rounded text-xs text-muted-foreground select-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'>
              <ChevronRight className='size-3.5 group-open:rotate-90 motion-safe:transition-transform' />
              {t('telemetry.rawRecords')}
            </summary>
            <pre className='mt-2 max-h-64 overflow-auto rounded-md bg-background/60 px-3 py-2 font-mono text-[11px] leading-5 text-foreground'>
              {[...(log.data || [])].reverse().join('\n')}
            </pre>
          </details>
        </>
      )}
    </div>
  )
}

function Stat({
  label,
  tone,
  children,
}: {
  label: string
  tone?: 'bad'
  children: React.ReactNode
}) {
  return (
    <div className='flex items-baseline gap-1.5'>
      <dt className='text-muted-foreground'>{label}</dt>
      <dd
        className={cn(
          'font-mono tabular-nums',
          tone === 'bad' ? 'text-[var(--status-bad)]' : 'text-foreground'
        )}
      >
        {children}
      </dd>
    </div>
  )
}

function clock(at: number) {
  return new Date(at).toLocaleTimeString('zh-CN', { hour12: false })
}

function Timeline({
  entries,
  first,
  last,
}: {
  entries: UploadEntry[]
  first: number | null
  last: number | null
}) {
  const { t } = useTranslation('settings')

  if (first === null || last === null) return null
  const span = last - first
  return (
    <div>
      <div className='relative h-7 rounded-md bg-background/50'>
        <span
          aria-hidden
          className='absolute inset-x-2 top-1/2 h-px bg-[var(--hairline)]'
        />
        {entries.map((entry, i) => {
          const x = span > 0 ? (entry.at - first) / span : 0.5
          return (
            <span
              key={`${entry.at}:${i}`}
              title={`${clock(entry.at)} · ${entry.kind}${entry.name ? ` ${entry.name}` : ''} · ${entry.state}`}
              className={cn(
                'absolute top-1/2 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full',
                !entry.ok
                  ? 'h-5 bg-[var(--status-bad)]'
                  : entry.kind === 'eval'
                    ? 'h-5 bg-[var(--chart-2)]'
                    : 'h-3 bg-primary'
              )}
              style={{ left: `calc(0.5rem + ${x} * (100% - 1rem))` }}
            />
          )
        })}
      </div>
      <div className='mt-1 flex items-center justify-between font-mono text-[11px] text-(--text-tertiary) tabular-nums'>
        <span>{clock(first)}</span>
        <span className='flex items-center gap-3 font-sans'>
          <Key swatch='bg-primary' label={t('telemetry.batches')} />
          <Key swatch='bg-[var(--chart-2)]' label='GrowthBook' />
          <Key swatch='bg-[var(--status-bad)]' label={t('failed')} />
        </span>
        <span>{clock(last)}</span>
      </div>
    </div>
  )
}

function Key({ swatch, label }: { swatch: string; label: string }) {
  return (
    <span className='inline-flex items-center gap-1'>
      <span aria-hidden className={cn('h-2.5 w-[3px] rounded-full', swatch)} />
      {label}
    </span>
  )
}

function ValueChip({ value, accent }: { value: string; accent?: boolean }) {
  const literal = /^(".*"|true|false|enabled|disabled)/.test(value)
  return (
    <span
      className={cn(
        'inline-flex rounded px-1.5 py-0.5 text-xs whitespace-nowrap',
        literal ? 'font-mono' : '',
        accent
          ? 'bg-accent text-accent-foreground'
          : 'bg-muted text-muted-foreground'
      )}
    >
      {value}
    </span>
  )
}

function RelatedRow({
  label,
  detail,
  on,
  tab,
  tabLabel,
}: {
  label: string
  detail: string
  on: boolean | null
  tab: 'init' | 'openai'
  tabLabel: string
}) {
  const { t } = useTranslation('settings')

  return (
    <li className='flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3.5 sm:px-6'>
      <div className='min-w-48 flex-1'>
        <div className='text-sm font-medium'>{label}</div>
        <p className='text-xs text-muted-foreground'>{detail}</p>
      </div>
      <span
        className={cn(
          'font-mono text-xs',
          on ? 'text-primary' : 'text-muted-foreground'
        )}
      >
        {on === null ? '…' : on ? t('on') : t('telemetry.off')}
      </span>
      <Link
        to='/settings/$tab'
        params={{ tab }}
        className='inline-flex items-center gap-1 rounded text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'
      >
        {t('telemetry.editIn', { page: tabLabel })}
        <ArrowRight className='size-3' aria-hidden />
      </Link>
    </li>
  )
}
