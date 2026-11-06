import { useTranslation, Trans } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { CreateVmForm, useCreateVmDraft } from '@/features/vm/create-vm-form'

/**
 * 槽位页的快捷创建。完整的「创建 → 出口 → 账号 → 上线」在导入页；
 * 这里只建槽，可选创建后直接开机 / 分配出口。
 */
export function CreateVmDialog({
  open,
  onOpenChange,
  nodeId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 预选放在哪台机器（集群页「在这台机器上新建槽」）；空 = 本机。 */
  nodeId?: string
}) {
  useTranslation('vm')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='max-h-[90vh] overflow-y-auto sm:max-w-2xl'>
        <DialogHeader>
          <DialogTitle>
            <Trans ns='vm' i18nKey='createVmDialog.createSlot' />
          </DialogTitle>
          <DialogDescription>
            <Trans
              ns='vm'
              i18nKey='createVmDialog.createsASlotOnlyUseImportToAddAn'
            />
          </DialogDescription>
        </DialogHeader>
        {open ? (
          <DialogBody nodeId={nodeId} onDone={() => onOpenChange(false)} />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

// 每次打开都是新草稿：关闭即卸载，不残留上次的选择。
function DialogBody({
  nodeId,
  onDone,
}: {
  nodeId?: string
  onDone: () => void
}) {
  useTranslation('vm')

  const draft = useCreateVmDraft({ onCreated: onDone, nodeId })
  return <CreateVmForm draft={draft} variant='dialog' onCancel={onDone} />
}
