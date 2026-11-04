import { useQueryClient } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { useTranslation, Trans } from 'react-i18next'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { SlotIdentity } from '@/components/platform-chip'
import { CredentialPanel } from '@/features/vm/credential-panel'
import { vmQueryOptions, vmsListQueryOptions } from '@/features/vm/queries'

/** 重新授权：复用导入凭证面板（授权链接 / 粘贴 code / 直接写入）。 */
export function VmReauthDialog({
  vm,
  onOpenChange,
}: {
  vm: Vm | null
  onOpenChange: (open: boolean) => void
}) {
  useTranslation('vm')

  const qc = useQueryClient()
  return (
    <Dialog open={vm != null} onOpenChange={onOpenChange}>
      <DialogContent className='flex max-h-[88vh] flex-col gap-3 sm:max-w-xl'>
        <DialogHeader>
          <DialogTitle className='flex items-center gap-2 text-base'>
            <Trans
              ns='vm'
              i18nKey='vmReauthDialog.reauthorize'
              components={{
                part0: <>{vm ? <SlotIdentity vm={vm} compact /> : null}</>,
              }}
            />
          </DialogTitle>
          <DialogDescription>
            <Trans
              ns='vm'
              i18nKey='vmReauthDialog.generateAnAuthorizationLinkForNewCredentialsSavingReplaces'
            />
          </DialogDescription>
        </DialogHeader>
        <div className='-me-3 min-h-0 flex-1 overflow-y-auto pe-3'>
          {vm ? (
            <CredentialPanel
              key={vm.id}
              vm={vm}
              showConvert={false}
              onCommitted={async (_data, vmId, what) => {
                toast.success(what)
                onOpenChange(false)
                await Promise.all([
                  qc.invalidateQueries({
                    queryKey: vmQueryOptions(vmId).queryKey,
                  }),
                  qc.invalidateQueries({
                    queryKey: vmsListQueryOptions().queryKey,
                  }),
                ])
              }}
            />
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
