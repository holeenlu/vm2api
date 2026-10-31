import { ERROR_PRED, SUCCESS_PRED, PROMPT_TOKENS_SQL, TOTAL_TOKENS_SQL } from '../db/repos/usage-log-preds.mjs'
import { zonedParts, zonedWallToMs, zonedDayStartMs } from '../core/timezone.mjs'
import { VendorError } from './vendor-platform.mjs'

// Retained supplier facts cover periods whose detailed request logs have expired.
// Prefer the detailed row when present so a request is never counted twice.
export const VENDOR_ACCOUNT_LOGS = `
  SELECT u.rowid AS watermark,u.id,COALESCE(NULLIF(u.request_id,''),u.id) AS request_id,u.vm_id,u.group_id,u.created_at,
    CASE WHEN f.id IS NULL THEN u.status ELSE 200 END AS status,CASE WHEN f.id IS NULL THEN u.error_code ELSE NULL END AS error_code,u.model,u.upstream_model,CASE WHEN f.id IS NULL THEN u.pricing_model ELSE NULL END AS pricing_model,COALESCE(f.cost_usd,u.total_cost) AS total_cost,u.input_tokens,u.output_tokens,
    u.cache_read_tokens,u.cache_creation_tokens,u.duration_ms,u.first_token_ms,a.vendor_id,a.id AS account_resource_id
  FROM usage_logs u LEFT JOIN vendor_resources v ON v.resource_type='vm' AND json_extract(v.config_json,'$.runtime_vm_id')=u.vm_id
  LEFT JOIN vendor_resources a ON a.resource_type='account' AND a.vendor_id=v.vendor_id AND json_extract(a.config_json,'$.vm_resource_id')=v.id
  LEFT JOIN vendor_usage_facts f ON f.source_request_id=u.request_id
  UNION ALL
  SELECT f.rowid AS watermark,f.id,COALESCE(NULLIF(f.source_request_id,''),f.id),COALESCE(json_extract(v.config_json,'$.runtime_vm_id'),'vendor-history:'||f.vendor_id),NULL,f.occurred_at,
    200,NULL,f.model,NULL,NULL,f.cost_usd,f.input_tokens,f.output_tokens,NULL,NULL,NULL,NULL,f.vendor_id,a.id
  FROM vendor_usage_facts f LEFT JOIN vendor_resources a ON a.id=f.resource_id AND a.vendor_id=f.vendor_id AND a.resource_type='account'
  LEFT JOIN vendor_resources v ON v.id=json_extract(a.config_json,'$.vm_resource_id') AND v.vendor_id=a.vendor_id AND v.resource_type='vm'
  WHERE NOT EXISTS(SELECT 1 FROM usage_logs u WHERE u.request_id=f.source_request_id)
`

export const VENDOR_USAGE_SELECT = `COUNT(*) AS requests,
  COALESCE(SUM(CASE WHEN ${SUCCESS_PRED} THEN 1 ELSE 0 END),0) AS success,
  COALESCE(SUM(CASE WHEN ${ERROR_PRED} THEN 1 ELSE 0 END),0) AS errors,
  COALESCE(SUM(input_tokens),0) AS input_tokens, COALESCE(SUM(output_tokens),0) AS output_tokens,
  COALESCE(SUM(cache_read_tokens),0) AS cache_read_tokens, COALESCE(SUM(cache_creation_tokens),0) AS cache_creation_tokens,
  COALESCE(SUM(${PROMPT_TOKENS_SQL}),0) AS prompt_tokens, COALESCE(SUM(${TOTAL_TOKENS_SQL}),0) AS total_tokens,
  COALESCE(SUM(CASE WHEN status>=200 AND status<300 THEN total_cost ELSE 0 END),0) AS cost_usd,
  COALESCE(SUM(CASE WHEN status>=200 AND status<300 AND (total_cost IS NULL OR pricing_model='unpriced') THEN 1 ELSE 0 END),0) AS unpriced_requests,
  COALESCE(SUM(CASE WHEN status>=200 AND status<300 AND LOWER(COALESCE(NULLIF(upstream_model,''),NULLIF(pricing_model,''),model,'')) LIKE '%fable%' THEN total_cost ELSE 0 END),0) AS fable_cost_usd,
  COALESCE(SUM(CASE WHEN status>=200 AND status<300 AND LOWER(COALESCE(NULLIF(upstream_model,''),NULLIF(pricing_model,''),model,'')) LIKE '%opus%' THEN total_cost ELSE 0 END),0) AS opus_cost_usd,
  SUM(CASE WHEN cache_read_tokens IS NULL OR cache_creation_tokens IS NULL THEN 1 ELSE 0 END) AS cache_unknown_requests,
  AVG(duration_ms) AS avg_duration_ms, AVG(first_token_ms) AS avg_ttft_ms`

