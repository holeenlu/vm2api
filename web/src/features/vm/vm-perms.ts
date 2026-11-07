import { useQuery } from '@tanstack/react-query'
import type { MeResponse } from '@/types/panel-auth'
import { meQueryOptions } from '@/features/auth/queries'
import { resourcePermsOf } from '@/features/auth/resource-permissions'

/**
 * VM 与 Codex 账号页面的显示裁剪，来自服务端下发的账号资源能力
 * （src/lib/admin/resource-permissions.mjs）。前端隐藏不是安全边界。
 */
export type VmPerms = {
  /** me 已返回。未返回时一律不放行，避免先发一批 403。 */
  known: boolean
  /** 查看：列表、详情、用量金额、分组与代理信息、测试模型列表。 */
  read: boolean
  /** 创建：新建 VM、导入凭证、新建或导入 Codex 账号。 */
  create: boolean
  /** 编辑：开关机与探测、测试、凭证授权与刷新、额度、代理、调度与各项配置。 */
  edit: boolean
  /** 管理：重建、删除、终端、内核与种子、打包导出、凭证明文。 */
  manage: boolean
  /** GET /api/panel/dashboard 属于平台总览，仍只给 super_admin。 */
  dashboard: boolean
}

export function vmPermsFor(me: MeResponse | undefined | null): VmPerms {
  const perms = resourcePermsOf(me)
  return {
    known: perms.known,
    read: perms.read,
    create: perms.create,
    edit: perms.edit,
    manage: perms.manage,
    dashboard: me?.role === 'super_admin',
  }
}

export function useVmPerms(): VmPerms {
  const me = useQuery(meQueryOptions())
  return vmPermsFor(me.data)
}

export type VmDetailTab =
  'overview' | 'account' | 'proxy' | 'test' | 'ops' | 'seed'

export function vmDetailTabs(perms: VmPerms): VmDetailTab[] {
  if (!perms.read) return []
  const tabs: VmDetailTab[] = ['overview', 'account', 'proxy']
  if (perms.edit) tabs.push('test')
  if (perms.manage) tabs.push('ops', 'seed')
  return tabs
}

/** 选中的页签当前角色看不到时回到概览。 */
export function visibleTab(tab: string, tabs: readonly string[]): string {
  return tabs.includes(tab) ? tab : 'overview'
}

/** 下拉里记住的出口已不在候选里（被绑满、切了槽）时回落到第一个候选。 */
export function pickBindTarget(
  bindId: string,
  candidates: readonly { id?: string | null }[]
): string {
  if (bindId && candidates.some((p) => p.id === bindId)) return bindId
  return candidates[0]?.id || ''
}
