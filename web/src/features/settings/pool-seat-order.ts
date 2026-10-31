import { i18n } from '@/i18n'
import type { Vm } from '@/types/panel-vm'
import type { TFunction } from 'i18next'
import { usedPctOf } from '@/lib/format'
import { isRestrictedSchedule } from '@/lib/vm-status'

type SeatRow = {
  vm: Vm
  used: number
  grace: number
  max: number
  queued: number
  concWaiting: number
  /** 开新席位的预估名次；null = 满了或不在池。 */
  rank: number | null
  inPool: boolean
  why: string | null
}

/** min(5h 闸 − 已用, 7d 闸 − 已用)，与后端 budgetHeadroom 同口径；没有闸配置时视为未知。 */
function headroomOf(vm: Vm): number | null {
  const policy = vm.quota_policy
  if (!policy) return null
  return Math.min(
    policy.limit_5h * 100 - usedPctOf(vm, '5h'),
    policy.limit_7d * 100 - usedPctOf(vm, '7d')
  )
}

/**
 * 按草稿策略复现 rankSeatCandidates 的顺序：调度等级降序 → 占用比例
 * （平衡升序 / 填充降序）→ 余量降序 → id。并发、RPM 和预算闸不在这里判，
 * 所以只是预估。
 */
export function predictSeatOrder(
  vms: Vm[],
  strategy: string,
  t: TFunction<'settings'> = i18n.getFixedT(null, 'settings')
): SeatRow[] {
  const fill = strategy === 'fill'
  const rows: SeatRow[] = vms
    .filter((vm) => vm.seats_max != null)
    .map((vm) => {
      const used = Number(vm.seats_used) || 0
      const max = Number(vm.seats_max) || 0
      const inPool =
        !isRestrictedSchedule(vm) &&
        vm.schedule_state !== 'off' &&
        vm.schedulable !== false
      const full = used >= max
      return {
        vm,
        inPool,
        used,
        grace: Number(vm.seats_grace) || 0,
        max,
        queued: Number(vm.queue_depth) || 0,
        concWaiting: Number(vm.conc_waiting) || 0,
        rank: null,
        why: !inPool
          ? t(
              isRestrictedSchedule(vm)
                ? 'poolLive.scheduleRestricted'
                : 'poolLive.scheduleOff'
            )
          : full
            ? t('full')
            : null,
      }
    })
  const open = rows
    .filter((row) => row.why == null)
    .sort((a, b) => {
      const priority =
        (Number(b.vm.schedule_level) || 0) - (Number(a.vm.schedule_level) || 0)
      if (priority) return priority
      const occ = a.used / a.max - b.used / b.max
      if (occ) return fill ? -occ : occ
      const room =
        (headroomOf(b.vm) ?? Number.POSITIVE_INFINITY) -
        (headroomOf(a.vm) ?? Number.POSITIVE_INFINITY)
      if (room && Number.isFinite(room)) return room
      return a.vm.id.localeCompare(b.vm.id)
    })
  open.forEach((row, i) => {
    row.rank = i + 1
  })
  const rest = rows
    .filter((row) => row.why != null)
    .sort((a, b) => a.vm.id.localeCompare(b.vm.id))
  return [...open, ...rest]
}