export function normalizeVendorUsage(row = {}) {
  const number = (key) => Number(row[key] || 0)
  const requests = number('requests'),
    success = number('success'),
    errors = number('errors')
  const input = number('input_tokens'),
    output = number('output_tokens'),
    read = number('cache_read_tokens'),
    write = number('cache_creation_tokens')
  const prompt = number('prompt_tokens')
  return {
    requests,
    success,
    errors,
    success_rate: requests ? success / requests : null,
    input_tokens: input,
    output_tokens: output,
    tokens: input + output,
    cache_read_tokens: read,
    cache_creation_tokens: write,
    total_tokens: number('cache_unknown_requests') ? null : input + output + read + write,
    cache_hit_rate: prompt && !number('cache_unknown_requests') ? read / prompt : null,
    cache_complete: !number('cache_unknown_requests'),
    cost_usd: number('unpriced_requests') ? null : number('cost_usd'),
    unpriced_requests: number('unpriced_requests'),
    fable_cost_usd: number('fable_cost_usd'),
    opus_cost_usd: number('opus_cost_usd'),
    avg_duration_ms: row.avg_duration_ms ?? null,
    avg_ttft_ms: row.avg_ttft_ms ?? null,
  }
}
function condition(ids, since, until) {
  const keys = [...new Set(ids.filter(Boolean))]
  return {
    sql: `vm_id IN (${keys.length ? keys.map(() => '?').join(',') : 'NULL'}) AND created_at<?${since ? ' AND created_at>=?' : ''}`,
    params: [...keys, until, ...(since ? [since] : [])],
  }
}
export function vendorUsageSummary(db, ids, { since = null, until = new Date().toISOString() } = {}) {
  const where = condition(ids, since, until)
  return normalizeVendorUsage(
    db
      .prepare(`SELECT ${VENDOR_USAGE_SELECT} FROM (${VENDOR_ACCOUNT_LOGS}) usage_logs WHERE ${where.sql}`)
      .get(...where.params),
  )
}
export function vendorAccountRuntime(platform, identity, accountId, { write = false } = {}) {
  if (write || !identity.system_admin) platform.requireActive(identity)
  const row = platform.getResource(identity, accountId, { write })
  if (row.resource_type !== 'account') throw new VendorError('resource_not_found', '账号不存在', 404)
  const config = JSON.parse(row.config_json || '{}')
  const linked = platform.db
    .prepare("SELECT * FROM vendor_resources WHERE id=? AND vendor_id=? AND resource_type='vm'")
    .get(config.vm_resource_id || '', row.vendor_id)
  return { row, config, linked, vmId: linked ? JSON.parse(linked.config_json || '{}').runtime_vm_id : null }
}
function dateStart(date, timezone, offset = 0) {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(String(date)) ||
    !Number.isFinite(Date.parse(date)) ||
    new Date(date).toISOString().slice(0, 10) !== date
  )
    throw new VendorError('invalid_usage_period', '日期范围无效')
  const [year, month, day] = date.split('-').map(Number)
  return zonedWallToMs({ year, month, day: day + offset }, timezone)
}
function periodOf(query, now) {
  const timezone = String(query.timezone || 'Asia/Shanghai')
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone }).format()
  } catch {
    throw new VendorError('invalid_usage_timezone', '时区无效')
  }
  const range = query.range || (query.start_date || query.end_date ? 'custom' : 'all')
  if (!['all', 'today', '7days', '30days', 'custom'].includes(range))
    throw new VendorError('invalid_usage_range', '用量范围无效')
  let start = null,
    end = now + 1
  if (range === 'custom') {
    start = dateStart(query.start_date, timezone)
    end = dateStart(query.end_date, timezone, 1)
  } else if (range !== 'all')
    start = zonedDayStartMs(now, timezone, range === 'today' ? 0 : range === '7days' ? -6 : -29)
  if (start != null && (start >= end || end - start > 3660 * 86400000))
    throw new VendorError('invalid_usage_period', '结束日期不能早于开始日期，自定义范围最长十年')
  return { range, timezone, start, until: Math.min(end, now + 1) }
}
const dateKey = (ms, tz, monthly = false) => {
  const p = zonedParts(ms, tz)
  return `${p.year}-${String(p.month).padStart(2, '0')}${monthly ? '' : '-' + String(p.day).padStart(2, '0')}`
}

