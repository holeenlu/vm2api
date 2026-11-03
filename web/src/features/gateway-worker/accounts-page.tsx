import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  BarChart3,
  LayoutGrid,
  List,
  MoreHorizontal,
  Plus,
  RefreshCw,
} from 'lucide-react'
import { Trans, useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useNow } from '@/hooks/use-now'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { EmptyState } from '@/components/empty-state'
import { PageHeader } from '@/components/page-header'
import { CredLaneChip, SlotIdentity } from '@/components/platform-chip'
import { QueryGate } from '@/components/query-gate'
import { SearchSelect } from '@/components/search-select'
import { StatusMark } from '@/components/status-mark'
import { AccountUsageDialog } from '@/features/vendor/account-usage-dialog'
import { VmListSkeleton } from '@/features/vm/list-skeleton'
import { VmCostLedger, VmUsageWindows } from '@/features/vm/usage-windows'
import { GatewayAccountBulkEdit } from './account-bulk-edit'
import { GatewayAccountDialog } from './account-dialog'
import {
  ForecastPanel,
  ProfilePanel,
  ProtectionPanel,
} from './account-runtime-panels'
import {
  GatewayAccountTable,
  type AccountRow,
  type AccountRowAction,
} from './account-table'
import { GatewayAccountTestDialog } from './account-test-dialog'
import {
  accountBase,
  accountQueryKey,
  quotaWindows,
  gatewayAccountAsVm,
  gatewayAccountState as state,
  type GatewayAccount,
  type GatewayAccountState,
  type GatewayCatalog,
  type GatewayCredits,
  type GatewayQuotaResult,
} from './accounts-model'

