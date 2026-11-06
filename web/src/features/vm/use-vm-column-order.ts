import { useCallback, useSyncExternalStore } from 'react'

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

/**
 * 列宽按内容自适应（CSS Grid 轨道）：不低于最小宽度，最多长到内容完整显示，
 * 有剩余空间时各列平均拉伸；表格总宽超出容器时横向滚动，不截断数据。
 * 备注可能很长，封顶 280px 后折成两行。顺序由 `useVmColumnOrder` 决定。
 */
export const VM_COL_TRACK: Record<VmColumnKey | 'select' | 'actions', string> =
  {
    select: '2.25rem',
    vm: 'minmax(180px, auto)',
    vendor: 'minmax(72px, auto)',
    groups: 'minmax(88px, auto)',
    sched: 'minmax(52px, auto)',
    type: 'minmax(110px, auto)',
    status: 'minmax(170px, auto)',
    conc: 'minmax(56px, auto)',
    req: 'minmax(120px, auto)',
    usage: 'minmax(220px, auto)',
    cost: 'minmax(200px, auto)',
    cache: 'minmax(72px, auto)',
    notes: 'minmax(96px, 280px)',
    actions: '44px',
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

type ColumnState = { order: VmColumnKey[]; hidden: VmColumnKey[] }

/**
 * 列顺序与显隐是页面级偏好：工具栏的「显示/隐藏列」与表头拖动共用一份状态，
 * 任一处修改立即同步到另一处并写入 localStorage。
 */
let state: ColumnState | null = null
const listeners = new Set<() => void>()

function current(): ColumnState {
  state ??= { order: read(), hidden: readHidden() }
  return state
}

function save(key: string, value: VmColumnKey[] | null) {
  try {
    if (value) localStorage.setItem(key, JSON.stringify(value))
    else localStorage.removeItem(key)
  } catch {
    /* 隐私模式等写不进去时只在本页生效 */
  }
}

function update(next: Partial<ColumnState>) {
  state = { ...current(), ...next }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useVmColumnOrder() {
  const { order, hidden } = useSyncExternalStore(subscribe, current, current)

  /** 列显示：账号列恒显示；其余列切换显隐并记住。 */
  const toggle = useCallback(
    (key: VmColumnKey) => {
      if (key === 'vm') return
      const next = hidden.includes(key)
        ? hidden.filter((k) => k !== key)
        : [...hidden, key]
      save(HIDDEN_KEY, next)
      update({ hidden: next })
    },
    [hidden]
  )

  /** 恢复全部列显示。 */
  const showAll = useCallback(() => {
    save(HIDDEN_KEY, null)
    update({ hidden: [] })
  }, [])

  /** 把 `from` 挪到 `to` 当前所在的位置。 */
  const move = useCallback(
    (from: VmColumnKey, to: VmColumnKey) => {
      if (from === to) return
      const next = order.filter((key) => key !== from)
      next.splice(order.indexOf(to), 0, from)
      save(STORAGE_KEY, next)
      update({ order: next })
    },
    [order]
  )

  const reset = useCallback(() => {
    save(STORAGE_KEY, null)
    update({ order: [...VM_COLUMN_KEYS] })
  }, [])

  const isDefault = order.every((key, i) => key === VM_COLUMN_KEYS[i])

  return { order, move, reset, isDefault, hidden, toggle, showAll }
}
