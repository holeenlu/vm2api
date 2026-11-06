import type { PanelUser } from '@/types/panel-users'

export type UserTreeRow = {
  user: PanelUser
  depth: number
  children: number
}

/**
 * 按创建者（parent_user_id）把用户列表排成深度优先的树。
 * 上级不在当前可见列表里的账号作为根；同级保持接口返回的顺序。
 * 折叠节点的下级不输出；异常的环形引用补在末尾，保证每个账号只出现一次。
 */
export function userTreeRows(
  items: PanelUser[],
  collapsed: ReadonlySet<string> = new Set()
): UserTreeRow[] {
  const ids = new Set(items.map((u) => u.id))
  const kids = new Map<string, PanelUser[]>()
  const roots: PanelUser[] = []
  for (const u of items) {
    const parent = u.parent_user_id
    if (parent && parent !== u.id && ids.has(parent))
      kids.set(parent, [...(kids.get(parent) || []), u])
    else roots.push(u)
  }
  const out: UserTreeRow[] = []
  const seen = new Set<string>()
  const walk = (u: PanelUser, depth: number, visible: boolean) => {
    if (seen.has(u.id)) return
    seen.add(u.id)
    const children = kids.get(u.id) || []
    if (visible) out.push({ user: u, depth, children: children.length })
    for (const c of children)
      walk(c, depth + 1, visible && !collapsed.has(u.id))
  }
  for (const u of roots) walk(u, 0, true)
  for (const u of items) walk(u, 0, true)
  return out
}
