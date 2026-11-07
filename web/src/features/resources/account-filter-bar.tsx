import type { ReactNode } from 'react'
import type { Vm } from '@/types/panel-vm'
import { RotateCcw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { credTypeLabel, type CredType } from '@/lib/cred-type'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SearchSelect } from '@/components/search-select'
import { ZONES, type VmZoneFilter } from '@/features/vm/vm-rack-model'
import {
  FAULT_KINDS,
  faultDistribution,
  hasAccountFilters,
  type AccountFilters,
  type FaultKind,
  type ScheduleFilter,
} from './account-overview-model'

const AUTH_TYPES: CredType[] = [
  'oauth',
  'setup-token',
  'official-setup-token',
  'apikey',
]
const SCHEDULE: ScheduleFilter[] = ['on', 'off', 'unschedulable', 'restricted']

/**
 * 账号筛选栏：状态分区、授权方式、调度可用性、创建时间与故障类型。
 * 故障分布按当前范围计数，点选即筛选，再点取消。
 */
export function AccountFilterBar({
  vms,
  zone,
  onZone,
  leading,
  filters,
  onFilters,
  onReset,
  canReset,
}: {
  /** 当前范围（入口、凭证面、归属）内的账号，用于故障计数。 */
  vms: Vm[]
  zone: VmZoneFilter
  onZone: (next: VmZoneFilter) => void
  /** 排在状态之前的筛选项（供应商、分组），由入口按数据范围提供。 */
  leading?: ReactNode
  filters: AccountFilters
  onFilters: (next: AccountFilters) => void
  onReset: () => void
  canReset: boolean
}) {
  const { t } = useTranslation('vm')
  const faults = faultDistribution(vms)
  const set = (patch: Partial<AccountFilters>) =>
    onFilters({ ...filters, ...patch })
  const faultTotal = FAULT_KINDS.reduce((n, k) => n + faults[k], 0)
  const chip = (
    key: FaultKind | null,
    label: string,
    n: number,
    active: boolean
  ) => (
    <button
      key={key || 'all'}
      type='button'
      aria-pressed={active}
      onClick={() => set({ fault: active || !key ? undefined : key })}
      className={cn(
        'rounded px-1.5 py-0.5 tabular-nums transition-colors hover:bg-accent/60',
        active
          ? 'bg-[color:var(--status-ok-bg)] font-medium text-[color:var(--status-ok)]'
          : n > 0 && key
            ? 'text-foreground'
            : 'text-muted-foreground'
      )}
    >
      {label} {n}
    </button>
  )
  return (
    <div className='mb-3 flex flex-col gap-2 rounded-lg border bg-card px-3 py-2.5'>
      <div className='flex flex-wrap items-center gap-2'>
        {leading}
        <SearchSelect
          label={t('vm:accountFilters.status')}
          value={zone === 'all' ? undefined : zone}
          options={ZONES.map((z) => ({ id: z.key, name: z.label }))}
          allLabel={t('vm:accountFilters.allStatus')}
          searchPlaceholder={t('vm:accountFilters.search')}
          onChange={(v) => onZone((v as VmZoneFilter) || 'all')}
        />
        <SearchSelect
          label={t('vm:accountFilters.authMethod')}
          value={filters.auth}
          options={AUTH_TYPES.map((k) => ({ id: k, name: credTypeLabel(k) }))}
          allLabel={t('vm:accountFilters.allAuth')}
          searchPlaceholder={t('vm:accountFilters.search')}
          onChange={(v) => set({ auth: (v as CredType) || undefined })}
        />
        <SearchSelect
          label={t('vm:accountFilters.schedule')}
          value={filters.schedule}
          options={SCHEDULE.map((k) => ({
            id: k,
            name: t(`vm:accountFilters.scheduleState.${k}`),
          }))}
          allLabel={t('vm:accountFilters.allSchedule')}
          searchPlaceholder={t('vm:accountFilters.search')}
          onChange={(v) =>
            set({ schedule: (v as ScheduleFilter) || undefined })
          }
        />
        <label className='flex items-center gap-1.5 text-xs text-muted-foreground'>
          {t('vm:accountFilters.created')}
          <Input
            type='date'
            className='h-8 w-[9.5rem] text-xs'
            value={filters.createdFrom || ''}
            max={filters.createdTo || undefined}
            aria-label={t('vm:accountFilters.createdFrom')}
            onChange={(e) => set({ createdFrom: e.target.value || undefined })}
          />
          <span>–</span>
          <Input
            type='date'
            className='h-8 w-[9.5rem] text-xs'
            value={filters.createdTo || ''}
            min={filters.createdFrom || undefined}
            aria-label={t('vm:accountFilters.createdTo')}
            onChange={(e) => set({ createdTo: e.target.value || undefined })}
          />
        </label>
        <Button
          type='button'
          size='sm'
          variant='ghost'
          disabled={!canReset && !hasAccountFilters(filters) && zone === 'all'}
          onClick={onReset}
        >
          <RotateCcw />
          {t('vm:accountFilters.reset')}
        </Button>
      </div>
      <div
        role='group'
        aria-label={t('vm:accountFilters.faults')}
        className='flex flex-wrap items-center gap-1 text-[11.5px]'
      >
        <span className='me-1 text-muted-foreground'>
          {t('vm:accountFilters.faults')}
        </span>
        {chip(
          null,
          t('vm:accountFilters.anyFault'),
          faultTotal,
          !filters.fault
        )}
        {FAULT_KINDS.map((k) =>
          chip(
            k,
            t(`vm:accountFilters.fault.${k}`),
            faults[k],
            filters.fault === k
          )
        )}
      </div>
    </div>
  )
}
