import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { VIEW_TITLES } from '@/config/nav'
import type { Vm } from '@/types/panel-vm'
import { Plus, Upload } from 'lucide-react'
import { Trans, useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { EmptyState } from '@/components/empty-state'
import { PageHeader } from '@/components/page-header'
import { QueryGate } from '@/components/query-gate'
import { SearchSelect } from '@/components/search-select'
import { accountQueryKey } from '@/features/gateway-worker/accounts-model'
import { groupsQueryOptions } from '@/features/groups/queries'
import { usageQueryOptions } from '@/features/overview/queries'
import { AdminAccountCreateForm } from '@/features/supplier-admin/account-create-form'
import { supplierQueryKeys } from '@/features/supplier-admin/model'
import { CreateVmDialog } from '@/features/vm/create-vm-dialog'
import { FleetPulse } from '@/features/vm/fleet-pulse'
import { VmListSkeleton } from '@/features/vm/list-skeleton'
import { vmsListQueryOptions } from '@/features/vm/queries'
import { usePoolSeatStream } from '@/features/vm/use-pool-seat-stream'
import {
  useVmActions,
  VmActionsContext,
  type VmActions,
} from '@/features/vm/vm-actions-context'
import { VmActionsProvider } from '@/features/vm/vm-actions-provider'
import { VmBulkEdit } from '@/features/vm/vm-bulk-edit'
import {
  readPref,
  VmListToolbar,
  writePref,
} from '@/features/vm/vm-list-toolbar'
import { useVmPerms } from '@/features/vm/vm-perms'
import { VmRack } from '@/features/vm/vm-rack'
import type { RackSize } from '@/features/vm/vm-rack-blade'
import type { VmZoneFilter } from '@/features/vm/vm-rack-model'
import { VmSelectionProvider } from '@/features/vm/vm-selection'
import {
  filterVms,
  KindFilterChips,
  sortVms,
  VmColumnsMenu,
  VmTable,
  type VmKindFilter,
  type VmSortKey,
} from '@/features/vm/vm-table'
import { AccountFilterBar } from './account-filter-bar'
import { AccountOverview } from './account-overview'
import {
  matchesAccountFilters,
  type AccountFilters,
} from './account-overview-model'
import { isGatewayRow, useGatewaySource } from './gateway-source'
import { suppliersListQueryOptions, type ResourcePreset } from './queries'
import { useVmDangerDialogs } from './vm-danger-dialogs'

/**
 * 账号资源统一工作台（docs/RESOURCE_WORKBENCH.md）。
 *
 *   vm        资源管理 → 虚拟机：全部 VM
 *   codex     资源管理 → Codex 账号：全部 Gateway 账号
 *   supplier  供应商平台 → 账号池：供应商自有的 VM 与 Gateway 账号
 *
 * 三个入口共用排版、概览、工具栏、机柜 / 表格、详情与凭证弹窗；
 * 入口只决定数据范围与默认筛选。按钮与字段按账号资源能力裁剪。
 */

const PLATFORM = 'platform'

function usePref<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T
): [T, (next: T) => void] {
  const [value, setValue] = useState(() => readPref(key, allowed, fallback))
  return [
    value,
    (next: T) => {
      setValue(next)
      writePref(key, next)
    },
  ]
}

/** 供应商账号池混排 VM 与 Gateway 账号：每行取各自的操作。 */
function MixedActions({
  gateway,
  children,
}: {
  gateway: VmActions
  children: React.ReactNode
}) {
  const vmActions = useVmActions()
  const value = useMemo<VmActions>(
    () => ({
      ...vmActions,
      resolve: (vm: Vm) => (isGatewayRow(vm) ? gateway : vmActions),
    }),
    [vmActions, gateway]
  )
  return (
    <VmActionsContext.Provider value={value}>
      {children}
    </VmActionsContext.Provider>
  )
}

