import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { t as tr } from '@/i18n'
import type { Vm } from '@/types/panel-vm'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { accountQueryKey } from '@/features/gateway-worker/accounts-model'
import { removeDeletedVmFromCache } from '@/features/vm/queries'
import {
  planBulkDelete,
  type BulkDeletePlan,
  type BulkDeleteStep,
} from './bulk-delete-model'

/** 一条失败记录：留在对话框里，便于对照名称重试。 */
type Failure = { id: string; name: string; message: string }

const nameOf = (vm: Vm) => vm.name || vm.email || vm.id

async function runStep(step: BulkDeleteStep) {
  if (step.kind === 'gateway') {
    await api(`/api/panel/codex-accounts/${encodeURIComponent(step.vm.id)}`, {
      method: 'DELETE',
    })
    return
  }
  if (step.switchTo)
    await api(`/api/panel/vms/${encodeURIComponent(step.switchTo)}/activate`, {
      method: 'POST',
    })
  await api(`/api/panel/vms/${encodeURIComponent(step.vm.id)}`, {
    method: 'DELETE',
  })
}

/** 确认框正文：数量、不可恢复提示、活跃指针切换、跳过项、进度与失败项。 */
export function BulkDeleteSummary({
  plan,
  done,
  total,
  busy,
  failures,
}: {
  plan: BulkDeletePlan
  done: number
  total: number
  busy: boolean
  failures: Failure[]
}) {
  const { t } = useTranslation(['vm', 'common'])
  const switching = plan.steps.find((step) => step.switchTo)
  return (
    <div className='grid gap-2'>
      <p>
        {plan.vmCount
          ? t('vm:vmBulk.deleteVmCount', { count: plan.vmCount })
          : null}
        {plan.vmCount && plan.gatewayCount ? ' · ' : null}
        {plan.gatewayCount
          ? t('vm:vmBulk.deleteGatewayCount', { count: plan.gatewayCount })
          : null}
      </p>
      {plan.vmCount ? (
        <p className='text-destructive'>
          {tr('vm:sync14008PermanentSlotDelete')}
        </p>
      ) : null}
      {plan.gatewayCount ? (
        <p className='text-destructive'>{t('common:codexDeleteBulkConfirm')}</p>
      ) : null}
      {switching ? (
        <p className='text-sm text-muted-foreground'>
          {t('vm:vmBulk.deleteSwitchActive', {
            id: switching.vm.id,
            to: switching.switchTo,
          })}
        </p>
      ) : null}
      {plan.skipped.length ? (
        <p className='text-sm text-[color:var(--status-warn)]'>
          {t('vm:vmBulk.deleteSkipped', {
            names: plan.skipped.map((vm) => vm.id).join('、'),
          })}
        </p>
      ) : null}
      {busy ? (
        <p aria-live='polite' className='text-sm tabular-nums'>
          {t('vm:vmBulk.deleteProgress', { done, total })}
        </p>
      ) : null}
      {failures.length ? (
        <ul className='grid gap-1 text-sm text-destructive'>
          {failures.map((failure) => (
            <li key={failure.id}>
              {t('vm:vmBulk.deleteFailedItem', {
                name: failure.name,
                message: failure.message,
              })}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

/**
 * 批量删除已选的虚拟机槽位与 Codex 账号。
 *
 * 逐条调用各自的删除接口（不新增批量接口），一条失败不影响其余，
 * 失败项留在列表里并保持勾选。与单条删除一样只做弹窗二次确认，不要求输入 ID。
 */
export function BulkDeleteDialog({
  targets,
  vms,
  onClose,
  onDeleted,
}: {
  /** 已选中的行（虚拟机槽位与 Gateway 账号混排）。 */
  targets: Vm[]
  /** 全部虚拟机槽位：删除活跃槽位时在本次不删的槽位里挑接管者。 */
  vms: Vm[]
  onClose: () => void
  /** 实际删掉的行 id，用于从选择中移除。 */
  onDeleted: (ids: string[]) => void
}) {
  const { t } = useTranslation(['vm', 'common'])
  const qc = useQueryClient()
  const plan = planBulkDelete(targets, vms)
  const [done, setDone] = useState(0)
  const [busy, setBusy] = useState(false)
  const [failures, setFailures] = useState<Failure[]>([])

  const run = async () => {
    setBusy(true)
    setDone(0)
    setFailures([])
    const deleted: string[] = []
    const deletedVms: string[] = []
    const failed: Failure[] = []
    for (const step of plan.steps) {
      try {
        await runStep(step)
        deleted.push(step.vm.id)
        if (step.kind === 'vm') deletedVms.push(step.vm.id)
      } catch (error) {
        failed.push({
          id: step.vm.id,
          name: nameOf(step.vm),
          message: (error as Error).message,
        })
      }
      setDone((n) => n + 1)
    }
    if (deletedVms.length) await removeDeletedVmFromCache(qc, deletedVms)
    if (deleted.length)
      await qc.invalidateQueries({ queryKey: accountQueryKey })
    setBusy(false)
    setFailures(failed)
    if (deleted.length)
      toast.success(t('vm:vmBulk.deleteDone', { count: deleted.length }))
    onDeleted(deleted)
    if (!failed.length) onClose()
    else toast.error(t('vm:vmBulk.deleteFailed', { count: failed.length }))
  }

  const total = plan.steps.length
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
      title={t('vm:vmBulk.deleteTitle', { count: targets.length })}
      destructive
      cancelBtnText={tr('models:cancel')}
      confirmText={
        failures.length ? t('vm:vmBulk.deleteRetry') : tr('anthropic:delete')
      }
      disabled={!total}
      isLoading={busy}
      handleConfirm={() => {
        if (!busy && total) void run()
      }}
      desc={
        <BulkDeleteSummary
          plan={plan}
          done={done}
          total={total}
          busy={busy}
          failures={failures}
        />
      }
    />
  )
}
