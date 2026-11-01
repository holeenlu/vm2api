import { useRef, useState } from 'react'
import {
  BarChart3,
  ChevronDown,
  Edit3,
  Info,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Settings2,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useNow } from '@/hooks/use-now'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { AccountPlatformChip } from '@/components/account-platform-chip'
import { ConfirmDialog } from '@/components/confirm-dialog'
import {
  DateRangePicker,
  dateRangeValueForPreset,
} from '@/components/date-range-picker'
import { QuotaWindowRow } from '@/features/vm/usage-windows'
import { canReauthorizeAccount } from '../../../../src/shared/vendor-account-filters.mjs'
import {
  accountRowsCsv,
  setAccountStatuses,
  type AccountStatus,
  type AccountStatusResult,
} from './account-actions'
import { AccountEditor } from './account-editor'
import { AccountIdentity } from './account-identity'
import { AccountProfileRefresh } from './account-profile-refresh'
import { AccountUsageDialog } from './account-usage-dialog'
import {
  accountSummary,
  accountStatusView,
  filterAccounts,
  quotaWindows,
  FAILURE_CATEGORIES,
  EMPTY_FILTERS,
  money,
  number,
  time,
  stateLabel,
  type Resource,
  type AccountFilters,
} from './portal-model'

const COLUMNS = [
  'platform',
  'groups',
  'quota',
  'concurrency',
  'priority',
  'today',
  'total',
  'notes',
  'cache',
  'created',
] as const
const selectClass =
  'h-9 min-w-0 max-w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30 sm:max-w-56'
