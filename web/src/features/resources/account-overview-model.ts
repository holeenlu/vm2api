import type { Vm } from '@/types/panel-vm'
import { credTypeOf, type CredType } from '@/lib/cred-type'
import { pct, usedPctOf } from '@/lib/format'
import { isCodexVm } from '@/lib/vm-kind'
import { zoneOf, type VmZone } from '@/features/vm/vm-rack-model'

/** `GET /api/panel/vms/live-stats`：最近 1 分钟请求量 + 最近 5 分钟质量，按行 id 汇总。 */
export type LiveBucket = {
  requests_1m: number
  tokens_1m: number
  io_tokens_1m: number
  requests: number
  success: number
  prompt_tokens: number
  cache_read_tokens: number
  ttft_sum: number
  ttft_n: number
  latency_sum: number
  latency_n: number
}

export type LiveSnapshot = {
  generated_at: string
  window_ms: number
  rpm_window_ms: number
  total: LiveBucket
  accounts: Record<string, LiveBucket>
}

export type LiveSummary = {
  rpm: number
  tpm: number
  ioTpm: number
  hitPct: number | null
  successPct: number | null
  ttftMs: number | null
  latencyMs: number | null
}

const ratio = (part: number, whole: number) =>
  whole > 0 ? (part / whole) * 100 : null
const avg = (sum: number, n: number) => (n > 0 ? sum / n : null)

export function summarizeBucket(b: LiveBucket | null | undefined): LiveSummary {
  if (!b)
    return {
      rpm: 0,
      tpm: 0,
      ioTpm: 0,
      hitPct: null,
      successPct: null,
      ttftMs: null,
      latencyMs: null,
    }
  return {
    rpm: b.requests_1m,
    tpm: b.tokens_1m,
    ioTpm: b.io_tokens_1m,
    hitPct: ratio(b.cache_read_tokens, b.prompt_tokens),
    successPct: ratio(b.success, b.requests),
    ttftMs: avg(b.ttft_sum, b.ttft_n),
    latencyMs: avg(b.latency_sum, b.latency_n),
  }
}

/** 当前范围内账号的实时指标：逐行累加各账号桶再算比例。 */
export function summarizeLive(
  vms: Vm[],
  snapshot: LiveSnapshot | undefined
): LiveSummary {
  if (!snapshot) return summarizeBucket(null)
  const sum: LiveBucket = {
    requests_1m: 0,
    tokens_1m: 0,
    io_tokens_1m: 0,
    requests: 0,
    success: 0,
    prompt_tokens: 0,
    cache_read_tokens: 0,
    ttft_sum: 0,
    ttft_n: 0,
    latency_sum: 0,
    latency_n: 0,
  }
  for (const vm of vms) {
    const b = snapshot.accounts[vm.id]
    if (!b) continue
    for (const key of Object.keys(sum) as (keyof LiveBucket)[])
      sum[key] += Number(b[key]) || 0
  }
  return summarizeBucket(sum)
}

export type AccountCounts = Record<VmZone, number> & { total: number }

export function accountCounts(vms: Vm[]): AccountCounts {
  const counts: AccountCounts = {
    total: vms.length,
    pool: 0,
    restricted: 0,
    off: 0,
    none: 0,
    dead: 0,
  }
  for (const vm of vms) counts[zoneOf(vm)] += 1
  return counts
}

/** 实时并发：在途请求之和 / 并发上限之和（未设上限的账号不计入分母）。 */
export function concurrencyOf(vms: Vm[]) {
  let inflight = 0
  let max = 0
  for (const vm of vms) {
    inflight += Number(vm.inflight) || 0
    const cap = Number(vm.max_concurrency)
    if (Number.isFinite(cap) && cap > 0) max += cap
  }
  return { inflight, max }
}

export const NEAR_LIMIT_PCT = 85

export type QuotaWindow = '5h' | '7d' | 'fable'

/** 账号在该窗口的已用百分比；没有该窗口（无凭证、GPT 没有 Fable、未探测）为 null。 */
export function windowUsedPct(vm: Vm, window: QuotaWindow): number | null {
  if (!vm.has_token) return null
  if (window === 'fable') {
    if (isCodexVm(vm) || vm.utilization_7d_oi == null) return null
    return pct(vm.utilization_7d_oi)
  }
  const codexHit = vm.codex_usage?.windows?.some(
    (w) => w?.id === window && w.used_percent != null
  )
  const raw = window === '5h' ? vm.utilization_5h : vm.utilization_7d
  if (!codexHit && raw == null) return null
  return usedPctOf(vm, window)
}

