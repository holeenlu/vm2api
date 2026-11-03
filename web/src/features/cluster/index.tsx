import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { VIEW_TITLES } from '@/config/nav'
import type { ClusterLocalStatus } from '@/types/panel-cluster'
import type { Vm } from '@/types/panel-vm'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { fmtUsd } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { PageHeader } from '@/components/page-header'
import { QueryGate, errorMessage } from '@/components/query-gate'
import { meQueryOptions } from '@/features/auth/queries'
import { ClusterSkeleton } from '@/features/cluster/cluster-skeleton'
import {
  localDetailRows,
  localDetailSummary,
} from '@/features/cluster/connection-rows'
import { JoinVpsDialog } from '@/features/cluster/join-dialog'
import { MachineDetail } from '@/features/cluster/machine-detail'
import { MachineTable } from '@/features/cluster/machine-table'
import {
  buildMachines,
  clusterSummary,
  type ClusterMachine,
} from '@/features/cluster/model'
import {
  CLUSTER_LOCAL_KEY,
  CLUSTER_NODES_KEY,
  clusterLocalQueryOptions,
  clusterNodesQueryOptions,
} from '@/features/cluster/queries'
import { SshPanel, type SshPanelTab } from '@/features/cluster/ssh-panel'
import { dashboardQueryOptions } from '@/features/overview/queries'
import { CreateVmDialog } from '@/features/vm/create-vm-dialog'

const SELECTED_KEY = 'vm2api.cluster.machine'

function readSelected(): string {
  try {
    return localStorage.getItem(SELECTED_KEY) || 'local'
  } catch {
    return 'local'
  }
}

function MiniStat({
  label,
  value,
  hint,
  tone,
}: {
  label: string
  value: string
  hint?: React.ReactNode
  tone?: 'caution' | 'bad'
}) {
  return (
    <Card
      className={cn(
        'gap-0 px-4 py-3 shadow-none',
        tone === 'caution' &&
          'border-l-2 border-l-[color:var(--status-caution)]',
        tone === 'bad' && 'border-l-2 border-l-[color:var(--status-bad)]'
      )}
    >
      <div className='text-xs text-muted-foreground'>{label}</div>
      <div className='field-metric mt-1 text-[22px] leading-tight font-semibold'>
        {value}
      </div>
      {hint ? (
        <div className='mt-0.5 truncate text-[11.5px] text-muted-foreground/90'>
          {hint}
        </div>
      ) : null}
    </Card>
  )
}

