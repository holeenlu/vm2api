import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { Vm } from '@/types/panel-vm'
import { useTranslation, Trans } from 'react-i18next'
import { toast } from 'sonner'
import { patchVm } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { dashboardQueryOptions } from '@/features/overview/queries'
import {
  normalizeSlotPersonaPreset,
  slotPersonaLabel,
  slotPersonaPatchValue,
} from '@/features/vm/persona-contract'
import { vmQueryOptions } from '@/features/vm/queries'
import { useVmPerms } from '@/features/vm/vm-perms'

export function VmPersonaEditor({ id, vm }: { id: string; vm: Vm }) {
  const { t: tVm } = useTranslation('vm')

  const qc = useQueryClient()
  const configured = normalizeSlotPersonaPreset(vm.persona_preset)
  const resolved = normalizeSlotPersonaPreset(
    vm.resolved_persona_preset,
    configured
  )
  const inherits = configured === 'inherit'
  const canEdit = useVmPerms().admin
  const inherit = useMutation({
    mutationFn: () =>
      patchVm(id, { persona_preset: slotPersonaPatchValue('inherit') }),
    onSuccess: async () => {
      toast.success(
        tVm('vm:personaEditor.outboundProtocolNowFollowsTheSystemPrompt')
      )
      await Promise.all([
        qc.invalidateQueries({ queryKey: vmQueryOptions(id).queryKey }),
        qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
      ])
    },
    onError: (error: Error) =>
      toast.error(
        tVm('vm:engineEditor.failedToRestoreGlobalSettings', {
          message: error.message,
        })
      ),
  })

  return (
    <section className='rounded-lg border bg-card p-4'>
      <h3 className='text-sm font-medium'>
        <Trans ns='vm' i18nKey='personaEditor.outboundProtocol' />
      </h3>
      <div className='mt-3 grid gap-2 text-sm sm:grid-cols-2'>
        <div>
          <div className='text-xs text-muted-foreground'>
            <Trans ns='vm' i18nKey='codexKernelHealthCard.configured' />
          </div>
          <div>{slotPersonaLabel(configured)}</div>
        </div>
        <div>
          <div className='text-xs text-muted-foreground'>
            <Trans ns='vm' i18nKey='personaEditor.effectiveSetting' />
          </div>
          <div>{slotPersonaLabel(resolved)}</div>
        </div>
      </div>
      <p className='mt-3 text-xs leading-relaxed text-muted-foreground'>
        <Trans
          ns='vm'
          i18nKey='personaEditor.editThePolicyOnlyUnderSystemPromptSlotOverrides'
          components={{
            part0: (
              <Link to='/system' className='underline underline-offset-4' />
            ),
          }}
        />
      </p>
      {inherits || !canEdit ? null : (
        <Button
          className='mt-3'
          variant='outline'
          disabled={inherit.isPending}
          onClick={() => inherit.mutate()}
        >
          {inherit.isPending
            ? tVm('vm:engineEditor.restoring')
            : tVm('vm:engineEditor.followGlobalSettings')}
        </Button>
      )}
    </section>
  )
}
