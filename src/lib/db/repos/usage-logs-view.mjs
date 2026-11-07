import { SYSTEM_TIMEZONE } from '../../../shared/system-time.mjs'
/**
 * Keyset-paginated camelCase view over `usage_logs` for the scrolling log page
 * and its side panels (`GET /api/panel/usage-logs*`).
 *
 * Kept apart from `usage-logs-repo.mjs`: that module serves the
 * snake_case `/request-logs` surface (keyset too since M5). Lists never run
 * COUNT(*) — the table grows without bound; only export counts its filtered
 * rows, and summary / ranking / overview read the hourly rollup when they can.
 *
 * Shape: `web/src/types/panel-usage-logs.ts`.
 */

import { getDb } from '../database.mjs'
import { dbClient } from '../db-client.mjs'
import { OUTBOUND_MODEL_VIAS, responseModelForLog } from '../../protocol/log-fields.mjs'
import { platformOfModel } from '../../admin/price-catalog.mjs'
import { DEFAULT_MUTED_ERROR_CLASSES, enrichLogRow, excludeErrorClassSql } from '../../admin/error-class.mjs'
import { zonedDayStartMs } from '../../core/timezone.mjs'
import {
  ADMIN_DOMAIN_IDS_SQL,
  ERROR_PRED,
  PROMPT_TOKENS_SQL,
  SUCCESS_PRED,
  TOTAL_TOKENS_SQL,
  ownerPred,
  totalTokens as rowTotalTokens,
} from './usage-log-preds.mjs'
import { rollupLogRankingRows, rollupLogSummaryRow, rollupSource } from './usage-log-rollup.mjs'
import { fromMicros, rowMicros } from '../../core/money.mjs'
import { microsSumSql, moneySql } from './money-sql.mjs'

const LIST_LIMIT_DEFAULT = 50
const LIST_LIMIT_MAX = 100
/** Rows read per round trip when classes must be filtered in JS. */
const SCAN_CHUNK = 500
/** Rows one list call may read before handing the cursor back to the client. */
const SCAN_CAP = 2000
/** Most recent rows a JS-classified summary aggregates. */
const SUMMARY_SCAN_CAP = 5000
/** Recent rows mined for distinct filter values / empty-prefix session suggestions. */
const RECENT_SCAN = 5000
const OPTION_LIMIT = 200
const EXPORT_LIMIT_DEFAULT = 2000
const EXPORT_LIMIT_MAX = 5000
/** Newest rows an export reads when classes must be filtered in JS. */
const EXPORT_SCAN_CAP = 10000
const DEFAULT_VIA = 'go-worker-pool'