function checkedTime(iso: string | null | undefined): string | null {
  const t = iso ? Date.parse(iso) : NaN
  if (!Number.isFinite(t)) return null
  return new Date(t).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

export function ClusterPage() {
  const { t } = useTranslation('cluster')
  const qc = useQueryClient()
  const dash = useQuery(dashboardQueryOptions(5000))
  const me = useQuery(meQueryOptions())
  const cluster = useQuery(clusterNodesQueryOptions())
  const localLink = useQuery(clusterLocalQueryOptions())
  const canManage = me.data?.role === 'super_admin'
  const apiNodes = useMemo(() => cluster.data || [], [cluster.data])
  const dashVms = useMemo(() => (dash.data?.vms || []) as Vm[], [dash.data])
  const dashReady = !!dash.data && !dash.data.error && !dash.error
  const hostName =
    typeof window === 'undefined' ? 'local' : window.location.hostname

  const machines = useMemo(
    () =>
      buildMachines({
        hostname: hostName,
        vms: dashVms,
        nodes: apiNodes,
        host: dashReady ? dash.data?.host : undefined,
        status: localLink.data,
        available: dashReady,
      }),
    [apiNodes, dash.data?.host, dashReady, dashVms, hostName, localLink.data]
  )
  const summary = clusterSummary(machines)
  // Slots belong to VM groups here; the upstream account-pool API was retired.
  const poolOf = useMemo(() => {
    const map = new Map<string, string>()
    for (const vm of dashVms) {
      const names = (vm.groups || []).map((group) => group.name).filter(Boolean)
      if (names.length) map.set(vm.id, names.join(', '))
    }
    return map
  }, [dashVms])

  const [selected, setSelected] = useState(readSelected)
  const current: ClusterMachine | undefined =
    machines.find((m) => m.id === selected) || machines[0]
  const select = (id: string) => {
    setSelected(id)
    try {
      localStorage.setItem(SELECTED_KEY, id)
    } catch {
      // 无痕窗口等读写不了就只记在本页
    }
  }

  const [joinOpen, setJoinOpen] = useState(false)
  const [panel, setPanel] = useState<{ id: string; tab: SshPanelTab } | null>(
    null
  )
  const [dropTarget, setDropTarget] = useState<ClusterMachine | null>(null)
  const [createOn, setCreateOn] = useState<ClusterMachine | null>(null)
  const panelNode = apiNodes.find((n) => n.id === panel?.id) || null

  const remove = useMutation({
    mutationFn: (id: string) =>
      api(`/api/panel/cluster/nodes/${id}`, { method: 'DELETE' }),
    onSuccess: (_data, id) => {
      toast.success(t('removed'))
      if (panel?.id === id) setPanel(null)
      qc.invalidateQueries({ queryKey: CLUSTER_NODES_KEY })
    },
    onError: (err) => toast.error(err.message),
  })
  const refreshLocal = useMutation({
    mutationFn: () =>
      api<ClusterLocalStatus>('/api/panel/cluster/local?refresh=1'),
    onSuccess: (data) => qc.setQueryData(CLUSTER_LOCAL_KEY, data),
    onError: (err) => toast.error(err.message),
  })

  const checkedAt = checkedTime(localLink.data?.checked_at)
  // 只有主控有：节点的 SSH / 直连 / Docker / 指纹都在「连接设置」里，底下不再重复一份。
  const localDetails = {
    rows: localLink.data
      ? localDetailRows({
          status: localLink.data,
          host: dashReady ? dash.data?.host : undefined,
          nodes: apiNodes,
        })
      : null,
    summary: localLink.data ? localDetailSummary(localLink.data) : '',
    checkedAt: checkedAt
      ? t('localDetail.checkedAt', { value1: checkedAt })
      : null,
    error: localLink.error ? localLink.error.message : null,
  }

  const today = Number(
    dash.data?.billing?.today?.total_cost ??
      machines.reduce((sum, m) => sum + m.todayUsd, 0)
  )
  const total = dash.data?.billing?.total?.total_cost

  return (
    <PageHeader
      title={VIEW_TITLES.cluster}
      extra={
        canManage ? (
          <Button onClick={() => setJoinOpen(true)}>{t('join')}</Button>
        ) : undefined
      }
    >
      <span
        className='hidden'
        aria-hidden
        dangerouslySetInnerHTML={{
          __html: `<!--
THESIS: Cluster is the machines that run slots. Every machine, control host included, is one row on the same scale.
FIRST VIEWPORT: Machine table (link, load, memory, disk, slots, room left, today) then the selected machine's slots.
LINK: state first (down / fell back to SSH), latency only when really slow; slot traffic rides the direct link.
ROOM: by slot memory quota, not current use — KVM guests fill what they were given.
ANTI-PATTERN: Local board vs remote table, lifetime spend per host, one-sample latency alarms, remove beside manage on every row.
-->`,
        }}
      />
      <QueryGate
        loading={dash.isLoading && !dash.data}
        error={null}
        skeleton={<ClusterSkeleton />}
      >
        <div className='space-y-3'>
          {dash.error || dash.data?.error ? (
            <Alert variant='destructive'>
              <AlertTitle>{t('localLoadFailed')}</AlertTitle>
              <AlertDescription>
                {errorMessage(
                  dash.error || new Error(String(dash.data?.error))
                )}
              </AlertDescription>
            </Alert>
          ) : null}
          {cluster.error ? (
            <Alert variant='destructive'>
              <AlertTitle>{t('nodeLoadFailed')}</AlertTitle>
              <AlertDescription>{errorMessage(cluster.error)}</AlertDescription>
            </Alert>
          ) : null}

          <div className='grid grid-cols-2 gap-3 xl:grid-cols-4'>
            <MiniStat
              label={t('machines')}
              value={String(summary.machines)}
              hint={
                summary.offline ? (
                  <span className='text-[color:var(--status-bad)]'>
                    {t('summary.offline', { count: summary.offline })}
                  </span>
                ) : summary.online === summary.machines ? (
                  t('summary.allOnline')
                ) : (
                  t('summary.online', { count: summary.online })
                )
              }
              tone={summary.offline ? 'bad' : undefined}
            />
            <MiniStat
              label={t('slots')}
              value={String(summary.slots)}
              hint={[
                t('summary.serving', { value1: summary.on }),
                t('summary.restricted', { value1: summary.restricted }),
                summary.stopped
                  ? t('summary.stopped', { value1: summary.stopped })
                  : '',
              ]
                .filter(Boolean)
                .join(' · ')}
            />
            <MiniStat
              label={t('capacity.room')}
              value={
                summary.fit == null
                  ? '—'
                  : t('capacity.fitCount', { count: summary.fit })
              }
              hint={
                summary.fit == null
                  ? t('summary.memoryPending')
                  : summary.fitBy.length
                    ? t('summary.fitBy', {
                        value1: summary.fitBy
                          .map((x) => `${x.name} ${x.fit}`)
                          .join(' · '),
                      })
                    : t('summary.allFull')
              }
              tone={summary.fit === 0 ? 'caution' : undefined}
            />
            <MiniStat
              label={t('summary.todaySpend')}
              value={fmtUsd(today, 2)}
              hint={
                total != null
                  ? t('summary.cumulative', { value1: fmtUsd(total, 2) })
                  : undefined
              }
            />
          </div>

          <Card className='gap-0 overflow-hidden py-0 shadow-none'>
            <div className='flex min-h-11 items-center gap-2 border-b px-4 py-2'>
              <h3 className='text-[13px] font-semibold'>{t('machines')}</h3>
              <span className='text-[11px] text-muted-foreground'>
                {t('machine.tableHint')}
              </span>
            </div>
            <MachineTable
              machines={machines}
              selectedId={current?.id || 'local'}
              onSelect={select}
            />
          </Card>

          <Card className='gap-0 overflow-hidden py-0 shadow-none'>
            <MachineDetail
              machines={machines}
              selectedId={current?.id || 'local'}
              onSelect={select}
              poolNameOf={(id) => poolOf.get(id) || null}
              canManage={canManage}
              localDetails={localDetails}
              localRefresh={{
                pending: refreshLocal.isPending,
                run: () => refreshLocal.mutate(),
              }}
              onOpenNode={(id, tab) => setPanel({ id, tab })}
              onRemove={setDropTarget}
              onCreate={setCreateOn}
            />
          </Card>
        </div>
      </QueryGate>

      <JoinVpsDialog
        open={joinOpen}
        onOpenChange={setJoinOpen}
        nodes={apiNodes}
        onJoined={(node) => {
          qc.invalidateQueries({ queryKey: CLUSTER_NODES_KEY })
          select(node.id)
          setPanel({ id: node.id, tab: 'link' })
        }}
      />
      <SshPanel
        node={panelNode}
        nodes={apiNodes}
        tab={panel?.tab}
        vmCount={
          dashReady
            ? dashVms.filter((vm) => vm.node_id === panel?.id).length
            : null
        }
        onOpenChange={(open) => {
          if (!open) setPanel(null)
        }}
      />
      <CreateVmDialog
        open={!!createOn}
        onOpenChange={(open) => {
          if (!open) setCreateOn(null)
        }}
        nodeId={createOn?.role === 'remote' ? createOn.id : undefined}
      />
      <ConfirmDialog
        open={!!dropTarget}
        onOpenChange={(open) => {
          if (!open) setDropTarget(null)
        }}
        title={t('removeTitle')}
        desc={
          dropTarget
            ? t('removeDescription', {
                value1: dropTarget.name,
                value2: dropTarget.address,
              })
            : ''
        }
        confirmText={t('remove')}
        cancelBtnText={t('cancel')}
        destructive
        handleConfirm={() => {
          if (!dropTarget) return
          remove.mutate(dropTarget.id)
          setDropTarget(null)
        }}
      />
    </PageHeader>
  )
}
