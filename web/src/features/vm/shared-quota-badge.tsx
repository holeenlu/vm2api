import { t as tr } from '@/i18n'
import type { Vm } from '@/types/panel-vm'
import { cn } from '@/lib/utils'

/**
 * 同号提示：本槽位与其他槽位共用同一个上游账号额度（后端按 7 天用量观测同步判定）。
 * 调度会把它们当成两份独立额度，提示运营停用其一或换成不同账号。
 */
export function SharedQuotaBadge({
  vm,
  className,
}: {
  vm: Vm | undefined
  className?: string
}) {
  const peers = vm?.shared_quota_with
  if (!peers?.length) return null
  const list = peers.join('、')
  return (
    <span
      className={cn(
        'inline-flex shrink-0 cursor-help items-center rounded px-1.5 py-0.5 text-[10px] leading-none font-semibold',
        'bg-[color:var(--status-warn-bg)] text-[color:var(--status-warn)]',
        className
      )}
      title={tr('vm:sharedQuota.help', { peers: list })}
    >
      {tr('vm:sharedQuota.label', { peers: list })}
    </span>
  )
}
