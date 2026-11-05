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
import { planDeleteActiveVm } from '@/features/vm/active-vm'
import { DeleteActiveVmHint } from '@/features/vm/delete-active-hint'
import {
  removeDeletedVmFromCache,
  vmsListQueryOptions,
} from '@/features/vm/queries'

/**
 * VM 的重建与删除确认（输入 ID 二次确认）。只在拥有「管理」能力时由调用方挂上入口。
 * vms 用于删除活跃槽时挑选替补。
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
  const [resetInput, setResetInput] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<Vm | null>(null)
  const [deleteInput, setDeleteInput] = useState('')
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
  const deletePlan = deleteTarget
    ? planDeleteActiveVm(deleteTarget, vms)
    : { kind: 'normal' as const }
  const deleteBlocked = deletePlan.kind === 'blocked'
  const deleteSwitchId =
    deletePlan.kind === 'switch' ? deletePlan.replacement.id : undefined
  const submitReset = () => {
    if (resetTarget && resetInput.trim() === resetTarget.id)
      resetVm.mutate({ id: resetTarget.id, mode: resetMode })
  }
  const submitDelete = () => {
    if (
      deleteTarget &&
      !deleteBlocked &&
      deleteInput.trim() === deleteTarget.id
    )
      deleteVm.mutate({ id: deleteTarget.id, switchTo: deleteSwitchId })
  }

  const dialogs = (
    <>
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
        handleConfirm={submitReset}
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
            if (e.key === 'Enter' && !resetVm.isPending) submitReset()
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
        handleConfirm={submitDelete}
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
            if (e.key === 'Enter' && !deleteVm.isPending) submitDelete()
          }}
        />
      </ConfirmDialog>
    </>
  )
  return {
    onReset: (vm) => {
      setResetInput('')
      setResetTarget(vm)
    },
    onDelete: (vm) => {
      setDeleteInput('')
      setDeleteTarget(vm)
    },
    dialogs,
  }
}
