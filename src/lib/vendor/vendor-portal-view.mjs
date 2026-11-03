import { shanghaiDayStartIso } from '../admin/pricing.mjs'
import { vendorUsageSummary } from './vendor-account-usage.mjs'
import { projectVendorUsage } from './projections/usage-projection.mjs'
import { projectVendorAccount } from './projections/account-projection.mjs'
import { isSpecificAccountReason, normalizeAccountReason } from '../../shared/account-status-reason.mjs'
import { stateOfReason } from '../pool/schedule-state.mjs'
import { accountLimitReason } from '../pool/availability.mjs'
import { GatewayWorkerRepo, gatewayQuotaWindows } from '../gateway-worker/gateway-repo.mjs'

export { normalizeAccountReason }

function publicProxyEndpoint(value) {
  try {
    const url = new URL(value)
    url.username = ''
    url.password = ''
    return url.href
  } catch {
    return null
  }
}

// 受限 / stateless codes (quota windows, cooldowns, holds) clear by themselves;
// only 不可调度 codes and unrecognised upstream prose describe an account fault.
function isFaultReason(reason) {
  const state = stateOfReason(reason)?.state
  return state !== 'restricted' && state !== 'on'
}

function accountReasonFromSummary(summary) {
  const refresh = summary?.refresh_error
  const candidates = [
    refresh?.code,
    refresh?.reason,
    refresh?.message,
    typeof refresh === 'string' ? refresh : null,
    summary?.unschedulable?.reason,
    summary?.unschedulable?.detail?.message,
    summary?.temp_unschedulable_reason,
    summary?.schedule_disabled_reason,
    summary?.schedule_disabled_detail?.message,
  ]
    .map(normalizeAccountReason)
    .filter((reason) => reason && isFaultReason(reason))
  return candidates.find(isSpecificAccountReason) || candidates[0] || null
}

function accountReasonDetail(summary, reason) {
  if (!reason) return null
  if (reason === 'proxy_unavailable') return '代理不可用'
  const refresh = summary?.refresh_error
  const candidates = [
    refresh?.message,
    typeof refresh === 'string' ? refresh : null,
    summary?.unschedulable?.detail?.message,
    summary?.schedule_disabled_detail?.message,
  ]
  const raw = candidates.find((value) => typeof value === 'string' && value.trim())
  if (!raw) return reason
  const text = raw.trim()
  if (/https?:\/\/[^\s]*@|password|authorization|access[_ -]?token|session[_ -]?key/i.test(text)) {
    return reason
  }
  return text.slice(0, 500)
}

function parseJson(value) {
  try {
    return value ? JSON.parse(value) : null
  } catch {
    return null
  }
}

/**
 * Gateway Worker 账号的运行事实：优先已同步实例的最新绑定（其他实例 drifted 不应判为待授权），
 * 额度窗口按时长归为 5h/7d（与运营端 Codex 账号页同口径），冻结取未到期的最晚一条。
 */
