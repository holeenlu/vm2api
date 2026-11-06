import { queryOptions } from '@tanstack/react-query'
import type {
  Vm,
  VmBillingModelRow,
  VmBillingPeriod,
  VmProxySnap,
} from '@/types/panel-vm'
import { api } from '@/lib/api'
import type { VendorUsageReport } from '@/features/vendor/portal-model'

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
  window_5h_input_tokens: number
  window_5h_output_tokens: number
  window_5h_cache_read_tokens: number
  window_5h_cache_creation_tokens: number
  window_7d_requests: number
  window_7d_success: number
  window_7d_errors: number
  window_7d_cost: number
  window_7d_tokens: number
  window_7d_input_tokens: number
  window_7d_output_tokens: number
  window_7d_cache_read_tokens: number
  window_7d_cache_creation_tokens: number
  requests: number
  total_cost: number
  total_tokens: number
}
/** 账号的 BPS（Excel Basispoints）设置（控制面 config.bps）。 */
export type BpsSettings = {
  enabled: boolean
  models: string[]
  omit_unsupported_tools: boolean
  ignore_encrypted_content: boolean
  auto_disable_on_403: boolean
  auto_recover_on_403: boolean
  recovery_interval_minutes: number
  rate_limit_cooldown_seconds?: number
  auto_move_on_403: boolean
  target_group_id: number | null
  cache_creation_as_input: boolean
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
    /** 供应商自有账号上供应商自己写的备注 */
    vendor_notes?: string
    plan?: string
    group_ids: number[]
    proxy_id?: string
    proxy_endpoint?: string
    auth_method?: string
    max_concurrency?: number
    max_rpm?: number
    weight?: number
    model_access?: ModelAccess
    reset_credit_auto?: boolean
    bps?: BpsSettings
    /** Worker 上 BPS 授权的代次与时间；未授权时缺省 */
    bps_grant?: { revision: number; authorized_at: string }
    bps_catalog?: BpsCatalog
    bps_verification?: BpsVerification
    /** 运营手动覆盖的订阅档位（只影响面板显示）；缺省时按额度观测、其次授权时的档位 */
    plan_override?: string | null
    /** 控制面保存的上游订阅周期（Worker 查询 /backend-api/subscriptions 后写回） */
    subscription?: {
      expires_at?: string | null
      will_renew?: boolean | null
      billing_period?: string | null
      /** 订阅渠道（stripe_subscription / apple_subscription / google_subscription） */
      billing_type?: string | null
      checked_at?: string | null
    } | null
  }
  /** Worker 心跳上报的 BPS 通道终态（expired / invalid / blocked），可用时为空 */
  bps_state?: string | null
  bps_error?: string | null
  bps_blocked_at?: string | null
  bps_recovery?: 'auto' | 'stopped' | 'off' | null
  bps_next_probe_at?: string | null
  bps_cooldown_until?: string | null
  runtime_account_id?: string | null
  credential_revision?: number | null
  projection_status?: string | null
  runtime_status?: string | null
  /** 在线 Worker 心跳上报的在途请求数（各实例之和） */
  inflight?: number
  gateway_instance_count?: number
  synced_instance_count?: number
  quota?: GatewayQuota | null
  usage?: GatewayAccountUsage
  last_error?: string | null
  /** Worker 心跳上报的凭据终态（expired/invalid/banned/unverified），null 表示可用 */
  credential_state?: string | null
  /** 凭据终态对应的 Worker 最近错误，如 credential_refresh_failed */
  credential_error?: string | null
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
// 默认 codex 桶以外的具名额度桶（Worker 解析响应头与 /wham/usage），只作展示
export type GatewayQuotaBucket = {
  limit_name?: string
  allowed?: boolean
  limit_reached?: boolean
  primary_window?: GatewayQuotaWindow
  secondary_window?: GatewayQuotaWindow
}
export type GatewayQuota = {
  primary_window?: GatewayQuotaWindow
  secondary_window?: GatewayQuotaWindow
  credits?: GatewayCredits
  plan_type?: string
  updated_at?: string
  buckets?: Record<string, GatewayQuotaBucket>
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
  /** 最近一次凭据刷新失败（脱敏的上游状态、错误码与信息），成功刷新后清除 */
  last_refresh_failure?: {
    at: string
    operation?: string
    status?: number
    code?: string
    message?: string
  } | null
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

/**
 * 白名单里当前目录未返回的已选 ID（CPR 242ffb23）。目录未就绪、加载失败或为空时返回空：
 * 这些情况不能作为批量清理依据；目录缺失本身也不代表模型失效（图像、搜索、映射目标可能不在目录里）。
 */
export function missingAllowlistModels(
  access: ModelAccess,
  catalog: string[] | undefined
): string[] {
  if (access.mode !== 'allowlist' || !catalog?.length) return []
  const listed = new Set(catalog)
  return access.models.filter((id) => !listed.has(id))
}

/** 从表单移除选中的缺失项；不在缺失列表里的 ID 忽略，会清空白名单时不改动。 */
export function removeAllowlistModels(
  access: ModelAccess,
  ids: string[],
  missing: string[]
): ModelAccess {
  if (access.mode !== 'allowlist') return access
  const removed = new Set(ids.filter((id) => missing.includes(id)))
  const models = access.models.filter((id) => !removed.has(id))
  if (!removed.size || !models.length) return access
  return { ...access, models }
}
export type GatewayCatalog = {
  groups: { id: number; name: string }[]
  proxies: { id: string; name: string; host: string; port: number }[]
  worker_available: boolean
  /** 在线 Worker 支持的授权方式（P6.3）：oauth、import、bps_oauth、bps_import */
  authorizations?: string[]
}

/** 账号向导：Worker 支持 BPS 授权时，新建账号后提供“添加 BPS 授权”步骤（缺省按支持处理）。 */
export function offersBpsStep(catalog: Pick<GatewayCatalog, 'authorizations'>) {
  return catalog.authorizations
    ? catalog.authorizations.includes('bps_oauth') ||
        catalog.authorizations.includes('bps_import')
    : true
}
export const accountBase = '/api/panel/codex-accounts'
export const accountQueryKey = ['gateway-workers', 'accounts'] as const

/** 账号列表（列表页与详情页的切换下拉共用缓存），5 秒轮询。 */
export const accountsQueryOptions = (archived: boolean) =>
  queryOptions({
    queryKey: [...accountQueryKey, archived],
    queryFn: () =>
      api<{ items: GatewayAccount[] }>(
        `${accountBase}?archived=${archived ? 'all' : 'active'}`
      ),
    refetchInterval: 5000,
  })

export const accountCatalogQueryOptions = () =>
  queryOptions({
    queryKey: ['gateway-account-catalog'],
    queryFn: () => api<GatewayCatalog>(`${accountBase}/catalog`),
  })

export const groupNamesOf = (catalog?: GatewayCatalog) =>
  new Map(catalog?.groups.map((group) => [group.id, group.name]) || [])

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

// Worker 凭据终态 → 与 VM 相同的后端原因文案（backendStatusLabel 本地化）
const CREDENTIAL_STATE_TEXT: Record<string, string> = {
  expired: 'oauth_expired',
  invalid: 'oauth_invalid_grant',
  banned: 'oauth_revoked',
  unverified: 'credential_blocked',
}

function credentialStateText(account: GatewayAccount): string {
  if (account.credential_error === 'credential_refresh_failed')
    return 'credential_refresh_failed'
  return (
    CREDENTIAL_STATE_TEXT[account.credential_state || ''] ||
    'oauth_invalid_grant'
  )
}

/**
 * Present a Gateway account in the VM row shape so the account list reuses the
 * Codex VM list cells (status, requests, quota windows, cost ledger) as-is.
 * 5h/7d windows come from `quotaWindows` (by window length, like VM slots).
 */
/**
 * 账号出站代理的代理池记录（与 VM 的 `vm.proxy` 同形，供 ProxyChip 显示健康与延迟）。
 * `proxy_id` 可能是平台代理池 id 或供应商代理资源 id；手填地址按主机端口匹配，
 * 池里没有时只返回主机端口。
 */
export function gatewayAccountProxy(
  account: GatewayAccount,
  pool: VmProxySnap[] = []
): VmProxySnap | null {
  const { proxy_id: id, proxy_endpoint: endpoint } = account.config
  let host = ''
  let port = ''
  if (endpoint) {
    try {
      const url = new URL(endpoint)
      host = url.hostname
      port = url.port
    } catch {
      /* Stored summaries are protocol//host; anything else has no host. */
    }
  }
  const pooled =
    (id &&
      pool.find((row) => row.id === id || row.vendor_resource_id === id)) ||
    (host &&
      pool.find(
        (row) => row.host === host && String(row.port ?? '') === port
      )) ||
    null
  if (pooled) return pooled
  return host ? { host, port: port || undefined } : null
}

/** 账号列表里的今日 / 5H / 7D 汇总，转成 VM 详情页「计费窗口」的 billing 形态。 */
export function gatewayAccountBilling(account: GatewayAccount) {
  const usage = account.usage
  const period = (prefix: string): VmBillingPeriod | null => {
    if (!usage) return null
    const row = usage as unknown as Record<string, number>
    return {
      requests: row[`${prefix}_requests`] || 0,
      input_tokens: row[`${prefix}_input_tokens`] || 0,
      output_tokens: row[`${prefix}_output_tokens`] || 0,
      cache_read_tokens: row[`${prefix}_cache_read_tokens`] || 0,
      cache_creation_tokens: row[`${prefix}_cache_creation_tokens`] || 0,
      total_cost: row[`${prefix}_cost`] || 0,
    }
  }
  return {
    today: period('today'),
    window_5h: period('window_5h'),
    window_7d: period('window_7d'),
  }
}

export function gatewayAccountAsVm(
  account: GatewayAccount,
  groupNames: Map<number, string>,
  proxies?: VmProxySnap[]
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
    : account.credential_state
      ? // 与 VM 一致：凭证失效先于调度开关判断；过期但仍有 refresh token 时 Worker 发送前会再试刷新
        {
          key: 'bad',
          usable: account.credential_state === 'expired',
          reason: `credential_${account.credential_state}`,
          text: credentialStateText(account),
        }
      : off
        ? { key: 'off', usable: false }
        : state === 'pending'
          ? { key: 'cool', usable: true, reason: 'projection_pending' }
          : limited
            ? {
                key: 'quota',
                usable: true,
                reason:
                  Number(w5?.used_percent) >= 100 ? 'quota_5h' : 'quota_7d',
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
    runtime_type: 'gateway',
    status: off ? 'stopped' : 'running',
    has_token: hasToken,
    has_refresh: hasToken,
    credential_mode: 'oauth',
    bps_status: bpsStatusOf(account),
    plan_type:
      account.config.plan_override ||
      account.quota?.plan_type ||
      account.config.plan ||
      null,
    chatgpt_subscription_active_until:
      account.config.subscription?.expires_at || null,
    subscription_will_renew: account.config.subscription?.will_renew ?? null,
    subscription_billing_period:
      account.config.subscription?.billing_period || null,
    billing_type: account.config.subscription?.billing_type || null,
    subscription_updated_at: account.config.subscription?.checked_at || null,
    notes: account.config.notes || account.config.vendor_notes || '',
    vendor_id: account.vendor_id,
    vendor_name: account.vendor_name,
    groups: (account.config.group_ids || []).map((id) => ({
      id,
      name: groupNames.get(id) || `#${id}`,
      status: 'active',
    })),
    schedulable: !off,
    schedule_state: off ? 'off' : 'on',
    // 权重 1–100 与 VM 调度等级同为「高者优先」，列表优先级标签直接显示权重。
    schedule_level: account.config.weight ?? 1,
    schedule_level_mode: 'manual',
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
    proxy: gatewayAccountProxy(account, proxies) ?? undefined,
    proxy_id: account.config.proxy_id || undefined,
    inflight: Number(account.inflight) || 0,
    created_at: account.created_at,
  } as Vm
}

/** 账号用量报表的按模型汇总，转成 VM 详情页「按模型成本」表的行。 */
export function usageModelRows(
  report?: Pick<VendorUsageReport, 'models'> | null
): VmBillingModelRow[] | undefined {
  return report?.models.map((row) => ({
    model: row.model,
    requests: row.requests,
    unpriced_requests: row.unpriced_requests,
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    cache_read_tokens: row.cache_read_tokens,
    cache_creation_tokens: row.cache_creation_tokens,
    total_cost: Number(row.cost_usd) || 0,
  }))
}

/** 代理芯片点击探测：池内代理查出口地理，池外手填地址没有可测记录。 */
export function gatewayExitProbePath(vm: Pick<Vm, 'proxy'>): string | null {
  return vm.proxy?.id
    ? `/api/panel/proxies/${encodeURIComponent(vm.proxy.id)}/geo`
    : null
}

/** BPS 通道状态：none 未授权、off 已授权但关闭或未选模型、active 可用、expired/invalid 需重新授权、blocked 403 停用。 */
export type BpsStatus =
  'none' | 'off' | 'active' | 'expired' | 'invalid' | 'blocked'

export function bpsStatusOf(account: GatewayAccount): BpsStatus {
  return bpsStatusFrom(bpsViewOf(account))
}

/** 一次 BPS 403 恢复探测（不进使用记录、不计费）。 */
export type BpsProbe = {
  probed_at: string
  model: string
  ok: boolean
  status: number | null
  error_code: string | null
  input_tokens: number
  output_tokens: number
  total_tokens: number
  duration_ms: number
}

/** BPS 区域的数据：运营端取自账号行，供应商门户取自 /api/vendor/accounts/:id/bps。 */
/** 最近一次 BPS 严格探测（精确模型 + 工具往返）的结果。 */
export type BpsVerification = {
  ok: boolean
  model: string
  mode: string | null
  response_model: string | null
  error_code: string | null
  verified_at: string
}

/** 官方 BPS 模型目录（/responses/access?include_models=true 的最近一次结果）。 */
export type BpsCatalog = {
  allowed: boolean
  models: {
    id: string
    display_name?: string
    reasoning_efforts: string[]
    cooling_down?: boolean
  }[]
  restricted_models: string[]
  fetched_at: string
}

/** BPS 模型名单上限（src/shared/executor-schema/codex-account.json models.max_items）。 */
const BPS_MODELS_MAX = 100

/**
 * 「获取 BPS 可用模型」后按交集重设勾选：BPS 目录中的模型且账号模型范围允许
 * （白名单取交集、黑名单排除、全部模型不限）。交集外的已选模型取消；冷却中的模型只保留原有勾选、不新增；
 * 已选的 gpt-image-* 不在 BPS 目录中但走 BPS，范围允许时保留。不超过名单上限；BPS 拒绝该账号时不改动。
 */
export function autoSelectBpsModels(
  selected: string[],
  catalog: BpsCatalog,
  access: ModelAccess | null | undefined
): string[] {
  if (!catalog.allowed) return selected
  const listed = new Set(access?.models || [])
  const permitted = (id: string) =>
    access?.mode === 'allowlist'
      ? listed.has(id)
      : access?.mode === 'denylist'
        ? !listed.has(id)
        : true
  const kept = new Set(selected)
  const out: string[] = []
  for (const model of catalog.models) {
    if (out.includes(model.id) || !permitted(model.id)) continue
    if (model.cooling_down && !kept.has(model.id)) continue
    out.push(model.id)
  }
  for (const id of selected)
    if (id.startsWith('gpt-image') && permitted(id) && !out.includes(id))
      out.push(id)
  return out.slice(0, BPS_MODELS_MAX)
}

export type BpsView = {
  bps_probes?: BpsProbe[]
  /** 账号模型范围：「获取 BPS 可用模型」按它自动勾选（autoSelectBpsModels） */
  model_access?: ModelAccess | null
  bps_catalog?: BpsCatalog | null
  bps_verification?: BpsVerification | null
  id: string
  name: string
  bps?: BpsSettings | null
  bps_grant?: { revision: number; authorized_at: string } | null
  bps_state?: string | null
  bps_error?: string | null
  bps_blocked_at?: string | null
  bps_recovery?: 'auto' | 'stopped' | 'off' | null
  bps_next_probe_at?: string | null
  bps_cooldown_until?: string | null
}

export function bpsViewOf(account: GatewayAccount): BpsView {
  return {
    id: account.id,
    name: account.name,
    bps: account.config.bps || null,
    bps_grant: account.config.bps_grant || null,
    bps_catalog: account.config.bps_catalog || null,
    bps_verification: account.config.bps_verification || null,
    bps_state: account.bps_state,
    bps_error: account.bps_error,
    bps_blocked_at: account.bps_blocked_at,
    bps_recovery: account.bps_recovery,
    bps_next_probe_at: account.bps_next_probe_at,
    bps_cooldown_until: account.bps_cooldown_until,
  }
}

export function bpsStatusFrom(view: BpsView): BpsStatus {
  if (!view.bps_grant) return 'none'
  const state = view.bps_state
  if (state === 'blocked') return 'blocked'
  if (state === 'invalid') return 'invalid'
  if (state === 'expired') return 'expired'
  return view.bps?.enabled && view.bps.models.length ? 'active' : 'off'
}

/** BPS 操作的接口：创建授权草稿、草稿授权前缀、导入授权文件、撤销（同时用于读取与保存设置）。 */
export type BpsEndpoints = {
  drafts: string
  draftApiBase: string
  import: string
  bps: string
}

export function operatorBpsEndpoints(id: string): BpsEndpoints {
  return {
    drafts: `${accountBase}/${id}/drafts`,
    draftApiBase: `${accountBase}/drafts`,
    import: `${accountBase}/${id}/bps/import`,
    bps: `${accountBase}/${id}/bps`,
  }
}
