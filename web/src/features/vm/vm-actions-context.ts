import { createContext, useContext, type ReactNode } from 'react'
import type { Vm } from '@/types/panel-vm'

export type OpenaiQuotaPayload = {
  reset_credits?: {
    available_count?: number
    credits?: Array<{ expires_at?: string }>
  } | null
  warning?: string
}

/** 列表页所有行 / 卡片共用的槽位操作；由 VmActionsProvider 提供。 */
export type VmActions = {
  openDetail: (vm: Vm) => void
  openTest: (vm: Vm) => void
  openStats: (vm: Vm) => void
  openReauth: (vm: Vm) => void
  /** 未提供时不显示「恢复服务」（如 Gateway 账号没有容器可恢复）。 */
  openRecovery?: (vm: Vm) => void
  refreshToken: (vm: Vm) => void
  recover: (vm: Vm) => void
  /** 正在刷新令牌 / 恢复状态的槽位 id，用于禁用重复点击。 */
  refreshingId: string | null
  recoveringId: string | null
  /** 未提供时菜单不渲染对应项。 */
  reset?: (vm: Vm) => void
  remove?: (vm: Vm) => void
  /** admin：打开分组多选对话框。 */
  openAssignGroups?: (vm: Vm) => void
  groupsBusyId?: string | null
  activate?: (vm: Vm) => void
  /** 取消全局活跃槽，不影响调度。 */
  deactivate?: (vm: Vm) => void
  activatingId?: string | null
  /** 调度开关；未提供时走 VM 的 /schedulable。 */
  setSchedulable?: (vm: Vm, next: boolean) => Promise<unknown>
  /** GPT 额度查询 / 重置券；未提供时走 VM 的 /openai-quota。 */
  openaiQuota?: {
    refresh: (vm: Vm) => Promise<OpenaiQuotaPayload>
    reset: (vm: Vm) => Promise<OpenaiQuotaPayload>
  }
  /** false 时不显示「打包 JSON」。 */
  packageExport?: boolean
  /** 出口代理摘要；未提供时显示 VM 的 ProxyChip（可点击探测出口）。 */
  renderProxy?: (vm: Vm) => ReactNode
  /** 详情卡「完整页面」的路由；未提供时进入 VM 详情页。 */
  detailRoute?: '/vm/$id' | '/codex-accounts/$id'
}

export const VmActionsContext = createContext<VmActions | null>(null)

/** 可在 provider 之外使用的组件读取可选覆盖。 */
export function useOptionalVmActions(): VmActions | null {
  return useContext(VmActionsContext)
}

export function useVmActions(): VmActions {
  const ctx = useContext(VmActionsContext)
  if (!ctx)
    throw new Error('useVmActions must be used within VmActionsProvider')
  return ctx
}