type Filter = 'all' | GatewayAccountState
function Quota({ row }: { row: AccountRow }) {
  const now = useNow()
  return (
    <div className='min-w-[248px] space-y-2'>
      <VmUsageWindows vm={row.vm} now={now} quiet />
      <VmCostLedger vm={row.vm} />
    </div>
  )
}
function creditText(
  credits: GatewayCredits | undefined,
  t: (key: string) => string
) {
  if (!credits) return t('unknown')
  if (credits.unlimited) return t('codexCreditsUnlimited')
  if (!credits.has_credits) return t('codexCreditsNone')
  return credits.balance ?? t('codexCreditsAvailable')
}
// 额度查询与重置卡：查询读取上游 /wham/usage；消费重置卡在结果不明时复用同一幂等键重试。
function QuotaPanel({
  account,
  onChanged,
}: {
  account: GatewayAccount
  onChanged: () => Promise<unknown>
}) {
  const { t } = useTranslation('common')
  const [result, setResult] = useState<GatewayQuotaResult | null>(null)
  const [pending, setPending] = useState<'query' | 'reset' | null>(null)
  const [confirm, setConfirm] = useState(false)
  const [redeemId, setRedeemId] = useState<string | null>(null)
  const credits = result?.credits ?? account.quota?.credits
  const resetCredits = result?.reset_credits
  async function query() {
    setPending('query')
    try {
      setResult(
        await api<GatewayQuotaResult>(`${accountBase}/${account.id}/quota`, {
          method: 'POST',
        })
      )
      await onChanged()
    } catch (error) {
      toast.error((error as Error).message || t('codexQuotaQueryFailed'))
    } finally {
      setPending(null)
    }
  }
  async function consume() {
    setPending('reset')
    try {
      const next = await api<GatewayQuotaResult & { code?: string }>(
        `${accountBase}/${account.id}/reset-credits`,
        {
          method: 'POST',
          body: JSON.stringify({
            credit_id: resetCredits?.credits[0]?.id,
            ...(redeemId ? { redeem_request_id: redeemId } : {}),
          }),
        }
      )
      setRedeemId(null)
      setResult(next)
      toast.success(t('codexResetCreditDone'))
      await onChanged()
    } catch (error) {
      const data = (
        error as { data?: { redeem_request_id?: string; outcome?: string } }
      ).data
      // 结果不明时保留幂等键，再次点击会用同一个键重试，不会重复消费
      if (data?.outcome === 'unknown' && data.redeem_request_id)
        setRedeemId(data.redeem_request_id)
      toast.error((error as Error).message || t('codexResetCreditFailed'))
    } finally {
      setPending(null)
      setConfirm(false)
    }
  }
  return (
    <div className='space-y-3 rounded-lg border p-3'>
      <div className='flex items-center justify-between gap-2'>
        <div className='text-sm font-medium'>{t('codexQuotaTitle')}</div>
        <Button
          size='sm'
          variant='outline'
          disabled={!!pending || account.status === 'archived'}
          onClick={() => void query()}
        >
          <RefreshCw
            className={cn('size-3.5', pending === 'query' && 'animate-spin')}
          />
          {t('codexQuotaQuery')}
        </Button>
      </div>
      <dl className='grid grid-cols-[auto_1fr] gap-x-5 gap-y-2 text-sm'>
        <dt className='text-muted-foreground'>{t('codexCredits')}</dt>
        <dd>{creditText(credits, t)}</dd>
        <dt className='text-muted-foreground'>{t('codexPlan')}</dt>
        <dd>
          {result?.plan_type ||
            account.quota?.plan_type ||
            account.config.plan ||
            '—'}
        </dd>
        <dt className='text-muted-foreground'>{t('codexResetCredits')}</dt>
        <dd className='flex items-center gap-2'>
          <span>
            {resetCredits ? resetCredits.available_count : t('unknown')}
          </span>
          {!!resetCredits?.available_count && (
            <Button
              size='sm'
              variant='secondary'
              disabled={!!pending}
              onClick={() => setConfirm(true)}
            >
              {redeemId ? t('codexResetCreditRetry') : t('codexResetCreditUse')}
            </Button>
          )}
        </dd>
      </dl>
      {result?.warning && (
        <p className='text-xs text-muted-foreground'>
          {t('codexQuotaPartial')}
        </p>
      )}
      <ConfirmDialog
        open={confirm}
        onOpenChange={(open) => {
          if (!open && pending !== 'reset') setConfirm(false)
        }}
        title={t('codexResetCreditUse')}
        desc={t('codexResetCreditConfirm', { name: account.name })}
        confirmText={t('codexResetCreditUse')}
        isLoading={pending === 'reset'}
        handleConfirm={() => void consume()}
      />
    </div>
  )
}
function Identity({ account }: { account: GatewayAccount }) {
  const { t } = useTranslation('common')
  return (
    <div className='min-w-0 space-y-1'>
      <div className='truncate text-sm font-semibold'>{account.name}</div>
      <SlotIdentity
        model='gpt-5-codex'
        email={account.config.email}
        emptyLabel={t('unknown')}
        compact
      />
      <div className='flex items-center gap-1.5'>
        <CredLaneChip endpoint='oauth' />
        <span className='truncate text-[11px] text-muted-foreground'>
          {account.config.plan || '—'} ·{' '}
          {account.vendor_name || t('codexPlatformOwned')}
        </span>
      </div>
    </div>
  )
}
function Status({ account }: { account: GatewayAccount }) {
  const { t } = useTranslation('common')
  const value = state(account)
  return (
    <StatusMark
      tone={{
        key: value,
        cls: value === 'active' ? 'ok' : value === 'pending' ? 'warn' : 'off',
        text: t(`codexStates.${value}`),
      }}
    />
  )
}
export function CodexAccountsPage() {
  const { t } = useTranslation(['common', 'vm', 'vendor'])
  const qc = useQueryClient()
  const [q, setQ] = useState('')
  const [group, setGroup] = useState<string | undefined>()
  const [owner, setOwner] = useState<string | undefined>()
  const [filter, setFilter] = useState<Filter>('all')
  const [archived, setArchived] = useState(false)
  const [view, setView] = useState<'grid' | 'list'>(() => {
    try {
      return localStorage.getItem('codex-accounts-view') === 'list'
        ? 'list'
        : 'grid'
    } catch {
      return 'grid'
    }
  })
  const [sort, setSort] = useState('status')
  const [ascending, setAscending] = useState(true)
  const [busy, setBusy] = useState(false)
  const [dialog, setDialog] = useState<{
    mode: 'create' | 'edit' | 'authorize'
    account?: GatewayAccount
  } | null>(null)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [testId, setTestId] = useState<string | null>(null)
  const [statsAccount, setStatsAccount] = useState<GatewayAccount | null>(null)
  const [archiveTarget, setArchiveTarget] = useState<GatewayAccount | null>(
    null
  )
  const query = useQuery({
    queryKey: [...accountQueryKey, archived],
    queryFn: () =>
      api<{ items: GatewayAccount[] }>(
        `${accountBase}?archived=${archived ? 'all' : 'active'}`
      ),
    refetchInterval: 5000,
  })
  const catalog = useQuery({
    queryKey: ['gateway-account-catalog'],
    queryFn: () => api<GatewayCatalog>(`${accountBase}/catalog`),
  })
  const rows = useMemo(() => query.data?.items || [], [query.data])
  const owners = useMemo(
    () => [
      ...new Map(
        rows
          .filter((row) => row.vendor_id)
          .map((row) => [
            row.vendor_id!,
            { id: row.vendor_id!, name: row.vendor_name || row.vendor_id! },
          ])
      ).values(),
    ],
    [rows]
  )
  const groupNames = useMemo(
    () =>
      new Map(
        catalog.data?.groups.map((group) => [group.id, group.name]) || []
      ),
    [catalog.data]
  )
  const vmById = useMemo(
    () =>
      new Map(rows.map((row) => [row.id, gatewayAccountAsVm(row, groupNames)])),
    [rows, groupNames]
  )
  const rowOf = (account: GatewayAccount): AccountRow => ({
    account,
    vm: vmById.get(account.id) || gatewayAccountAsVm(account, groupNames),
  })
  const [selected, setSelected] = useState<string[]>([])
  const [bulkOpen, setBulkOpen] = useState(false)
  const scoped = rows.filter(
    (row) =>
      (!group || row.config.group_ids?.includes(Number(group))) &&
      (!owner ||
        (owner === 'platform' ? !row.vendor_id : row.vendor_id === owner))
  )
  const filtered = scoped
    .filter(
      (row) =>
        (filter === 'all' || state(row) === filter) &&
        `${row.name} ${row.config.email || ''} ${row.config.proxy_endpoint || ''} ${row.runtime_account_id || ''}`
          .toLowerCase()
          .includes(q.trim().toLowerCase())
    )
    .sort((a, b) => {
      const key = (row: GatewayAccount) =>
        sort === 'name'
          ? row.name
          : sort === 'remain'
            ? 100 - (quotaWindows(row.quota).fiveHour?.used_percent ?? 100)
            : sort === 'today'
              ? (row.usage?.today_cost ?? 0)
              : sort === 'cost7'
                ? (row.usage?.window_7d_cost ?? 0)
                : sort === 'total'
                  ? (row.usage?.total_cost ?? 0)
                  : state(row)
      const av = key(a)
      const bv = key(b)
      return (
        (typeof av === 'number' && typeof bv === 'number'
          ? av - bv
          : String(av).localeCompare(String(bv))) * (ascending ? 1 : -1)
      )
    })
  const [page, setPage] = useState(0)
  const pageIndex = Math.min(
    page,
    Math.max(0, Math.ceil(filtered.length / 20) - 1)
  )
  const visible = filtered.slice(pageIndex * 20, pageIndex * 20 + 20)
  const detail = rows.find((row) => row.id === detailId)
  const refresh = () => qc.invalidateQueries({ queryKey: accountQueryKey })
  const editable = filtered.filter((row) => row.status !== 'archived')
  const picked = rows.filter(
    (row) => selected.includes(row.id) && row.status !== 'archived'
  )
  const toggleOne = (id: string) =>
    setSelected((ids) =>
      ids.includes(id)
        ? ids.filter((x) => x !== id)
        : ids.length >= 500
          ? (toast.error(t('vm:vmBulk.limit')), ids)
          : [...ids, id]
    )
  const toggleAll = () => {
    if (editable.length > 500) return void toast.error(t('vm:vmBulk.limit'))
    setSelected((ids) =>
      editable.every((row) => ids.includes(row.id))
        ? []
        : editable.map((row) => row.id)
    )
  }
  const onRowAction = (name: AccountRowAction, account: GatewayAccount) => {
    if (name === 'detail') setDetailId(account.id)
    else if (name === 'stats') setStatsAccount(account)
    else if (name === 'test') setTestId(account.id)
    else if (name === 'edit' || name === 'groups')
      setDialog({ mode: 'edit', account })
    else if (name === 'authorize') setDialog({ mode: 'authorize', account })
    else if (name === 'archive') setArchiveTarget(account)
    else void action(account, name)
  }
  const groupText = (account: GatewayAccount) =>
    account.config.group_ids
      ?.map((id) => groupNames.get(id) || `#${id}`)
      .join(' · ') || '—'
  async function action(account: GatewayAccount, name: string) {
    if (busy) return
    setBusy(true)
    try {
      const result = await api<{
        projection_pending?: boolean
        ok?: boolean
        data?: { error?: { message?: string } }
      }>(
        `${accountBase}/${account.id}${name === 'archive' ? '' : `/${name}`}`,
        {
          method: name === 'archive' ? 'PATCH' : 'POST',
          ...(name === 'archive'
            ? { body: JSON.stringify({ status: 'archived' }) }
            : {}),
        }
      )
      if (result.ok === false)
        throw new Error(result.data?.error?.message || t('codexActionFailed'))
      if (result.projection_pending) toast.warning(t('codexProjectionPending'))
      else toast.success(t('codexActionDone'))
      setArchiveTarget(null)
      await refresh()
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setBusy(false)
    }
  }
  function actions(account: GatewayAccount) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant='ghost'
            size='icon'
            aria-label={`${t('actions')} · ${account.name}`}
          >
            <MoreHorizontal className='size-4' />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align='end'>
          <DropdownMenuItem onSelect={() => setStatsAccount(account)}>
            <Trans
              ns='vm'
              i18nKey='vmActionMenu.viewStatistics'
              components={{
                part0: (
                  <BarChart3 className='text-[color:var(--tier-pro-solid)]' />
                ),
              }}
            />
          </DropdownMenuItem>
          {account.status !== 'archived' && (
            <>
              <DropdownMenuItem
                disabled={busy}
                onSelect={() => setDialog({ mode: 'edit', account })}
              >
                {t('codexEdit')}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={busy}
                onSelect={() => setDialog({ mode: 'authorize', account })}
              >
                {t('reauthorize')}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={busy}
                onSelect={() => void action(account, 'refresh')}
              >
                {t('refreshCredentials')}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={busy}
                onSelect={() => void action(account, 'recover')}
              >
                {t('recoverCooldown')}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={busy}
                onSelect={() => setTestId(account.id)}
              >
                {t('testAccount')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={busy}
                className='text-destructive'
                onSelect={() => setArchiveTarget(account)}
              >
                {t('archiveAccount')}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    )
  }
  return (
    <PageHeader
      title={t('codexAccountsTitle')}
      description={t('codexAccountsDescription')}
      fluid
      extra={
        <div className='flex flex-wrap items-center gap-3'>
          <SearchSelect
            label={t('vm:listPage.filterByGroup')}
            value={group}
            options={
              catalog.data?.groups.map((group) => ({
                id: String(group.id),
                name: group.name,
              })) || []
            }
            allLabel={t('vm:listPage.allGroups')}
            searchPlaceholder={t('vm:listPage.searchGroups')}
            onChange={(value) => {
              setGroup(value)
              setPage(0)
            }}
          />
          <SearchSelect
            label={t('codexOwner')}
            value={owner}
            options={[
              { id: 'platform', name: t('codexPlatformOwned') },
              ...owners,
            ]}
            allLabel={t('codexAllOwners')}
            searchPlaceholder={t('vm:listPage.searchSuppliers')}
            onChange={(value) => {
              setOwner(value)
              setPage(0)
            }}
          />
          <Button onClick={() => setDialog({ mode: 'create' })}>
            <Plus />
            {t('codexCreate')}
          </Button>
        </div>
      }
    >
      <QueryGate
        loading={query.isPending}
        error={query.error}
        skeleton={<VmListSkeleton />}
      >
        <div className='mb-3 flex flex-wrap overflow-hidden rounded-xl border bg-card'>
          {(['all', 'active', 'pending', 'paused'] as const).map((value) => (
            <button
              key={value}
              type='button'
              onClick={() => {
                setFilter(filter === value ? 'all' : value)
                setPage(0)
              }}
              aria-pressed={filter === value}
              className={cn(
                'min-w-32 flex-1 border-r border-border/50 px-5 py-3 text-start transition-colors hover:bg-muted/40',
                filter === value && 'bg-muted/60'
              )}
            >
              <span className='text-xs text-muted-foreground'>
                {t(`codexStates.${value}`)}
              </span>
              <div className='mt-1 font-mono text-2xl font-semibold tabular-nums'>
                {value === 'all'
                  ? scoped.length
                  : scoped.filter((row) => state(row) === value).length}
              </div>
            </button>
          ))}
        </div>
        <div className='mb-4 flex flex-wrap items-center gap-2'>
          <Input
            className='h-8 w-64'
            type='search'
            aria-label={t('vm:listPage.searchNameEmailProxy')}
            placeholder={t('vm:listPage.searchNameEmailProxy')}
            value={q}
            onChange={(event) => {
              setQ(event.target.value)
              setPage(0)
            }}
          />
          <label className='flex items-center gap-2 text-xs text-muted-foreground'>
            <Switch
              checked={archived}
              onCheckedChange={(checked) => {
                setArchived(checked)
                if (!checked) setFilter('all')
              }}
            />
            {t('showArchived')}
          </label>
          <div className='ms-auto flex flex-wrap items-center gap-2'>
            <span className='text-xs text-muted-foreground'>
              {t('vm:listPage.sort')}
            </span>
            <Select value={sort} onValueChange={setSort}>
              <SelectTrigger
                size='sm'
                className='w-28'
                aria-label={t('vm:listPage.sortBy')}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value='status'>
                  {t('vm:detailAccountTab.status')}
                </SelectItem>
                <SelectItem value='name'>{t('vendor:name')}</SelectItem>
                <SelectItem value='remain'>
                  {t('vm:listPage.5HourRemaining')}
                </SelectItem>
                <SelectItem value='today'>
                  {t('vm:listPage.todaySCost')}
                </SelectItem>
                <SelectItem value='cost7'>
                  {t('vm:listPage.7DayCost')}
                </SelectItem>
                <SelectItem value='total'>
                  {t('vm:listPage.totalCost')}
                </SelectItem>
              </SelectContent>
            </Select>
            <Button
              size='sm'
              variant='outline'
              aria-label={t(
                ascending
                  ? 'vm:listPage.ascendingSwitchToDescending'
                  : 'vm:listPage.descendingSwitchToAscending'
              )}
              onClick={() => setAscending(!ascending)}
            >
              {ascending ? <ArrowUpNarrowWide /> : <ArrowDownWideNarrow />}
            </Button>
            <Separator orientation='vertical' className='mx-1 h-5' />
            {(['list', 'grid'] as const).map((next) => (
              <Button
                key={next}
                size='sm'
                variant={view === next ? 'default' : 'outline'}
                aria-pressed={view === next}
                aria-label={t(
                  next === 'list'
                    ? 'vm:listPage.listView'
                    : 'vm:listPage.gridView'
                )}
                onClick={() => {
                  setView(next)
                  try {
                    localStorage.setItem('codex-accounts-view', next)
                  } catch {
                    /* Session preference still applies. */
                  }
                }}
              >
                {next === 'list' ? <List /> : <LayoutGrid />}
              </Button>
            ))}
            <Button
              size='sm'
              variant='outline'
              disabled={query.isFetching}
              aria-label={t('vendor:refresh')}
              onClick={() => void refresh()}
            >
              <RefreshCw className={cn(query.isFetching && 'animate-spin')} />
            </Button>
          </div>
        </div>
        {editable.length > 0 && (
          <div className='sticky top-0 z-20 mb-3 flex flex-wrap items-center gap-2 bg-background py-1 text-sm'>
            <Checkbox
              checked={
                picked.length && picked.length === editable.length
                  ? true
                  : picked.length
                    ? 'indeterminate'
                    : false
              }
              aria-label={t('codexSelectAll', { count: editable.length })}
              onCheckedChange={toggleAll}
            />
            <span>{t('codexSelectAll', { count: editable.length })}</span>
            {picked.length ? (
              <div
                role='toolbar'
                aria-label={t('codexBulkTitle')}
                className='flex flex-1 flex-wrap items-center gap-3 rounded-lg border bg-muted p-2'
              >
                <span aria-live='polite'>
                  {t('codexSelected', { count: picked.length })}
                </span>
                <Button
                  size='sm'
                  variant='ghost'
                  onClick={() => setSelected([])}
                >
                  {t('vm:vmBulk.clear')}
                </Button>
                <Button
                  className='ms-auto'
                  size='sm'
                  onClick={() => setBulkOpen(true)}
                >
                  {t('vm:vmBulk.edit')}
                </Button>
              </div>
            ) : null}
          </div>
        )}
        {!filtered.length ? (
          <EmptyState
            reason={rows.length ? t('codexNoMatches') : t('codexEmpty')}
            actionLabel={rows.length ? undefined : t('codexCreate')}
            onAction={() => setDialog({ mode: 'create' })}
          />
        ) : view === 'grid' ? (
          <div className='rounded-xl border bg-muted/10 p-3'>
            <div className='grid grid-cols-[repeat(auto-fill,minmax(min(100%,380px),1fr))] gap-2'>
              {visible.map((account) => (
                <section
                  key={account.id}
                  className='min-w-0 rounded-[10px] border border-border/70 bg-card p-4 shadow-sm'
                >
                  <div className='flex items-start justify-between gap-2'>
                    {account.status !== 'archived' && (
                      <Checkbox
                        className='mt-1'
                        checked={selected.includes(account.id)}
                        aria-label={t('vm:vmBulk.selectOne', {
                          name: account.name,
                        })}
                        onCheckedChange={() => toggleOne(account.id)}
                      />
                    )}
                    <button
                      className='min-w-0 text-start'
                      onClick={() => setDetailId(account.id)}
                    >
                      <Identity account={account} />
                    </button>
                    {actions(account)}
                  </div>
                  <div className='my-3 flex items-center justify-between gap-2'>
                    <Status account={account} />
                    <Switch
                      aria-label={`${t('codexSchedule')} · ${account.name}`}
                      disabled={busy || account.status === 'archived'}
                      checked={account.status === 'active'}
                      onCheckedChange={(checked) =>
                        void action(account, checked ? 'resume' : 'pause')
                      }
                    />
                  </div>
                  <Quota row={rowOf(account)} />
                  <div className='mt-3 space-y-1 border-t pt-3 text-xs text-muted-foreground'>
                    <p className='truncate'>{groupText(account)}</p>
                    <p className='truncate'>
                      {account.config.proxy_endpoint || '—'}
                    </p>
                    <p>
                      {t('codexProjection')}:{' '}
                      {t(
                        `codexProjectionStates.${account.projection_status || 'pending'}`
                      )}{' '}
                      · {t('codexCredentialRevision')}:{' '}
                      {account.credential_revision ?? '—'}
                    </p>
                  </div>
                </section>
              ))}
            </div>
          </div>
        ) : (
          <GatewayAccountTable
            rows={visible.map(rowOf)}
            selected={selected}
            busy={busy}
            onToggle={toggleOne}
            onToggleAll={toggleAll}
            onSchedule={(account, on) =>
              void action(account, on ? 'resume' : 'pause')
            }
            onAction={onRowAction}
          />
        )}
        {filtered.length > 0 && (
          <div className='mt-3 flex items-center justify-end gap-3 text-xs text-muted-foreground'>
            <span>
              {pageIndex * 20 + 1}–
              {Math.min((pageIndex + 1) * 20, filtered.length)} /{' '}
              {filtered.length}
            </span>
            <Button
              variant='outline'
              size='sm'
              disabled={pageIndex === 0}
              onClick={() => setPage(pageIndex - 1)}
            >
              {t('codexPrevious')}
            </Button>
            <Button
              variant='outline'
              size='sm'
              disabled={(pageIndex + 1) * 20 >= filtered.length}
              onClick={() => setPage(pageIndex + 1)}
            >
              {t('codexNext')}
            </Button>
          </div>
        )}
      </QueryGate>
      {bulkOpen && picked.length > 0 && (
        <GatewayAccountBulkEdit
          accounts={picked}
          onClose={() => setBulkOpen(false)}
          onSaved={async (ids) => {
            setSelected((current) => current.filter((id) => !ids.includes(id)))
            await refresh()
          }}
        />
      )}
      {statsAccount && (
        <AccountUsageDialog
          resource={statsAccount}
          apiBase={accountBase}
          onClose={() => setStatsAccount(null)}
        />
      )}
      <GatewayAccountTestDialog
        account={rows.find((row) => row.id === testId) || null}
        vm={(() => {
          const row = rows.find((item) => item.id === testId)
          return row ? rowOf(row).vm : null
        })()}
        onOpenChange={(open) => {
          if (!open) setTestId(null)
        }}
      />
      {dialog && (
        <GatewayAccountDialog
          {...dialog}
          onClose={() => setDialog(null)}
          onChanged={refresh}
        />
      )}
      <ConfirmDialog
        open={!!archiveTarget}
        onOpenChange={(open) => {
          if (!open && !busy) setArchiveTarget(null)
        }}
        title={t('archiveAccount')}
        desc={t('codexArchiveConfirm', { name: archiveTarget?.name })}
        confirmText={t('archive')}
        destructive
        isLoading={busy}
        handleConfirm={() => {
          if (archiveTarget) void action(archiveTarget, 'archive')
        }}
      />
      <Sheet
        open={!!detail}
        onOpenChange={(open) => {
          if (!open) setDetailId(null)
        }}
      >
        <SheetContent className='overflow-y-auto sm:max-w-xl'>
          <SheetHeader>
            <SheetTitle>{detail?.name}</SheetTitle>
            <SheetDescription>{t('codexDetails')}</SheetDescription>
          </SheetHeader>
          {detail && (
            <div className='space-y-5 px-4 pb-6'>
              <Identity account={detail} />
              <Status account={detail} />
              <Quota row={rowOf(detail)} />
              <QuotaPanel account={detail} onChanged={refresh} />
              <ProfilePanel account={detail} />
              <ForecastPanel account={detail} />
              <ProtectionPanel account={detail} />
              <dl className='grid grid-cols-[auto_1fr] gap-x-5 gap-y-3 text-sm'>
                {[
                  [
                    t('codexOwner'),
                    detail.vendor_name || t('codexPlatformOwned'),
                  ],
                  [t('vendor:groups'), groupText(detail)],
                  [t('vendor:proxy'), detail.config.proxy_endpoint || '—'],
                  [
                    t('codexRuntimeAccount'),
                    detail.runtime_account_id || t('pending'),
                  ],
                  [
                    t('codexProjection'),
                    t(
                      `codexProjectionStates.${detail.projection_status || 'pending'}`
                    ),
                  ],
                  [
                    t('codexCredentialRevision'),
                    detail.credential_revision ?? '—',
                  ],
                  [t('vendor:wb.column.notes'), detail.config.notes || '—'],
                ].map(([label, value]) => (
                  <div key={label} className='contents'>
                    <dt className='text-muted-foreground'>{label}</dt>
                    <dd className='min-w-0 break-all'>{value}</dd>
                  </div>
                ))}
              </dl>
              {detail.last_error && (
                <p className='rounded-lg border border-destructive/30 p-3 text-sm break-words text-destructive'>
                  {detail.last_error}
                </p>
              )}
              {detail.status !== 'archived' && (
                <div className='flex gap-2'>
                  <Button
                    onClick={() => {
                      setDetailId(null)
                      setDialog({ mode: 'edit', account: detail })
                    }}
                  >
                    {t('codexEdit')}
                  </Button>
                  <Button
                    variant='outline'
                    onClick={() => {
                      setDetailId(null)
                      setDialog({ mode: 'authorize', account: detail })
                    }}
                  >
                    {t('reauthorize')}
                  </Button>
                </div>
              )}
            </div>
          )}
        </SheetContent>
      </Sheet>
    </PageHeader>
  )
}
