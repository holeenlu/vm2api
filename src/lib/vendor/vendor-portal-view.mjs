import { shanghaiDayStartIso } from '../admin/pricing.mjs'
import { vendorUsageSummary } from './vendor-account-usage.mjs'

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

function failureCategory(reason) {
  const value = String(reason || '').toLowerCase()
  if (!value) return null
  if (/auth|credential|token|revoked|401/.test(value)) return 'authentication'
  if (/kyc/.test(value)) return 'kyc'
  if (/terms/.test(value)) return 'terms'
  if (/tier|plan/.test(value)) return 'tier'
  if (/duplicate/.test(value)) return 'duplicate'
  if (/email.*mismatch/.test(value)) return 'email_mismatch'
  if (/proxy|egress|socks/.test(value)) return 'proxy'
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
    const linked = platform.db
      .prepare("SELECT config_json FROM vendor_resources WHERE id=? AND vendor_id=? AND resource_type='vm'")
      .get(resource.config?.vm_resource_id || '', resource.vendor_id)
    runtimeIds.set(resource.id, linked ? JSON.parse(linked.config_json).runtime_vm_id : null)
  }
  const ids = [...new Set([...runtimeIds.values()].filter(Boolean))]
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
    const vm = runtimeId ? readVm(runtimeId) : null
    const summary = vm?.summary || null
    const usage = usageAccounts.find(
      (row) => row.vm_id === runtimeId && (!summary?.account_uuid || row.account_id === summary.account_uuid),
    )
    const readings = summary?.has_token === false ? null : summary?.platform === 'openai' ? summary : usage
    const stats = metrics.get(runtimeId)
    const totals = runtimeId
      ? vendorUsageSummary(platform.db, [runtimeId], { until: new Date(now + 1).toISOString() })
      : null
    const today = runtimeId
      ? vendorUsageSummary(platform.db, [runtimeId], {
          since: shanghaiDayStartIso(new Date(now)),
          until: new Date(now + 1).toISOString(),
        })
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
      WHERE r.resource_kind='vm' AND r.resource_id=? AND g.deleted_at IS NULL ORDER BY g.sort_order,g.id`)
      .all(runtimeId || '')
    const reason =
      summary?.refresh_error?.code ||
      summary?.unschedulable?.reason ||
      summary?.temp_unschedulable_reason ||
      summary?.schedule_disabled_reason
    const until = summary?.temp_unschedulable_until || usage?.cooldown_until
    const cooling = !!until && (typeof until === 'number' ? until : Date.parse(until)) > now
    const category = failureCategory(reason && !['no_credential', 'vendor_paused'].includes(reason) ? reason : '')
    const available =
      resource.status === 'active' &&
      summary?.has_token === true &&
      summary?.status === 'running' &&
      vm?.schedulable === true &&
      !cooling &&
      !category
    const state = ['paused', 'archived'].includes(resource.status)
      ? resource.status
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
    return {
      ...resource,
      config: {
        ...resource.config,
        auth_method: summary?.has_token
          ? summary.platform === 'openai'
            ? 'oauth'
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
        vm_id: runtimeId || null,
        state,
        plan_type:
          summary?.platform === 'openai'
            ? summary?.plan_type || null
            : summary?.credential_mode === 'apikey'
              ? null
              : usage?.account_tier || summary?.account_tier || null,
        priority: summary?.weight ?? null,
        utilization_5h: readings?.utilization_5h ?? null,
        reset_5h: readings?.reset_5h ?? null,
        utilization_7d: readings?.utilization_7d ?? null,
        reset_7d: readings?.reset_7d ?? null,
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
        inflight: usage?.inflight ?? null,
        max_concurrency: usage?.max_concurrency ?? summary?.max_concurrency ?? null,
        rpm: runtimeId ? (stats?.rpm ?? 0) : null,
        max_rpm: usage?.max_rpm ?? summary?.max_rpm ?? null,
        tpm: runtimeId ? (stats?.tpm ?? 0) : null,
        tpm_with_cache: runtimeId ? (stats?.tpm_with_cache ?? 0) : null,
        window_5h_cost: usage?.window_5h_cost ?? null,
        window_7d_cost: usage?.window_7d_cost ?? null,
        window_5h_requests: usage?.window_5h_requests ?? null,
        window_7d_requests: usage?.window_7d_requests ?? null,
        window_5h_tokens: usage?.window_5h_tokens ?? null,
        window_7d_tokens: usage?.window_7d_tokens ?? null,
        near_limit: [usage?.utilization_5h, usage?.utilization_7d, usage?.utilization_7d_oi].some(
          (v) => v != null && v >= 0.9,
        ),
        failure_category: category,
        cooldown_until: cooling ? new Date(typeof until === 'number' ? until : Date.parse(until)).toISOString() : null,
        email: usage?.email || summary?.email || null,
        collected_at: new Date(now).toISOString(),
      },
    }
  })
}