export function windowDistribution(vms: Vm[], window: QuotaWindow) {
  const out = { accounts: 0, normal: 0, near: 0, reached: 0 }
  for (const vm of vms) {
    const used = windowUsedPct(vm, window)
    if (used == null) continue
    out.accounts += 1
    if (used >= 100) out.reached += 1
    else if (used >= NEAR_LIMIT_PCT) out.near += 1
    else out.normal += 1
  }
  return out
}

/** 配额高负载：5 小时或 7 天任一窗口达到「接近上限」。 */
export function quotaHighLoad(vms: Vm[]): number {
  return vms.filter((vm) =>
    (['5h', '7d'] as const).some(
      (w) => (windowUsedPct(vm, w) ?? 0) >= NEAR_LIMIT_PCT
    )
  ).length
}

/* ---------- 筛选 ---------- */

export const FAULT_KINDS = [
  'auth',
  'forbidden',
  'terms',
  'proxy',
  'other',
] as const
export type FaultKind = (typeof FAULT_KINDS)[number]

const FAULT_RULES: Array<[Exclude<FaultKind, 'other'>, RegExp]> = [
  [
    'auth',
    /^(oauth_(revoked|invalid_grant|expired|no_refresh|cleared|refresh_required)|credential_(refresh_failed|blocked|expired|invalid|unverified)|auth_cooldown|authentication_failed_after_refresh)$/,
  ],
  [
    'forbidden',
    /^(permission_denied|organization_disabled|account_disabled|credential_banned)$/,
  ],
  ['terms', /^terms_not_accepted$/],
  [
    'proxy',
    /^(proxy_\w+|egress_down|worker_proxy_missing|vendor_proxy_disabled)$/,
  ],
]

/**
 * 故障类型：按后端原因码归类（schedule-state.mjs 的归因表与 Gateway 凭据终态）。
 * 额度、限流、席位等自动恢复的受限不算故障。
 */
export function faultKindOf(vm: Vm): FaultKind | null {
  const codes = [
    vm.unschedulable_reason,
    vm.restriction_reason,
    vm.availability?.reason,
  ]
    .map((code) => String(code || '').trim())
    .filter(Boolean)
  for (const code of codes)
    for (const [kind, rule] of FAULT_RULES) if (rule.test(code)) return kind
  if (vm.schedule_state === 'unschedulable' || vm.availability?.key === 'bad')
    return 'other'
  return null
}

export function faultDistribution(vms: Vm[]): Record<FaultKind, number> {
  const out = Object.fromEntries(FAULT_KINDS.map((k) => [k, 0])) as Record<
    FaultKind,
    number
  >
  for (const vm of vms) {
    const kind = faultKindOf(vm)
    if (kind) out[kind] += 1
  }
  return out
}

export type ScheduleFilter = 'on' | 'off' | 'unschedulable' | 'restricted'

export type AccountFilters = {
  auth?: CredType
  schedule?: ScheduleFilter
  fault?: FaultKind
  /** 本地日期 yyyy-mm-dd（含当天）。 */
  createdFrom?: string
  createdTo?: string
}

export function hasAccountFilters(f: AccountFilters) {
  return Object.values(f).some(Boolean)
}

function dayStartMs(day: string) {
  return new Date(`${day}T00:00:00`).getTime()
}

export function matchesAccountFilters(vm: Vm, f: AccountFilters): boolean {
  if (f.auth && credTypeOf(vm) !== f.auth) return false
  if (f.schedule && (vm.schedule_state || 'on') !== f.schedule) return false
  if (f.fault && faultKindOf(vm) !== f.fault) return false
  if (f.createdFrom || f.createdTo) {
    const created = Date.parse(String(vm.created_at || ''))
    if (!Number.isFinite(created)) return false
    if (f.createdFrom && created < dayStartMs(f.createdFrom)) return false
    if (f.createdTo && created >= dayStartMs(f.createdTo) + 86_400_000)
      return false
  }
  return true
}
