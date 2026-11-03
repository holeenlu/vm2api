import type { Vm } from '@/types/panel-vm'

export type GatewayAccountUsage = {
  today_requests: number
  today_cost: number
  today_tokens: number
  today_input_tokens: number
  today_output_tokens: number
  today_cache_read_tokens: number
  today_cache_creation_tokens: number
  window_5h_requests: number
  window_5h_cost: number
  window_5h_tokens: number
  window_7d_requests: number
  window_7d_success: number
  window_7d_errors: number
  window_7d_cost: number
  window_7d_tokens: number
  requests: number
  total_cost: number
  total_tokens: number
}
export type GatewayAccount = {
  id: string
  name: string
  vendor_id: string | null
  vendor_name?: string | null
  status: string
  created_at?: string
  config: {
    email?: string | null
    notes?: string
    plan?: string
    group_ids: number[]
    proxy_id?: string
    proxy_endpoint?: string
    auth_method?: string
    max_concurrency?: number
    max_rpm?: number
    weight?: number
    model_access?: ModelAccess
  }
  runtime_account_id?: string | null
  credential_revision?: number | null
  projection_status?: string | null
  runtime_status?: string | null
  gateway_instance_count?: number
  synced_instance_count?: number
  quota?: GatewayQuota | null
  usage?: GatewayAccountUsage
  last_error?: string | null
}
export type GatewayQuotaWindow = {
  used_percent?: number
  reset_at?: string
  window_minutes?: number
}
export type GatewayCredits = {
  has_credits?: boolean
  unlimited?: boolean
  balance?: string | null
}
export type GatewayQuota = {
  primary_window?: GatewayQuotaWindow
  secondary_window?: GatewayQuotaWindow
  credits?: GatewayCredits
  plan_type?: string
  updated_at?: string
}
// Worker 账号错误保护运行态（POST /status 只读返回，见 worker protection.go）
export type GatewayAccountRuntime = {
  protection?: {
    count?: number
    frozen_until?: string
    requires_probe?: boolean
    rules?: { id: string; name: string }[]
    last_probe_at?: string
    last_probe_error?: string
  } | null
  /** 其他 Worker 对同一上游账号的冻结（经控制面共享），本实例同样暂停接单 */
  peer_freeze?: { until: string; source?: string; reason?: string } | null
}
export type GatewayQuotaForecast = {
  period: 'weekly' | 'monthly'
  extrapolated: boolean
  unavailable_reason: string | null
  low_sample: boolean
  incomplete_cost: boolean
  incomplete_tokens: boolean
  estimated_tokens: number | null
  estimated_usd: number | null
}
export type GatewayResetCredits = {
  available_count: number
  credits: { id?: string; expires_at?: string }[]
}
export type GatewayQuotaResult = {
  quota?: GatewayQuota
  credits?: GatewayCredits
  reset_credits?: GatewayResetCredits
  plan_type?: string
  warning?: string
}
// 5h/7d 按窗口时长判断，不按 primary/secondary 位置（与 VM 槽的 normalizeCodexLimits 相同口径）
export function quotaWindows(quota?: GatewayQuota | null) {
  const primary = quota?.primary_window
  const secondary = quota?.secondary_window
  const pm = primary?.window_minutes
  const sm = secondary?.window_minutes
  let fiveFromPrimary: boolean
  if (pm != null && sm != null) fiveFromPrimary = pm < sm
  else if (pm != null) fiveFromPrimary = pm <= 360
  else if (sm != null) fiveFromPrimary = sm > 360
  else fiveFromPrimary = false
  return fiveFromPrimary
    ? { fiveHour: primary, sevenDay: secondary }
    : { fiveHour: secondary, sevenDay: primary }
}
export type ModelAccess = {
  mode: 'all' | 'allowlist' | 'denylist'
  models: string[]
}
export type GatewayCatalog = {
  groups: { id: number; name: string }[]
  proxies: { id: string; name: string; host: string; port: number }[]
  worker_available: boolean
}
export const accountBase = '/api/panel/codex-accounts'
export const accountQueryKey = ['gateway-workers', 'accounts'] as const

export type GatewayAccountState = 'active' | 'paused' | 'pending' | 'archived'

export function gatewayAccountState(
  account: GatewayAccount
): GatewayAccountState {
  if (account.status === 'archived') return 'archived'
  if (account.status === 'paused') return 'paused'
  if (!account.runtime_account_id || account.projection_status !== 'synced')
    return 'pending'
  return 'active'
}

const ratio = (pct?: number) =>
  pct == null || !Number.isFinite(Number(pct)) ? null : Number(pct) / 100

/**
 * Present a Gateway account in the VM row shape so the account list reuses the
 * Codex VM list cells (status, requests, quota windows, cost ledger) as-is.
 * 5h/7d windows come from `quotaWindows` (by window length, like VM slots).
 */
export function gatewayAccountAsVm(
  account: GatewayAccount,
  groupNames: Map<number, string>
): Vm {
  const state = gatewayAccountState(account)
  const { fiveHour: w5, sevenDay: w7 } = quotaWindows(account.quota)
  const hasToken = Number(account.credential_revision || 0) > 0
  const now = Date.now()
  const limited = [w5, w7].some(
    (w) => Number(w?.used_percent) >= 100 && Date.parse(w?.reset_at || '') > now
  )
  const off = state === 'paused' || state === 'archived'
  const availability: NonNullable<Vm['availability']> = !hasToken
    ? { key: 'none', usable: false }
    : off
      ? { key: 'off', usable: false }
      : state === 'pending'
        ? { key: 'cool', usable: true, reason: 'projection_pending' }
        : limited
          ? {
              key: 'quota',
              usable: true,
              reason: Number(w5?.used_percent) >= 100 ? 'quota_5h' : 'quota_7d',
            }
          : { key: 'ok', usable: true }
  const usage = account.usage
  return {
    id: account.id,
    name: account.name,
    email: account.config.email || null,
    platform: 'openai',
    family: 'codex',
    codex_kernel: true,
    status: off ? 'stopped' : 'running',
    has_token: hasToken,
    has_refresh: hasToken,
    credential_mode: 'oauth',
    plan_type: account.config.plan || null,
    vendor_id: account.vendor_id,
    vendor_name: account.vendor_name,
    groups: (account.config.group_ids || []).map((id) => ({
      id,
      name: groupNames.get(id) || `#${id}`,
      status: 'active',
    })),
    schedulable: !off,
    schedule_state: off ? 'off' : 'on',
    availability,
    max_concurrency: account.config.max_concurrency,
    max_rpm: account.config.max_rpm,
    utilization_5h: ratio(w5?.used_percent),
    utilization_7d: ratio(w7?.used_percent),
    reset_5h: w5?.reset_at,
    reset_7d: w7?.reset_at,
    codex_usage: {
      windows: [
        {
          id: '5h',
          used_percent: w5?.used_percent ?? null,
          reset_at: w5?.reset_at ?? null,
        },
        {
          id: '7d',
          used_percent: w7?.used_percent ?? null,
          reset_at: w7?.reset_at ?? null,
        },
      ],
    },
    ...(usage || {}),
    created_at: account.created_at,
  } as Vm
}
