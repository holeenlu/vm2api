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

/** Gateway（Codex）账号映射成 VM 形态后，以此区分行类型。 */
export const isGatewayRow = (vm: Vm) => vm.runtime_type === 'gateway'

export type GatewaySource = {
  loading: boolean
  error: Error | null
  vms: Vm[]
  accountOf: (vm: Vm) => GatewayAccount | undefined
  actions: VmActions
  /** 详情卡、测试、统计、编辑 / 授权、导入与归档确认。 */
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
 * 操作入口按账号资源能力裁剪：编辑类需要 edit，归档需要 manage。
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
  const actions: VmActions = {
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
    ...(perms.manage ? { remove: byVm(setArchiveTarget) } : {}),
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
  const dialogs = (
    <>
      <VmDetailCard
        vm={vms.find((vm) => vm.id === detailId) || null}
        onOpenChange={(open) => {
          if (!open) setDetailId(null)
        }}
      />
      {statsAccount && (
        <AccountUsageDialog
          resource={statsAccount}
          apiBase={accountBase}
          authorizationFilter
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
    </>
  )
  return {
    loading: enabled && query.isPending,
    error: query.error,
    vms,
    accountOf,
    actions,
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
