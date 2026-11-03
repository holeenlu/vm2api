import { useCallback, useState } from 'react'

export const VM_COLUMN_KEYS = [
  'vm',
  'groups',
  'sched',
  'type',
  'status',
  'req',
  'usage',
  'cost',
] as const

export type VmColumnKey = (typeof VM_COLUMN_KEYS)[number]

/** 列的宽度与弹性；顺序由 `useVmColumnOrder` 决定，不写死在这里。 */
export const VM_COL_CLS: Record<VmColumnKey | 'actions', string> = {
  groups: 'min-w-[130px] flex-[0.8]',
  vm: 'min-w-[170px] flex-[1.15]',
  sched: 'min-w-[62px] flex-[0.3]',
  type: 'min-w-[120px] flex-[0.75]',
  status: 'min-w-[180px] flex-[1.1]',
  req: 'min-w-[124px] flex-[0.7]',
  usage: 'min-w-[248px] flex-[1.4]',
  cost: 'min-w-[212px] flex-[1.1]',
  actions: 'w-[44px] shrink-0 pr-2',
}

const STORAGE_KEY = 'kin.vm.column-order'

/** 丢弃未知键、补齐缺失键，旧版本存下的顺序在列增减后仍然可用。 */
function normalize(raw: unknown): VmColumnKey[] {
  const known = new Set<string>(VM_COLUMN_KEYS)
  const seen = new Set<string>()
  const order: VmColumnKey[] = []
  if (Array.isArray(raw)) {
    for (const key of raw) {
      if (typeof key !== 'string' || !known.has(key) || seen.has(key)) continue
      seen.add(key)
      order.push(key as VmColumnKey)
    }
  }
  for (const key of VM_COLUMN_KEYS) if (!seen.has(key)) order.push(key)
  return order
}

function read(): VmColumnKey[] {
  try {
    return normalize(JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'))
  } catch {
    return [...VM_COLUMN_KEYS]
  }
}

export function useVmColumnOrder() {
  const [order, setOrder] = useState<VmColumnKey[]>(read)

  const commit = useCallback((next: VmColumnKey[]) => {
    setOrder(next)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }, [])

  /** 把 `from` 挪到 `to` 当前所在的位置。 */
  const move = useCallback(
    (from: VmColumnKey, to: VmColumnKey) => {
      if (from === to) return
      const next = order.filter((key) => key !== from)
      next.splice(order.indexOf(to), 0, from)
      commit(next)
    },
    [order, commit]
  )

  const reset = useCallback(() => {
    setOrder([...VM_COLUMN_KEYS])
    localStorage.removeItem(STORAGE_KEY)
  }, [])

  const isDefault = order.every((key, i) => key === VM_COLUMN_KEYS[i])

  return { order, move, reset, isDefault }
}
