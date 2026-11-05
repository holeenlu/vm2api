import { SYSTEM_TIMEZONE } from '../../shared/system-time.mjs'
import { zonedParts, zonedWallToMs, zonedDayStartMs } from '../core/timezone.mjs'
import { VendorError } from './vendor-platform.mjs'
import { pooledVendorRead } from './vendor-read-pool.mjs'
import {
  accountUsageCondition as condition,
  firstUsageRow,
  latestGatewayBinding,
  supplierAccountResources,
  usageAccountRows,
  usageModelRows,
  usageSlotRows,
  usageSummaryRow,
  usageSummaryRowsByVm,
} from './repos/account-usage-repo.mjs'
import { getVendorVmResource } from './repos/resources-repo.mjs'

export function normalizeVendorUsage(row = {}) {
  const number = (key) => Number(row[key] || 0)
  const requests = number('requests'),
    success = number('success'),
    errors = number('errors')
  const input = number('input_tokens'),
    output = number('output_tokens'),
    read = number('cache_read_tokens'),
    write = number('cache_creation_tokens')
  const knownPrompt = number('cache_known_prompt_tokens')
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
    cache_read_known_requests: number('cache_read_known_requests'),
    cache_creation_known_requests: number('cache_creation_known_requests'),
    total_tokens: number('cache_unknown_requests') ? null : input + output + read + write,
    cache_hit_rate: knownPrompt ? number('cache_known_read_tokens') / knownPrompt : null,
    cache_complete: !number('cache_unknown_requests'),
    cost_usd: number('unpriced_requests') ? null : number('cost_usd'),
    unpriced_requests: number('unpriced_requests'),
    fable_cost_usd: number('fable_cost_usd'),
    opus_cost_usd: number('opus_cost_usd'),
    avg_duration_ms: row.avg_duration_ms ?? null,
    avg_ttft_ms: row.avg_ttft_ms ?? null,
  }
}
// authorization_mode：按 Gateway 请求的实际授权方式筛选（native / bps，迁移 094）；历史补录用量没有授权方式，筛选时不计入
const AUTHORIZATION_MODES = new Set(['native', 'bps'])
function authorizationModeOf(query = {}) {
  const mode = query.authorization_mode
  if (mode == null || mode === '' || mode === 'all') return null
  if (!AUTHORIZATION_MODES.has(mode)) throw new VendorError('invalid_authorization_mode', '授权方式筛选无效')
  return mode
}
export function vendorUsageSummary(db, ids, { since = null, until = new Date().toISOString(), mode = null } = {}) {
  const where = condition(ids, since, until, mode)
  return normalizeVendorUsage(usageSummaryRow(db, where))
}
// Per-account summaries in one pass; accounts without requests are absent from the map.
export function vendorUsageSummaries(db, ids, { since = null, until = new Date().toISOString() } = {}) {
  const where = condition(ids, since, until)
  const rows = usageSummaryRowsByVm(db, where)
  return new Map(rows.map((row) => [row.vm_id, normalizeVendorUsage(row)]))
}
export function vendorAccountRuntime(platform, identity, accountId, { write = false } = {}) {
  if (write || !identity.system_admin) platform.requireActive(identity)
  const row = platform.getResource(identity, accountId, { write })
  if (row.resource_type !== 'account') throw new VendorError('resource_not_found', '账号不存在', 404)
  const config = JSON.parse(row.config_json || '{}')
  if (config.execution_kind === 'gateway_worker') {
    const binding = latestGatewayBinding(platform.db, row.id)
    return {
      row,
      config,
      linked: null,
      vmId: null,
      executionKind: 'gateway_worker',
      gatewayInstanceId: binding?.gateway_instance_id || config.gateway_instance_id || null,
      runtimeAccountId: binding?.runtime_account_id || config.runtime_account_id || null,
      accountResourceId: row.id,
    }
  }
  const linked = getVendorVmResource(platform.db, config.vm_resource_id || '', row.vendor_id)
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
  const timezone = SYSTEM_TIMEZONE
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
  const mode = authorizationModeOf(query)
  const since = period.start == null ? null : new Date(period.start).toISOString(),
    until = new Date(period.until).toISOString()
  const where = condition(ids, since, until, mode)
  const summary = vendorUsageSummary(db, ids, { since, until, mode })
  const first = firstUsageRow(db, where)?.at
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
        cache_read_known_requests: 0,
        cache_creation_known_requests: 0,
        cache_known_read_tokens: 0,
        cache_known_prompt_tokens: 0,
        tokens: 0,
        total_tokens: 0,
        cost_usd: 0,
        cache_complete: true,
      })
    }
  }
  const slots = usageSlotRows(db, where)
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
      'cache_read_known_requests',
      'cache_creation_known_requests',
      'cache_known_read_tokens',
      'cache_known_prompt_tokens',
      'total_tokens',
    ])
      target[field] += Number(row[field] || 0)
    if (row.unpriced) target.cost_usd = null
    else if (target.cost_usd != null) target.cost_usd += Number(row.cost_usd || 0)
    if (row.cache_unknown) target.cache_complete = false
    target.tokens = target.input_tokens + target.output_tokens
  }
  const models = usageModelRows(db, where).map((row) => ({ model: row.model, ...normalizeVendorUsage(row) }))
  const account_usage = usageAccountRows(db, where).map((row) => ({
    account_id: row.account_resource_id,
    account_name: row.account_name,
    ...normalizeVendorUsage(row),
  }))
  const fixed_windows = {}
  for (const [key, duration] of [
    ['5h', 5 * 3600000],
    ['7d', 7 * 86400000],
    ['30d', 30 * 86400000],
  ])
    fixed_windows[key] = vendorUsageSummary(db, ids, {
      since: new Date(now - duration).toISOString(),
      until: new Date(now + 1).toISOString(),
      mode,
    })
  return {
    period: { range: period.range, start: since, end: until, timezone: period.timezone },
    authorization_mode: mode || 'all',
    summary,
    trend: [...buckets.values()].map(
      ({ cache_known_read_tokens: knownRead, cache_known_prompt_tokens: knownPrompt, ...row }) => ({
        ...row,
        total_tokens: row.cache_complete ? row.total_tokens : null,
        cache_hit_rate: knownPrompt ? knownRead / knownPrompt : null,
      }),
    ),
    account_usage,
    models,
    fixed_windows,
    collected_at: new Date(now).toISOString(),
    resolution: monthly ? 'month' : 'day',
    source: 'usage_logs',
  }
}
export async function readVendorUsagePooled(db, ids, query = {}, now = Date.now()) {
  periodOf(query, now)
  authorizationModeOf(query)
  return pooledVendorRead(db, 'readVendorUsage', [ids, query, now], () => readVendorUsage(db, ids, query, now))
}
export async function supplierAccountUsage(platform, identity, accountId, query = {}, now = Date.now()) {
  platform.requireCapability(identity, 'vendor.usage.read')
  const account = vendorAccountRuntime(platform, identity, accountId)
  if (!account.vmId && account.executionKind !== 'gateway_worker')
    throw new VendorError('resource_pair_missing', '账号的运行关联缺失，请联系超级管理员', 409)
  const usageId = account.vmId || `gateway:${account.accountResourceId}`
  return {
    account_id: account.row.id,
    name: account.row.name,
    ...(await readVendorUsagePooled(platform.db, [usageId], query, now)),
  }
}
export async function supplierUsage(platform, identity, { query = {} } = {}) {
  platform.requireCapability(identity, 'vendor.usage.read')
  const ids = platform.resourceScope(identity, query.vendor_id || '')
  let rows = supplierAccountResources(platform.db, ids)
  if (query.account_id) {
    if (!rows.some((r) => r.id === query.account_id))
      throw new VendorError('vendor_scope_forbidden', '账号不属于当前供应商范围', 403)
    rows = rows.filter((r) => r.id === query.account_id)
  }
  const result = await readVendorUsagePooled(
    platform.db,
    [
      ...rows.map((r) => {
        const config = JSON.parse(r.config_json || '{}')
        return config.execution_kind === 'gateway_worker'
          ? `gateway:${r.id}`
          : JSON.parse(r.vm_config_json || '{}').runtime_vm_id
      }),
      ...(query.account_id ? [] : ids.map((id) => 'vendor-history:' + id)),
    ],
    query,
    Date.now(),
  )
  return { ...result, accounts: rows.map((r) => ({ id: r.id, name: r.name, vendor_id: r.vendor_id })) }
}