// Mirrors the panel statistics reader: aggregate UTC quarter-hours, then bucket by local date.
// Supplier projections never include consumer users, API keys, prompts, or request bodies.
export function readVendorUsage(db, ids, query = {}, now = Date.now()) {
  const period = periodOf(query, now)
  const since = period.start == null ? null : new Date(period.start).toISOString(),
    until = new Date(period.until).toISOString()
  const where = condition(ids, since, until)
  const summary = vendorUsageSummary(db, ids, { since, until })
  const first = db
    .prepare(`SELECT MIN(created_at) at FROM (${VENDOR_ACCOUNT_LOGS}) usage_logs WHERE ${where.sql}`)
    .get(...where.params)?.at
  const start = period.start ?? (first ? zonedDayStartMs(Date.parse(first), period.timezone) : period.until)
  const monthly = period.until - start > 366 * 86400000
  const buckets = new Map()
  if (first) {
    const parts = zonedParts(start, period.timezone)
    for (let i = 0; i < 3700; i++) {
      const at = monthly
        ? zonedWallToMs({ year: parts.year, month: parts.month + i, day: 1 }, period.timezone)
        : zonedDayStartMs(start, period.timezone, i)
      if (at >= period.until) break
      const date = dateKey(at, period.timezone, monthly)
      buckets.set(date, {
        date,
        requests: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        tokens: 0,
        total_tokens: 0,
        cost_usd: 0,
        cache_complete: true,
      })
    }
  }
  const slots = db
    .prepare(`SELECT substr(created_at,1,14)||printf('%02d',(CAST(substr(created_at,15,2) AS INTEGER)/15)*15) slot,
    COUNT(*) requests,COALESCE(SUM(input_tokens),0) input_tokens,COALESCE(SUM(output_tokens),0) output_tokens,
    COALESCE(SUM(cache_read_tokens),0) cache_read_tokens,COALESCE(SUM(cache_creation_tokens),0) cache_creation_tokens,
    COALESCE(SUM(${TOTAL_TOKENS_SQL}),0) total_tokens,COALESCE(SUM(CASE WHEN status>=200 AND status<300 THEN total_cost ELSE 0 END),0) cost_usd,
    SUM(CASE WHEN status>=200 AND status<300 AND (total_cost IS NULL OR pricing_model='unpriced') THEN 1 ELSE 0 END) unpriced,
    SUM(CASE WHEN cache_read_tokens IS NULL OR cache_creation_tokens IS NULL THEN 1 ELSE 0 END) cache_unknown
    FROM (${VENDOR_ACCOUNT_LOGS}) usage_logs WHERE ${where.sql} GROUP BY slot ORDER BY slot`)
    .all(...where.params)
  for (const row of slots) {
    const date = dateKey(Date.parse(row.slot + ':00.000Z'), period.timezone, monthly)
    const target = buckets.get(date)
    if (!target) continue
    for (const field of [
      'requests',
      'input_tokens',
      'output_tokens',
      'cache_read_tokens',
      'cache_creation_tokens',
      'total_tokens',
    ])
      target[field] += Number(row[field] || 0)
    if (row.unpriced) target.cost_usd = null
    else if (target.cost_usd != null) target.cost_usd += Number(row.cost_usd || 0)
    if (row.cache_unknown) target.cache_complete = false
    target.tokens = target.input_tokens + target.output_tokens
  }
  const models = db
    .prepare(`SELECT COALESCE(NULLIF(upstream_model,''),NULLIF(model,''),'unknown') model,${VENDOR_USAGE_SELECT}
    FROM (${VENDOR_ACCOUNT_LOGS}) usage_logs WHERE ${where.sql} GROUP BY 1 ORDER BY requests DESC,model`)
    .all(...where.params)
    .map((row) => ({ model: row.model, ...normalizeVendorUsage(row) }))
  const fixed_windows = {}
  for (const [key, duration] of [
    ['5h', 5 * 3600000],
    ['7d', 7 * 86400000],
    ['30d', 30 * 86400000],
  ])
    fixed_windows[key] = vendorUsageSummary(db, ids, {
      since: new Date(now - duration).toISOString(),
      until: new Date(now + 1).toISOString(),
    })
  return {
    period: { range: period.range, start: since, end: until, timezone: period.timezone },
    summary,
    trend: [...buckets.values()].map((row) => ({ ...row, total_tokens: row.cache_complete ? row.total_tokens : null })),
    models,
    fixed_windows,
    collected_at: new Date(now).toISOString(),
    resolution: monthly ? 'month' : 'day',
    source: 'usage_logs',
  }
}
export function supplierAccountUsage(platform, identity, accountId, query = {}, now = Date.now()) {
  platform.requireCapability(identity, 'vendor.usage.read')
  const account = vendorAccountRuntime(platform, identity, accountId)
  if (!account.vmId) throw new VendorError('resource_pair_missing', '账号的虚拟机关联缺失，请联系超级管理员', 409)
  return {
    account_id: account.row.id,
    name: account.row.name,
    ...readVendorUsage(platform.db, [account.vmId], query, now),
  }
}
export function supplierUsage(platform, identity, { query = {} } = {}) {
  platform.requireCapability(identity, 'vendor.usage.read')
  const ids = platform.resourceScope(identity, query.vendor_id || '')
  let rows = platform.db
    .prepare(`SELECT a.id,a.name,a.vendor_id,v.config_json FROM vendor_resources a JOIN vendor_resources v
    ON v.id=json_extract(a.config_json,'$.vm_resource_id') AND v.vendor_id=a.vendor_id AND v.resource_type='vm'
    WHERE a.resource_type='account' AND a.vendor_id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids)
  if (query.account_id) {
    if (!rows.some((r) => r.id === query.account_id))
      throw new VendorError('vendor_scope_forbidden', '账号不属于当前供应商范围', 403)
    rows = rows.filter((r) => r.id === query.account_id)
  }
  const result = readVendorUsage(
    platform.db,
    [
      ...rows.map((r) => JSON.parse(r.config_json).runtime_vm_id),
      ...(query.account_id ? [] : ids.map((id) => 'vendor-history:' + id)),
    ],
    query,
  )
  return { ...result, accounts: rows.map((r) => ({ id: r.id, name: r.name, vendor_id: r.vendor_id })) }
}
