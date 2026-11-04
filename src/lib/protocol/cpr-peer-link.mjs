import crypto from 'node:crypto'
import { GroupsRepo } from '../db/repos/groups-repo.mjs'
import { groupResourceIds } from '../pool/group-policy.mjs'
import { GatewayWorkerRepo } from '../gateway-worker/gateway-repo.mjs'
import { normalizePeerSharing } from '../admin/peer-sharing.mjs'

/**
 * CPR 互联只读协议（codex-proxy-rs docs/api.md「CPR 互联只读协议」，schema_version 2）。
 *
 * GET /v1/cpr/link 用推理 Key 查询该 Key 授权范围内的只读快照：不执行推理、不占并发/RPM、
 * 不更新最近使用时间，预算耗尽后仍可查询。只有 Key 显式开启 peer_sharing.enabled 且绑定分组时可用。
 * 能力：key_usage（默认）、pool_summary（share_pool，share_plans 附套餐分布）、
 * quota_windows + model_availability（share_quota）。账号以 Key 内稳定的匿名 ID 公开，
 * 不返回邮箱、名称、代理或凭据；池与额度只覆盖分组绑定的 Gateway Worker 账号。
 */

const SNAPSHOT_TTL_MS = 5 * 60_000
const MAX_TTL_MS = 30 * 60_000
const MAX_ACCOUNTS = 3000
const MAX_MODELS = 2000

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')

function decimal(value) {
  const number = Number(value) || 0
  return String(Math.max(0, Math.round(number * 1e6) / 1e6))
}

/** Key 预算：访问结论按 Key 自身的额度与消费窗口判定（不含 RPM、并发等临时限流）。 */
export function keyUsage(record, now = Date.now()) {
  const windows = []
  let exhausted = false
  const quota = Number(record.quota) || 0
  if (quota > 0) {
    const used = Number(record.quota_used) || 0
    const reached = used >= quota
    exhausted ||= reached
    windows.push({
      key: 'total',
      label: '总额度',
      limit_reached: reached,
      total: decimal(quota),
      used: decimal(used),
      remaining: decimal(Math.max(0, quota - used)),
    })
  }
  for (const [key, label, seconds] of [
    ['5h', '5 小时', 5 * 3600],
    ['1d', '日额度', 86_400],
    ['7d', '周额度', 7 * 86_400],
  ]) {
    const limit = Number(record[`rate_limit_${key}`]) || 0
    if (limit <= 0) continue
    const start = Date.parse(record[`window_${key}_start`] || '')
    const open = Number.isFinite(start) && now - start < seconds * 1000
    const used = open ? Number(record[`usage_${key}`]) || 0 : 0
    const reached = open && used >= limit
    exhausted ||= reached
    windows.push({
      key,
      label,
      window_seconds: seconds,
      limit_reached: reached,
      total: decimal(limit),
      used: decimal(used),
      remaining: decimal(Math.max(0, limit - used)),
      ...(open ? { reset_at: iso(start + seconds * 1000) } : {}),
    })
  }
  const requestQuota = Number(record.quota_requests) || 0
  if (requestQuota > 0 && (Number(record.quota_requests_used) || 0) >= requestQuota) exhausted = true
  const expired = record.expires_at && Date.parse(record.expires_at) <= now
  const allowed = record.status !== 'quota_exhausted' && !exhausted && !expired && record.status === 'active'
  return {
    status: 'available',
    observed_at: iso(now),
    data: { allowed, ...(windows.length ? { unit: 'USD', windows } : {}) },
  }
}

function quotaWindows(quota) {
  const out = []
  for (const [field, role] of [
    ['primary_window', 'primary'],
    ['secondary_window', 'secondary'],
  ]) {
    const window = quota?.[field]
    if (!window) continue
    const minutes = Number(window.window_minutes)
    const seconds = Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes * 60) : null
    const percent = Number(window.used_percent)
    const resetAt = Date.parse(window.reset_at || '')
    const key = seconds == null ? role : seconds <= 6 * 3600 ? '5h' : seconds >= 6 * 86_400 ? 'weekly' : role
    out.push({
      key,
      role,
      ...(seconds ? { window_seconds: seconds } : {}),
      ...(Number.isFinite(percent) ? { used_percent: Math.min(100, Math.max(0, percent)) } : {}),
      ...(Number.isFinite(resetAt) ? { reset_at: iso(resetAt) } : {}),
      ...(Number.isFinite(percent) && percent >= 100 ? { limit_reached: true } : {}),
    })
  }
  return out
}