function gatewayFacts(platform, resources, now) {
  const ids = resources.filter((r) => r.config?.execution_kind === 'gateway_worker').map((r) => r.id)
  const facts = new Map()
  if (!ids.length) return facts
  const marks = ids.map(() => '?').join(',')
  const bindings = new Map()
  for (const row of platform.db
    .prepare(`SELECT * FROM gateway_worker_account_bindings WHERE account_resource_id IN (${marks})
      ORDER BY account_resource_id, projection_status='synced' DESC, updated_at DESC`)
    .all(...ids))
    if (!bindings.has(row.account_resource_id)) bindings.set(row.account_resource_id, row)
  const freezes = new Map()
  for (const row of platform.db
    .prepare(`SELECT account_resource_id, MAX(frozen_until) AS until FROM gateway_account_freezes
      WHERE account_resource_id IN (${marks}) GROUP BY account_resource_id`)
    .all(...ids))
    if (Date.parse(row.until) > now) freezes.set(row.account_resource_id, row.until)
  // 在途数来自在线实例的心跳；离线实例的旧值不计
  const inflight = new Map()
  for (const row of platform.db
    .prepare(`SELECT b.account_resource_id, SUM(b.inflight) AS n FROM gateway_worker_account_bindings b
      JOIN gateway_worker_instances i ON i.id=b.gateway_instance_id
      WHERE b.account_resource_id IN (${marks}) AND i.health_state IN ('healthy','degraded') GROUP BY b.account_resource_id`)
    .all(...ids))
    inflight.set(row.account_resource_id, Number(row.n) || 0)
  const quotas = new Map(ids.map((id) => [id, parseJson(bindings.get(id)?.quota_json)]))
  const usage = new GatewayWorkerRepo(platform.db).codexAccountUsage(
    ids.map((id) => ({ id, quota: quotas.get(id) })),
    now,
  )
  for (const id of ids) {
    const quota = quotas.get(id)
    const [five, seven] = gatewayQuotaWindows(quota)
    const exhausted = [
      ['quota_5h', five],
      ['quota_7d', seven],
    ].find(([, w]) => Number(w?.used_percent) >= 100 && Date.parse(w?.reset_at || '') > now)
    facts.set(id, {
      binding: bindings.get(id) || null,
      quota,
      five,
      seven,
      usage: usage.get(id) || null,
      freezeUntil: freezes.get(id) || null,
      inflight: inflight.get(id) || 0,
      exhausted: exhausted ? { reason: exhausted[0], until: exhausted[1].reset_at } : null,
    })
  }
  return facts
}

const ratio = (percent) => (percent == null || !Number.isFinite(Number(percent)) ? null : Number(percent) / 100)

function failureCategory(reason) {
  const value = String(reason || '').toLowerCase()
  if (!value) return null
  if (/email.*mismatch/.test(value)) return 'email_mismatch'
  if (/proxy|egress|socks/.test(value)) return 'proxy'
  if (/auth|credential|token|revoked|401/.test(value)) return 'authentication'
  if (/kyc/.test(value)) return 'kyc'
  if (/terms/.test(value)) return 'terms'
  if (/tier|plan/.test(value)) return 'tier'
  if (/duplicate/.test(value)) return 'duplicate'
  if (/permission|403/.test(value)) return 'permission'
  if (/connect|timeout|network/.test(value)) return 'connection'
  if (/reject|400/.test(value)) return 'rejected'
  if (/upstream|502|503|529/.test(value)) return 'upstream'
  return 'unknown'
}

