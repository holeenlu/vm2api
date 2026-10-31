import { t as tr } from '@/i18n'
import type { Vm } from '@/types/panel-vm'
import { SlotIdentity } from '@/components/platform-chip'
import { planDeleteActiveVm } from '@/features/vm/active-vm'

export function DeleteActiveVmHint({ target, vms }: { target: Vm; vms: Vm[] }) {
  const plan = planDeleteActiveVm(target, vms)
  if (plan.kind === 'normal' || plan.kind === 'sole_active') {
    return (
      <p className='mt-2 text-destructive'>
        {tr('vm:sync14008PermanentSlotDelete')}
      </p>
    )
  }
  if (plan.kind === 'blocked') {
    return (
      <>
        <p className='mt-2 text-destructive'>
          {tr('vm:sync14008ActiveSlotNoReplacement')}
        </p>
        <p className='mt-2 text-sm text-muted-foreground'>
          {tr('vm:sync14008SwitchBeforeDeleteHelp')}
        </p>
      </>
    )
  }
  return (
    <>
      <p className='mt-2 text-destructive'>
        {tr('vm:sync14008SwitchActiveDeleteHelp')}
      </p>
      <p className='mt-2 flex min-w-0 items-center gap-1.5 text-sm'>
        <span className='shrink-0 text-muted-foreground'>
          {tr('vm:sync14008ReplacementSlot')}
        </span>
        <SlotIdentity vm={plan.replacement} compact />
        <span className='shrink-0 font-mono text-xs text-muted-foreground'>
          · {plan.replacement.id}
        </span>
      </p>
    </>
  )
}
