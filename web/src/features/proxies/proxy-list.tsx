import { useEffect, useRef } from 'react'
import { t as translate } from '@/i18n'
import type { Vm, VmProxySnap } from '@/types/panel-vm'
import {
  ArrowDown,
  ArrowDownWideNarrow,
  ArrowUp,
  ArrowUpNarrowWide,
  Search,
  X,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
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
import type { ProxyHover } from './proxy-hover'
import {
  PROXY_ROW_GRID,
  ProxyRow,
  type ProxyRowActions,
  type ProxyRowPending,
} from './proxy-row'
import {
  PROXY_HEALTH_LABEL,
  type ProxyFilter,
  type ProxySortKey,
  proxyInFilter,
} from './proxy-sort'

const SORT_LABEL: Record<ProxySortKey, string> = {
  get status() {
    return translate('proxies:status')
  },
  get latency() {
    return translate('proxies:latency')
  },
  get seats() {
    return translate('proxies:boundCount')
  },
  get geo() {
    return translate('proxies:exitRegion')
  },
  get host() {
    return translate('proxies:address')
  },
}

const SEAT_FILTERS: { key: ProxyFilter; label: string }[] = [
  {
    key: 'all',
    get label() {
      return translate('proxies:all')
    },
  },
  {
    key: 'open',
    get label() {
      return translate('proxies:hasCapacity')
    },
  },
  {
    key: 'full',
    get label() {
      return translate('proxies:full')
    },
  },
]

/** 表头：可排序的列给按钮，其余只是标签。顺序与 `PROXY_ROW_GRID` 一一对应。 */
const COLUMNS: { label: string; sort?: ProxySortKey; kind?: 'actions' }[] = [
  {
    get label() {
      return translate('proxies:node')
    },
    sort: 'host',
  },
  {
    get label() {
      return translate('proxies:region')
    },
    sort: 'geo',
  },
  {
    get label() {
      return translate('proxies:status')
    },
    sort: 'status',
  },
  {
    get label() {
      return translate('proxies:latency')
    },
    sort: 'latency',
  },
  {
    get label() {
      return translate('proxies:seats')
    },
    sort: 'seats',
  },
  {
    get label() {
      return translate('proxies:boundSlots')
    },
  },
  {
    kind: 'actions',
    get label() {
      return translate('proxies:actions')
    },
  },
]

export function ProxyList({
  all,
  rows,
  vms,
  vmById,
  ownerOf,
  poolLimit,
  query,
  onQuery,
  filter,
  onFilter,
  regionText,
  onClearRegion,
  sortKey,
  sortDir,
  onSort,
  onSortKey,
  onSortDir,
  hover,
  dragVm,
  pending,
  actions,
}: {
  /** 已排序全集，用于筛选计数。 */
  all: VmProxySnap[]
  /** 筛选 + 搜索后的可见行。 */
  rows: VmProxySnap[]
  vms: Vm[]
  vmById: Map<string, Vm>
  ownerOf: Map<string, VmProxySnap>
  poolLimit: number
  query: string
  onQuery: (next: string) => void
  filter: ProxyFilter
  onFilter: (next: ProxyFilter) => void
  /** 当前地区筛选的显示名；空串表示不限地区。 */
  regionText: string
  onClearRegion: () => void
  sortKey: ProxySortKey
  sortDir: 'asc' | 'desc'
  /** 点表头：同一列翻转方向，换列落到该列的自然方向。 */
  onSort: (key: ProxySortKey) => void
  onSortKey: (next: ProxySortKey) => void
  onSortDir: () => void
  hover: ProxyHover
  dragVm: string
  pending: ProxyRowPending
  actions: ProxyRowActions
}) {
  const { t: translate } = useTranslation('proxies')

  const searchRef = useRef<HTMLInputElement>(null)
  const healthFilter = !SEAT_FILTERS.some((f) => f.key === filter)
  const narrowed = !!query || filter !== 'all' || !!regionText

  // `/` 聚焦搜索，和日志页、命令面板的习惯一致；输入框里按 `/` 不拦截。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return
      const el = e.target as HTMLElement | null
      if (el?.closest('input, textarea, select, [contenteditable="true"]')) {
        return
      }
      e.preventDefault()
      searchRef.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <section
      aria-label={translate('proxies:proxyList')}
      className='@container/plist min-w-0 rounded-xl border bg-card'
    >
      <div className='flex flex-wrap items-center gap-2 border-b px-4 py-3'>
        <div className='relative min-w-[200px] flex-1'>
          <Search
            aria-hidden='true'
            className='pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground'
          />
          <Input
            ref={searchRef}
            type='search'
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && query) {
                e.preventDefault()
                onQuery('')
              }
            }}
            placeholder={translate('proxies:filterNodesPlaceholder')}
            aria-label={translate('proxies:filterNodes')}
            className='h-8 ps-8 pe-8 text-sm'
          />
          <kbd className='pointer-events-none absolute top-1/2 right-2 hidden -translate-y-1/2 rounded border bg-muted px-1 font-mono text-[10px] text-muted-foreground sm:block'>
            /
          </kbd>
        </div>

        <div
          role='group'
          aria-label={translate('proxies:filterSeats')}
          className='flex items-center gap-0.5 rounded-lg bg-muted/60 p-0.5'
        >
          {SEAT_FILTERS.map((f) => {
            const n =
              f.key === 'all'
                ? all.length
                : all.filter((p) => proxyInFilter(p, f.key, poolLimit)).length
            const on = filter === f.key
            return (
              <button
                key={f.key}
                type='button'
                aria-pressed={on}
                onClick={() => onFilter(f.key)}
                className={cn(
                  'inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs transition-colors',
                  on
                    ? 'bg-background font-medium text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {f.label}
                <span className='tabular-nums opacity-70'>{n}</span>
              </button>
            )
          })}
        </div>

        {healthFilter ? (
          <ClearChip
            label={
              PROXY_HEALTH_LABEL[filter as keyof typeof PROXY_HEALTH_LABEL]
            }
            onClear={() => onFilter('all')}
          />
        ) : null}
        {regionText ? (
          <ClearChip label={regionText} onClear={onClearRegion} />
        ) : null}

        {/* 宽屏用表头排序；表头隐藏时才需要这组下拉。 */}
        <div className='ms-auto flex items-center gap-1 @5xl/plist:hidden'>
          <Select
            value={sortKey}
            onValueChange={(v) => onSortKey(v as ProxySortKey)}
          >
            <SelectTrigger
              className='h-8 w-[112px] text-xs'
              aria-label={translate('proxies:sortField')}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent align='end'>
              {(Object.keys(SORT_LABEL) as ProxySortKey[]).map((k) => (
                <SelectItem key={k} value={k}>
                  {translate('proxies:sortOption', { field: SORT_LABEL[k] })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size='icon'
            variant='outline'
            className='size-8'
            onClick={onSortDir}
            aria-label={
              sortDir === 'asc'
                ? translate('proxies:switchToDescending')
                : translate('proxies:switchToAscending')
            }
            title={
              sortDir === 'asc'
                ? translate('proxies:ascending')
                : translate('proxies:descending')
            }
          >
            {sortDir === 'asc' ? (
              <ArrowUpNarrowWide />
            ) : (
              <ArrowDownWideNarrow />
            )}
          </Button>
        </div>
      </div>

      {rows.length ? (
        <>
          <div
            className={cn(
              'hidden border-b bg-muted/30 px-4 py-1 text-[11px] font-medium text-muted-foreground',
              PROXY_ROW_GRID
            )}
          >
            {COLUMNS.map((c) =>
              c.sort ? (
                <SortHeader
                  key={c.label}
                  label={c.label}
                  active={sortKey === c.sort}
                  dir={sortDir}
                  // 行首有展开箭头，表头文字对齐到名称上。
                  className={c.sort === 'host' ? 'ms-[18px]' : undefined}
                  onClick={() => onSort(c.sort as ProxySortKey)}
                />
              ) : (
                <span
                  key={c.label}
                  className={cn(c.kind === 'actions' && 'text-center')}
                >
                  {c.label}
                </span>
              )
            )}
          </div>
          <ul className='divide-y divide-border/60'>
            {rows.map((p) => (
              <ProxyRow
                key={p.id}
                proxy={p}
                vms={vms}
                vmById={vmById}
                ownerOf={ownerOf}
                poolLimit={poolLimit}
                hover={hover}
                dragVm={dragVm}
                pending={pending}
                actions={actions}
              />
            ))}
          </ul>
        </>
      ) : (
        <div className='flex flex-col items-center gap-3 px-6 py-16 text-center'>
          <p className='text-sm text-muted-foreground'>
            {all.length
              ? query
                ? translate('proxies:noAvailableNodeMatches')
                : translate('proxies:noProxyMatches')
              : translate('proxies:noProxies')}
          </p>
          {all.length && narrowed ? (
            <Button
              size='sm'
              variant='outline'
              onClick={() => {
                onQuery('')
                onFilter('all')
                onClearRegion()
              }}
            >
              {translate('proxies:clearFilters')}
            </Button>
          ) : null}
        </div>
      )}

      <p className='border-t px-4 py-2 text-[11px] text-muted-foreground'>
        {rows.length === all.length
          ? translate('proxies:proxyCount', { count: all.length })
          : translate('proxies:shownProxyCount', {
              p0: rows.length,
              p1: all.length,
            })}
        {' · '}
        {translate('proxies:credentialsNotShown')}
      </p>
    </section>
  )
}

function ClearChip({ label, onClear }: { label: string; onClear: () => void }) {
  const { t: translate } = useTranslation('proxies')

  return (
    <button
      type='button'
      onClick={onClear}
      className='inline-flex h-7 items-center gap-1 rounded-md bg-primary/10 px-2 text-xs font-medium text-primary transition-colors hover:bg-primary/15'
      aria-label={translate('proxies:clearNamedFilter', { p0: label })}
    >
      {label}
      <X className='size-3' aria-hidden='true' />
    </button>
  )
}

function SortHeader({
  label,
  active,
  dir,
  className,
  onClick,
}: {
  label: string
  active: boolean
  dir: 'asc' | 'desc'
  className?: string
  onClick: () => void
}) {
  const { t: translate } = useTranslation('proxies')

  const Arrow = dir === 'asc' ? ArrowUp : ArrowDown
  return (
    <button
      type='button'
      onClick={onClick}
      aria-label={
        active
          ? translate('proxies:toggleSort', {
              p0: label,
              p1:
                dir === 'asc'
                  ? translate('proxies:ascending')
                  : translate('proxies:descending'),
            })
          : translate('proxies:sortByField', { p0: label })
      }
      className={cn(
        'group -mx-1 inline-flex h-6 w-fit items-center gap-1 rounded px-1 text-start transition-colors hover:text-foreground',
        active && 'text-foreground',
        className
      )}
    >
      {label}
      <Arrow
        aria-hidden='true'
        className={cn(
          'size-3 transition-opacity',
          active ? 'opacity-100' : 'opacity-0 group-hover:opacity-50'
        )}
      />
    </button>
  )
}