// All fields are explicitly projected. No provider token, proxy password or consumer log is returned.
export function accountPortalRows(
  platform,
  resources,
  { usageAccounts = [], readVm = () => null, now = Date.now() } = {},
) {
  const runtimeIds = new Map()
  for (const resource of resources) {
    const config = resource.config || {}
    if (config.execution_kind === 'gateway_worker') {
      runtimeIds.set(resource.id, `gateway:${resource.id}`)
      continue
    }
    const linked = platform.db
      .prepare("SELECT config_json FROM vendor_resources WHERE id=? AND vendor_id=? AND resource_type='vm'")
      .get(resource.config?.vm_resource_id || '', resource.vendor_id)
    runtimeIds.set(resource.id, linked ? JSON.parse(linked.config_json).runtime_vm_id : null)
  }
  const ids = [...new Set([...runtimeIds.values()].filter(Boolean))]
  const gateways = gatewayFacts(platform, resources, now)
  const metrics = new Map()
  if (ids.length) {
    const stamp = new Date(now).toISOString()
    const minute = new Date(now - 60000).toISOString()
    // Read only supplied VM IDs; lifetime token totals are never used as TPM.
    const rows = platform.db
      .prepare(`
      SELECT vm_id,
        SUM(CASE WHEN created_at>=? THEN 1 ELSE 0 END) AS rpm,
        SUM(CASE WHEN created_at>=? THEN COALESCE(input_tokens,0)+COALESCE(output_tokens,0) ELSE 0 END) AS tpm,
        SUM(CASE WHEN created_at>=? THEN COALESCE(input_tokens,0)+COALESCE(output_tokens,0)+COALESCE(cache_read_tokens,0)+COALESCE(cache_creation_tokens,0) ELSE 0 END) AS tpm_with_cache
      FROM usage_logs WHERE vm_id IN (${ids.map(() => '?').join(',')}) AND created_at<=? GROUP BY vm_id
    `)
      .all(minute, minute, minute, ...ids, stamp)
    for (const row of rows) metrics.set(row.vm_id, row)
  }
  return resources.map((resource) => {
    const runtimeId = runtimeIds.get(resource.id)
    const executionKind = resource.config?.execution_kind === 'gateway_worker' ? 'gateway_worker' : 'vm'
    const gateway = executionKind === 'gateway_worker' ? gateways.get(resource.id) : null
    const gatewayBinding = gateway?.binding || null
    const vm = runtimeId ? readVm(runtimeId) : null
    const summary = vm?.summary || null
    const usage = usageAccounts.find(
      (row) => row.vm_id === runtimeId && (!summary?.account_uuid || row.account_id === summary.account_uuid),
    )
    const readings = summary?.has_token === false ? null : summary?.platform === 'openai' ? summary : usage
    const stats = metrics.get(runtimeId)
    const totals = runtimeId
      ? projectVendorUsage({
          summary: vendorUsageSummary(platform.db, [runtimeId], { until: new Date(now + 1).toISOString() }),
        }).summary
      : null
    const today = runtimeId
      ? projectVendorUsage({
          summary: vendorUsageSummary(platform.db, [runtimeId], {
            since: shanghaiDayStartIso(new Date(now)),
            until: new Date(now + 1).toISOString(),
          }),
        }).summary
      : null
    const proxy = resource.config?.proxy_id
      ? platform.db
          .prepare(
            "SELECT id,name,config_json FROM vendor_resources WHERE id=? AND vendor_id=? AND resource_type='proxy'",
          )
          .get(resource.config.proxy_id, resource.vendor_id)
      : null
    const groups = platform.db
      .prepare(`SELECT g.id,g.name,g.platform FROM group_resources r JOIN groups g ON g.id=r.group_id
      WHERE r.resource_kind=? AND r.resource_id=? AND g.deleted_at IS NULL ORDER BY g.sort_order,g.id`)
      .all(
        executionKind === 'gateway_worker' ? 'gateway_worker_account' : 'vm',
        executionKind === 'gateway_worker' ? resource.id : runtimeId || '',
      )
    const reason = accountReasonFromSummary(summary)
    const credentialState =
      executionKind === 'gateway_worker'
        ? gatewayBinding?.projection_status === 'synced'
          ? 'valid'
          : gatewayBinding?.projection_status === 'blocked'
            ? 'revoked'
            : 'missing'
        : reason === 'oauth_revoked' || reason === 'oauth_invalid_grant' || reason === 'credential_refresh_failed'
          ? 'revoked'
          : reason === 'oauth_expired'
            ? 'expired'
            : reason === 'organization_disabled' || reason === 'terms_not_accepted'
              ? 'blocked'
              : summary?.has_token === true
                ? 'valid'
                : 'missing'
    const scheduleDisabledReason = normalizeAccountReason(summary?.schedule_disabled_reason)
    // Gateway：错误保护冻结优先，其次是用尽且未重置的额度窗口
    const until = gateway
      ? gateway.freezeUntil || gateway.exhausted?.until || null
      : summary?.temp_unschedulable_until || usage?.cooldown_until
    const cooling = !!until && (typeof until === 'number' ? until : Date.parse(until)) > now
    const coolReason = gateway
      ? gateway.freezeUntil
        ? 'cooldown'
        : gateway.exhausted?.reason || null
      : accountLimitReason(summary?.temp_unschedulable_reason, { quota: usage || summary || {} }, now)
    const restrictionReason = cooling
      ? stateOfReason(coolReason)?.state === 'restricted'
        ? coolReason
        : 'cooldown'
      : null
    const category = failureCategory(reason !== 'no_credential' ? reason : '')
    const available =
      executionKind === 'gateway_worker'
        ? resource.status === 'active' && gatewayBinding?.projection_status === 'synced' && !cooling && !category
        : resource.status === 'active' &&
          summary?.has_token === true &&
          summary?.status === 'running' &&
          vm?.schedulable === true &&
          !cooling &&
          !category
    const state = ['paused', 'archived'].includes(resource.status)
      ? resource.status
      : executionKind === 'gateway_worker'
        ? !gatewayBinding
          ? 'provisioning'
          : cooling
            ? 'cooling'
            : category
              ? 'error'
              : available
                ? 'available'
                : 'unavailable'
        : !summary
          ? 'provisioning'
          : cooling
            ? 'cooling'
            : category
              ? 'error'
              : !summary.has_token
                ? 'unauthorized'
                : available
                  ? 'available'
                  : 'unavailable'
    const fable = summary?.platform === 'anthropic' || resource.config?.platform === 'anthropic'
    return projectVendorAccount({
      ...resource,
      config: {
        ...resource.config,
        auth_method:
          executionKind === 'gateway_worker'
            ? resource.config?.auth_method || 'oauth'
            : summary?.has_token
              ? summary.platform === 'openai'
                ? 'oauth'
                : summary.credential_mode === 'official-setup-token'
                  ? 'setup-token'
                  : summary.credential_mode || resource.config?.auth_method
              : resource.config?.auth_method,
      },
      groups,
      proxy: proxy
        ? { id: proxy.id, name: proxy.name, endpoint: publicProxyEndpoint(JSON.parse(proxy.config_json).endpoint) }
        : null,
      notes: resource.config?.vendor_notes || '',
      all_time_usage: totals,
      today_usage: today,
      telemetry: {
        vm_id: executionKind === 'gateway_worker' ? null : runtimeId || null,
        execution_kind: executionKind,
        gateway_instance_id: gatewayBinding?.gateway_instance_id || null,
        runtime_account_id: gatewayBinding?.runtime_account_id || resource.config?.runtime_account_id || null,
        has_token: executionKind === 'gateway_worker' ? credentialState === 'valid' : summary?.has_token === true,
        credential_state: credentialState,
        unschedulable_reason: reason || null,
        reason_detail: accountReasonDetail(summary, reason),
        schedule_disabled_reason: scheduleDisabledReason,
        schedule_state:
          executionKind === 'gateway_worker'
            ? resource.status === 'paused'
              ? 'off'
              : restrictionReason
                ? 'restricted'
                : available
                  ? 'on'
                  : 'unschedulable'
            : summary?.schedule_off
              ? 'off'
              : summary?.unschedulable || category
                ? 'unschedulable'
                : restrictionReason || summary?.schedulable === false
                  ? 'restricted'
                  : 'on',
        restriction_reason: restrictionReason,
        restriction_text: restrictionReason ? stateOfReason(restrictionReason).text : null,
        // Gateway Worker 账号没有槽内令牌，按凭据状态判断是否需要重新授权
        requires_authorization:
          executionKind === 'gateway_worker'
            ? credentialState !== 'valid'
            : !!summary && (!summary.has_token || !!category),
        schedulable: available,
        subscription_type: summary?.subscription_type || null,
        rate_limit_tier: summary?.rate_limit_tier || null,
        billing_type: summary?.billing_type || null,
        subscription_updated_at: summary?.subscription_updated_at || null,
        subscription_expires_at: summary?.chatgpt_subscription_active_until || null,
        subscription_will_renew: summary?.subscription?.will_renew ?? null,
        can_refresh_profile: summary?.can_refresh_profile === true,
        state,
        plan_type:
          executionKind === 'gateway_worker'
            ? gateway?.quota?.plan_type || resource.config?.plan || null
            : summary?.platform === 'openai'
              ? summary?.plan_type || summary?.chatgpt_plan_type || null
              : summary?.credential_mode === 'apikey'
                ? null
                : summary?.subscription_type || null,
        priority: gateway ? (resource.config?.weight ?? 1) : (summary?.weight ?? null),
        utilization_5h: gateway ? ratio(gateway.five?.used_percent) : (readings?.utilization_5h ?? null),
        reset_5h: gateway ? gateway.five?.reset_at || null : (readings?.reset_5h ?? null),
        utilization_7d: gateway ? ratio(gateway.seven?.used_percent) : (readings?.utilization_7d ?? null),
        reset_7d: gateway ? gateway.seven?.reset_at || null : (readings?.reset_7d ?? null),
        utilization_fable: usage?.utilization_7d_oi ?? null,
        reset_fable: usage?.reset_7d_oi ?? null,
        has_fable:
          fable &&
          (usage?.usage_has_fable === true || usage?.utilization_7d_oi != null || summary?.account_tier === 'max'),
        today_cost: today?.cost_usd ?? null,
        total_cost: totals?.cost_usd ?? null,
        today_fable_cost: fable ? (today?.fable_cost_usd ?? null) : null,
        fable_cost: fable ? (totals?.fable_cost_usd ?? null) : null,
        requests: totals?.requests ?? null,
        total_tokens: totals?.total_tokens ?? null,
        tokens_in: totals?.input_tokens ?? null,
        tokens_out: totals?.output_tokens ?? null,
        cache_read_tokens: totals?.cache_read_tokens ?? null,
        cache_creation_tokens: totals?.cache_creation_tokens ?? null,
        cache_hit_rate: totals?.cache_hit_rate ?? null,
        inflight: gateway ? gateway.inflight : (usage?.inflight ?? null),
        max_concurrency: gateway
          ? (resource.config?.max_concurrency ?? null)
          : (usage?.max_concurrency ?? summary?.max_concurrency ?? null),
        rpm: runtimeId ? (stats?.rpm ?? 0) : null,
        max_rpm: gateway ? (resource.config?.max_rpm ?? null) : (usage?.max_rpm ?? summary?.max_rpm ?? null),
        tpm: runtimeId ? (stats?.tpm ?? 0) : null,
        tpm_with_cache: runtimeId ? (stats?.tpm_with_cache ?? 0) : null,
        window_5h_cost: (gateway ? gateway.usage : usage)?.window_5h_cost ?? null,
        window_7d_cost: (gateway ? gateway.usage : usage)?.window_7d_cost ?? null,
        window_5h_requests: (gateway ? gateway.usage : usage)?.window_5h_requests ?? null,
        window_7d_requests: (gateway ? gateway.usage : usage)?.window_7d_requests ?? null,
        window_5h_tokens: (gateway ? gateway.usage : usage)?.window_5h_tokens ?? null,
        window_7d_tokens: (gateway ? gateway.usage : usage)?.window_7d_tokens ?? null,
        near_limit: (gateway
          ? [ratio(gateway.five?.used_percent), ratio(gateway.seven?.used_percent)]
          : [usage?.utilization_5h, usage?.utilization_7d, usage?.utilization_7d_oi]
        ).some((v) => v != null && v >= 0.9),
        failure_category: category,
        cooldown_until: cooling ? new Date(typeof until === 'number' ? until : Date.parse(until)).toISOString() : null,
        email: gateway ? resource.config?.email || null : summary?.email || usage?.email || null,
        collected_at: new Date(now).toISOString(),
      },
    })
  })
}
