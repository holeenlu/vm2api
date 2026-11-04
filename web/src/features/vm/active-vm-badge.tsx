import { t as tr } from '@/i18n'
import type { Vm } from '@/types/panel-vm'
import { cn } from '@/lib/utils'
import { isActiveVmPointer } from '@/features/vm/active-vm'

/** 全局活跃槽（`vms/active.json`）标记，与调度/运行状态无关。 */
export function ActiveVmBadge({
  vm,
  className,
}: {
  vm: Vm | undefined
  className?: string
}) {
  if (!isActiveVmPointer(vm)) return null
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[10px] leading-none font-semibold tracking-[0.02em] uppercase',
        'bg-[color:var(--tier-pro-bg)] text-[color:var(--tier-pro-solid)]',
        className
      )}
      title={tr('vm:sync14008ActiveSlotHelp')}
    >
      {tr('vm:sync14008Active')}
    </span>
  )
}
