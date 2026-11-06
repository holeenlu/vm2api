import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from '@tanstack/react-router'
import type { Vm } from '@/types/panel-vm'
import { BarChart3, Link2, Pencil, RefreshCw } from 'lucide-react'
import { useTranslation, Trans } from 'react-i18next'
import { api } from '@/lib/api'
import {
  concInfo,
  fableCap,
  rpmInfo,
  vmCost,
  weeklySplitInfo,
} from '@/lib/fable-status'
import { usedPctOf } from '@/lib/format'
import { panelQueryKeys } from '@/lib/query-keys'
import { compactEmail } from '@/lib/vm-kind'
import {
  accountStatus,
  claudeTier,
  distinctStatusTones,
  poolStatus,
  restrictionCopy,
  vmRunning,
} from '@/lib/vm-status'
import { useNow } from '@/hooks/use-now'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { PageHeader } from '@/components/page-header'
import { PlatformChip } from '@/components/platform-chip'
import { QueryGate } from '@/components/query-gate'
import { SearchSelect } from '@/components/search-select'
import { StatusMark } from '@/components/status-mark'
import { ProxyChip } from '@/features/proxies/proxy-chip'
import { proxiesQueryOptions } from '@/features/proxies/queries'
import { useAccountDeleteDialog } from '@/features/resources/vm-danger-dialogs'
import {
  AccountUsageDialog,
  usageQueryString,
  type UsageRange,
} from '@/features/vendor/account-usage-dialog'
import type { VendorUsageReport } from '@/features/vendor/portal-model'
import { VmOverviewTab } from '@/features/vm/detail-overview-tab'
import { Field } from '@/features/vm/detail-section-primitives'
import { VmDetailSkeleton } from '@/features/vm/detail-skeleton'
import { vmTodayCounts } from '@/features/vm/detail-today'
import { NodeChip } from '@/features/vm/node-chip'
import { RuntimeChip } from '@/features/vm/runtime-chip'
import {
  SchedulableSwitch,
  vmSchedulableProps,
} from '@/features/vm/schedulable-switch'
import {
  VmActionsContext,
  type VmActions,
} from '@/features/vm/vm-actions-context'
import { useVmPerms } from '@/features/vm/vm-perms'
import { useAccountAction, useGatewayQuota } from './account-actions'
import { GatewayAccountDialog } from './account-dialog'
import { GatewayAccountProxyTab } from './account-proxy-tab'
import {
  ForecastPanel,
  PanelCard,
  ProfilePanel,
  ProtectionPanel,
  QuotaPanel,
} from './account-runtime-panels'
import { GatewayAccountTestPanel } from './account-test-dialog'
import {
  type BpsProbe,
  bpsViewOf,
  accountBase,
  accountCatalogQueryOptions,
  accountQueryKey,
  accountsQueryOptions,
  gatewayAccountAsVm,
  gatewayAccountBilling,
  gatewayExitProbePath,
  groupNamesOf,
  usageModelRows,
  type GatewayAccount,
} from './accounts-model'
import { BpsProbeList, BpsStatusText } from './bps-section'

// 与「查看统计」弹窗的默认范围相同，按模型成本与弹窗共用缓存。
const ALL_TIME: UsageRange = { range: 'all', start_date: '', end_date: '' }

/** 页签留在外层：切换账号时主体按 id 重挂，停在同一页签。 */
export function CodexAccountDetailPage() {
  const { id } = useParams({ from: '/_authenticated/codex-accounts/$id' })
  const [tab, setTab] = useState('overview')
  return <AccountDetailBody key={id} id={id} tab={tab} onTabChange={setTab} />
}