function observation(quota, now) {
  const observedAt = Date.parse(quota?.updated_at || '')
  if (!Number.isFinite(observedAt) || observedAt > now) return null
  return { observedAt, expiresAt: Math.min(observedAt + SNAPSHOT_TTL_MS, observedAt + MAX_TTL_MS) }
}

function accountState(account, now) {
  if (account.status === 'paused' || account.status === 'archived') return 'disabled'
  if (!account.runtime_account_id || account.projection_status !== 'synced') return 'unknown'
  const windows = quotaWindows(account.quota)
  if (windows.some((w) => w.limit_reached && (!w.reset_at || Date.parse(w.reset_at) > now))) return 'exhausted'
  if (account.runtime_status === 'upstream_error' && account.last_error) return 'error'
  return 'ready'
}

function accountModels(account, catalog) {
  const access = account.config?.model_access
  if (access?.mode === 'allowlist') return catalog.filter((model) => access.models.includes(model))
  if (access?.mode === 'denylist') return catalog.filter((model) => !access.models.includes(model))
  return catalog
}

/** 组装快照；models 为该 Key 可见的 OpenAI 模型 ID（由调用方按推理路由的同一范围计算）。 */
export function buildPeerLinkSnapshot({ db, record, models = [], now = Date.now() }) {
  const sharing = normalizePeerSharing(record.peer_sharing)
  const capabilities = ['key_usage']
  const snapshot = {
    object: 'cpr.peer',
    schema_version: 2,
    capabilities,
    observed_at: iso(now),
    expires_at: iso(now + SNAPSHOT_TTL_MS),
    usage: keyUsage(record, now),
  }
  if (!sharing.share_pool && !sharing.share_quota) return snapshot
  const ids = new Set(groupResourceIds(new GroupsRepo(db).resources(Number(record.group_id)), 'gateway_worker_account'))
  const accounts = new GatewayWorkerRepo(db)
    .listCodexAccounts({ includeArchived: true })
    .filter((account) => ids.has(account.id))
  if (accounts.length > MAX_ACCOUNTS) return snapshot
  if (sharing.share_pool) {
    const states = { ready: 0, cooldown: 0, exhausted: 0, disabled: 0, error: 0, unknown: 0 }
    const plans = new Map()
    for (const account of accounts) {
      states[accountState(account, now)] += 1
      const plan = account.config?.plan || account.quota?.plan_type
      if (plan) plans.set(plan, (plans.get(plan) || 0) + 1)
    }
    capabilities.push('pool_summary')
    snapshot.pool = {
      account_count: accounts.length,
      states,
      observed_at: iso(now),
      ...(sharing.share_plans && plans.size ? { plans: [...plans].map(([name, count]) => ({ name, count })) } : {}),
    }
  }
  if (sharing.share_quota) {
    const catalog = models.slice(0, MAX_MODELS)
    const anonymous = (id) =>
      crypto.createHash('sha256').update(`cpr-peer-v1\0${record.id}\0${id}`).digest('hex').slice(0, 32)
    const visible = accounts.filter((account) => account.status !== 'archived')
    capabilities.push('quota_windows')
    snapshot.quota = {
      accounts: visible.map((account) => {
        const seen = observation(account.quota, now)
        return {
          id: anonymous(account.id),
          models: accountModels(account, catalog),
          ...(seen ? { observed_at: iso(seen.observedAt), expires_at: iso(seen.expiresAt) } : {}),
          windows: quotaWindows(account.quota),
        }
      }),
    }
    capabilities.push('model_availability')
    snapshot.models = catalog.map((model) => {
      const candidates = visible.filter(
        (account) => accountState(account, now) !== 'disabled' && accountModels(account, [model]).length,
      )
      const valid = candidates
        .map((account) => ({ account, seen: observation(account.quota, now) }))
        .filter(({ seen }) => seen && seen.expiresAt > now)
      const exhausted = valid.filter(({ account }) => accountState(account, now) === 'exhausted')
      const complete = candidates.length > 0 && valid.length === candidates.length
      const state =
        complete && exhausted.length === valid.length
          ? 'exhausted'
          : valid.length > exhausted.length
            ? 'available'
            : 'unknown'
      const latest = valid.reduce((max, { seen }) => Math.max(max, seen.observedAt), 0)
      return {
        model,
        coverage: complete ? 'complete' : 'partial',
        state,
        ...(latest ? { observed_at: iso(latest), expires_at: iso(latest + SNAPSHOT_TTL_MS) } : {}),
      }
    })
  }
  return snapshot
}
