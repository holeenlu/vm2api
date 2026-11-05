import { useCallback, useState } from 'react'

export const VM_COLUMN_KEYS = [
  'vm',
  'vendor',
  'groups',
  'sched',
  'type',
  'status',
  'conc',
  'req',
  'usage',
  'cost',
  'cache',
  'notes',
] as const

export type VmColumnKey = (typeof VM_COLUMN_KEYS)[number]

/** 列的宽度与弹性；顺序由 `useVmColumnOrder` 决定，不写死在这里。 */
export const VM_COL_CLS: Record<VmColumnKey | 'actions', string> = {
  groups: 'min-w-[130px] flex-[0.8]',
  vm: 'min-w-[170px] flex-[1.15]',
  vendor: 'min-w-[96px] flex-[0.5]',
  conc: 'min-w-[64px] flex-[0.3]',
  cache: 'min-w-[72px] flex-[0.35]',
  notes: 'min-w-[120px] flex-[0.7]',
  sched: 'min-w-[62px] flex-[0.3]',
  type: 'min-w-[120px] flex-[0.75]',
  status: 'min-w-[180px] flex-[1.1]',
  req: 'min-w-[124px] flex-[0.7]',
  usage: 'min-w-[208px] flex-[1.3]',
  cost: 'min-w-[212px] flex-[1.1]',
  actions: 'w-[60px] shrink-0 pr-2',
}

const STORAGE_KEY = 'kin.vm.column-order'
const HIDDEN_KEY = 'kin.vm.column-hidden'

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

function readHidden(): VmColumnKey[] {
  try {
    const raw = JSON.parse(localStorage.getItem(HIDDEN_KEY) || '[]')
    const known = new Set<string>(VM_COLUMN_KEYS)
    // 账号列是行的身份，不允许隐藏
    return Array.isArray(raw)
      ? raw.filter(
          (key): key is VmColumnKey =>
            typeof key === 'string' && known.has(key) && key !== 'vm'
        )
      : []
  } catch {
    return []
  }
}

export function useVmColumnOrder() {
  const [order, setOrder] = useState<VmColumnKey[]>(read)
  const [hidden, setHidden] = useState<VmColumnKey[]>(readHidden)

  /** 列显示：账号列恒显示；其余列切换显隐并记住。 */
  const toggle = useCallback(
    (key: VmColumnKey) => {
      if (key === 'vm') return
      const next = hidden.includes(key)
        ? hidden.filter((k) => k !== key)
        : [...hidden, key]
      setHidden(next)
      try {
        localStorage.setItem(HIDDEN_KEY, JSON.stringify(next))
      } catch {
        /* 隐私模式等写不进去时只在本页生效 */
      }
    },
    [hidden]
  )

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

  return { order, move, reset, isDefault, hidden, toggle }
}
