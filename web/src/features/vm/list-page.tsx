import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { VIEW_TITLES } from '@/config/nav'
import { t as tr } from '@/i18n'
import type { Vm } from '@/types/panel-vm'
import { useTranslation, Trans } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { panelQueryKeys } from '@/lib/query-keys'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { ChoiceTiles } from '@/components/choice-tiles'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { EmptyState } from '@/components/empty-state'
import { PageHeader } from '@/components/page-header'
import { SlotIdentity } from '@/components/platform-chip'
import { QueryGate } from '@/components/query-gate'
import { SearchSelect } from '@/components/search-select'
import { meQueryOptions } from '@/features/auth/queries'
import { groupsQueryOptions } from '@/features/groups/queries'
import { usageQueryOptions } from '@/features/overview/queries'
import { planDeleteActiveVm } from '@/features/vm/active-vm'
import { CreateVmDialog } from '@/features/vm/create-vm-dialog'
import { DeleteActiveVmHint } from '@/features/vm/delete-active-hint'
import { FleetPulse } from '@/features/vm/fleet-pulse'
import { VmListSkeleton } from '@/features/vm/list-skeleton'
import { vmsListQueryOptions } from '@/features/vm/queries'
import { usePoolSeatStream } from '@/features/vm/use-pool-seat-stream'
import { VmActionsProvider } from '@/features/vm/vm-actions-provider'
import {
  readPref,
  VmListToolbar,
  writePref,
} from '@/features/vm/vm-list-toolbar'
import { vmPermsFor } from '@/features/vm/vm-perms'
import { VmRack } from '@/features/vm/vm-rack'
import type { RackSize } from '@/features/vm/vm-rack-blade'
import type { VmZoneFilter } from '@/features/vm/vm-rack-model'
import {
  filterVms,
  KindFilterChips,
  sortVms,
  VmTable,
  type VmKindFilter,
  type VmSortKey,
} from '@/features/vm/vm-table'
import { removeDeletedVmFromCache } from './queries'
import { VmSelectionProvider } from './vm-selection'

const LS_VIEW = 'vm-list-view'
const LS_SIZE = 'vm-rack-size'

