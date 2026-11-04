import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { Plus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { EmptyState } from '@/components/empty-state'
import { PageHeader } from '@/components/page-header'
import { QueryGate } from '@/components/query-gate'
import { SearchSelect } from '@/components/search-select'
import { AccountUsageDialog } from '@/features/vendor/account-usage-dialog'
import { FleetPulse } from '@/features/vm/fleet-pulse'
import { VmListSkeleton } from '@/features/vm/list-skeleton'
import {
  VmActionsContext,
  type OpenaiQuotaPayload,
  type VmActions,
} from '@/features/vm/vm-actions-context'
import { VmDetailCard } from '@/features/vm/vm-detail-card'
import {
  readPref,
  VmListToolbar,
  writePref,
} from '@/features/vm/vm-list-toolbar'
import { VmRack } from '@/features/vm/vm-rack'
import type { RackSize } from '@/features/vm/vm-rack-blade'
import type { VmZoneFilter } from '@/features/vm/vm-rack-model'
import { VmSelectionProvider } from '@/features/vm/vm-selection'
import {
  filterVms,
  sortVms,
  VmTable,
  type VmSortKey,
} from '@/features/vm/vm-table'
import { useAccountAction } from './account-actions'
import { GatewayAccountBulkEdit } from './account-bulk-edit'
import { GatewayAccountDialog } from './account-dialog'
import { ProxySummary } from './account-runtime-panels'
import { GatewayAccountTestDialog } from './account-test-dialog'
import {
  accountBase,
  accountCatalogQueryOptions,
  accountsQueryOptions,
  gatewayAccountAsVm,
  groupNamesOf,
  type GatewayAccount,
  type GatewayQuotaResult,
} from './accounts-model'

const LS_VIEW = 'codex-accounts-view'
const LS_SIZE = 'codex-accounts-card-size'

export function CodexAccountsPage() {
  const { t } = useTranslation(['common', 'vm'])
  const [q, setQ] = useState('')
  const [group, setGroup] = useState<string | undefined>()
  const [owner, setOwner] = useState<string | undefined>()
  const [filter, setFilter] = useState<VmZoneFilter>('all')
  const [archived, setArchived] = useState(false)
  const [view, setViewState] = useState(() =>
    readPref(LS_VIEW, ['grid', 'list'] as const, 'grid')
  )
  const [size, setSizeState] = useState(() =>
    readPref(LS_SIZE, ['s', 'm', 'l'] as const, 'l')
  )
  const setView = (next: 'grid' | 'list') => {
    setViewState(next)
    writePref(LS_VIEW, next)
  }
  const setSize = (next: RackSize) => {
    setSizeState(next)
    writePref(LS_SIZE, next)
  }
  const [sort, setSort] = useState<VmSortKey>('status')
  const [dir, setDir] = useState<'asc' | 'desc'>('asc')
  const { busyId, run, refresh } = useAccountAction()
  const busy = busyId != null
  // 列表里的「券查询」结果：上游重置券只在查询时返回，不随账号列表持久化。
  const [quotaResults, setQuotaResults] = useState<
    Record<string, GatewayQuotaResult>
  >({})
  const [redeemIds, setRedeemIds] = useState<Record<string, string>>({})
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
  const query = useQuery(accountsQueryOptions(archived))
  const catalog = useQuery(accountCatalogQueryOptions())
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
  const groupNames = useMemo(() => groupNamesOf(catalog.data), [catalog.data])
  const vms = useMemo(
    () =>
      rows.map(
        (row) =>
          ({
            ...gatewayAccountAsVm(row, groupNames),
            proxy_id: row.config.proxy_id,
            reset_credits: quotaResults[row.id]?.reset_credits,
          }) as Vm
      ),
    [rows, groupNames, quotaResults]
  )
  const vmOf = (account: GatewayAccount) =>
    vms.find((vm) => vm.id === account.id) ||
    gatewayAccountAsVm(account, groupNames)
  const accountOf = (vm: Vm) => rows.find((row) => row.id === vm.id)
  const scoped = vms.filter((vm) => {
    const row = accountOf(vm)
    return (
      (!group || row?.config.group_ids?.includes(Number(group))) &&
      (!owner ||
        (owner === 'platform' ? !row?.vendor_id : row?.vendor_id === owner))
    )
  })
  const list = sortVms(filterVms(scoped, q, filter), sort, dir)
  const editable = list.filter((vm) => accountOf(vm)?.status !== 'archived')
  const quotaResult = (vm: Vm, next: GatewayQuotaResult) => {
    setQuotaResults((current) => ({ ...current, [vm.id]: next }))
    return {
      reset_credits: next.reset_credits,
    } satisfies OpenaiQuotaPayload
  }
  const byVm = (run: (account: GatewayAccount) => void) => (vm: Vm) => {
    const account = accountOf(vm)
    if (account) run(account)
  }
  // 与 VM 列表共用 VmTable / VmRack，操作改走 Gateway 账号接口。
  const gatewayActions: VmActions = {
    openDetail: byVm((account) => setDetailId(account.id)),
    openTest: byVm((account) => setTestId(account.id)),
    openStats: byVm(setStatsAccount),
    openReauth: byVm((account) => setDialog({ mode: 'authorize', account })),
    refreshToken: byVm((account) => void run(account, 'refresh')),
    recover: byVm((account) => void run(account, 'recover')),
    refreshingId: busyId,
    recoveringId: busyId,
    remove: byVm(setArchiveTarget),
    openAssignGroups: byVm((account) => setDialog({ mode: 'edit', account })),
    groupsBusyId: busyId,
    packageExport: false,
    setSchedulable: async (vm, next) => {
      const account = accountOf(vm)
      if (account)
        await run(account, next ? 'resume' : 'pause', { quiet: true })
    },
    renderProxy: (vm) => (
      <ProxySummary endpoint={accountOf(vm)?.config.proxy_endpoint} />
    ),
    detailRoute: '/codex-accounts/$id',
    openaiQuota: {
      refresh: async (vm) => {
        const next = await api<GatewayQuotaResult>(
          `${accountBase}/${vm.id}/quota`,
          { method: 'POST' }
        )
        await refresh()
        return quotaResult(vm, next)
      },
      reset: async (vm) => {
        const redeemId = redeemIds[vm.id]
        try {
          const next = await api<GatewayQuotaResult>(
            `${accountBase}/${vm.id}/reset-credits`,
            {
              method: 'POST',
              body: JSON.stringify({
                credit_id: quotaResults[vm.id]?.reset_credits?.credits[0]?.id,
                ...(redeemId ? { redeem_request_id: redeemId } : {}),
              }),
            }
          )
          setRedeemIds(({ [vm.id]: _done, ...rest }) => rest)
          await refresh()
          return quotaResult(vm, next)
        } catch (error) {
          const data = (
            error as { data?: { redeem_request_id?: string; outcome?: string } }
          ).data
          // 结果不明时保留幂等键，再次点击用同一个键重试，不会重复消费。
          if (data?.outcome === 'unknown' && data.redeem_request_id) {
            const id = data.redeem_request_id
            setRedeemIds((current) => ({ ...current, [vm.id]: id }))
          }
          throw error
        }
      },
    },
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
        <FleetPulse
          className='mb-3'
          vms={scoped}
          filter={filter}
          onFilter={setFilter}
        />
        <VmListToolbar
          leading={
            <>
              <label className='flex items-center gap-2 text-xs text-muted-foreground'>
                <Switch checked={archived} onCheckedChange={setArchived} />
                {t('showArchived')}
              </label>
              <Separator orientation='vertical' className='mx-1 h-5' />
            </>
          }
          q={q}
          onQ={setQ}
          sort={sort}
          onSort={setSort}
          dir={dir}
          onDir={setDir}
          view={view}
          onView={setView}
          size={size}
          onSize={setSize}
        />
        <VmSelectionProvider
          vms={editable}
          enabled
          scopeKey={JSON.stringify([q, filter, group, owner, archived])}
          renderBulkEdit={({ ids, onClose, onSaved }) => (
            <GatewayAccountBulkEdit
              accounts={rows.filter((row) => ids.includes(row.id))}
              onClose={onClose}
              onSaved={async (saved) => {
                onSaved(saved)
                await refresh()
              }}
            />
          )}
        >
          <VmActionsContext.Provider value={gatewayActions}>
            {list.length ? (
              view === 'grid' ? (
                <VmRack
                  vms={list}
                  filter={filter}
                  size={size}
                  onCreate={() => setDialog({ mode: 'create' })}
                />
              ) : (
                <VmTable vms={list} />
              )
            ) : (
              <EmptyState
                reason={rows.length ? t('codexNoMatches') : t('codexEmpty')}
                actionLabel={rows.length ? undefined : t('codexCreate')}
                onAction={() => setDialog({ mode: 'create' })}
              />
            )}
            <VmDetailCard
              vm={vms.find((vm) => vm.id === detailId) || null}
              onOpenChange={(open) => {
                if (!open) setDetailId(null)
              }}
            />
          </VmActionsContext.Provider>
        </VmSelectionProvider>
      </QueryGate>
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
          return row ? vmOf(row) : null
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
          if (archiveTarget)
            void run(archiveTarget, 'archive').then(
              (ok) => ok && setArchiveTarget(null)
            )
        }}
      />
    </PageHeader>
  )
}
