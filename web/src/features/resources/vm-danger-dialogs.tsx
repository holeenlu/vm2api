import { useState, type ReactNode } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { t as tr } from '@/i18n'
import type { Vm } from '@/types/panel-vm'
import { Trans, useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Input } from '@/components/ui/input'
import { ChoiceTiles } from '@/components/choice-tiles'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { SlotIdentity } from '@/components/platform-chip'
import {
  accountBase,
  accountQueryKey,
} from '@/features/gateway-worker/accounts-model'
import { planDeleteActiveVm } from '@/features/vm/active-vm'
import { DeleteActiveVmHint } from '@/features/vm/delete-active-hint'
import {
  removeDeletedVmFromCache,
  vmsListQueryOptions,
} from '@/features/vm/queries'

/**
 * 输入 ID 二次确认的危险操作对话框：VM 重建、VM 删除与账号永久删除共用。
 * id 为 null 时关闭；换目标时清空输入。输入与 id 一致且未被 blocked 时才能确认（含回车）。
 */
export function ConfirmByIdDialog({
  id,
  title,
  desc,
  confirmText,
  cancelText,
  destructive = true,
  blocked = false,
  isLoading = false,
  onClose,
  onConfirm,
  children,
}: {
  id: string | null
  title: ReactNode
  desc: React.JSX.Element | string
  confirmText: ReactNode
  cancelText?: string
  destructive?: boolean
  blocked?: boolean
  isLoading?: boolean
  onClose: () => void
  onConfirm: () => void
  children?: ReactNode
}) {
  const { t } = useTranslation('vm')
  const [input, setInput] = useState('')
  const [shownFor, setShownFor] = useState(id)
  if (shownFor !== id) {
    setShownFor(id)
    setInput('')
  }
  const matches = !!id && input.trim() === id
  const submit = () => {
    if (matches && !blocked && !isLoading) onConfirm()
  }
  return (
    <ConfirmDialog
      open={!!id}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      title={title}
      desc={desc}
      confirmText={confirmText}
      cancelBtnText={cancelText ?? tr('models:cancel')}
      destructive={destructive}
      disabled={blocked || !matches}
      isLoading={isLoading}
      handleConfirm={submit}
    >
      {children}
      <Input
        autoFocus
        autoComplete='off'
        spellCheck={false}
        placeholder={id ?? ''}
        aria-label={t('vm:detailPage.confirmID')}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit()
        }}
      />
    </ConfirmDialog>
  )
}

/**
 * VM 的重建与删除确认（输入 ID 二次确认）。只在拥有「管理」能力时由调用方挂上入口。
 * vms 用于删除活跃槽时挑选替补。供应商自有 VM 删除后，服务端一并删除它的账号池资源对。
 */
export function useVmDangerDialogs(vms: Vm[]): {
  onReset: (vm: Vm) => void
  onDelete: (vm: Vm) => void
  dialogs: ReactNode
} {
  const { t: tVm } = useTranslation('vm')
  const qc = useQueryClient()
  const [resetTarget, setResetTarget] = useState<Vm | null>(null)
  const [resetMode, setResetMode] = useState<'keep' | 'traits'>('keep')
  const [deleteTarget, setDeleteTarget] = useState<Vm | null>(null)
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
      await removeDeletedVmFromCache(qc, id)
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const deletePlan = deleteTarget
    ? planDeleteActiveVm(deleteTarget, vms)
    : { kind: 'normal' as const }
  const deleteSwitchId =
    deletePlan.kind === 'switch' ? deletePlan.replacement.id : undefined

  const dialogs = (
    <>
      <ConfirmByIdDialog
        id={resetTarget?.id ?? null}
        onClose={() => setResetTarget(null)}
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
        cancelText={tVm('vm:authSchemeEditor.cancel')}
        destructive={resetMode === 'traits'}
        isLoading={resetVm.isPending}
        onConfirm={() => {
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
      </ConfirmByIdDialog>
      <ConfirmByIdDialog
        id={deleteTarget?.id ?? null}
        onClose={() => setDeleteTarget(null)}
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
        blocked={deletePlan.kind === 'blocked'}
        isLoading={deleteVm.isPending}
        onConfirm={() => {
          if (deleteTarget)
            deleteVm.mutate({ id: deleteTarget.id, switchTo: deleteSwitchId })
        }}
      />
    </>
  )
  return {
    onReset: (vm) => setResetTarget(vm),
    onDelete: (vm) => setDeleteTarget(vm),
    dialogs,
  }
}

type DeletableAccount = { id: string; name: string }

/**
 * Codex（Gateway）账号与账号池 Gateway 账号的永久删除确认（DELETE /api/panel/codex-accounts/:id）。
 * 与 VM 删除同一个输入 ID 对话框；可逆的下线是归档。部分 Worker 不可达时服务端留待心跳补删，这里给出提示。
 */
export function useAccountDeleteDialog({
  onDeleted,
}: { onDeleted?: (id: string) => void } = {}): {
  onDelete: (account: DeletableAccount) => void
  dialog: ReactNode
} {
  const { t } = useTranslation('common')
  const qc = useQueryClient()
  const [target, setTarget] = useState<DeletableAccount | null>(null)
  const remove = useMutation({
    mutationFn: (id: string) =>
      api<{ deleted: string }>(`${accountBase}/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }),
    onSuccess: async (_result, id) => {
      toast.success(t('codexDeleted'))
      setTarget(null)
      onDeleted?.(id)
      await qc.invalidateQueries({ queryKey: accountQueryKey })
    },
    onError: (error: Error) => toast.error(error.message),
  })
  return {
    onDelete: setTarget,
    dialog: (
      <ConfirmByIdDialog
        id={target?.id ?? null}
        onClose={() => {
          if (!remove.isPending) setTarget(null)
        }}
        title={t('codexDeleteAccount')}
        desc={
          target ? (
            <p className='text-destructive'>
              {t('codexDeleteConfirm', { name: target.name })}
            </p>
          ) : (
            ''
          )
        }
        confirmText={tr('anthropic:delete')}
        isLoading={remove.isPending}
        onConfirm={() => {
          if (target) remove.mutate(target.id)
        }}
      />
    ),
  }
}