export function VmListPage() {
  const { t: tVm } = useTranslation('vm')

  const me = useQuery(meQueryOptions())
  const canCreate = me.data?.role === 'super_admin'
  const vendorsQ = useQuery({
    queryKey: panelQueryKeys.supplierList(),
    queryFn: () =>
      api<Array<{ id: string; name: string }>>('/api/admin/vendors'),
    enabled: canCreate,
  })
  const vmsQ = useQuery(vmsListQueryOptions())
  const refetchVms = vmsQ.refetch
  useEffect(() => {
    // SSE patches reset React Query's observer timers. Keep the HTTP refresh
    // cadence independent so busy seats cannot starve quota/window updates.
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
  }, [refetchVms])
  usePoolSeatStream()
  const usage = useQuery({
    ...usageQueryOptions(5000),
    enabled: me.data?.role !== 'user',
  })
  const qc = useQueryClient()
  const [groupFilter, setGroupFilter] = useState('all')
  const [vendorFilter, setVendorFilter] = useState('all')
  const groups = useQuery(groupsQueryOptions())
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<VmZoneFilter>('all')
  const [kind, setKind] = useState<VmKindFilter>('all')
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
  const [resetTarget, setResetTarget] = useState<Vm | null>(null)
  const [resetMode, setResetMode] = useState<'keep' | 'traits'>('keep')
  const [resetInput, setResetInput] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<Vm | null>(null)
  const [deleteInput, setDeleteInput] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const resetVm = useMutation({
    mutationFn: ({ id, mode }: { id: string; mode: 'keep' | 'traits' }) =>
      api(`/api/panel/vms/${encodeURIComponent(id)}/reset`, {
        method: 'POST',
        body: JSON.stringify({ mode }),
      }),
    onSuccess: async (_data, { mode }) => {
      toast.success(
        mode === 'keep'
          ? tVm('vm:listPage.rebuiltWithExistingData')
          : tVm('vm:listPage.rebuiltWithANewIdentity')
      )
      setResetTarget(null)
      setResetInput('')
      await qc.invalidateQueries({ queryKey: vmsListQueryOptions().queryKey })
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const deleteVm = useMutation({
    mutationFn: async ({ id, switchTo }: { id: string; switchTo?: string }) => {
      if (switchTo) {
        await api(`/api/panel/vms/${encodeURIComponent(switchTo)}/activate`, {
          method: 'POST',
        })
      }
      return api(`/api/panel/vms/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      })
    },
    onSuccess: async (_data, { id, switchTo }) => {
      toast.success(
        switchTo
          ? tr('vm:sync14008SwitchedAndDeleted', {
              value1: switchTo,
              value2: id,
            })
          : tr('vm:detailPage.deleted')
      )
      setDeleteTarget(null)
      setDeleteInput('')
      await removeDeletedVmFromCache(qc, id)
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const vms: Vm[] = vmsQ.data?.items || []
  const poolQueue = vmsQ.data?.pool_queue
  const accounts = usage.data?.accounts
  const perms = vmPermsFor(me.data?.role)
  const matchesVendor = (v: Vm) =>
    vendorFilter === 'all' ||
    (vendorFilter === 'none' ? !v.vendor_id : v.vendor_id === vendorFilter)
  const matchesGroup = (v: Vm) =>
    groupFilter === 'all' ||
    (groupFilter === 'none'
      ? !v.groups?.length
      : v.groups?.some((g) => String(g.id) === groupFilter))
  const scoped = filterVms(vms, '', 'all', kind).filter(matchesVendor)
  const list = sortVms(
    filterVms(vms, q, filter, kind).filter(
      (v) => matchesGroup(v) && matchesVendor(v)
    ),
    sort,
    dir,
    accounts
  )
  const deletePlan = deleteTarget
    ? planDeleteActiveVm(deleteTarget, vms)
    : { kind: 'normal' as const }
  const deleteBlocked = deletePlan.kind === 'blocked'
  const deleteSwitchId =
    deletePlan.kind === 'switch' ? deletePlan.replacement.id : undefined

  return (
    <PageHeader
      title={VIEW_TITLES.vm}
      description={tVm(
        'vm:listPage.slotAndAccountUsageGroupedByServerAndStatus'
      )}
      fluid
      extra={
        poolQueue || canCreate ? (
          <div className='flex flex-wrap items-center gap-3'>
            <SearchSelect
              label={tVm('vm:listPage.filterByGroup')}
              value={groupFilter === 'all' ? undefined : groupFilter}
              options={[
                { id: 'none', name: tVm('vm:listPage.ungrouped') },
                ...(groups.data?.items || []).map((g) => ({
                  id: String(g.id),
                  name: g.name,
                })),
              ]}
              allLabel={tVm('vm:listPage.allGroups')}
              searchPlaceholder={tVm('vm:listPage.searchGroups')}
              onChange={(id) => setGroupFilter(id || 'all')}
            />
            {canCreate ? (
              <SearchSelect
                label={tVm('vm:listPage.filterBySupplier')}
                value={vendorFilter === 'all' ? undefined : vendorFilter}
                options={[
                  { id: 'none', name: tVm('vm:listPage.unassignedSupplier') },
                  ...(vendorsQ.data || []).map((vendor) => ({
                    id: vendor.id,
                    name: vendor.name,
                  })),
                ]}
                allLabel={tVm('vm:listPage.allSuppliers')}
                searchPlaceholder={tVm('vm:listPage.searchSuppliers')}
                loading={vendorsQ.isLoading}
                onChange={(id) => setVendorFilter(id || 'all')}
              />
            ) : null}
            {poolQueue ? (
              <span
                className={cn(
                  'text-xs text-muted-foreground tabular-nums',
                  poolQueue.global_queue_depth > 0 &&
                    'text-[color:var(--status-warn)]'
                )}
                title={tVm(
                  'vm:listPage.claudeRequestsWaitingForANewSeatBeforeVM'
                )}
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
            {canCreate ? (
              <Button onClick={() => setCreateOpen(true)}>
                <Trans ns='vm' i18nKey='createVmForm.create' />
              </Button>
            ) : null}
          </div>
        ) : undefined
      }
    >
      <QueryGate
        loading={vmsQ.isLoading}
        error={vmsQ.error}
        skeleton={<VmListSkeleton />}
      >
        <FleetPulse
          className='mb-3'
          vms={scoped}
          accounts={accounts}
          filter={filter}
          onFilter={setFilter}
        />
        <VmListToolbar
          leading={
            <>
              <KindFilterChips vms={vms} kind={kind} onChange={setKind} />
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
          vms={list}
          enabled={canCreate}
          scopeKey={JSON.stringify([
            q,
            filter,
            kind,
            groupFilter,
            vendorFilter,
          ])}
        >
          <VmActionsProvider
            accounts={accounts}
            onReset={
              perms.admin
                ? (vm) => {
                    setResetInput('')
                    setResetTarget(vm)
                  }
                : undefined
            }
            onDelete={
              perms.remove
                ? (vm) => {
                    setDeleteInput('')
                    setDeleteTarget(vm)
                  }
                : undefined
            }
          >
            {list.length ? (
              view === 'grid' ? (
                <VmRack
                  vms={list}
                  accounts={accounts}
                  filter={filter}
                  size={size}
                  onCreate={canCreate ? () => setCreateOpen(true) : undefined}
                />
              ) : (
                <VmTable vms={list} accounts={accounts} />
              )
            ) : (
              <EmptyState
                reason={tVm('vm:listPage.noSlotsMatchTheCurrentFilters')}
                actionLabel={
                  canCreate ? tVm('vm:createVmForm.create') : undefined
                }
                onAction={canCreate ? () => setCreateOpen(true) : undefined}
              />
            )}
          </VmActionsProvider>
        </VmSelectionProvider>
      </QueryGate>
      <ConfirmDialog
        open={!!resetTarget}
        onOpenChange={(open) => {
          if (!open) {
            setResetTarget(null)
            setResetInput('')
          }
        }}
        title={tVm('vm:detailPage.rebuildSlot')}
        desc={
          resetTarget ? (
            <>
              <p className='flex min-w-0 items-center gap-1.5'>
                <SlotIdentity vm={resetTarget} compact />
                <span className='shrink-0 text-muted-foreground'>
                  · {resetTarget.id}
                </span>
              </p>
              <p className='mt-2'>
                <Trans
                  ns='vm'
                  i18nKey='detailPage.localAndClusterSlotsBothReceiveAReplacementContainer'
                />
              </p>
            </>
          ) : (
            ''
          )
        }
        confirmText={
          resetMode === 'keep'
            ? tVm('vm:detailOpsTab.rebuildWithExistingData')
            : tVm('vm:detailOpsTab.rebuildWithNewIdentity')
        }
        cancelBtnText={tVm('vm:authSchemeEditor.cancel')}
        destructive={resetMode === 'traits'}
        disabled={resetInput.trim() !== resetTarget?.id}
        isLoading={resetVm.isPending}
        handleConfirm={() => {
          if (resetTarget)
            resetVm.mutate({ id: resetTarget.id, mode: resetMode })
        }}
      >
        <ChoiceTiles
          label={tVm('vm:detailPage.rebuildMethod')}
          value={resetMode}
          onChange={setResetMode}
          choices={[
            {
              value: 'keep',
              title: tVm('vm:detailOpsTab.rebuildWithExistingData'),
              detail: tVm(
                'vm:detailPage.keepsCredentialsFingerprintsHostnameAndStatisticsReplacesOnlyContainer'
              ),
            },
            {
              value: 'traits',
              title: tVm('vm:detailOpsTab.rebuildWithNewIdentity'),
              detail: tVm(
                'vm:detailPage.clearsCredentialsAndTheHomeDirectoryThenRegeneratesHostname'
              ),
            },
          ]}
        />
        <Input
          autoFocus
          autoComplete='off'
          spellCheck={false}
          placeholder={resetTarget?.id}
          aria-label={tVm('vm:detailPage.confirmID')}
          value={resetInput}
          onChange={(e) => setResetInput(e.target.value)}
          onKeyDown={(e) => {
            if (
              e.key === 'Enter' &&
              resetInput.trim() === resetTarget?.id &&
              !resetVm.isPending &&
              resetTarget
            ) {
              resetVm.mutate({ id: resetTarget.id, mode: resetMode })
            }
          }}
        />
      </ConfirmDialog>
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTarget(null)
            setDeleteInput('')
          }
        }}
        title={tVm('vm:detailPage.deleteAlternative')}
        desc={
          deleteTarget ? (
            <>
              <p className='flex min-w-0 items-center gap-1.5'>
                <SlotIdentity vm={deleteTarget} compact />
                <span className='shrink-0 text-muted-foreground'>
                  · {deleteTarget.id}
                </span>
              </p>
              <p className='mt-2 text-destructive'>
                <Trans
                  ns='vm'
                  i18nKey='listPage.slotDeletionIsPermanentTheContainerHomeDirectoryCredentials'
                />
              </p>
              <DeleteActiveVmHint target={deleteTarget} vms={vms} />
            </>
          ) : (
            ''
          )
        }
        confirmText={
          deletePlan.kind === 'switch'
            ? tr('vm:sync14008SwitchAndDelete')
            : tr('anthropic:delete')
        }
        cancelBtnText={tr('models:cancel')}
        destructive
        disabled={deleteBlocked || deleteInput.trim() !== deleteTarget?.id}
        isLoading={deleteVm.isPending}
        handleConfirm={() => {
          if (deleteTarget && !deleteBlocked) {
            deleteVm.mutate({
              id: deleteTarget.id,
              switchTo: deleteSwitchId,
            })
          }
        }}
      >
        <Input
          autoFocus
          autoComplete='off'
          spellCheck={false}
          placeholder={deleteTarget?.id}
          aria-label={tVm('vm:detailPage.confirmID')}
          value={deleteInput}
          onChange={(e) => setDeleteInput(e.target.value)}
          onKeyDown={(e) => {
            if (
              e.key === 'Enter' &&
              deleteInput.trim() === deleteTarget?.id &&
              !deleteVm.isPending &&
              !deleteBlocked
            ) {
              deleteVm.mutate({
                id: deleteTarget.id,
                switchTo: deleteSwitchId,
              })
            }
          }}
        />
      </ConfirmDialog>
      <CreateVmDialog open={createOpen} onOpenChange={setCreateOpen} />
    </PageHeader>
  )
}