const cardClass = 'min-w-0 overflow-hidden rounded-xl border bg-card shadow-sm'
const tones = {
  normal: 'bg-[var(--status-ok-solid)]',
  near: 'bg-[var(--status-caution-solid)]',
  full: 'bg-[var(--status-bad-solid)]',
  unknown: 'bg-[var(--status-none)]/40',
}
function exportRows(rows: Resource[]) {
  const url = URL.createObjectURL(
    new Blob([accountRowsCsv(rows)], { type: 'text/csv;charset=utf-8' })
  )
  const a = document.createElement('a')
  a.href = url
  a.download = 'supplier-accounts.csv'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

type Props = {
  rows: Resource[]
  admin?: boolean
  apiBase?: string
  onVmSettings?: (r: Resource) => void
  vendorId: string
  vendorName: string
  scope: string
  scopes: { id: string; name: string }[]
  loading: boolean
  error: Error | null
  busy: boolean
  updatedAt: number
  canManage: boolean
  canCreate: boolean
  refreshSeconds: number
  onScope: (scope: string) => void
  onRefreshSeconds: (n: number) => void
  onRefresh: () => void | Promise<unknown>
  onCreate: () => void
  onDetail: (r: Resource) => void
  onAuthorize: (r: Resource) => void
  onSetStatus: (r: Resource, status: AccountStatus) => Promise<unknown>
  onDelete: (r: Resource) => Promise<void>
  canViewUsage: boolean
}

export function AccountWorkbench(props: Props) {
  const { t } = useTranslation('vendor')
  const now = useNow()
  const { rows, vendorId } = props
  const showVendor = props.admin === true
  const [overviewOpen, setOverviewOpen] = useState(true)
  const [filtersOpen, setFiltersOpen] = useState(true)
  const [draft, setDraft] = useState<AccountFilters>({ ...EMPTY_FILTERS })
  const applied = draft
  const [page, setPage] = useState(0)
  const [size, setSize] = useState(20)
  const [selected, setSelected] = useState(new Set<string>())
  const statusPending = useRef(false)
  const [progress, setProgress] = useState<{
    done: number
    total: number
  } | null>(null)
  const [statusResult, setStatusResult] = useState<AccountStatusResult | null>(
    null
  )
  const [refreshError, setRefreshError] = useState('')
  const busy = props.busy || progress !== null
  const [statsAccount, setStatsAccount] = useState<Resource | null>(null)
  const [editing, setEditing] = useState<Resource | null>(null)
  const [deleting, setDeleting] = useState<Resource | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  const [hidden, setHidden] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(
        localStorage.getItem('vendor-columns:' + vendorId) || '[]'
      )
      return Array.isArray(saved)
        ? saved.filter((key) => COLUMNS.includes(key))
        : []
    } catch {
      return []
    }
  })
  const visible = (key: string) => !hidden.includes(key)
  const changeColumn = (key: string, show: boolean) => {
    const next = show ? hidden.filter((k) => k !== key) : [...hidden, key]
    setHidden(next)
    try {
      localStorage.setItem('vendor-columns:' + vendorId, JSON.stringify(next))
    } catch {
      /* Browsing remains usable when storage is disabled. */
    }
  }
  const summary = accountSummary(rows)
  const filtered = filterAccounts(
    rows,
    applied.search,
    applied.platform,
    applied.status,
    applied
  )
  const currentPage = Math.min(
    page,
    Math.max(0, Math.ceil(filtered.length / size) - 1)
  )
  const pageRows = filtered.slice(currentPage * size, (currentPage + 1) * size)
  const own = (r: Resource) =>
    props.canManage &&
    (props.admin || r.vendor_id === vendorId) &&
    r.status !== 'archived'
  const selectable = pageRows.filter(own)
  const allSelected =
    selectable.length > 0 && selectable.every((r) => selected.has(r.id))
  const selectedRows = filtered.filter((r) => own(r) && selected.has(r.id))
  const groups = [
    ...new Map(
      rows.flatMap((r) => r.groups || []).map((g) => [String(g.id), g])
    ).values(),
  ]
  const setFilter = (key: keyof AccountFilters, value: string) => {
    setDraft((old) => ({
      ...old,
      [key]: value,
      ...(key === 'platform' ? { group: 'all', method: 'all' } : {}),
    }))
    setPage(0)
    setSelected(new Set())
  }
  const reset = () => {
    setDraft({ ...EMPTY_FILTERS })
    setPage(0)
    setSelected(new Set())
  }
  const changeStatus = async (targets: Resource[], status: AccountStatus) => {
    if (statusPending.current || busy || props.loading || !targets.length)
      return
    statusPending.current = true
    setProgress({ done: 0, total: targets.length })
    setStatusResult(null)
    setRefreshError('')
    try {
      const result = await setAccountStatuses(
        targets,
        status,
        props.onSetStatus,
        (row, ok, done) => {
          if (ok)
            setSelected((old) => {
              const next = new Set(old)
              next.delete(row.id)
              return next
            })
          setProgress({ done, total: targets.length })
        }
      )
      setStatusResult(result)
      try {
        await props.onRefresh()
      } catch {
        setRefreshError(t('wb.refreshFailed'))
      }
    } finally {
      statusPending.current = false
      setProgress(null)
    }
  }
  const remove = async () => {
    if (!deleting || deleteBusy) return
    setDeleteBusy(true)
    setDeleteError('')
    try {
      await props.onDelete(deleting)
      setDeleting(null)
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : t('updateFailed'))
    } finally {
      setDeleteBusy(false)
    }
  }
  const throughput = (v: number | null) => (props.loading ? '—' : number(v))
  return (
    <section
      className='min-w-0 space-y-5'
      data-testid='supplier-account-workbench'
    >
      <div className='flex flex-wrap items-end justify-between gap-3'>
        <div className='min-w-0'>
          <h1 className='text-2xl font-bold tracking-tight'>
            {t('view.accounts')}
          </h1>
          <p className='mt-1 text-sm text-muted-foreground'>
            {props.admin
              ? t('supplierAdmin:accountsDescription')
              : t(props.scope ? 'scopeReadOnly' : 'manageResources')}
          </p>
        </div>
        <div className='flex flex-wrap items-center gap-2'>
          <Button
            variant='outline'
            disabled={props.loading || busy}
            onClick={props.onRefresh}
          >
            <RefreshCw className={props.loading ? 'animate-spin' : ''} />
            {t('refresh')}
          </Button>
          {props.canManage && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant='outline' disabled={props.loading || busy}>
                  <MoreHorizontal />
                  {t('wb.moreActions')}
                  <ChevronDown />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align='end'>
                <DropdownMenuItem
                  disabled={!selectedRows.length || busy}
                  onSelect={() => void changeStatus(selectedRows, 'paused')}
                >
                  {t('wb.pauseSelected')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!selectedRows.length || busy}
                  onSelect={() => void changeStatus(selectedRows, 'active')}
                >
                  {t('wb.resumeSelected')}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  disabled={!selectedRows.length || busy || props.loading}
                  onSelect={() => exportRows(selectedRows)}
                >
                  {t('wb.exportSelected')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {props.canCreate && (
            <Button disabled={busy} onClick={props.onCreate}>
              <Plus />
              {t('addAccount')}
            </Button>
          )}
        </div>
      </div>
      {progress && (
        <p role='status' className='text-sm text-muted-foreground'>
          {t('wb.statusProgress', progress)}
        </p>
      )}
      {statusResult && (
        <div
          role={statusResult.failed.length ? 'alert' : 'status'}
          className='space-y-1 text-sm'
        >
          <p>
            {t('wb.statusResult', {
              succeeded: statusResult.succeeded.length,
              failed: statusResult.failed.length,
            })}
          </p>
          {statusResult.failed.length > 0 && (
            <ul className='max-h-40 overflow-auto text-destructive'>
              {statusResult.failed.map((row) => (
                <li key={row.id}>
                  {row.name}:{' '}
                  {row.error instanceof Error
                    ? row.error.message
                    : t('updateFailed')}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {refreshError && (
        <p role='alert' className='text-sm text-destructive'>
          {refreshError}
        </p>
      )}
      <section className={cardClass} aria-label={t('accountOverviewMine')}>
        <div className='flex flex-wrap items-center justify-between gap-2 px-4 py-3'>
          <h2 className='text-sm font-semibold'>
            {props.scope
              ? t('accountOverviewScoped')
              : t('accountOverviewMine')}
          </h2>
          <div className='flex flex-wrap items-center gap-2 text-xs text-muted-foreground'>
            <time>
              {props.updatedAt
                ? time(new Date(props.updatedAt).toISOString())
                : '—'}
            </time>
            <label className='flex items-center gap-2'>
              {t('autoRefresh')}
              <select
                className={selectClass}
                value={props.refreshSeconds}
                onChange={(e) => props.onRefreshSeconds(Number(e.target.value))}
              >
                <option value={0}>{t('off')}</option>
                <option value={60}>{t('oneMinute')}</option>
                <option value={300}>{t('fiveMinutes')}</option>
              </select>
            </label>
            <Button
              variant='ghost'
              size='sm'
              aria-expanded={overviewOpen}
              onClick={() => setOverviewOpen(!overviewOpen)}
            >
              {t(overviewOpen ? 'wb.collapse' : 'wb.expand')}
              <ChevronDown className={overviewOpen ? 'rotate-180' : ''} />
            </Button>
          </div>
        </div>
        {overviewOpen && (
          <>
            <div className='grid gap-5 px-4 pb-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.8fr)]'>
              <div className='grid min-w-0 grid-cols-2 gap-4 rounded-lg bg-muted/30 p-4 sm:grid-cols-[0.8fr_1fr_1fr]'>
                <div className='col-span-2 sm:col-span-1'>
                  <p className='text-xs text-muted-foreground'>
                    {t('totalAccounts')}
                  </p>
                  <p className='mt-2 text-2xl font-semibold tabular-nums'>
                    {summary.total}
                  </p>
                </div>
                <div className='grid gap-2 text-xs'>
                  <span className='flex justify-between gap-2'>
                    {t('availableAccounts')}
                    <b className='text-base text-[var(--status-ok)] tabular-nums'>
                      {summary.available}
                    </b>
                  </span>
                  <span className='flex justify-between gap-2'>
                    {t('wb.abnormal')}
                    <b className='text-base text-[var(--status-bad)] tabular-nums'>
                      {summary.abnormal}
                    </b>
                  </span>
                </div>
                <div className='grid gap-2 text-xs'>
                  <span className='flex justify-between gap-2'>
                    {t('wb.cooling')}
                    <b className='text-base text-[var(--status-caution)] tabular-nums'>
                      {summary.cooling}
                    </b>
                  </span>
                  <span className='flex justify-between gap-2'>
                    {t('wb.disabled')}
                    <b className='text-base'>{summary.disabled}</b>
                  </span>
                </div>
              </div>
              <div className='grid min-w-0 grid-cols-2 gap-4 sm:grid-cols-3 2xl:grid-cols-5'>
                {[
                  [t('wb.rpm'), throughput(summary.rpm), t('wb.recentMinute')],
                  [
                    t('wb.tpm'),
                    throughput(summary.tpmWithCache),
                    t('wb.includesCache'),
                  ],
                  [
                    t('wb.tpmWithoutCache'),
                    throughput(summary.tpm),
                    t('wb.inputOutput'),
                  ],
                  [
                    t('liveConcurrency'),
                    throughput(summary.inflight) +
                      ' / ' +
                      (summary.capacity === 0 && summary.total > 0
                        ? t('unlimited')
                        : throughput(summary.capacity)),
                    '',
                  ],
                  [
                    t('wb.quotaLoad'),
                    throughput(summary.nearLimit),
                    t('wb.quotaThresholds'),
                  ],
                ].map(([label, value, hint]) => (
                  <div key={label} className='min-w-0'>
                    <p className='text-xs text-muted-foreground'>{label}</p>
                    <p className='mt-2 text-xl font-semibold break-words tabular-nums'>
                      {value}
                    </p>
                    <p className='mt-1 text-[11px] text-muted-foreground'>
                      {hint}
                    </p>
                  </div>
                ))}
              </div>
            </div>
            <div className='grid gap-5 border-t px-4 py-3 md:grid-cols-3'>
              {(['5h', '7d', 'fable'] as const).map((key) => {
                const dist = summary.distributions[key]
                return (
                  <div key={key}>
                    <h3 className='text-xs font-medium'>
                      {t('wb.window.' + key)}{' '}
                      <span className='text-muted-foreground'>
                        · {dist.total}
                      </span>
                    </h3>
                    <div
                      className='my-2 flex h-1 overflow-hidden rounded-full bg-muted'
                      aria-hidden
                    >
                      {(['normal', 'near', 'full', 'unknown'] as const).map(
                        (type) => (
                          <span
                            key={type}
                            className={tones[type]}
                            style={{
                              width:
                                (dist.total
                                  ? (dist[type] / dist.total) * 100
                                  : 0) + '%',
                            }}
                          />
                        )
                      )}
                    </div>
                    <div className='flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground'>
                      {(['normal', 'near', 'full', 'unknown'] as const).map(
                        (type) => (
                          <span key={type}>
                            {t('wb.distribution.' + type)} {dist[type]}
                          </span>
                        )
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </>
        )}
      </section>
      <section className={cardClass}>
        <fieldset className='min-w-0 space-y-4 border-b p-4' disabled={busy}>
          <div className='flex min-w-0 flex-wrap items-center gap-3'>
            <select
              className={selectClass + ' w-full sm:w-auto'}
              aria-label={t('vendorFilter')}
              value={props.scope}
              onChange={(e) => {
                props.onScope(e.target.value)
                setPage(0)
                setSelected(new Set())
              }}
            >
              {props.scopes.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <div className='relative min-w-0 flex-1 basis-56 sm:max-w-sm'>
              <Search className='absolute start-3 top-2.5 size-4 text-muted-foreground' />
              <Input
                className='h-9 w-full ps-9'
                aria-label={t('searchResources')}
                placeholder={t('searchPlaceholder')}
                value={draft.search}
                onChange={(e) => setFilter('search', e.target.value)}
              />
            </div>
            <div className='flex flex-wrap items-center gap-2 sm:ms-auto'>
              <Button variant='ghost' size='sm' type='button' onClick={reset}>
                {t('wb.clearFilters')}
              </Button>
              <Button
                variant='ghost'
                size='sm'
                type='button'
                aria-expanded={filtersOpen}
                onClick={() => setFiltersOpen(!filtersOpen)}
              >
                {t(filtersOpen ? 'wb.collapseFilters' : 'wb.moreFilters')}
                <ChevronDown className={filtersOpen ? 'rotate-180' : ''} />
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant='outline' size='sm' type='button'>
                    <Settings2 />
                    {t('wb.columns')}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align='end'>
                  {COLUMNS.map((key) => (
                    <DropdownMenuCheckboxItem
                      key={key}
                      checked={visible(key)}
                      onSelect={(e) => e.preventDefault()}
                      onCheckedChange={(value) => changeColumn(key, value)}
                    >
                      {t('wb.column.' + key)}
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
          {filtersOpen && (
            <div className='flex min-w-0 flex-wrap items-center gap-3 border-t pt-4 [&>select]:w-full sm:[&>select]:w-auto'>
              <select
                className={selectClass}
                aria-label={t('platformFilter')}
                value={draft.platform}
                onChange={(e) => setFilter('platform', e.target.value)}
              >
                <option value='all'>{t('allPlatforms')}</option>
                <option value='anthropic'>{t('wb.claude')}</option>
                <option value='openai'>{t('wb.openai')}</option>
              </select>
              <select
                className={selectClass}
                aria-label={t('statusFilter')}
                value={draft.status}
                onChange={(e) => setFilter('status', e.target.value)}
              >
                <option value='all'>{t('allStatuses')}</option>
                {['normal', 'error', 'paused'].map((key) => (
                  <option key={key} value={key}>
                    {key === 'error'
                      ? t('wb.abnormal')
                      : key === 'paused'
                        ? t('wb.disabled')
                        : stateLabel(key)}
                  </option>
                ))}
              </select>
              <select
                className={selectClass}
                aria-label={t('groups')}
                value={draft.group}
                onChange={(e) => setFilter('group', e.target.value)}
              >
                <option value='all'>{t('wb.allGroups')}</option>
                {groups
                  .filter(
                    (g) =>
                      draft.platform === 'all' ||
                      g.platform === 'mixed' ||
                      g.platform === draft.platform
                  )
                  .map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
              </select>
              <select
                className={selectClass}
                aria-label={t('authMethod')}
                value={draft.method}
                onChange={(e) => setFilter('method', e.target.value)}
              >
                <option value='all'>{t('wb.allMethods')}</option>
                {(draft.platform === 'openai'
                  ? ['oauth']
                  : ['oauth', 'setup-token', 'apikey']
                ).map((key) => (
                  <option key={key} value={key}>
                    {t('wb.method.' + key)}
                  </option>
                ))}
              </select>
              <select
                className={selectClass}
                aria-label={t('filters.cooldown')}
                value={draft.cooldown}
                onChange={(e) => setFilter('cooldown', e.target.value)}
              >
                {['all', 'cooling', 'available', '5h', '7d', 'fable'].map(
                  (key) => (
                    <option key={key} value={key}>
                      {t('filters.cooldownOptions.' + key)}
                    </option>
                  )
                )}
              </select>
              <select
                className={selectClass}
                aria-label={t('filters.schedulable')}
                value={draft.schedulable}
                onChange={(e) => setFilter('schedulable', e.target.value)}
              >
                {['all', 'yes', 'no'].map((key) => (
                  <option key={key} value={key}>
                    {t('filters.scheduleOptions.' + key)}
                  </option>
                ))}
              </select>
              <label className='flex min-h-9 items-center gap-2 text-sm'>
                <input
                  type='checkbox'
                  className='size-4 rounded border-input accent-primary focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50'
                  checked={draft.archived === 'only'}
                  onChange={(e) =>
                    setFilter('archived', e.target.checked ? 'only' : 'exclude')
                  }
                />
                {t('filters.archived')}
              </label>
              <select
                className={selectClass}
                aria-label={t('wb.sort')}
                value={draft.sort}
                onChange={(e) => setFilter('sort', e.target.value)}
              >
                {[
                  'created_desc',
                  'created_asc',
                  'name_asc',
                  'cost_desc',
                  'cost_asc',
                  'fable_desc',
                  'fable_asc',
                  'quota_desc',
                ].map((key) => (
                  <option key={key} value={key}>
                    {t('wb.sortBy.' + key)}
                  </option>
                ))}
              </select>
              <DateRangePicker
                className='max-w-full min-w-0'
                value={{ startDate: draft.from, endDate: draft.to }}
                disableFuture
                presets={[
                  'today',
                  'yesterday',
                  '7days',
                  '30days',
                  'thisMonth',
                  'lastMonth',
                ].map((id) => ({
                  id,
                  label: t('details.rangeLabel.' + id),
                  value: dateRangeValueForPreset(
                    id as Parameters<typeof dateRangeValueForPreset>[0]
                  ),
                }))}
                labels={{
                  empty: t('wb.createdFrom'),
                  clear: t('clear'),
                }}
                onChange={(value) => {
                  setFilter('from', value.startDate || '')
                  setFilter('to', value.endDate || '')
                }}
              />
            </div>
          )}
        </fieldset>
        <div className='flex items-center gap-2 overflow-x-auto border-b bg-muted/20 px-4 py-3 text-xs whitespace-nowrap'>
          <span className='text-muted-foreground'>
            {t('wb.failureCategory')}
          </span>
          {['all', ...FAILURE_CATEGORIES].map((key) => (
            <button
              type='button'
              key={key}
              aria-pressed={applied.failure === key}
              disabled={busy}
              className={
                'shrink-0 rounded-md border px-2.5 py-1 font-medium transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 ' +
                (applied.failure === key
                  ? 'border-select-border bg-select-surface text-select-fg'
                  : 'border-transparent text-muted-foreground hover:border-border hover:bg-background hover:text-foreground')
              }
              onClick={() => {
                setFilter('failure', key)
              }}
            >
              {t('wb.failure.' + key)}
              {key === 'all' ? '' : ' ' + summary.failures[key]}
            </button>
          ))}
        </div>
        {props.error ? (
          <p role='alert' className='p-8 text-sm text-destructive'>
            {props.error.message}
          </p>
        ) : props.loading ? (
          <p className='p-8 text-center text-sm text-muted-foreground'>
            {t('loading')}
          </p>
        ) : (
          <>
            <div className='overflow-x-auto'>
              <table
                className={
                  'w-full text-xs whitespace-nowrap ' +
                  (showVendor ? 'min-w-[1320px]' : 'min-w-[1120px]')
                }
              >
                <thead className='border-b bg-muted/40 text-muted-foreground'>
                  <tr className='[&_th]:px-3 [&_th]:py-3 [&_th]:text-start [&_th]:font-medium'>
                    <th className='w-8'>
                      <input
                        type='checkbox'
                        className='size-4 rounded border-input accent-primary focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50'
                        aria-label={t('wb.selectPage')}
                        checked={allSelected}
                        disabled={!selectable.length || busy}
                        onChange={(e) =>
                          setSelected((previous) => {
                            const next = new Set(previous)
                            for (const r of selectable)
                              if (e.target.checked) next.add(r.id)
                              else next.delete(r.id)
                            return next
                          })
                        }
                      />
                    </th>
                    <th className='min-w-52'>{t('wb.nameProxy')}</th>
                    {showVendor && <th>{t('vendor')}</th>}
                    {COLUMNS.filter(
                      (key) => key === 'platform' && visible(key)
                    ).map((key) => (
                      <th key={key}>{t('wb.column.' + key)}</th>
                    ))}
                    <th>{t('status')}</th>
                    {COLUMNS.filter(
                      (key) => key !== 'platform' && visible(key)
                    ).map((key) => (
                      <th key={key}>{t('wb.column.' + key)}</th>
                    ))}
                    <th className='sticky end-0 z-10 border-s bg-card'>
                      {t('actions')}
                    </th>
                  </tr>
                </thead>
                <tbody className='divide-y'>
                  {pageRows.map((r) => {
                    const a = r.telemetry
                    const claude = r.config.platform === 'anthropic'
                    const status = accountStatusView(r)
                    const enabled = status.schedulable
                    return (
                      <tr
                        key={r.id}
                        className='transition-colors focus-within:bg-muted/40 hover:bg-muted/40 [&_td]:px-3 [&_td]:py-3 [&_td]:align-middle'
                      >
                        <td>
                          <input
                            type='checkbox'
                            className='size-4 rounded border-input accent-primary focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50'
                            aria-label={t('wb.selectAccount', { name: r.name })}
                            checked={own(r) && selected.has(r.id)}
                            disabled={!own(r) || busy}
                            onChange={(e) =>
                              setSelected((old) => {
                                const next = new Set(old)
                                if (e.target.checked) next.add(r.id)
                                else next.delete(r.id)
                                return next
                              })
                            }
                          />
                        </td>
                        <td
                          className={
                            showVendor ? 'max-w-64' : 'max-w-80 min-w-64'
                          }
                        >
                          <AccountIdentity resource={r} />
                          {r.status === 'archived' && (
                            <p className='mt-1 text-[10px] text-muted-foreground'>
                              {stateLabel('archived')} ·{' '}
                              {time(r.archived_at || r.updated_at)}
                            </p>
                          )}
                        </td>
                        {showVendor && (
                          <td>
                            {r.vendor_id === vendorId
                              ? props.vendorName
                              : props.scopes.find((s) => s.id === r.vendor_id)
                                  ?.name || r.vendor_id}
                          </td>
                        )}
                        {visible('platform') && (
                          <td>
                            <AccountPlatformChip
                              platform={
                                typeof r.config.platform === 'string'
                                  ? r.config.platform
                                  : null
                              }
                            />
                          </td>
                        )}
                        <td>
                          <div className='flex items-center gap-2'>
                            <Switch
                              aria-label={t('wb.scheduling', { name: r.name })}
                              checked={enabled}
                              disabled={
                                !own(r) ||
                                busy ||
                                (status.unavailable && r.status !== 'paused')
                              }
                              onCheckedChange={(checked) =>
                                void changeStatus(
                                  [r],
                                  checked ? 'active' : 'paused'
                                )
                              }
                            />
                            {status.title ? (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span
                                    className={
                                      'rounded-full px-2 py-0.5 text-[11px] ' +
                                      (status.schedulable
                                        ? 'bg-[var(--status-ok-bg)] text-[var(--status-ok)]'
                                        : status.unavailable
                                          ? 'bg-destructive/10 text-destructive'
                                          : 'bg-muted text-muted-foreground')
                                    }
                                    title={status.title}
                                  >
                                    {status.primary}
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent className='max-w-sm whitespace-normal'>
                                  {status.title}
                                </TooltipContent>
                              </Tooltip>
                            ) : (
                              <span
                                className={
                                  'rounded-full px-2 py-0.5 text-[11px] ' +
                                  (status.schedulable
                                    ? 'bg-[var(--status-ok-bg)] text-[var(--status-ok)]'
                                    : status.unavailable
                                      ? 'bg-destructive/10 text-destructive'
                                      : 'bg-muted text-muted-foreground')
                                }
                              >
                                {status.primary}
                              </span>
                            )}
                          </div>
                          {status.credential && !status.title && (
                            <span className='mt-1 inline-flex rounded-full bg-destructive/10 px-2 py-0.5 text-[10px] text-destructive'>
                              {status.credential}
                            </span>
                          )}
                        </td>
                        {visible('groups') && (
                          <td>
                            <div className='flex max-w-36 flex-wrap gap-1'>
                              {r.groups?.length
                                ? r.groups.map((g) => (
                                    <span
                                      key={g.id}
                                      className='rounded-md border bg-muted/40 px-1.5 py-0.5 text-muted-foreground'
                                    >
                                      {g.name}
                                    </span>
                                  ))
                                : '—'}
                            </div>
                          </td>
                        )}
                        {visible('quota') && (
                          <td className='min-w-[300px]'>
                            <div className='grid min-w-0 gap-1'>
                              {quotaWindows(r).map((q) => (
                                <QuotaWindowRow
                                  key={q.key}
                                  w={{
                                    key: q.key,
                                    label: t('wb.shortWindow.' + q.key),
                                    pct: q.value == null ? null : q.value * 100,
                                    note: null,
                                    reset: q.reset,
                                  }}
                                  now={now}
                                  hasToken={a?.has_token === true}
                                  quiet
                                />
                              ))}
                            </div>
                          </td>
                        )}
                        {visible('concurrency') && (
                          <td className='tabular-nums'>
                            {number(a?.inflight)}{' '}
                            <span className='text-muted-foreground'>
                              /{' '}
                              {a?.max_concurrency === 0
                                ? t('unlimited')
                                : number(a?.max_concurrency)}
                            </span>
                          </td>
                        )}
                        {visible('priority') && <td>{number(a?.priority)}</td>}
                        {(['today', 'total'] as const).map((key) => {
                          const total =
                            key === 'today' ? a?.today_cost : a?.total_cost
                          const fable =
                            key === 'today'
                              ? a?.today_fable_cost
                              : a?.fable_cost
                          return (
                            visible(key) && (
                              <td key={key} className='tabular-nums'>
                                <p className='font-semibold'>{money(total)}</p>
                                {claude && (
                                  <dl className='mt-1 grid grid-cols-[auto_1fr] gap-x-3 text-[10px] leading-4 text-muted-foreground'>
                                    <dt>{t('wb.fable')}</dt>
                                    <dd className='text-end'>{money(fable)}</dd>
                                    <dt>{t('wb.nonFable')}</dt>
                                    <dd className='text-end'>
                                      {total != null && fable != null
                                        ? money(Math.max(0, total - fable))
                                        : '—'}
                                    </dd>
                                  </dl>
                                )}
                              </td>
                            )
                          )
                        })}
                        {visible('notes') && (
                          <td className='max-w-40 truncate' title={r.notes}>
                            {r.notes || '—'}
                          </td>
                        )}
                        {visible('cache') && (
                          <td>
                            {a?.cache_hit_rate == null
                              ? '—'
                              : (a.cache_hit_rate * 100).toFixed(1) + '%'}
                          </td>
                        )}
                        {visible('created') && (
                          <td className='text-[11px] text-muted-foreground'>
                            {time(r.created_at)}
                          </td>
                        )}
                        <td className='sticky end-0 border-s bg-card'>
                          <div className='flex items-center gap-0.5'>
                            <Button
                              variant='ghost'
                              size='icon'
                              className='size-7'
                              aria-label={t('detailsButton')}
                              onClick={() => props.onDetail(r)}
                            >
                              <Info className='size-3.5' />
                            </Button>
                            {props.canViewUsage && (
                              <Button
                                variant='ghost'
                                size='icon'
                                className='size-7'
                                aria-label={t('view.usage')}
                                onClick={() => setStatsAccount(r)}
                              >
                                <BarChart3 className='size-3.5' />
                              </Button>
                            )}
                            {own(r) && (
                              <>
                                <Button
                                  variant='ghost'
                                  size='icon'
                                  className='size-7'
                                  aria-label={t('wb.editAccount')}
                                  disabled={busy}
                                  onClick={() => setEditing(r)}
                                >
                                  <Edit3 className='size-3.5' />
                                </Button>
                                <DropdownMenu>
                                  <DropdownMenuTrigger asChild>
                                    <Button
                                      variant='ghost'
                                      size='icon'
                                      className='size-7'
                                      aria-label={t('wb.moreActions')}
                                      disabled={busy}
                                    >
                                      <MoreHorizontal className='size-3.5' />
                                    </Button>
                                  </DropdownMenuTrigger>
                                  <DropdownMenuContent align='end'>
                                    {canReauthorizeAccount(r) && (
                                      <DropdownMenuItem
                                        onSelect={() => props.onAuthorize(r)}
                                      >
                                        {t('wb.authorize')}
                                      </DropdownMenuItem>
                                    )}
                                    {claude && (
                                      <AccountProfileRefresh
                                        resource={r}
                                        apiBase={props.apiBase}
                                        disabled={busy}
                                        onChanged={props.onRefresh}
                                      />
                                    )}
                                    {props.onVmSettings && (
                                      <DropdownMenuItem
                                        onSelect={() => props.onVmSettings?.(r)}
                                      >
                                        {t('supplierAdmin:vmDetails')}
                                      </DropdownMenuItem>
                                    )}
                                    <DropdownMenuItem
                                      className='text-destructive focus:text-destructive'
                                      disabled={busy}
                                      onSelect={() => {
                                        setDeleting(r)
                                        setDeleteError('')
                                      }}
                                    >
                                      {t('details.delete')}
                                    </DropdownMenuItem>
                                  </DropdownMenuContent>
                                </DropdownMenu>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            {!filtered.length && (
              <p className='p-10 text-center text-sm text-muted-foreground'>
                {t('noRecords')}
              </p>
            )}
          </>
        )}
        <div className='flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3 text-xs text-muted-foreground'>
          <div className='flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2'>
            <span>
              {t('wb.pagination', {
                from: filtered.length ? currentPage * size + 1 : 0,
                to: Math.min((currentPage + 1) * size, filtered.length),
                total: filtered.length,
              })}
            </span>
            <label className='flex items-center gap-2'>
              {t('wb.pageSize')}
              <select
                className={selectClass}
                value={size}
                disabled={busy}
                onChange={(e) => {
                  setSize(Number(e.target.value))
                  setPage(0)
                }}
              >
                {[10, 20, 50, 100].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            {selectedRows.length > 0 && (
              <span>{t('wb.selected', { count: selectedRows.length })}</span>
            )}
          </div>
          <div className='flex items-center gap-2'>
            <Button
              variant='outline'
              size='sm'
              disabled={currentPage === 0 || busy}
              onClick={() => setPage(currentPage - 1)}
            >
              {t('previous')}
            </Button>
            <span className='grid size-8 place-items-center rounded-md border border-select-border bg-select-surface font-medium text-select-fg tabular-nums'>
              {currentPage + 1}
            </span>
            <Button
              variant='outline'
              size='sm'
              disabled={(currentPage + 1) * size >= filtered.length || busy}
              onClick={() => setPage(currentPage + 1)}
            >
              {t('next')}
            </Button>
          </div>
        </div>
      </section>
      {statsAccount && (
        <AccountUsageDialog
          resource={statsAccount}
          apiBase={props.apiBase}
          onClose={() => setStatsAccount(null)}
        />
      )}
      {editing && (
        <AccountEditor
          resource={editing}
          apiBase={props.apiBase}
          onClose={() => setEditing(null)}
          onChanged={props.onRefresh}
        />
      )}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(open) => {
          if (!open && !deleteBusy) setDeleting(null)
        }}
        destructive
        title={t('details.deleteAccount')}
        desc={
          <div className='space-y-3'>
            <p>{t('details.deleteHelp', { name: deleting?.name || '' })}</p>
            {deleteError && (
              <p role='alert' className='text-destructive'>
                {deleteError}
              </p>
            )}
          </div>
        }
        confirmText={t('details.delete')}
        isLoading={deleteBusy}
        handleConfirm={() => void remove()}
      />
    </section>
  )
}
