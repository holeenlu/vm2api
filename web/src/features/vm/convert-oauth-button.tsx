import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { credTypeOf } from '@/lib/cred-type'
import { importErrorMessage } from '@/lib/import-errors'
import { isCodexVm } from '@/lib/vm-kind'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { dashboardQueryOptions } from '@/features/overview/queries'
import { vmQueryOptions } from '@/features/vm/queries'
import { useVmPerms } from '@/features/vm/vm-perms'

export type ConvertOauthResult = {
  official_cc_bootstrap?: { scheduled?: boolean; reason?: string } | null
  oauth_email?: string
}

export function ConvertOauthToSetupButton({
  vm,
  onCommitted,
}: {
  vm: Vm
  onCommitted?: (data: ConvertOauthResult, vmId: string, what: string) => void
}) {
  const { t: tVm } = useTranslation('vm')

  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const perms = useVmPerms()
  const convert = useMutation({
    mutationFn: () =>
      api<ConvertOauthResult>(
        `/api/panel/vms/${encodeURIComponent(vm.id)}/oauth/to-setup-token`,
        { method: 'POST', body: '{}' }
      ),
    onSuccess: async (data) => {
      setOpen(false)
      await Promise.all([
        qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
        qc.invalidateQueries({ queryKey: vmQueryOptions(vm.id).queryKey }),
      ])
      const what = tVm('vm:convertOauthButton.convertedToSetupToken')
      if (onCommitted) onCommitted(data, vm.id, what)
      else toast.success(what)
    },
    onError: (e: Error) => toast.error(importErrorMessage(e)),
  })

  if (!perms.credential || isCodexVm(vm) || credTypeOf(vm) !== 'oauth') {
    return null
  }

  return (
    <>
      <Button
        size='sm'
        variant='outline'
        disabled={convert.isPending}
        loading={convert.isPending}
        onClick={() => setOpen(true)}
      >
        {convert.isPending
          ? tVm('vm:convertOauthButton.converting')
          : tVm('vm:convertOauthButton.convertToSetupToken')}
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={tVm('vm:convertOauthButton.convertToSetupToken')}
        desc={tVm(
          'vm:convertOauthButton.keepsTheCurrentAccessTokenRefreshTokenActualExpiry'
        )}
        confirmText={tVm('vm:convertOauthButton.confirmConversion')}
        cancelBtnText={tVm('vm:authSchemeEditor.cancel')}
        isLoading={convert.isPending}
        handleConfirm={() => convert.mutate()}
      />
    </>
  )
}
