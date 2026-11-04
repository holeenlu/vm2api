import type { ReactNode } from 'react'
import { t as tVm } from '@/i18n'
import {
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  LayoutGrid,
  List,
} from 'lucide-react'
import { useTranslation, Trans } from 'react-i18next'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import type { RackSize } from '@/features/vm/vm-rack-blade'
import type { VmSortKey } from '@/features/vm/vm-table'
import { localizedOption } from './localized-option'

const SORT_CHIPS = [
  localizedOption('status', 'vm:detailAccountTab.status'),
  localizedOption('name', 'vm:createVmForm.name'),
  localizedOption('remain', 'vm:listPage.5HourRemaining'),
  localizedOption('today', 'vm:listPage.todaySCost'),
  localizedOption('cost7', 'vm:listPage.7DayCost'),
  localizedOption('total', 'vm:listPage.totalCost'),
  localizedOption('cache', 'vm:detailAccountTab.cacheHit'),
] as const

function cardSizes(): [RackSize, string, string][] {
  return [
    localizedOption(
      's',
      'vm:listPage.small',
      tVm('vm:listPage.smallCardsViewTheWholeFleet')
    ),
    localizedOption(
      'm',
      'vm:listPage.medium',
      tVm('vm:listPage.mediumCardsRoutineChecks')
    ),
    localizedOption(
      'l',
      'vm:listPage.large',
      tVm('vm:listPage.largeCardsInspectEachSlot')
    ),
  ]
}

export function readPref<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T
): T {
  try {
    const v = localStorage.getItem(key)
    return allowed.includes(v as T) ? (v as T) : fallback
  } catch {
    return fallback
  }
}

export function writePref(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // 隐私模式 / 配额满：本次会话内仍按内存状态生效。
  }
}

/** VM 列表与 Codex 账号列表共用的筛选栏：搜索、排序、卡片尺寸、列表 / 卡片切换。 */
export function VmListToolbar({
  leading,
  q,
  onQ,
  sort,
  onSort,
  dir,
  onDir,
  view,
  onView,
  size,
  onSize,
  trailing,
}: {
  leading?: ReactNode
  q: string
  onQ: (next: string) => void
  sort: VmSortKey
  onSort: (next: VmSortKey) => void
  dir: 'asc' | 'desc'
  onDir: (next: 'asc' | 'desc') => void
  view: 'grid' | 'list'
  onView: (next: 'grid' | 'list') => void
  size: RackSize
  onSize: (next: RackSize) => void
  trailing?: ReactNode
}) {
  const { t } = useTranslation('vm')

  return (
    <div className='mb-4 flex flex-wrap items-center gap-2'>
      {leading}
      <Input
        className='h-8 w-64'
        type='search'
        name='vm-filter'
        autoComplete='off'
        data-1p-ignore
        data-lpignore='true'
        data-bwignore
        placeholder={t('vm:listPage.searchNameEmailProxy')}
        value={q}
        onChange={(e) => onQ(e.target.value)}
      />
      <div className='ms-auto flex flex-wrap items-center gap-2'>
        <span className='text-xs text-muted-foreground'>
          <Trans ns='vm' i18nKey='listPage.sort' />
        </span>
        <Select
          value={sort}
          onValueChange={(next) => {
            onSort(next as VmSortKey)
            onDir(next === 'name' ? 'asc' : 'desc')
          }}
        >
          <SelectTrigger
            size='sm'
            className='w-28'
            aria-label={t('vm:listPage.sortBy')}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent align='end'>
            {SORT_CHIPS.map(([key, label]) => (
              <SelectItem key={key} value={key}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          size='sm'
          variant='outline'
          title={
            dir === 'asc'
              ? t('vm:listPage.ascending')
              : t('vm:listPage.descending')
          }
          aria-label={
            dir === 'asc'
              ? t('vm:listPage.ascendingSwitchToDescending')
              : t('vm:listPage.descendingSwitchToAscending')
          }
          onClick={() => onDir(dir === 'asc' ? 'desc' : 'asc')}
        >
          {dir === 'asc' ? <ArrowUpNarrowWide /> : <ArrowDownWideNarrow />}
        </Button>
        <Separator orientation='vertical' className='mx-1 h-5' />
        {view === 'grid' ? (
          <div
            role='group'
            aria-label={t('vm:listPage.cardSize')}
            className='inline-flex gap-0.5 rounded-lg bg-muted p-0.5'
          >
            {cardSizes().map(([key, label, title]) => (
              <button
                key={key}
                type='button'
                title={title}
                aria-pressed={size === key}
                onClick={() => onSize(key)}
                className={cn(
                  'h-7 min-w-8 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground',
                  size === key &&
                    'bg-card text-foreground shadow-[0_1px_2px_oklch(0_0_0/12%),0_0_0_1px_var(--border)]'
                )}
              >
                {label}
              </button>
            ))}
          </div>
        ) : null}
        <Button
          size='sm'
          variant={view === 'list' ? 'default' : 'outline'}
          aria-pressed={view === 'list'}
          aria-label={t('vm:listPage.listView')}
          title={t('vm:detailPage.list')}
          onClick={() => onView('list')}
        >
          <List />
        </Button>
        <Button
          size='sm'
          variant={view === 'grid' ? 'default' : 'outline'}
          aria-pressed={view === 'grid'}
          aria-label={t('vm:listPage.gridView')}
          title={t('vm:listPage.grid')}
          onClick={() => onView('grid')}
        >
          <LayoutGrid />
        </Button>
        {trailing}
      </div>
    </div>
  )
}