const BLOCKED_STATES = {
  distill_blocked: 'distill',
  refusal_guard: 'refusal_guard',
  refusal_similar: 'refusal_guard',
  refusal_device: 'refusal_guard',
  policy_blocked: 'policy',
}

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function nullableNum(v) {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function clampInt(v, min, max, fallback) {
  const n = Math.trunc(Number(v))
  if (v == null || v === '' || !Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function isoOrNull(v) {
  if (v == null || v === '') return null
  const ms = Date.parse(String(v))
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

function uniq(values) {
  return [...new Set(values.filter((v) => v != null && v !== ''))]
}

function placeholders(list) {
  return list.map(() => '?').join(', ')
}

/**
 * Batched display names for one page / one aggregate. One IN query per entity
 * kind so a page of 100 rows costs at most four lookups.
 */
/** 运行账号 ID → Gateway 账号名称；Worker 尚未加载的账号按 `gwacct_<账号资源 ID>` 约定回落。 */
async function gatewayAccountNames(db, ids) {
  const names = new Map()
  const list = uniq(ids)
  if (!list.length) return names
  for (const row of await dbClient(db).many(
    `SELECT b.runtime_account_id AS id, r.name FROM gateway_worker_account_bindings b
      JOIN vendor_resources r ON r.id=b.account_resource_id WHERE b.runtime_account_id IN (${placeholders(list)})`,
    ...list,
  ))
    names.set(row.id, row.name)
  const pending = list.filter((id) => !names.has(id) && id.startsWith(GATEWAY_RUNTIME_PREFIX))
  if (pending.length)
    for (const row of await dbClient(db).many(
      `SELECT id, name FROM vendor_resources WHERE resource_type='account' AND id IN (${placeholders(pending)})`,
      ...pending.map((id) => id.slice(GATEWAY_RUNTIME_PREFIX.length)),
    ))
      names.set(GATEWAY_RUNTIME_PREFIX + row.id, row.name)
  return names
}

const GATEWAY_RUNTIME_PREFIX = 'gwacct_'
const GATEWAY_VM_PREFIX = 'gateway:'

/**
 * Gateway Worker 请求没有 VM，`vm_id` 记为 `gateway:<账号资源 ID>`；按账号资源补上账号名称，
 * 否则没有决策链的行（搜索、图片）会把原始 ID 当作供应商名展示。
 */
async function gatewayVmNames(db, vms, vmIds) {
  const pending = uniq(vmIds).filter((id) => !vms.has(id) && String(id).startsWith(GATEWAY_VM_PREFIX))
  if (!pending.length) return vms
  for (const row of await dbClient(db).many(
    `SELECT id, name FROM vendor_resources WHERE resource_type='account' AND id IN (${placeholders(pending)})`,
    ...pending.map((id) => id.slice(GATEWAY_VM_PREFIX.length)),
  ))
    vms.set(GATEWAY_VM_PREFIX + row.id, row.name || row.id)
  return vms
}
const API_KEY_PREFIX = 'ek_'

/** 上游 API 子 Key（`ek_…`）→ 所属上游 API 的名称与协议；`ids` 为空时取全部。 */
async function apiEndpointKeys(db, ids = null) {
  if (ids && !ids.length) return []
  return dbClient(db).many(
    `SELECT k.id, k.endpoint_id, e.name, e.protocol FROM api_endpoint_keys k JOIN api_endpoints e ON e.id = k.endpoint_id
      ${ids ? `WHERE k.id IN (${placeholders(ids)})` : ''}`,
    ...(ids || []),
  )
}

/** 账号/接口/模型的平台口径统一为 `anthropic` | `openai`。 */
export function normalizeUsagePlatform(value) {
  const v = String(value || '').toLowerCase()
  if (v === 'claude' || v.startsWith('anthropic')) return 'anthropic'
  if (v === 'codex' || v === 'gpt' || v.startsWith('openai')) return 'openai'
  return null
}

/** 控制面从已解密槽位注册表算出的「槽位 → 平台」；读库 worker 解不开 `vm_json`，由调用方传入。 */
function vmPlatformMap(vmPlatforms) {
  const out = new Map()
  for (const [id, platform] of Object.entries(vmPlatforms || {})) {
    const p = normalizeUsagePlatform(platform)
    if (p) out.set(id, p)
  }
  return out
}

/**
 * 已知上游账号 → 平台：槽位账号按槽位平台（账号表的 `platform` 对 Codex 槽位不可靠），
 * 其余账号表行按 `platform`；上游 API Key 按接口协议；Gateway Worker 运行账号固定 OpenAI。
 * 含已删除账号，历史日志仍按原平台归类。槽位 ID 本身也作为账号 ID（槽位直连行）。
 */
async function accountPlatforms(db, vmPlatforms = {}) {
  const out = new Map()
  const vms = vmPlatformMap(vmPlatforms)
  for (const [id, platform] of vms) out.set(id, platform)
  for (const r of await dbClient(db).many('SELECT id, vm_id, platform FROM accounts')) {
    const platform = (r.vm_id && vms.get(r.vm_id)) || vms.get(r.id) || normalizeUsagePlatform(r.platform)
    if (platform) out.set(r.id, platform)
  }
  for (const r of await dbClient(db).many(
    'SELECT DISTINCT runtime_account_id AS id FROM gateway_worker_account_bindings',
  ))
    out.set(r.id, 'openai')
  for (const r of await apiEndpointKeys(db)) {
    const platform = normalizeUsagePlatform(r.protocol)
    if (platform) out.set(r.id, platform)
  }
  return out
}

function platformOfAccount(known, id) {
  return known.get(id) || (String(id || '').startsWith(GATEWAY_RUNTIME_PREFIX) ? 'openai' : null)
}

const MODEL_PLATFORM_FN = 'usage_model_platform'
const modelPlatformDbs = new WeakSet()

/** 行内模型 → 平台的 SQL 函数，口径同价格目录 `platformOfModel`。 */
function registerModelPlatform(db) {
  if (modelPlatformDbs.has(db) || typeof db.function !== 'function') return
  db.function(MODEL_PLATFORM_FN, { deterministic: true }, (model) => platformOfModel(model))
  modelPlatformDbs.add(db)
}

/**
 * 一行的平台：命中已知上游账号时按账号平台；未路由或账号未登记（如槽位 ID）时按模型，
 * 模型也无法识别再按入站协议族。
 */
async function platformPredicate(db, platform, vmPlatforms) {
  const known = await accountPlatforms(db, vmPlatforms)
  const ids = { anthropic: [], openai: [] }
  for (const [id, p] of known) ids[p].push(id)
  const acct = "COALESCE(NULLIF(final_account_id, ''), NULLIF(account_id, ''))"
  return {
    sql: `(CASE WHEN ${acct} IN (${placeholders(ids.anthropic)}) THEN 'anthropic'
      WHEN ${acct} IN (${placeholders(ids.openai)}) OR substr(${acct}, 1, ${GATEWAY_RUNTIME_PREFIX.length}) = '${GATEWAY_RUNTIME_PREFIX}' THEN 'openai'
      ELSE COALESCE(${MODEL_PLATFORM_FN}(COALESCE(NULLIF(model, ''), requested_model)),
        CASE WHEN protocol LIKE 'anthropic.%' THEN 'anthropic' WHEN protocol LIKE 'openai.%' THEN 'openai' END) END) = ?`,
    params: [...ids.anthropic, ...ids.openai, platform],
  }
}

/** 分组平台：anthropic / openai / mixed（历史值 claude 归 anthropic）。 */
function normalizeGroupPlatform(value) {
  const v = String(value || '').toLowerCase()
  if (v === 'mixed') return 'mixed'
  return normalizeUsagePlatform(v)
}

/** 分组模型白名单；空数组表示不限（按分组平台）。 */
function groupModels(json) {
  try {
    const list = JSON.parse(json || '[]')
    return Array.isArray(list) ? uniq(list.map((m) => String(m || '').trim())) : []
  } catch {
    return []
  }
}

/**
 * 分组 → 资源：槽位（vm）、上游 API（其下全部子 Key）、Gateway 账号（其运行账号）。
 * 上游账号按所在槽位、所属上游 API 或绑定的 Gateway 账号资源归属分组。
 */
async function groupMembership(db) {
  const byKind = { vm: new Map(), api_endpoint: new Map(), gateway_worker_account: new Map() }
  for (const r of await dbClient(db).many('SELECT group_id, resource_kind, resource_id FROM group_resources')) {
    const map = byKind[r.resource_kind]
    if (!map) continue
    const list = map.get(r.resource_id) || []
    list.push(String(r.group_id))
    map.set(r.resource_id, list)
  }
  const accountVm = new Map((await dbClient(db).many('SELECT id, vm_id FROM accounts')).map((r) => [r.id, r.vm_id]))
  const keyEndpoint = new Map((await apiEndpointKeys(db)).map((r) => [r.id, r.endpoint_id]))
  const runtimeResource = new Map(
    (
      await dbClient(db).many(
        'SELECT runtime_account_id AS id, account_resource_id AS res FROM gateway_worker_account_bindings',
      )
    ).map((r) => [r.id, r.res]),
  )
  const ofVm = (id) => uniq(byKind.vm.get(id) || [])
  const ofAccount = (id) => {
    if (keyEndpoint.has(id)) return uniq(byKind.api_endpoint.get(keyEndpoint.get(id)) || [])
    const resource =
      runtimeResource.get(id) ||
      (id.startsWith(GATEWAY_RUNTIME_PREFIX) ? id.slice(GATEWAY_RUNTIME_PREFIX.length) : null)
    if (resource && byKind.gateway_worker_account.has(resource))
      return uniq(byKind.gateway_worker_account.get(resource))
    return ofVm(accountVm.get(id) || id)
  }
  return { ofVm, ofAccount }
}

export async function lookupNames(
  db,
  { userIds = [], keyIds = [], vmIds = [], accountIds = [], accountVmIds = [] } = {},
) {
  const pick = async (sql, ids, nameOf) => {
    const list = uniq(ids)
    const map = new Map()
    if (!list.length) return map
    for (const r of await dbClient(db).many(sql.replace('$IN', placeholders(list)), ...list)) map.set(r.id, nameOf(r))
    return map
  }
  const accountIdList = uniq(accountIds)
  const accountVmIdList = uniq(accountVmIds)
  const accounts = new Map()
  const accountsByVm = new Map()
  if (accountIdList.length || accountVmIdList.length) {
    const clauses = []
    const params = []
    if (accountIdList.length) {
      clauses.push(`id IN (${placeholders(accountIdList)})`)
      params.push(...accountIdList)
    }
    if (accountVmIdList.length) {
      clauses.push(`vm_id IN (${placeholders(accountVmIdList)})`)
      params.push(...accountVmIdList)
    }
    for (const row of await dbClient(db).many(
      `SELECT id, vm_id, email, name FROM accounts WHERE ${clauses.join(' OR ')}`,
      ...params,
    )) {
      const name = row.email || row.name || row.id
      accounts.set(row.id, name)
      if (row.vm_id) accountsByVm.set(row.vm_id, { id: row.id, name })
    }
  }
  // Gateway Worker 日志记的是运行账号 ID（gwacct_…），对外统一显示创建账号时的账号名称
  for (const [id, name] of await gatewayAccountNames(
    db,
    accountIdList.filter((id) => !accounts.has(id)),
  ))
    accounts.set(id, name)
  // 上游 API 日志记的是子 Key ID（ek_…），对外显示所属上游 API 名称
  for (const row of await apiEndpointKeys(
    db,
    accountIdList.filter((id) => !accounts.has(id) && id.startsWith(API_KEY_PREFIX)),
  ))
    accounts.set(row.id, row.name || row.id)
  return {
    users: await pick(
      'SELECT id, username, email FROM users WHERE id IN ($IN)',
      userIds,
      (r) => r.username || r.email || r.id,
    ),
    keys: await pick('SELECT id, name FROM api_keys WHERE id IN ($IN)', keyIds, (r) => r.name || r.id),
    vms: await gatewayVmNames(
      db,
      await pick('SELECT id, name FROM vms WHERE id IN ($IN)', vmIds, (r) => r.name || r.id),
      vmIds,
    ),
    accounts,
    accountsByVm,
  }
}

function cacheTtlApplied(row) {
  const short = num(row.cache_creation_5m_tokens)
  const long = num(row.cache_creation_1h_tokens)
  if (short > 0 && long > 0) return 'mixed'
  if (long > 0) return '1h'
  if (short > 0) return '5m'
  return null
}

function costBreakdown(row) {
  if (
    [row.input_cost, row.output_cost, row.cache_read_cost, row.cache_creation_cost, row.total_cost].every(
      (v) => v == null,
    )
  )
    return null
  return {
    input: nullableNum(row.input_cost),
    output: nullableNum(row.output_cost),
    cacheRead: nullableNum(row.cache_read_cost),
    cacheCreation: nullableNum(row.cache_creation_cost),
    baseTotal: nullableNum(row.total_cost),
    groupMultiplier: nullableNum(row.rate_multiplier),
    pricingModel: row.pricing_model ?? null,
    // 成本列按上游原始消耗计价；主 token 列是客户计费口径（119），单价按这里的 token 算
    tokens: {
      input: num(row.upstream_input_tokens ?? row.input_tokens),
      output: num(row.output_tokens),
      cacheRead: num(row.upstream_cache_read_tokens ?? row.cache_read_tokens),
      cacheCreation: nullableNum(row.upstream_cache_creation_tokens ?? row.cache_creation_tokens),
      cacheCreation5m: nullableNum(row.upstream_cache_creation_5m_tokens ?? row.cache_creation_5m_tokens),
      cacheCreation1h: nullableNum(row.upstream_cache_creation_1h_tokens ?? row.cache_creation_1h_tokens),
    },
  }
}

/** Switches that changed how this request was served. Fixed order; the UI does not sort. */
function specialSettings(row) {
  const out = []
  if (row.stream) out.push({ key: 'stream', label: '流式' })
  if (row.has_tools) out.push({ key: 'tools', label: '工具调用' })
  if (row.log_mode === 'debug') out.push({ key: 'debug', label: '调试采样' })
  if (row.model_mismatch === 1 && responseModelForLog(row))
    out.push({ key: 'mismatch', label: '模型重定向', value: `${row.requested_model} → ${responseModelForLog(row)}` })
  if (row.speed === 'fast') out.push({ key: 'fast', label: 'Fast 模式', value: row.speed })
  if (row.service_tier === 'priority') out.push({ key: 'priority', label: 'Priority', value: row.service_tier })
  // Sent priority, upstream echoed another tier: Codex did not serve it as Fast (#777).
  if (
    (row.service_tier === 'priority' || row.service_tier === 'fast') &&
    row.upstream_service_tier &&
    row.upstream_service_tier !== 'priority' &&
    row.upstream_service_tier !== 'fast'
  )
    out.push({
      key: 'tier_downgrade',
      label: 'Fast 未生效',
      value: `${row.service_tier} → ${row.upstream_service_tier}`,
    })
  if (row.long_context === 1) out.push({ key: 'context1m', label: '1M 上下文' })
  if (row.via && row.via !== DEFAULT_VIA) out.push({ key: 'via', label: '路由', value: row.via })
  return out
}

function blockedBy(row) {
  if (BLOCKED_STATES[row.final_state]) return BLOCKED_STATES[row.final_state]
  if (row.error_class === 'distill') return 'distill'
  return null
}

/** Raw `usage_logs` row (already `enrichLogRow`-ed) + batched names → `UsageLogRow`. */
function parseUpstreamError(raw) {
  if (!raw) return null
  try {
    const value = JSON.parse(raw)
    return value && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

export function toUsageLogRow(row, names, chain = []) {
  const final = finalChainItem(chain)
  const fromVm = row.vm_id ? names.accountsByVm?.get(row.vm_id) : null
  const accountId = row.final_account_id || row.account_id || final?.accountId || fromVm?.id || null
  const providerName = accountId
    ? names.accounts.get(accountId) || final?.providerName || fromVm?.name || accountId
    : final?.providerName || fromVm?.name || null
  const inputTokens = num(row.input_tokens)
  const outputTokens = num(row.output_tokens)
  const cacheCreation = nullableNum(row.cache_creation_tokens)
  const cacheRead = num(row.cache_read_tokens)
  const blocked = blockedBy(row)
  return {
    billingStatus: row.billing_status || 'unmetered',
    groupId: row.billing_group_id ?? row.group_id ?? null,
    id: row.id,
    requestId: row.request_id ?? null,
    createdAt: row.created_at,
    userId: row.user_id ?? null,
    userName: row.user_id ? (names.users.get(row.user_id) ?? null) : null,
    keyId: row.api_key_id ?? null,
    keyName: row.api_key_name || (row.api_key_id ? (names.keys.get(row.api_key_id) ?? null) : null),
    sessionId: row.outbound_session_id ?? null,
    /** What the caller sent; differs from sessionId whenever the gateway rebuilt it. */
    clientSessionId: row.session_id ?? null,
    providerName,
    accountId,
    vmId: row.vm_id ?? null,
    vmName: row.vm_id ? (names.vms.get(row.vm_id) ?? row.vm_id) : null,
    model: row.model ?? null,
    originalModel: row.requested_model ?? null,
    actualResponseModel: responseModelForLog(row),
    modelMismatch: !responseModelForLog(row) || row.model_mismatch == null ? null : Number(row.model_mismatch),
    endpoint: row.path ?? null,
    /** 端点与传输方式（099）：入站 http / websocket；上游路径与传输由执行路径写入，未发往上游为 null。仅超级管理员可见上游部分。 */
    inboundTransport: row.inbound_transport ?? null,
    upstreamEndpoint: row.upstream_path ?? null,
    upstreamTransport: row.upstream_transport ?? null,
    protocol: row.protocol ?? null,
    method: row.method ?? null,
    statusCode: nullableNum(row.status),
    logMode: row.log_mode === 'debug' || row.log_mode === 'normal' ? row.log_mode : null,
    inputTokens,
    outputTokens,
    cacheCreationInputTokens: cacheCreation,
    cacheReadInputTokens: cacheRead,
    cacheCreation5mInputTokens: num(row.cache_creation_5m_tokens),
    cacheCreation1hInputTokens: num(row.cache_creation_1h_tokens),
    cacheTtlApplied: cacheTtlApplied(row),
    totalTokens: rowTotalTokens(row),
    costUsd: nullableNum(row.total_cost),
    actualCostUsd: nullableNum(row.actual_cost),
    groupCostMultiplier: nullableNum(row.rate_multiplier),
    costBreakdown: costBreakdown(row),
    durationMs: nullableNum(row.duration_ms),
    ttftMs: nullableNum(row.first_token_ms),
    firstByteMs: nullableNum(row.first_byte_ms),
    generationMs: nullableNum(row.generation_ms),
    stopReason: row.stop_reason ?? null,
    attemptCount: nullableNum(row.attempt_count),
    finalState: row.final_state ?? null,
    via: row.via ?? null,
    stream: row.stream == null ? null : !!row.stream,
    hasTools: row.has_tools == null ? null : !!row.has_tools,
    serviceTier: row.service_tier ?? null,
    /** `response.service_tier` the upstream echoed; billing uses serviceTier (the sent tier). */
    upstreamServiceTier: row.upstream_service_tier ?? null,
    /** Gateway 请求诊断（092）：网关错误分类、上游错误对象投影、WS 关闭码、续接与连接退出原因、重试等待。仅超级管理员可见。 */
    errorKind: row.error_kind ?? null,
    /** Gateway 请求的授权方式（094，历史记录）：2026-11-07 起不再写入；此前的行为 native 或 bps（已下线的 BPS 通道），只读展示。 */
    authorizationMode: row.authorization_mode ?? null,
    upstreamError: parseUpstreamError(row.upstream_error_json),
    websocketCloseCode: row.websocket_close_code ?? null,
    continuationUnavailableReason: row.continuation_unavailable_reason ?? null,
    upstreamConnectionExitReason: row.upstream_connection_exit_reason ?? null,
    retryAfterMs: row.retry_after_ms ?? null,
    speed: row.speed ?? null,
    context1mApplied: row.long_context == null ? null : row.long_context === 1,
    reasoningEffort: row.reasoning_effort ?? null,
    inboundDeviceId: row.inbound_device_id ?? null,
    jevState: row.jev_state || null,
    errorClass: row.error_class ?? null,
    errorLabel: row.error_label ?? null,
    errorOwner: row.error_owner ?? null,
    errorCode: row.error_code || null,
    errorMessage: row.error_message || null,
    blockedBy: blocked,
    blockedReason: blocked ? row.error_message || row.error_label || null : null,
    userAgent: row.user_agent || null,
    clientIp: row.ip_address || null,
    apiKeyPresented: row.api_key_presented || null,
    specialSettings: specialSettings(row),
    providerChain: chain,
  }
}

const ATTEMPT_CLOCK_SLACK_MS = 1000

/**
 * request_id can come from the client's `x-request-id`, so an id can be reused
 * across requests (and tenants) once one side's rows are purged. Only attach
 * attempts that started inside this row's own request lifetime:
 * [created_at - duration_ms, created_at], created_at being completion time.
 */
function attemptWithinRow(attempt, row) {
  const started = Date.parse(attempt.started_at)
  const finished = Date.parse(row.created_at)
  if (!Number.isFinite(started) || !Number.isFinite(finished)) return false
  if (started > finished + ATTEMPT_CLOCK_SLACK_MS) return false
  const duration = Number(row.duration_ms)
  if (row.duration_ms == null || !Number.isFinite(duration)) return true
  return started >= finished - duration - ATTEMPT_CLOCK_SLACK_MS
}

function toProviderChainItem(r, names) {
  const fromVm = r.vm_id ? names.accountsByVm?.get(r.vm_id) : null
  const accountId = r.account_id ?? fromVm?.id ?? null
  return {
    attemptNumber: num(r.attempt_no),
    vmId: r.vm_id ?? null,
    vmName: r.vm_id ? (names.vms.get(r.vm_id) ?? r.vm_id) : null,
    accountId,
    providerName: accountId ? (names.accounts.get(accountId) ?? fromVm?.name ?? accountId) : (fromVm?.name ?? null),
    model: r.model ?? null,
    selectionReason: r.selection_reason ?? null,
    upstreamStatus: nullableNum(r.upstream_status),
    errorScope: r.error_scope ?? null,
    terminalState: r.terminal_state ?? null,
    action: r.action ?? null,
    downstreamCommitted: !!r.downstream_committed,
    waitMs: nullableNum(r.wait_ms),
    queueWaitMs: nullableNum(r.queue_wait_ms),
    schedulingMs: nullableNum(r.scheduling_ms),
    ttftMs: nullableNum(r.ttft_ms),
    latencyMs: nullableNum(r.latency_ms),
    startedAt: r.started_at ?? null,
    completedAt: r.completed_at ?? null,
    route: r.route ?? null,
    stage: r.stage ?? null,
    errorMessage: r.error_message ?? null,
  }
}

function splitClasses(raw) {
  return uniq(
    String(raw || '')
      .split(',')
      .map((s) => s.trim()),
  )
}

/**
 * Same muting rules as `RequestLogStore._mutedExclude`: an explicit error_class
 * or include_muted disables muting; an explicit exclude list replaces the
 * settings default; otherwise the settings default applies.
 */
function mutedClasses(filters, defaults) {
  if (filters.error_class || filters.include_muted) return []
  const explicit = splitClasses(filters.exclude_error_class)
  return explicit.length ? explicit : defaults.slice()
}

/**
 * Query-string filters (snake_case, see `UsageLogFilters`) → SQL fragment +
 * the JS predicate for what SQL cannot express (read-time error classes).
 *
 * `rollup`（技术债 M5）：筛选全部能由小时汇总表 `usage_stats_hourly` 回答时，给出套在汇总数据源外层的谓词与时间窗，
 * 否则为 null（调用方回落到逐行扫描）。汇总表能回答的条件只引用它的维度列：归属（ownerPred）、用户、Key、槽位、
 * 状态码、排除 2xx、只看错误、开始 / 结束时间，以及只屏蔽 `auth` 类（SQL 可表达）。
 * 回落到逐行扫描的条件：分组（读 `group_id` 回退列）、会话、账号、模型（含 `requested_model`）、平台、模型不一致、
 * 最少尝试次数、全文搜索、指定错误类别，以及屏蔽 `auth` 以外的错误类别（按行在 JS 中判定）。
 */
async function buildFilter(db, filters, defaultMuted) {
  const where = []
  const params = []
  const rollupWhere = []
  const rollupParams = []
  let rollupOk = true
  // 汇总维度列上的条件同时用于汇总路径；其余条件让汇总路径失效
  const add = (sql, values = [], { rollup = false } = {}) => {
    where.push(sql)
    params.push(...values)
    if (rollup) {
      rollupWhere.push(sql)
      rollupParams.push(...values)
    } else rollupOk = false
  }
  const own = ownerPred(filters.owner_user_id)
  if (own.sql) add(own.sql, own.params, { rollup: true })
  const eq = (col, val, rollup) => {
    if (val == null || val === '') return
    add(`${col} = ?`, [String(val)], { rollup })
  }
  eq('user_id', filters.user_id, true)
  eq('api_key_id', filters.key_id, true)
  eq('CAST(COALESCE(billing_group_id, group_id) AS TEXT)', filters.group_id, false)
  eq('vm_id', filters.vm_id, true)
  if (filters.session_id) {
    // Either side of the mapping finds the conversation.
    add('(outbound_session_id = ? OR session_id = ?)', [String(filters.session_id), String(filters.session_id)])
  }
  if (filters.account_id) add('(account_id = ? OR final_account_id = ?)', [filters.account_id, filters.account_id])
  if (filters.model) add('(model = ? OR requested_model = ?)', [filters.model, filters.model])
  const platform = normalizeUsagePlatform(filters.platform)
  if (platform) {
    const pred = await platformPredicate(db, platform, filters.vm_platforms)
    add(pred.sql, pred.params)
  }
  const statusCode = clampInt(filters.status_code, 0, 999, null)
  if (statusCode != null) add('status = ?', [statusCode], { rollup: true })
  else if (filters.exclude_status_200) add('(status IS NULL OR status < 200 OR status >= 300)', [], { rollup: true })
  if (filters.model_mismatch)
    add(
      `model_mismatch = 1 AND (COALESCE(via, '') NOT IN (${OUTBOUND_MODEL_VIAS.map((via) => `'${via}'`).join(',')}) OR NULLIF(response_model, '') IS NOT NULL)`,
    )
  const minAttempts = clampInt(filters.min_attempt_count, 0, 1000, null)
  if (minAttempts != null) add('IFNULL(attempt_count, 0) >= ?', [minAttempts])
  // Legacy export `status=error`: the error predicate without picking a class.
  if (filters.errors_only) add(ERROR_PRED, [], { rollup: true })
  // 时间窗由汇总数据源按小时拆分，不进外层谓词
  const start = isoOrNull(filters.start_time)
  if (start) {
    where.push('created_at >= ?')
    params.push(start)
  }
  const end = isoOrNull(filters.end_time)
  if (end) {
    where.push('created_at < ?')
    params.push(end)
  }
  if (filters.q) {
    const like = `%${String(filters.q).slice(0, 100)}%`
    add('(path LIKE ? OR error_code LIKE ? OR error_message LIKE ? OR request_id LIKE ?)', [like, like, like, like])
  }
  const errorClass = filters.error_class ? String(filters.error_class) : null
  if (errorClass) add(ERROR_PRED)
  const muted = mutedClasses(filters, defaultMuted)
  // SQL can only pre-drop ingress auth; every other class is decided per row.
  const excludeSql = excludeErrorClassSql(muted)
  if (excludeSql) add(excludeSql, [], { rollup: true })
  const blocked = new Set(muted)
  let keep = null
  if (errorClass) keep = (row) => row.error_class === errorClass
  else if (blocked.size) keep = (row) => !row.error_class || !blocked.has(row.error_class)
  const sqlOnlySummary = !errorClass && muted.every((c) => c === 'auth')
  return {
    where,
    params,
    keep,
    sqlOnlySummary,
    rollup:
      rollupOk && sqlOnlySummary
        ? {
            where: rollupWhere,
            params: rollupParams,
            since: start ? Date.parse(start) : null,
            until: end ? Date.parse(end) : null,
          }
        : null,
  }
}

function exportRow(raw) {
  return enrichLogRow({
    ...raw,
    ts: raw.created_at,
    ip: raw.ip_address,
    stream: !!raw.stream,
    has_tools: raw.has_tools == null ? null : !!raw.has_tools,
  })
}

function whereSql(where) {
  return where.length ? `WHERE ${where.join(' AND ')}` : ''
}

function finalChainItem(chain) {
  if (!Array.isArray(chain)) return null
  for (let i = chain.length - 1; i >= 0; i--) {
    if (chain[i].downstreamCommitted) return chain[i]
  }
  return chain.length ? chain[chain.length - 1] : null
}

/** 排行顺序：金额（整数微单位，M6）降序、请求数降序，ID 升序。 */
/** 排行最多返回的条目数（M5 复审 P2-10）。 */
export const RANKING_LIMIT = 200

function compareRanking(a, b) {
  const cost = (e) => e.cost_micros || 0
  return cost(b) - cost(a) || b.requests - a.requests || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

export class UsageLogsView {
  /**
   * @param {import('node:sqlite').DatabaseSync} db
   * @param {{ mutedErrorClasses?: string[] }} [opts] settings default mute list
   */
  constructor(db = getDb(), { mutedErrorClasses = DEFAULT_MUTED_ERROR_CLASSES, useRollup = true } = {}) {
    this.db = db
    registerModelPlatform(db)
    this.mutedErrorClasses = Array.isArray(mutedErrorClasses) ? mutedErrorClasses.slice() : []
    // summary / ranking / overview 读小时汇总表（技术债 M5）；false 时一律逐行扫描（一致性测试的对照路径）
    this.useRollup = useRollup !== false
  }

  /**
   * One page, newest first, keyset on `(created_at DESC, id DESC)`.
   * When classes are filtered in JS the scan reads at most SCAN_CAP rows; if
   * that cap is hit before `limit` matches, the cursor points at the last
   * scanned row and `hasMore` stays true so the client keeps paging.
   */
  async listBatch(filters = {}) {
    const limit = clampInt(filters.limit, 1, LIST_LIMIT_MAX, LIST_LIMIT_DEFAULT)
    const { where, params, keep } = await buildFilter(this.db, filters, this.mutedErrorClasses)
    let cursor =
      filters.cursor_created_at && filters.cursor_id
        ? { createdAt: String(filters.cursor_created_at), id: String(filters.cursor_id) }
        : null
    const matches = []
    let scanned = 0
    let lastScanned = null
    let exhausted = false
    while (matches.length <= limit) {
      const want = keep ? SCAN_CHUNK : limit + 1 - matches.length
      const w = where.slice()
      const p = params.slice()
      if (cursor) {
        // 先给 created_at 一个范围下界，索引才能从游标处开始扫，深翻页不随页数变慢（数据访问分层 R4）
        w.push('created_at <= ? AND (created_at < ? OR id < ?)')
        p.push(cursor.createdAt, cursor.createdAt, cursor.id)
      }
      const rows = await dbClient(this.db).many(
        `SELECT * FROM usage_logs ${whereSql(w)} ORDER BY created_at DESC, id DESC LIMIT ?`,
        ...p,
        want,
      )
      for (const raw of rows) {
        scanned++
        lastScanned = raw
        const row = enrichLogRow(raw)
        if (keep && !keep(row)) continue
        matches.push(row)
        if (matches.length > limit) break
      }
      if (matches.length > limit) break
      if (rows.length < want) {
        exhausted = true
        break
      }
      if (scanned >= SCAN_CAP) break
      cursor = { createdAt: lastScanned.created_at, id: lastScanned.id }
    }

    let page
    let next
    let hasMore
    if (matches.length > limit) {
      page = matches.slice(0, limit)
      next = page[page.length - 1]
      hasMore = true
    } else if (exhausted) {
      page = matches
      next = null
      hasMore = false
    } else {
      page = matches
      next = lastScanned
      hasMore = true
    }
    return {
      logs: await this._hydrate(page),
      nextCursor: next ? { createdAt: next.created_at, id: next.id } : null,
      hasMore,
    }
  }

  /**
   * Key / 用户排行（当前筛选下的精确合计）。筛选能由汇总表回答时读 `usage_stats_hourly`（边界小时读明细），
   * 其余 SQL 可表达的筛选按 usage_logs 分组聚合；只有按行判定错误类别时，才回落到按最新 5000 行抽样（`capped` 说明抽样截断）。
   */
  async ranking(filters, scope = 'key') {
    const col = scope === 'user' ? 'user_id' : 'api_key_id'
    const { where, params, sqlOnlySummary, rollup } = await buildFilter(this.db, filters, this.mutedErrorClasses)
    if (this.useRollup && rollup) {
      const source = rollupSource(rollup)
      return this._rankingEntries(await rollupLogRankingRows(this.db, source, col), scope)
    }
    if (sqlOnlySummary) {
      const w = [...where, `${col} IS NOT NULL`, `${col} != ''`]
      const rows = await dbClient(this.db).many(
        `
        SELECT ${col} AS id,
               MAX(NULLIF(user_id, '')) AS owner_id,
               COUNT(*) AS requests,
               COALESCE(SUM(${TOTAL_TOKENS_SQL}), 0) AS tokens,
               ${microsSumSql('actual_cost')} AS cost_micros,
               COUNT(${moneySql('actual_cost')}) AS cost_n
        FROM usage_logs ${whereSql(w)}
        GROUP BY ${col}
      `,
        ...params,
      )
      return this._rankingEntries(rows, scope)
    }
    return this._sampledRanking(filters, scope)
  }

  /**
   * 分组行 → 排行条目：金额全为空时 cost 为 null；按金额（整数微单位）、请求数、ID 排序，只取前 RANKING_LIMIT 条
   * 再查名称（M5 复审 P2-10：条目与 IN 列表都有上限）。名称按当前 Key / 用户表；Key 已删除时退回日志里记录的名称。
   */
  async _rankingEntries(rows, scope) {
    const all = rows
      .map((r) => ({
        id: r.id,
        owner_id: r.owner_id,
        requests: num(r.requests),
        tokens: num(r.tokens),
        cost_micros: num(r.cost_n) > 0 ? num(r.cost_micros) : null,
      }))
      .sort(compareRanking)
    const top = all.slice(0, RANKING_LIMIT)
    const names = await lookupNames(this.db, {
      keyIds: scope === 'key' ? top.map((r) => r.id) : [],
      userIds: scope === 'user' ? top.map((r) => r.id) : top.map((r) => r.owner_id),
    })
    const snapshotNames = new Map()
    const missingKeys = scope === 'key' ? top.map((r) => r.id).filter((id) => !names.keys.has(id)) : []
    if (missingKeys.length)
      for (const r of await dbClient(this.db).many(
        `SELECT api_key_id AS id, MAX(api_key_name) AS name FROM usage_logs WHERE api_key_id IN (${placeholders(missingKeys)}) AND api_key_name IS NOT NULL AND api_key_name != '' GROUP BY api_key_id`,
        ...missingKeys,
      ))
        snapshotNames.set(r.id, r.name)
    const entries = top.map(({ owner_id, cost_micros, ...r }) => ({
      ...r,
      cost: fromMicros(cost_micros),
      name: scope === 'user' ? names.users.get(r.id) || r.id : names.keys.get(r.id) || snapshotNames.get(r.id) || r.id,
      owner: scope === 'key' ? names.users.get(owner_id) || null : null,
    }))
    return {
      entries,
      sampled: all.reduce((sum, e) => sum + e.requests, 0),
      capped: all.length > RANKING_LIMIT,
    }
  }

  /** 按行判定错误类别时的抽样排行：最新 5000 行（原实现）。 */
  async _sampledRanking(filters, scope) {
    const { items, capped, total } = await this.exportRows({ ...filters, limit: 5000 })
    const names = await lookupNames(this.db, {
      keyIds: items.map((r) => r.api_key_id),
      userIds: items.map((r) => r.user_id),
    })
    const entries = new Map()
    for (const r of items) {
      const id = scope === 'user' ? r.user_id : r.api_key_id
      if (!id) continue
      const entry = entries.get(id) || {
        id,
        name: scope === 'user' ? names.users.get(id) || id : r.api_key_name || names.keys.get(id) || id,
        owner: scope === 'key' ? names.users.get(r.user_id) || null : null,
        requests: 0,
        tokens: 0,
        cost_micros: null,
      }
      entry.requests++
      entry.tokens += rowTotalTokens(r)
      const micros = rowMicros(r, 'actual_cost')
      if (micros != null) entry.cost_micros = (entry.cost_micros || 0) + micros
      entries.set(id, entry)
    }
    return {
      entries: [...entries.values()]
        .sort(compareRanking)
        .map(({ cost_micros, ...e }) => ({ ...e, cost: fromMicros(cost_micros) })),
      sampled: items.length,
      capped: capped || total > items.length,
    }
  }

  /** Names + provider chains for a whole page: one attempts query, one lookup per entity kind. */
  async _hydrate(rows) {
    if (!rows.length) return []
    const requestIds = uniq(rows.map((r) => r.request_id))
    const attempts = requestIds.length
      ? await dbClient(this.db).many(
          `SELECT * FROM request_attempts WHERE request_id IN (${placeholders(requestIds)}) ORDER BY request_id, attempt_no`,
          ...requestIds,
        )
      : []
    const names = await lookupNames(this.db, {
      userIds: rows.map((r) => r.user_id),
      keyIds: rows.map((r) => r.api_key_id),
      vmIds: [...rows.map((r) => r.vm_id), ...attempts.map((a) => a.vm_id)],
      accountIds: [...rows.map((r) => r.final_account_id || r.account_id), ...attempts.map((a) => a.account_id)],
      accountVmIds: [...rows.map((r) => r.vm_id), ...attempts.map((a) => a.vm_id)],
    })
    const chains = new Map()
    for (const a of attempts) {
      const list = chains.get(a.request_id) || []
      list.push(a)
      chains.set(a.request_id, list)
    }
    return rows.map((row) => {
      const own = (row.request_id && chains.get(row.request_id)) || []
      const chain = own.filter((a) => attemptWithinRow(a, row)).map((a) => toProviderChainItem(a, names))
      return toUsageLogRow(row, names, chain)
    })
  }

  /**
   * Totals for the current filters. Rollup-backed when every filter is a
   * rollup dimension (see buildFilter); SQL-only when muting is limited to the
   * SQL-expressible `auth` class; otherwise aggregates the newest
   * SUMMARY_SCAN_CAP rows after JS classification.
   */
  async summary(filters = {}) {
    const { where, params, keep, sqlOnlySummary, rollup } = await buildFilter(this.db, filters, this.mutedErrorClasses)
    // 汇总表能回答时读 usage_stats_hourly（边界小时读明细，技术债 M5），结果与下面的逐行 SQL 逐项一致
    if (this.useRollup && rollup) return toSummary(await rollupLogSummaryRow(this.db, rollupSource(rollup)))
    const cond = whereSql(where)
    if (sqlOnlySummary) {
      const row = await dbClient(this.db).one(
        `
        SELECT COUNT(*) AS requests,
               COALESCE(SUM(CASE WHEN ${SUCCESS_PRED} THEN 1 ELSE 0 END), 0) AS success,
               COALESCE(SUM(CASE WHEN ${ERROR_PRED} THEN 1 ELSE 0 END), 0) AS errors,
               ${microsSumSql('actual_cost')} AS cost_micros,
               COALESCE(SUM(input_tokens), 0) AS input_tokens,
               COALESCE(SUM(output_tokens), 0) AS output_tokens,
               COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
               COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
               COALESCE(SUM(cache_creation_5m_tokens), 0) AS cache_creation_5m_tokens,
               COALESCE(SUM(cache_creation_1h_tokens), 0) AS cache_creation_1h_tokens,
               COALESCE(SUM(${PROMPT_TOKENS_SQL}), 0) AS prompt_tokens,
               AVG(duration_ms) AS avg_duration_ms,
               AVG(first_token_ms) AS avg_ttft_ms
        FROM usage_logs ${cond}
      `,
        ...params,
      )
      return toSummary(row)
    }
    const rows = (
      await dbClient(this.db).many(
        `SELECT *, (${PROMPT_TOKENS_SQL}) AS prompt_tokens FROM usage_logs ${cond} ORDER BY created_at DESC, id DESC LIMIT ?`,
        ...params,
        SUMMARY_SCAN_CAP,
      )
    )
      .map(enrichLogRow)
      .filter(keep)
    const acc = {
      requests: rows.length,
      success: 0,
      errors: 0,
      cost_micros: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_5m_tokens: 0,
      cache_creation_1h_tokens: 0,
      prompt_tokens: 0,
    }
    let durSum = 0
    let durN = 0
    let ttftSum = 0
    let ttftN = 0
    for (const r of rows) {
      if (r.error_class) acc.errors++
      else if (r.status != null && r.status < 400) acc.success++
      acc.cost_micros += rowMicros(r, 'actual_cost') || 0
      for (const k of [
        'input_tokens',
        'output_tokens',
        'cache_creation_tokens',
        'cache_read_tokens',
        'cache_creation_5m_tokens',
        'cache_creation_1h_tokens',
        'prompt_tokens',
      ])
        acc[k] += num(r[k])
      if (r.duration_ms != null) {
        durSum += num(r.duration_ms)
        durN++
      }
      if (r.first_token_ms != null) {
        ttftSum += num(r.first_token_ms)
        ttftN++
      }
    }
    return toSummary({
      ...acc,
      avg_duration_ms: durN ? durSum / durN : null,
      avg_ttft_ms: ttftN ? ttftSum / ttftN : null,
    })
  }

  /**
   * Export rows under the same filters as the list, in the snake_case
   * `/request-logs` shape. Muting beyond `auth` is decided per row: then at
   * most EXPORT_SCAN_CAP newest rows are read and `capped` says the scan ended
   * before the table did.
   */
  async exportRows(filters = {}) {
    const limit = clampInt(filters.limit, 1, EXPORT_LIMIT_MAX, EXPORT_LIMIT_DEFAULT)
    const { where, params, keep, sqlOnlySummary } = await buildFilter(this.db, filters, this.mutedErrorClasses)
    const cond = whereSql(where)
    const select = `SELECT * FROM usage_logs ${cond} ORDER BY created_at DESC, id DESC LIMIT ?`
    if (!keep || sqlOnlySummary) {
      const total = (await dbClient(this.db).one(`SELECT COUNT(*) AS c FROM usage_logs ${cond}`, ...params)).c
      return {
        items: (await dbClient(this.db).many(select, ...params, limit)).map(exportRow),
        total,
        capped: false,
      }
    }
    const scanned = await dbClient(this.db).many(select, ...params, EXPORT_SCAN_CAP)
    const matched = scanned.map(exportRow).filter(keep)
    return {
      items: matched.slice(0, limit),
      total: matched.length,
      capped: scanned.length >= EXPORT_SCAN_CAP,
    }
  }

  /** Lazy dropdown values. Entity lists come from their tables; free-form columns from recent rows. */
  async filterOptions({ owner_user_id = null, vm_platforms = {} } = {}) {
    const db = dbClient(this.db)
    const own = ownerPred(owner_user_id)
    const recentWhere = own.sql ? `WHERE ${own.sql}` : ''
    const recent = `(SELECT * FROM usage_logs ${recentWhere} ORDER BY created_at DESC LIMIT ${RECENT_SCAN})`
    const distinct = async (col) =>
      (
        await db.many(
          `SELECT ${col} AS v FROM ${recent} WHERE ${col} IS NOT NULL AND ${col} != '' GROUP BY ${col} ORDER BY MAX(created_at) DESC LIMIT ${OPTION_LIMIT}`,
          ...own.params,
        )
      ).map((r) => r.v)

    let users
    let keys
    let vmIds
    let accountIds
    if (owner_user_id?.type === 'panel_users' || owner_user_id?.type === 'panel_admin_scope') {
      const scopeId = owner_user_id.scopeRootId || owner_user_id.adminId || null
      const id = owner_user_id.userId || null
      users = scopeId
        ? await db.many(
            `SELECT id, username, email FROM users
            WHERE id IN (${ADMIN_DOMAIN_IDS_SQL})${id ? ' AND id = ?' : ''} ORDER BY username`,
            scopeId,
            ...(id ? [id] : []),
          )
        : []
      keys = scopeId
        ? await db.many(
            `SELECT id, name, user_id FROM api_keys
            WHERE deleted_at IS NULL AND (user_id IN (${ADMIN_DOMAIN_IDS_SQL})
              OR created_by_user_id IN (${ADMIN_DOMAIN_IDS_SQL}))${id ? ' AND user_id = ?' : ''}
            ORDER BY name`,
            scopeId,
            scopeId,
            ...(id ? [id] : []),
          )
        : []
      vmIds = []
      accountIds = []
    } else if (owner_user_id?.type === 'panel_key_creator') {
      users = []
      keys = await db.many(
        'SELECT id, name, user_id FROM api_keys WHERE created_by_user_id = ? AND deleted_at IS NULL ORDER BY name',
        String(owner_user_id.creatorId || ''),
      )
      vmIds = []
      accountIds = []
    } else if (owner_user_id) {
      users = await db.many('SELECT id, username, email FROM users WHERE id = ?', String(owner_user_id))
      keys = await db.many(
        'SELECT id, name, user_id FROM api_keys WHERE user_id = ? ORDER BY name',
        String(owner_user_id),
      )
      // Historical filters follow caller snapshots, never current resource ownership.
      vmIds = await distinct('vm_id')
      accountIds = uniq([...(await distinct('final_account_id')), ...(await distinct('account_id'))])
    } else {
      users = await db.many('SELECT id, username, email FROM users WHERE deleted_at IS NULL ORDER BY username')
      keys = await db.many('SELECT id, name, user_id FROM api_keys WHERE deleted_at IS NULL ORDER BY name')
      vmIds = (await db.many('SELECT id FROM vms ORDER BY id')).map((r) => r.id)
      // 槽位已删除而账号表残留的行不列出，否则与在用槽位的同邮箱账号重名，选错即查不到记录
      accountIds = (
        await db.many(`SELECT a.id FROM accounts a WHERE a.deleted_at IS NULL
          AND (a.vm_id IS NULL OR a.vm_id = '' OR EXISTS (SELECT 1 FROM vms v WHERE v.id = a.vm_id)) ORDER BY a.id`)
      ).map((r) => r.id)
      // Gateway Worker 账号按运行账号 ID 筛选，选项显示账号名称
      accountIds.push(
        ...(
          await db.many(`SELECT DISTINCT b.runtime_account_id AS id FROM gateway_worker_account_bindings b
            JOIN vendor_resources r ON r.id=b.account_resource_id WHERE r.status<>'archived' ORDER BY r.name`)
        ).map((r) => r.id),
      )
      // 上游 API 按子 Key 筛选，选项显示上游 API 名称
      accountIds.push(...(await apiEndpointKeys(this.db)).map((r) => r.id))
    }
    const names = await lookupNames(this.db, { vmIds, accountIds })
    const platforms = accountIds.length ? await accountPlatforms(this.db, vm_platforms) : new Map()
    const vmPlatforms = vmPlatformMap(vm_platforms)
    const membership = vmIds.length || accountIds.length ? await groupMembership(this.db) : null
    // 同名选项（同邮箱的多个槽位账号、同一上游 API 的多个子 Key）补所在槽位名，无槽位或仍重名时补 ID
    const accountNames = accountIds.map((id) => names.accounts.get(id) ?? String(id))
    const isDup = (list, v) => list.indexOf(v) !== list.lastIndexOf(v)
    const dupIds = accountIds.filter((_, i) => isDup(accountNames, accountNames[i]))
    const slots = new Map(
      dupIds.length
        ? (
            await db.many(
              `SELECT a.id, COALESCE(NULLIF(v.name, ''), v.id) AS slot FROM accounts a JOIN vms v ON v.id = a.vm_id
                WHERE a.id IN (${placeholders(dupIds)})`,
              ...dupIds,
            )
          ).map((r) => [r.id, r.slot])
        : [],
    )
    const labels = accountIds.map((id, i) => {
      const name = accountNames[i]
      return isDup(accountNames, name) && slots.has(id) ? `${name} · ${slots.get(id)}` : name
    })
    const accounts = accountIds.map((id, i) => {
      const label = labels[i]
      return {
        id: String(id),
        name: isDup(labels, label) ? `${label} · ${id}` : label,
        platform: platformOfAccount(platforms, id),
        groupIds: membership ? membership.ofAccount(id) : [],
      }
    })
    // Historical groups follow visible log snapshots, not current grants or a privileged groups API.
    const groupIds = await distinct('COALESCE(billing_group_id, group_id)')
    const groupInfo = new Map(
      groupIds.length
        ? (
            await db.many(
              `SELECT id, name, platform, models_json FROM groups WHERE id IN (${groupIds.map(() => '?').join(',')})`,
              ...groupIds,
            )
          ).map((g) => [String(g.id), g])
        : [],
    )
    const models = uniq([...(await distinct('model')), ...(await distinct('requested_model'))])
    const statusCodes = await distinct('status')
    return {
      groups: groupIds.map((id) => {
        const g = groupInfo.get(String(id))
        return {
          id: String(id),
          name: g?.name || String(id),
          platform: g ? normalizeGroupPlatform(g.platform) : null,
          models: g ? groupModels(g.models_json) : [],
        }
      }),
      users: users.map((u) => ({ id: String(u.id), name: u.username || u.email || String(u.id) })),
      keys: keys.map((k) => ({ id: String(k.id), name: k.name || String(k.id), userId: k.user_id ?? null })),
      vms: vmIds.map((id) => ({
        id: String(id),
        name: names.vms.get(id) ?? String(id),
        platform: vmPlatforms.get(id) || null,
        groupIds: membership ? membership.ofVm(id) : [],
      })),
      accounts,
      models: models.sort().map((id) => ({ id, platform: platformOfModel(id) })),
      statusCodes: statusCodes.map(Number).sort((a, b) => a - b),
    }
  }

  /** Outbound sessions with a completed request in the last `minutes`. */
  async activeSessions({ minutes = 5, limit = 50, owner_user_id = null, now = Date.now() } = {}) {
    const mins = clampInt(minutes, 1, 1440, 5)
    const n = clampInt(limit, 1, 200, 50)
    const where = ['created_at >= ?', 'outbound_session_id IS NOT NULL']
    const params = [new Date(now - mins * 60_000).toISOString()]
    const own = ownerPred(owner_user_id)
    if (own.sql) {
      where.push(own.sql)
      params.push(...own.params)
    }
    const cond = `WHERE ${where.join(' AND ')}`
    const total = (
      await dbClient(this.db).one(`SELECT COUNT(DISTINCT outbound_session_id) AS n FROM usage_logs ${cond}`, ...params)
    ).n
    // Aggregate first, then pull the newest row per session by id; SQLite's
    // bare-column-with-MAX shortcut is undefined once MIN() is also present.
    const rows = await dbClient(this.db).many(
      `
      WITH s AS (
        SELECT outbound_session_id AS sid,
               MAX(created_at) AS last_at,
               MIN(created_at) AS first_at,
               COUNT(*) AS requests,
               SUM(IFNULL(input_tokens, 0) + IFNULL(output_tokens, 0) + IFNULL(cache_read_tokens, 0) + IFNULL(cache_creation_tokens, 0)) AS tokens,
               ${microsSumSql('actual_cost')} AS cost_micros
        FROM usage_logs ${cond}
        GROUP BY outbound_session_id
        ORDER BY last_at DESC
        LIMIT ?
      )
      SELECT s.*, l.session_id AS client_session_id, l.user_id, l.api_key_id, l.vm_id, l.model, l.status, l.duration_ms,
             COALESCE(l.final_account_id, l.account_id) AS account
      FROM s
      JOIN usage_logs l ON l.id = (
        SELECT id FROM usage_logs
        WHERE outbound_session_id = s.sid AND created_at = s.last_at${own.sql ? ` AND ${own.sql}` : ''}
        ORDER BY id DESC LIMIT 1
      )
      ORDER BY s.last_at DESC
    `,
      ...params,
      n,
      ...own.params,
    )
    const names = await lookupNames(this.db, {
      userIds: rows.map((r) => r.user_id),
      keyIds: rows.map((r) => r.api_key_id),
      vmIds: rows.map((r) => r.vm_id),
      accountIds: rows.map((r) => r.account),
    })
    return {
      minutes: mins,
      total: num(total),
      sessions: rows.map((r) => ({
        sessionId: r.sid,
        clientSessionId: r.client_session_id ?? null,
        userName: r.user_id ? (names.users.get(r.user_id) ?? null) : null,
        keyName: r.api_key_id ? (names.keys.get(r.api_key_id) ?? null) : null,
        providerName: r.account ? (names.accounts.get(r.account) ?? r.account) : null,
        vmId: r.vm_id ?? null,
        vmName: r.vm_id ? (names.vms.get(r.vm_id) ?? r.vm_id) : null,
        model: r.model ?? null,
        firstAt: r.first_at,
        lastAt: r.last_at,
        requests: num(r.requests),
        lastStatus: nullableNum(r.status),
        lastDurationMs: nullableNum(r.duration_ms),
        totalTokens: num(r.tokens),
        totalCost: fromMicros(num(r.cost_micros)),
      })),
    }
  }

  /**
   * Header cards. "Today" = UTC+8 midnight → now; "yesterday" = the
   * same elapsed span starting at yesterday's local midnight.
   */
  async overview({ owner_user_id = null, now = Date.now() } = {}) {
    const zone = SYSTEM_TIMEZONE
    const own = ownerPred(owner_user_id)
    const todayStart = zonedDayStartMs(now, zone)
    const yesterdayStart = zonedDayStartMs(now, zone, -1)
    const yesterdayEnd = Math.min(todayStart, yesterdayStart + (now - todayStart))
    const agg = (sinceMs, untilMs) => {
      const where = ['created_at >= ?', 'created_at < ?']
      const params = [new Date(sinceMs).toISOString(), new Date(untilMs).toISOString()]
      if (own.sql) {
        where.push(own.sql)
        params.push(...own.params)
      }
      return dbClient(this.db).one(
        `
        SELECT COUNT(*) AS requests,
               COALESCE(SUM(CASE WHEN ${ERROR_PRED} THEN 1 ELSE 0 END), 0) AS errors,
               ${microsSumSql('actual_cost')} AS cost_micros,
               COALESCE(SUM(input_tokens), 0) AS input_tokens,
               COALESCE(SUM(output_tokens), 0) AS output_tokens,
               COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
               COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
               COALESCE(SUM(cache_creation_5m_tokens), 0) AS cache_creation_5m_tokens,
               COALESCE(SUM(cache_creation_1h_tokens), 0) AS cache_creation_1h_tokens,
               COALESCE(SUM(${PROMPT_TOKENS_SQL}), 0) AS prompt_tokens,
               AVG(duration_ms) AS avg_duration_ms,
               AVG(first_token_ms) AS avg_ttft_ms,
               COUNT(DISTINCT outbound_session_id) AS sessions
        FROM usage_logs WHERE ${where.join(' AND ')}
      `,
        ...params,
      )
    }
    // 今日与昨日同期读汇总表（技术债 M5）：只用可加的列，会话数只取最近 5 分钟（走明细，窗口很小）
    const totals = (sinceMs, untilMs) =>
      this.useRollup
        ? rollupLogSummaryRow(
            this.db,
            rollupSource({ since: sinceMs, until: untilMs, where: [own.sql], params: own.params }),
          )
        : agg(sinceMs, untilMs)
    // +1ms so a row stamped exactly `now` still counts.
    const today = await totals(todayStart, now + 1)
    const yesterday = await totals(yesterdayStart, yesterdayEnd)
    const active = await agg(now - 5 * 60_000, now + 1)
    const lastMinute = await agg(now - 60_000, now + 1)
    const avg = (v) => (v == null ? null : Math.round(Number(v)))
    const input = num(today.input_tokens)
    const output = num(today.output_tokens)
    const cacheRead = num(today.cache_read_tokens)
    const cacheCreation = num(today.cache_creation_tokens)
    const prompt = num(today.prompt_tokens)
    return {
      activeSessions: num(active.sessions),
      rpm: num(lastMinute.requests),
      todayRequests: num(today.requests),
      todayCost: fromMicros(num(today.cost_micros)),
      todayActualCost: fromMicros(num(today.cost_micros)),
      todayErrors: num(today.errors),
      todayTokens: input + output + cacheRead + cacheCreation,
      todayInputTokens: input,
      todayOutputTokens: output,
      todayCacheReadTokens: cacheRead,
      todayCacheCreationTokens: cacheCreation,
      todayCacheCreation5mTokens: num(today.cache_creation_5m_tokens),
      todayCacheCreation1hTokens: num(today.cache_creation_1h_tokens),
      todayCacheHitRate: prompt > 0 ? Math.min(1, cacheRead / prompt) : 0,
      todayAvgDurationMs: avg(today.avg_duration_ms),
      todayAvgTtftMs: avg(today.avg_ttft_ms),
      yesterdayRequests: num(yesterday.requests),
      yesterdayCost: fromMicros(num(yesterday.cost_micros)),
      yesterdayAvgDurationMs: avg(yesterday.avg_duration_ms),
    }
  }
}

function toSummary(row) {
  const input = num(row.input_tokens)
  const output = num(row.output_tokens)
  const cacheCreation = num(row.cache_creation_tokens)
  const cacheRead = num(row.cache_read_tokens)
  const prompt = num(row.prompt_tokens)
  return {
    totalRequests: num(row.requests),
    successRequests: num(row.success),
    errorRequests: num(row.errors),
    // M6：金额是整数微单位之和，这里只换算成美元
    totalCost: fromMicros(num(row.cost_micros)),
    totalActualCost: fromMicros(num(row.cost_micros)),
    totalTokens: rowTotalTokens(row),
    totalInputTokens: input,
    totalOutputTokens: output,
    totalCacheCreationTokens: cacheCreation,
    totalCacheReadTokens: cacheRead,
    totalCacheCreation5mTokens: num(row.cache_creation_5m_tokens),
    totalCacheCreation1hTokens: num(row.cache_creation_1h_tokens),
    cacheHitRate: prompt > 0 ? Math.min(1, cacheRead / prompt) : 0,
    avgDurationMs: row.avg_duration_ms == null ? null : Math.round(Number(row.avg_duration_ms)),
    avgTtftMs: row.avg_ttft_ms == null ? null : Math.round(Number(row.avg_ttft_ms)),
  }
}