export function ResourceWorkbench({
  preset,
  initialVendor = 'all',
}: {
  preset: ResourcePreset
  initialVendor?: string
}) {
  const { t } = useTranslation(['common', 'vm', 'supplierAdmin'])
  const qc = useQueryClient()
  const perms = useVmPerms()
  const wantVm = preset !== 'codex'
  const wantGateway = preset !== 'vm'

  const vmsQ = useQuery({ ...vmsListQueryOptions(), enabled: wantVm })
  const refetchVms = vmsQ.refetch
  useEffect(() => {
    if (!wantVm) return
    // SSE 补丁会重置 React Query 的轮询计时；HTTP 刷新独立运行，避免忙碌槽位饿死额度窗口。
    const refreshVisible = () => {
      if (document.visibilityState === 'visible')
        void refetchVms({ cancelRefetch: false })
    }
    const interval = window.setInterval(refreshVisible, 5000)
    document.addEventListener('visibilitychange', refreshVisible)
    return () => {
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', refreshVisible)
    }
  }, [refetchVms, wantVm])
  usePoolSeatStream(wantVm)
  const usage = useQuery({
    ...usageQueryOptions(5000),
    enabled: wantVm && perms.dashboard,
  })
  const accounts = usage.data?.accounts
  const [archived, setArchived] = useState(false)
  const gateway = useGatewaySource({ enabled: wantGateway, archived, perms })

  const suppliersQ = useQuery({
    ...suppliersListQueryOptions(),
    enabled: perms.read,
  })
  const suppliers = suppliersQ.data || []
  const groups = useQuery({ ...groupsQueryOptions(), enabled: perms.read })

  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<VmZoneFilter>('all')
  const [kind, setKind] = useState<VmKindFilter>('all')
  const [group, setGroup] = useState<string | undefined>()
  const [owner, setOwner] = useState<string | undefined>(
    initialVendor === 'all' ? undefined : initialVendor
  )
  const [view, setView] = usePref(
    `resource-view:${preset}`,
    ['grid', 'list'] as const,
    'grid'
  )
  const [size, setSize] = usePref<RackSize>(
    `resource-card-size:${preset}`,
    ['s', 'm', 'l'] as const,
    'l'
  )
  const [filters, setFilters] = useState<AccountFilters>({})
  const [sort, setSort] = useState<VmSortKey>('status')
  const [dir, setDir] = useState<'asc' | 'desc'>('asc')
  const [creating, setCreating] = useState(false)

  const allVms = vmsQ.data?.items
  const rows = useMemo(() => {
    const merged = [
      ...(wantVm ? allVms || [] : []),
      ...(wantGateway ? gateway.vms : []),
    ]
    return preset === 'supplier' ? merged.filter((vm) => vm.vendor_id) : merged
  }, [allVms, gateway.vms, preset, wantVm, wantGateway])
  const matchesOwner = (vm: Vm) =>
    !owner || (owner === PLATFORM ? !vm.vendor_id : vm.vendor_id === owner)
  const matchesGroup = (vm: Vm) =>
    !group ||
    (group === 'none'
      ? !vm.groups?.length
      : vm.groups?.some((g) => String(g.id) === group))
  const scoped = filterVms(rows, '', 'all', kind).filter(matchesOwner)
  const list = sortVms(
    filterVms(rows, q, filter, kind).filter(
      (vm) =>
        matchesOwner(vm) &&
        matchesGroup(vm) &&
        matchesAccountFilters(vm, filters)
    ),
    sort,
    dir,
    accounts
  )
  const selectable = list.filter(
    (vm) => !isGatewayRow(vm) || gateway.accountOf(vm)?.status !== 'archived'
  )
  const danger = useVmDangerDialogs(allVms || [])
  const loading = (wantVm && vmsQ.isLoading) || gateway.loading
  const error = (wantVm ? vmsQ.error : null) || gateway.error
  const poolQueue = wantVm ? vmsQ.data?.pool_queue : undefined

  const refreshSupplier = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: supplierQueryKeys.root() }),
      qc.invalidateQueries({ queryKey: vmsListQueryOptions().queryKey }),
      qc.invalidateQueries({ queryKey: accountQueryKey }),
    ])
  }
  const openCreate = () =>
    preset === 'codex' ? gateway.openCreate() : setCreating(true)
  const createLabel =
    preset === 'vm'
      ? t('vm:createVmForm.create')
      : preset === 'codex'
        ? t('common:codexCreate')
        : t('vendor:addAccount')
  const header = {
    vm: {
      title: VIEW_TITLES.vm,
      description: t('vm:listPage.slotAndAccountUsageGroupedByServerAndStatus'),
    },
    codex: {
      title: t('common:codexAccountsTitle'),
      description: t('common:codexAccountsDescription'),
    },
    supplier: {
      title: t('supplierAdmin:accounts'),
      description: t('supplierAdmin:accountsDescription'),
    },
  }[preset]

  const renderBulkEdit =
    preset === 'vm'
      ? undefined
      : preset === 'codex'
        ? gateway.renderBulkEdit
        : ({
            ids,
            onClose,
            onSaved,
          }: {
            ids: string[]
            onClose: () => void
            onSaved: (saved: string[]) => void
          }) => {
            const picked = rows.filter((vm) => ids.includes(vm.id))
            const gatewayOnly = picked.every(isGatewayRow)
            if (gatewayOnly)
              return gateway.renderBulkEdit({ ids, onClose, onSaved })
            if (picked.some(isGatewayRow)) {
              onClose()
              return null
            }
            return <VmBulkEdit ids={ids} onClose={onClose} onSaved={onSaved} />
          }
  const mixedSelection = (ids: string[]) => {
    const picked = rows.filter((vm) => ids.includes(vm.id))
    return picked.some(isGatewayRow) && !picked.every(isGatewayRow)
  }

  const body = list.length ? (
    view === 'grid' ? (
      <VmRack
        vms={list}
        accounts={accounts}
        filter={filter}
        size={size}
        onCreate={perms.create ? openCreate : undefined}
      />
    ) : (
      <VmTable vms={list} accounts={accounts} />
    )
  ) : (
    <EmptyState
      reason={
        rows.length
          ? t('common:codexNoMatches')
          : preset === 'codex'
            ? t('common:codexEmpty')
            : t('vm:listPage.noSlotsMatchTheCurrentFilters')
      }
      actionLabel={!rows.length && perms.create ? createLabel : undefined}
      onAction={!rows.length && perms.create ? openCreate : undefined}
    />
  )
  const withActions = (children: React.ReactNode) =>
    preset === 'codex' ? (
      <VmActionsContext.Provider value={gateway.actions}>
        {children}
      </VmActionsContext.Provider>
    ) : (
      <VmActionsProvider
        accounts={accounts}
        onReset={perms.manage ? danger.onReset : undefined}
        onDelete={perms.manage ? danger.onDelete : undefined}
      >
        {preset === 'supplier' ? (
          <MixedActions gateway={gateway.actions}>{children}</MixedActions>
        ) : (
          children
        )}
      </VmActionsProvider>
    )

  return (
    <PageHeader
      title={header.title}
      description={header.description}
      fluid
      extra={
        <div className='flex flex-wrap items-center gap-3'>
          <SearchSelect
            label={t('vm:listPage.filterByGroup')}
            value={group}
            options={[
              { id: 'none', name: t('vm:listPage.ungrouped') },
              ...(groups.data?.items || []).map((g) => ({
                id: String(g.id),
                name: g.name,
              })),
            ]}
            allLabel={t('vm:listPage.allGroups')}
            searchPlaceholder={t('vm:listPage.searchGroups')}
            onChange={setGroup}
          />
          <SearchSelect
            label={
              preset === 'supplier'
                ? t('vm:listPage.filterBySupplier')
                : t('common:codexOwner')
            }
            value={owner}
            options={[
              ...(preset === 'supplier'
                ? []
                : [{ id: PLATFORM, name: t('common:codexPlatformOwned') }]),
              ...suppliers.map((s) => ({ id: s.id, name: s.name })),
            ]}
            allLabel={
              preset === 'supplier'
                ? t('vm:listPage.allSuppliers')
                : t('common:codexAllOwners')
            }
            searchPlaceholder={t('vm:listPage.searchSuppliers')}
            loading={suppliersQ.isLoading}
            onChange={setOwner}
          />
          {poolQueue ? (
            <span
              className={cn(
                'text-xs text-muted-foreground tabular-nums',
                poolQueue.global_queue_depth > 0 &&
                  'text-[color:var(--status-warn)]'
              )}
              title={t('vm:listPage.claudeRequestsWaitingForANewSeatBeforeVM')}
            >
              <Trans
                ns='vm'
                i18nKey='listPage.globalQueue'
                values={{
                  global_queue_depth: poolQueue.global_queue_depth,
                  queue_max: poolQueue.queue_max,
                }}
              />
            </span>
          ) : null}
          {perms.create && preset === 'codex' ? (
            <Button variant='outline' onClick={gateway.openImport}>
              <Upload />
              {t('common:codexImportTitle')}
            </Button>
          ) : null}
          {perms.create ? (
            <Button onClick={openCreate}>
              <Plus />
              {createLabel}
            </Button>
          ) : null}
        </div>
      }
    >
      <QueryGate loading={loading} error={error} skeleton={<VmListSkeleton />}>
        <FleetPulse
          className='mb-3'
          vms={scoped}
          accounts={accounts}
          filter={filter}
          onFilter={setFilter}
        />
        <AccountOverview className='mb-3' vms={scoped} enabled={perms.read} />
        <VmListToolbar
          leading={
            <>
              {preset === 'codex' ? null : (
                <KindFilterChips vms={rows} kind={kind} onChange={setKind} />
              )}
              {wantGateway ? (
                <label className='flex items-center gap-2 text-xs text-muted-foreground'>
                  <Switch checked={archived} onCheckedChange={setArchived} />
                  {t('common:showArchived')}
                </label>
              ) : null}
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
          trailing={view === 'list' ? <VmColumnsMenu /> : null}
        />
        <AccountFilterBar
          vms={scoped}
          zone={filter}
          onZone={setFilter}
          filters={filters}
          onFilters={setFilters}
          canReset={Boolean(q || group || owner || kind !== 'all')}
          onReset={() => {
            setQ('')
            setFilter('all')
            setKind('all')
            setGroup(undefined)
            setOwner(undefined)
            setFilters({})
          }}
        />
        <VmSelectionProvider
          vms={selectable}
          enabled={perms.edit}
          scopeKey={JSON.stringify([
            q,
            filter,
            kind,
            group,
            owner,
            archived,
            filters,
          ])}
          renderBulkEdit={renderBulkEdit}
          blockBulkEdit={
            preset === 'supplier'
              ? (ids) =>
                  mixedSelection(ids) ? t('vm:vmBulk.mixedKinds') : null
              : undefined
          }
        >
          {withActions(
            <>
              {body}
              {/* 详情卡读取操作上下文，必须在提供者内部 */}
              {wantGateway ? gateway.detailCard : null}
            </>
          )}
        </VmSelectionProvider>
      </QueryGate>
      {wantGateway ? gateway.dialogs : null}
      {wantVm && perms.manage ? danger.dialogs : null}
      {preset === 'vm' ? (
        <CreateVmDialog open={creating} onOpenChange={setCreating} />
      ) : null}
      {preset === 'supplier' && creating ? (
        <AdminAccountCreateForm
          suppliers={suppliers}
          initialVendor={owner || 'all'}
          close={() => setCreating(false)}
          saved={refreshSupplier}
        />
      ) : null}
    </PageHeader>
  )
}
