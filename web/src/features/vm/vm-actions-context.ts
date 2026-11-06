import { createContext, useContext } from 'react'
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
  /** 可逆下线（Gateway 账号归档）；未提供时不显示。 */
  archive?: (vm: Vm) => void
  /** 永久删除（输入 ID 二次确认）。 */
  remove?: (vm: Vm) => void
  /** 打开账号编辑对话框；未提供时菜单与详情卡不显示「编辑账号」（如 VM 槽位）。 */
  openEdit?: (vm: Vm) => void
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
  /** 点击代理芯片探测出口的接口；未提供时走 VM 的 /exit-probe，返回 null 不可探测。 */
  exitProbePath?: (vm: Vm) => string | null
  /** 详情卡「完整页面」的路由；未提供时进入 VM 详情页。 */
  detailRoute?: '/vm/$id' | '/codex-accounts/$id'
  /**
   * 混排列表（供应商账号池同时含 VM 与 Gateway 账号）按行取各自的操作；
   * 未提供时所有行共用这一份。
   */
  resolve?: (vm: Vm) => VmActions
}

export const VmActionsContext = createContext<VmActions | null>(null)

/** 可在 provider 之外使用的组件读取可选覆盖。 */
export function useOptionalVmActions(vm?: Vm | null): VmActions | null {
  const ctx = useContext(VmActionsContext)
  return ctx && vm && ctx.resolve ? ctx.resolve(vm) : ctx
}

/** 传入行时返回该行适用的操作（见 resolve）。 */
export function useVmActions(vm?: Vm | null): VmActions {
  const ctx = useContext(VmActionsContext)
  if (!ctx)
    throw new Error('useVmActions must be used within VmActionsProvider')
  return vm && ctx.resolve ? ctx.resolve(vm) : ctx
}
