import { useMemo, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { useTranslation } from 'react-i18next'
import { ConfirmDialog } from '@/components/confirm-dialog'
import {
  useAccountAction,
  useGatewayQuota,
} from '@/features/gateway-worker/account-actions'
import { GatewayAccountBulkEdit } from '@/features/gateway-worker/account-bulk-edit'
import { GatewayAccountDialog } from '@/features/gateway-worker/account-dialog'
import { GatewayAccountImportDialog } from '@/features/gateway-worker/account-import-dialog'
import { GatewayAccountTestDialog } from '@/features/gateway-worker/account-test-dialog'
import {
  accountBase,
  accountCatalogQueryOptions,
  accountsQueryOptions,
  gatewayAccountAsVm,
  gatewayExitProbePath,
  groupNamesOf,
  type GatewayAccount,
} from '@/features/gateway-worker/accounts-model'
import { proxiesQueryOptions } from '@/features/proxies/queries'
import { AccountUsageDialog } from '@/features/vendor/account-usage-dialog'
import type { VmActions } from '@/features/vm/vm-actions-context'
import { VmDetailCard } from '@/features/vm/vm-detail-card'
import type { VmPerms } from '@/features/vm/vm-perms'
import { useAccountDeleteDialog } from './vm-danger-dialogs'

export type GatewaySource = {
  loading: boolean
  error: Error | null
  vms: Vm[]
  accountOf: (vm: Vm) => GatewayAccount | undefined
  actions: VmActions
  /** 详情卡：读取操作上下文，必须渲染在 VmActionsContext 提供者内部。 */
  detailCard: ReactNode
  /** 测试、统计、编辑 / 授权、导入、归档与永久删除确认；不依赖操作上下文。 */
  dialogs: ReactNode
  renderBulkEdit: (props: {
    ids: string[]
    onClose: () => void
    onSaved: (saved: string[]) => void
  }) => ReactNode
  openCreate: () => void
  openImport: () => void
}

/**
 * Codex 账号页与供应商账号池共用的 Gateway 账号数据与操作。
 * 操作入口按账号资源能力裁剪：编辑类需要 edit，归档与永久删除需要 manage；
 * 已归档账号不再提供归档，仍可永久删除。
 */
export function useGatewaySource({
  enabled,
  archived,
  perms,
}: {
  enabled: boolean
  archived: boolean
  perms: VmPerms
}): GatewaySource {
  const { t } = useTranslation(['common', 'vm'])
  const query = useQuery({ ...accountsQueryOptions(archived), enabled })
  const catalog = useQuery({ ...accountCatalogQueryOptions(), enabled })
  const proxies = useQuery({ ...proxiesQueryOptions(), enabled })
  const { busyId, run, refresh } = useAccountAction()
  const busy = busyId != null
  const quota = useGatewayQuota()
  const [dialog, setDialog] = useState<{
    mode: 'create' | 'edit' | 'authorize'
    account?: GatewayAccount
  } | null>(null)
  const [importing, setImporting] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [testId, setTestId] = useState<string | null>(null)
  const [statsAccount, setStatsAccount] = useState<GatewayAccount | null>(null)
  const [archiveTarget, setArchiveTarget] = useState<GatewayAccount | null>(
    null
  )
  const deletion = useAccountDeleteDialog({
    onDeleted: (id) =>
      setDetailId((current) => (current === id ? null : current)),
  })
  const rows = useMemo(() => query.data?.items || [], [query.data])
  const groupNames = useMemo(() => groupNamesOf(catalog.data), [catalog.data])
  const vms = useMemo(
    () =>
      rows.map(
        (row) =>
          ({
            ...gatewayAccountAsVm(row, groupNames, proxies.data?.proxies),
            reset_credits: quota.results[row.id]?.reset_credits,
          }) as Vm
      ),
    [rows, groupNames, proxies.data, quota.results]
  )
  const accountOf = (vm: Vm) => rows.find((row) => row.id === vm.id)
  const vmOf = (account: GatewayAccount) =>
    vms.find((vm) => vm.id === account.id) ||
    gatewayAccountAsVm(account, groupNames, proxies.data?.proxies)
  const byVm = (fn: (account: GatewayAccount) => void) => (vm: Vm) => {
    const account = accountOf(vm)
    if (account) fn(account)
  }
  const editable = (fn: (account: GatewayAccount) => void) =>
    byVm((account) => {
      if (perms.edit && account.status !== 'archived') fn(account)
    })
  const base: VmActions = {
    openDetail: byVm((account) => setDetailId(account.id)),
    openTest: editable((account) => setTestId(account.id)),
    openStats: byVm(setStatsAccount),
    openReauth: editable((account) =>
      setDialog({ mode: 'authorize', account })
    ),
    refreshToken: editable((account) => void run(account, 'refresh')),
    recover: editable((account) => void run(account, 'recover')),
    refreshingId: busyId,
    recoveringId: busyId,
    ...(perms.manage
      ? {
          archive: byVm(setArchiveTarget),
          remove: byVm(deletion.onDelete),
        }
      : {}),
    ...(perms.edit
      ? {
          openEdit: editable((account) => setDialog({ mode: 'edit', account })),
          openAssignGroups: editable((account) =>
            setDialog({ mode: 'edit', account })
          ),
          groupsBusyId: busyId,
          setSchedulable: async (vm: Vm, next: boolean) => {
            const account = accountOf(vm)
            if (account)
              await run(account, next ? 'resume' : 'pause', { quiet: true })
          },
        }
      : {}),
    packageExport: false,
    exitProbePath: gatewayExitProbePath,
    detailRoute: '/codex-accounts/$id',
    openaiQuota: quota.openaiQuota,
  }
  // 已归档账号的菜单不再提供归档，只保留永久删除
  const archivedActions: VmActions = { ...base, archive: undefined }
  const actions: VmActions = {
    ...base,
    resolve: (vm) =>
      accountOf(vm)?.status === 'archived' ? archivedActions : base,
  }
  const detailCard = (
    <VmDetailCard
      vm={vms.find((vm) => vm.id === detailId) || null}
      onOpenChange={(open) => {
        if (!open) setDetailId(null)
      }}
    />
  )
  const dialogs = (
    <>
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
          mode={dialog.mode}
          // 用列表里的最新账号：状态行与保存内容随刷新更新，不停留在打开时的快照
          account={
            dialog.account &&
            (rows.find((row) => row.id === dialog.account?.id) ??
              dialog.account)
          }
          onClose={() => setDialog(null)}
          onChanged={refresh}
        />
      )}
      {importing ? (
        <GatewayAccountImportDialog
          onClose={() => setImporting(false)}
          onImported={refresh}
        />
      ) : null}
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
      {deletion.dialog}
    </>
  )
  return {
    loading: enabled && query.isPending,
    error: query.error,
    vms,
    accountOf,
    actions,
    detailCard,
    dialogs,
    renderBulkEdit: ({ ids, onClose, onSaved }) => (
      <GatewayAccountBulkEdit
        accounts={rows.filter((row) => ids.includes(row.id))}
        onClose={onClose}
        onSaved={async (saved) => {
          onSaved(saved)
          await refresh()
        }}
      />
    ),
    openCreate: () => setDialog({ mode: 'create' }),
    openImport: () => setImporting(true),
  }
}