export function AccountDetailBody({
  id,
  tab,
  onTabChange,
}: {
  id: string
  tab: string
  onTabChange: (tab: string) => void
}) {
  const { t } = useTranslation(['common', 'vm', 'vendor'])
  const navigate = useNavigate()
  const perms = useVmPerms()
  const detail = useQuery({
    queryKey: [...accountQueryKey, id, 'detail'],
    queryFn: () =>
      api<{ account: GatewayAccount; bps_probes?: BpsProbe[] }>(
        `${accountBase}/${encodeURIComponent(id)}`
      ),
    refetchInterval: 5000,
  })
  const list = useQuery(accountsQueryOptions(false))
  const catalog = useQuery(accountCatalogQueryOptions())
  const proxies = useQuery(proxiesQueryOptions())
  const usage = useQuery({
    queryKey: panelQueryKeys.vendorAccount(
      accountBase,
      'account-usage',
      id,
      ALL_TIME
    ),
    queryFn: () =>
      api<VendorUsageReport>(
        `${accountBase}/${encodeURIComponent(id)}/usage?${usageQueryString(ALL_TIME)}`
      ),
    refetchOnWindowFocus: false,
  })
  const { busyId, run, refresh } = useAccountAction()
  const quota = useGatewayQuota()
  const now = useNow()
  const [dialog, setDialog] = useState<'edit' | 'authorize' | null>(null)
  const [stats, setStats] = useState(false)
  const [confirmArchive, setConfirmArchive] = useState(false)
  const deletion = useAccountDeleteDialog({
    onDeleted: () => void navigate({ to: '/codex-accounts' }),
  })
  const groupNames = useMemo(() => groupNamesOf(catalog.data), [catalog.data])
  const rows = list.data?.items || []
  const listed = rows.find((row) => row.id === id)
  const account = detail.data?.account || listed
  const vm: Vm | null = account
    ? {
        ...gatewayAccountAsVm(account, groupNames, proxies.data?.proxies),
        reset_credits: quota.results[account.id]?.reset_credits,
      }
    : null
  const archived = account?.status === 'archived'
  const accountTone = vm ? accountStatus(vm) : null
  const extraPoolTones =
    vm && accountTone
      ? distinctStatusTones([poolStatus(vm)], accountTone.text)
      : []
  // 概览直接复用 VM 详情页的状态板、计费窗口与按模型成本，数据取自 Gateway 账号。
  const billing = account
    ? {
        ...gatewayAccountBilling(account),
        by_model: usageModelRows(usage.data),
      }
    : null
  const actions: VmActions | null =
    account && vm
      ? {
          openDetail: () => onTabChange('overview'),
          openTest: () => onTabChange('test'),
          openStats: () => setStats(true),
          openReauth: () => setDialog('authorize'),
          openEdit: () => setDialog('edit'),
          refreshToken: () => void run(account, 'refresh'),
          recover: () => void run(account, 'recover'),
          refreshingId: busyId,
          recoveringId: busyId,
          packageExport: false,
          setSchedulable: (_vm, next) =>
            run(account, next ? 'resume' : 'pause', { quiet: true }),
          exitProbePath: gatewayExitProbePath,
          detailRoute: '/codex-accounts/$id',
          openaiQuota: quota.openaiQuota,
        }
      : null
  const groupText =
    account?.config.group_ids
      ?.map((group) => groupNames.get(group) || `#${group}`)
      .join(' · ') || '—'

  return (
    <PageHeader
      title={
        account?.config.email
          ? compactEmail(account.config.email, 28)
          : account?.name || id
      }
      fluid
    >
      <QueryGate
        loading={detail.isLoading && !listed}
        error={listed ? null : detail.error}
        skeleton={<VmDetailSkeleton />}
      >
        {account && vm && accountTone && actions ? (
          <VmActionsContext.Provider value={actions}>
            <div className='mb-4 flex flex-wrap items-center gap-2'>
              <Button variant='ghost' size='sm' asChild>
                <Link to='/codex-accounts'>
                  <Trans ns='vm' i18nKey='detailPage.list' />
                </Link>
              </Button>
              {rows.length > 1 ? (
                <SearchSelect
                  className='w-64'
                  label={t('codexSwitchAccount')}
                  value={id}
                  options={rows.map((row) => ({
                    id: row.id,
                    name: row.config.email
                      ? `${row.name} · ${row.config.email}`
                      : row.name,
                  }))}
                  searchPlaceholder={t('codexSearchAccounts')}
                  onChange={(next) => {
                    if (next)
                      void navigate({
                        to: '/codex-accounts/$id',
                        params: { id: next },
                      })
                  }}
                />
              ) : null}
              <PlatformChip vm={vm} />
              <RuntimeChip vm={vm} className='text-[11px]' />
              <NodeChip nodeId={vm.node_id} className='text-[11px]' />
              <StatusMark tone={accountTone} variant='pill' />
              {extraPoolTones.map((tone) => (
                <Tooltip key={`${tone.key}:${tone.text}`}>
                  <TooltipTrigger asChild>
                    <span>
                      <StatusMark tone={tone} variant='pill' />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>{restrictionCopy(vm)}</TooltipContent>
                </Tooltip>
              ))}
              <span className='text-sm text-muted-foreground'>
                {vmRunning(vm)
                  ? t('vm:detailPage.running')
                  : t('vm:detailPage.stop')}
              </span>
              {archived ? null : (
                <div className='flex items-center gap-1.5 rounded-md border px-2 py-1 text-sm text-muted-foreground'>
                  <Trans
                    ns='vm'
                    i18nKey='detailPage.scheduling'
                    components={{
                      part0: (
                        <SchedulableSwitch
                          {...vmSchedulableProps(vm)}
                          onToggle={(next) =>
                            actions!.setSchedulable!(vm, next)
                          }
                        />
                      ),
                    }}
                  />
                </div>
              )}
              <div className='ms-auto flex flex-wrap gap-2'>
                <Button
                  size='sm'
                  variant='outline'
                  onClick={() => setStats(true)}
                >
                  <Trans
                    ns='vm'
                    i18nKey='vmDetailCard.viewStatistics'
                    components={{ part0: <BarChart3 /> }}
                  />
                </Button>
                {perms.edit && !archived ? (
                  <Button
                    size='sm'
                    variant='outline'
                    loading={busyId === account.id}
                    onClick={() => void run(account, 'refresh')}
                  >
                    <Trans
                      ns='vm'
                      i18nKey='vmDetailCard.refreshToken'
                      components={{ part0: <RefreshCw /> }}
                    />
                  </Button>
                ) : null}
              </div>
            </div>
            <Tabs value={tab} onValueChange={onTabChange}>
              <TabsList>
                <TabsTrigger value='overview'>
                  <Trans ns='vm' i18nKey='detailPage.overview' />
                </TabsTrigger>
                <TabsTrigger value='account'>
                  <Trans ns='vm' i18nKey='detailAccountTab.account' />
                </TabsTrigger>
                <TabsTrigger value='proxy'>
                  <Trans ns='vm' i18nKey='detailPage.proxy' />
                </TabsTrigger>
                {perms.edit ? (
                  <TabsTrigger value='test'>
                    <Trans ns='vm' i18nKey='detailPage.test' />
                  </TabsTrigger>
                ) : null}
                <TabsTrigger value='ops'>
                  <Trans ns='vm' i18nKey='detailPage.operations' />
                </TabsTrigger>
              </TabsList>
              <VmOverviewTab
                vm={vm}
                kernel={null}
                acc={{}}
                proxy={vm.proxy || {}}
                dash={{ data: undefined }}
                u5={usedPctOf(vm, '5h')}
                u7={usedPctOf(vm, '7d')}
                tierKey={claudeTier(vm).key}
                now={now}
                cost={vmCost(vm)}
                split={weeklySplitInfo(vm)}
                conc={concInfo(vm, undefined, fableCap(undefined))}
                rpm={rpmInfo(vm, {})}
                today={vmTodayCounts(vm, billing)}
                costByModel={billing?.by_model}
                billing={billing}
                runtime={<GatewayRuntimeFields account={account} />}
              />
              <TabsContent value='account' className='space-y-3 pt-3'>
                <div className='grid gap-3 xl:grid-cols-[minmax(0,1.15fr)_minmax(20rem,0.85fr)]'>
                  <PanelCard
                    title={t('codexProperties')}
                    action={
                      archived ? null : (
                        <div className='flex gap-2'>
                          <Button
                            size='sm'
                            variant='outline'
                            onClick={() => setDialog('edit')}
                          >
                            <Pencil />
                            {t('codexEdit')}
                          </Button>
                          {perms.edit ? (
                            <Button
                              size='sm'
                              variant='outline'
                              onClick={() => setDialog('authorize')}
                            >
                              <Link2 />
                              {t('reauthorize')}
                            </Button>
                          ) : null}
                        </div>
                      )
                    }
                  >
                    <div className='divide-y'>
                      <Field label={t('codexOwner')}>
                        {account.vendor_name || t('codexPlatformOwned')}
                      </Field>
                      <Field label={t('vm:vmListTable.groups')}>
                        {groupText}
                      </Field>
                      <Field label={t('vm:detailPage.proxy')}>
                        <ProxyChip vm={vm} />
                      </Field>
                      <Field label={t('codexProjection')}>
                        {t(
                          `codexProjectionStates.${account.projection_status || 'pending'}`
                        )}
                      </Field>
                      <Field label={t('codexCredentialRevision')}>
                        {account.credential_revision ?? '—'}
                      </Field>
                      <Field label={t('vendor:wb.column.notes')}>
                        {account.config.notes || '—'}
                      </Field>
                    </div>
                  </PanelCard>
                  <div className='space-y-3'>
                    <PanelCard
                      title={t('codexBpsTitle')}
                      action={
                        archived ? null : (
                          <Button
                            size='sm'
                            variant='outline'
                            onClick={() => setDialog('edit')}
                          >
                            <Pencil />
                            {t('codexBpsManage')}
                          </Button>
                        )
                      }
                    >
                      <div className='divide-y'>
                        <Field label={t('codexBpsState')}>
                          <BpsStatusText view={bpsViewOf(account)} />
                        </Field>
                        <Field label={t('codexBpsModels')}>
                          {account.config.bps?.models.length
                            ? account.config.bps.models.join(', ')
                            : '—'}
                        </Field>
                      </div>
                      <div className='pt-3'>
                        <BpsProbeList probes={detail.data?.bps_probes} />
                      </div>
                    </PanelCard>
                    <QuotaPanel account={account} onChanged={refresh} />
                    <ProfilePanel account={account} />
                  </div>
                </div>
              </TabsContent>
              <GatewayAccountProxyTab
                account={account}
                vm={vm}
                pool={proxies.data?.proxies || []}
                canManage={perms.edit && !archived}
              />
              {perms.edit ? (
                <TabsContent value='test' className='space-y-3 pt-4'>
                  <GatewayAccountTestPanel
                    account={account}
                    vm={vm}
                    className='max-w-lg'
                  />
                </TabsContent>
              ) : null}
              <TabsContent value='ops' className='space-y-3 pt-4'>
                <div className='grid gap-3 lg:grid-cols-2'>
                  <ForecastPanel account={account} />
                  <ProtectionPanel account={account} />
                </div>
                {account.last_error ? (
                  <PanelCard title={t('codexLastError')}>
                    <p className='text-sm break-words text-destructive'>
                      {account.last_error}
                    </p>
                  </PanelCard>
                ) : null}
                {perms.manage && !archived ? (
                  <PanelCard
                    title={t('archiveAccount')}
                    action={
                      <Button
                        size='sm'
                        variant='destructive'
                        onClick={() => setConfirmArchive(true)}
                      >
                        {t('archive')}
                      </Button>
                    }
                  >
                    <p className='text-xs text-muted-foreground'>
                      {t('codexArchiveConfirm', { name: account.name })}
                    </p>
                  </PanelCard>
                ) : null}
                {perms.manage ? (
                  <PanelCard
                    title={t('codexDeleteAccount')}
                    action={
                      <Button
                        size='sm'
                        variant='destructive'
                        onClick={() => deletion.onDelete(account)}
                      >
                        {t('vm:detailPage.deleteAlternative')}
                      </Button>
                    }
                  >
                    <p className='text-xs text-muted-foreground'>
                      {t('codexDeleteConfirm', { name: account.name })}
                    </p>
                  </PanelCard>
                ) : null}
              </TabsContent>
            </Tabs>
            {stats ? (
              <AccountUsageDialog
                resource={account}
                apiBase={accountBase}
                onClose={() => setStats(false)}
              />
            ) : null}
            {dialog ? (
              <GatewayAccountDialog
                mode={dialog}
                account={account}
                onClose={() => setDialog(null)}
                onChanged={refresh}
              />
            ) : null}
            <ConfirmDialog
              open={confirmArchive}
              onOpenChange={(open) => {
                if (!open && busyId == null) setConfirmArchive(false)
              }}
              title={t('archiveAccount')}
              desc={t('codexArchiveConfirm', { name: account.name })}
              confirmText={t('archive')}
              destructive
              isLoading={busyId != null}
              handleConfirm={() =>
                void run(account, 'archive').then(
                  (ok) => ok && setConfirmArchive(false)
                )
              }
            />
            {deletion.dialog}
          </VmActionsContext.Provider>
        ) : null}
      </QueryGate>
    </PageHeader>
  )
}

/** 状态板「运行」栏：Gateway 账号没有槽位调度与内核，显示 Worker 侧的并发、RPM、权重与同步。 */
function GatewayRuntimeFields({ account }: { account: GatewayAccount }) {
  const { t } = useTranslation(['common', 'vm'])
  const unlimited = t('vm:schedulingSteps.unlimited')
  const max = Number(account.config.max_concurrency) || 0
  const rpm = Number(account.config.max_rpm) || 0
  return (
    <>
      <Field label={t('vm:vmScheduling.concurrency')} compact>
        <span className='tabular-nums'>
          {Number(account.inflight) || 0} / {max || unlimited}
        </span>
      </Field>
      <Field label={t('codexRpm')} compact>
        {rpm || unlimited}
      </Field>
      <Field label={t('codexWeight')} compact>
        {account.config.weight ?? 1}
      </Field>
      <Field label={t('codexWorkerSync')} compact>
        <span className='tabular-nums'>
          {account.synced_instance_count ?? 0} /{' '}
          {account.gateway_instance_count ?? 0}
        </span>
      </Field>
      <Field label={t('codexProjection')} compact>
        {t(`codexProjectionStates.${account.projection_status || 'pending'}`)}
      </Field>
    </>
  )
}
