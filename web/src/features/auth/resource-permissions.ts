import { useQuery } from '@tanstack/react-query'
import type { MeResponse, ResourcePermission } from '@/types/panel-auth'
import { meQueryOptions } from './queries'

/**
 * 账号资源（虚拟机、Codex 账号、供应商账号池）的四级能力。
 * 由服务端 /me 下发，前端只用于显示裁剪；安全边界在后端
 * src/lib/admin/resource-permissions.mjs。
 */
export const RESOURCE_PERMISSIONS: ResourcePermission[] = [
  'resources.read',
  'resources.create',
  'resources.edit',
  'resources.manage',
]

const IMPLIES: Record<ResourcePermission, ResourcePermission[]> = {
  'resources.read': [],
  'resources.create': ['resources.read'],
  'resources.edit': ['resources.read'],
  'resources.manage': ['resources.edit', 'resources.read'],
}

/** 勾选时补齐隐含能力，取消时连带取消依赖它的能力。 */
export function toggleResourcePermission(
  current: readonly ResourcePermission[],
  cap: ResourcePermission,
  on: boolean
): ResourcePermission[] {
  const set = new Set(current)
  if (on) {
    set.add(cap)
    for (const implied of IMPLIES[cap]) set.add(implied)
  } else {
    set.delete(cap)
    for (const [other, implied] of Object.entries(IMPLIES))
      if (implied.includes(cap)) set.delete(other as ResourcePermission)
  }
  return RESOURCE_PERMISSIONS.filter((p) => set.has(p))
}

export type ResourcePerms = {
  /** /me 已返回。未返回时一律不放行，避免先发一批 403。 */
  known: boolean
  read: boolean
  create: boolean
  edit: boolean
  manage: boolean
}

export function resourcePermsOf(
  me: MeResponse | undefined | null
): ResourcePerms {
  const caps = new Set(me?.resource_permissions || [])
  return {
    known: !!me,
    read: caps.has('resources.read'),
    create: caps.has('resources.create'),
    edit: caps.has('resources.edit'),
    manage: caps.has('resources.manage'),
  }
}

export function useResourcePerms(): ResourcePerms {
  const me = useQuery(meQueryOptions())
  return resourcePermsOf(me.data)
}

/** 列表里的简短摘要：管理覆盖编辑，没有更高级别时显示查看。 */
export function resourcePermissionSummary(
  value: readonly ResourcePermission[] | undefined,
  label: (level: 'read' | 'create' | 'edit' | 'manage') => string
): string {
  const caps = new Set(value || [])
  if (!caps.size) return ''
  const shown = (['manage', 'edit', 'create'] as const).filter(
    (k) =>
      caps.has(`resources.${k}`) &&
      !(k === 'edit' && caps.has('resources.manage'))
  )
  return (shown.length ? shown : (['read'] as const)).map(label).join(' · ')
}
