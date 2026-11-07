import crypto from 'node:crypto'
import { getDb } from '../db/database.mjs'
import { dbClient } from '../db/db-client.mjs'
import { usageForStorage } from '../core/usage-persist.mjs'
import { costColumnsFromUsage, normalizeUsage, shanghaiDayStartIso } from '../admin/pricing.mjs'
import { disjointOpenaiUsage } from '../protocol/openai-usage.mjs'
import { ERROR_PRED, SUCCESS_PRED, totalTokens } from '../db/repos/usage-log-preds.mjs'
import { codexBillingType } from '../vm/codex-slot.mjs'
import {
  addRollupBuckets,
  ceilHourMs,
  hourKey,
  rawMeasures,
  ROLLUP_SOURCE,
  rollupMeasures,
} from '../db/repos/usage-cost-rollup.mjs'
import { extraWindowSince } from '../pool/quota-window.mjs'
import { gatewayAccountResource, insertUsageFact } from '../vendor/repos/usage-repo.mjs'

const now = () => new Date().toISOString()
const id = (prefix) => `${prefix}_${crypto.randomUUID()}`
const parse = (value, fallback = {}) => {
  try {
    return value == null ? fallback : JSON.parse(value)
  } catch {
    return fallback
  }
}
// 回执 payload_hash 的规范化 JSON，与 Worker（Go encoding/json）同口径：Go 总是把 U+2028/U+2029 转义（R1 复审 N4）
const goJsonString = (value) => {
  const raw = JSON.stringify(value)
  return raw === undefined ? raw : raw.replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
}
const stableJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${goJsonString(key)}:${stableJson(value[key])}`)
      .join(',')}}`
  return goJsonString(value)
}

// 回执补算成本时改写的金额列（与 usage_cost_hourly 的成本口径一致）
const RECEIPT_COST_COLUMNS = ['input_cost', 'output_cost', 'cache_read_cost', 'cache_creation_cost', 'total_cost']

const usageFields = (prefix, bucket) => ({
  [`${prefix}_requests`]: bucket.requests,
  [`${prefix}_cost`]: bucket.total_cost,
  [`${prefix}_tokens`]: totalTokens(bucket),
  [`${prefix}_input_tokens`]: bucket.input_tokens,
  [`${prefix}_output_tokens`]: bucket.output_tokens,
  [`${prefix}_cache_read_tokens`]: bucket.cache_read_tokens,
  [`${prefix}_cache_creation_tokens`]: bucket.cache_creation_tokens,
})

const emptyAccountUsage = () => ({
  today_requests: 0,
  today_cost: 0,
  today_tokens: 0,
  today_input_tokens: 0,
  today_output_tokens: 0,
  today_cache_read_tokens: 0,
  today_cache_creation_tokens: 0,
  window_5h_requests: 0,
  window_5h_cost: 0,
  window_5h_tokens: 0,
  window_5h_input_tokens: 0,
  window_5h_output_tokens: 0,
  window_5h_cache_read_tokens: 0,
  window_5h_cache_creation_tokens: 0,
  window_7d_requests: 0,
  window_7d_success: 0,
  window_7d_errors: 0,
  window_7d_cost: 0,
  window_7d_tokens: 0,
  window_7d_input_tokens: 0,
  window_7d_output_tokens: 0,
  window_7d_cache_read_tokens: 0,
  window_7d_cache_creation_tokens: 0,
  requests: 0,
  total_cost: 0,
  total_tokens: 0,
})

const quotaStamp = (quota) => Date.parse(quota?.updated_at || '') || 0

// Receipt 的额度只来自本次响应头：没有任何观测（unknown）时保留已有快照，否则按字段合并，不整体替换
const mergeReceiptQuota = (currentJson, incoming) => {
  if (!incoming || typeof incoming !== 'object' || incoming.confidence === 'unknown') return null
  const observed = Object.fromEntries(Object.entries(incoming).filter(([, value]) => value != null))
  return JSON.stringify({ ...parse(currentJson, {}), ...observed })
}

/** 5h/7d by window length, not primary/secondary position (same as the console's quotaWindows). */
export function gatewayQuotaWindows(quota) {
  const primary = quota?.primary_window
  const secondary = quota?.secondary_window
  const pm = primary?.window_minutes
  const sm = secondary?.window_minutes
  const fiveFromPrimary = pm != null && sm != null ? pm < sm : pm != null ? pm <= 360 : sm != null ? sm > 360 : false
  return fiveFromPrimary ? [primary, secondary] : [secondary, primary]
}

const ENQUEUE_RECONCILIATION_SQL = `INSERT INTO gateway_worker_reconciliation_jobs(id,gateway_instance_id,dispatch_id,receipt_id,request_id,model,context_json,usage_json,status,attempts,next_attempt_at,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,'pending',0,?,?,?)
         ON CONFLICT(gateway_instance_id,dispatch_id) DO UPDATE SET receipt_id=COALESCE(excluded.receipt_id,receipt_id),model=COALESCE(excluded.model,model),usage_json=COALESCE(excluded.usage_json,usage_json),context_json=COALESCE(excluded.context_json,context_json),status=CASE WHEN status='settled' THEN status ELSE 'pending' END,updated_at=excluded.updated_at`

// 对账任务的编号与参数（enqueueReconciliation 与其临时同步出口共用）；缺少实例、dispatch 或请求编号时不入队
function reconciliationJob({
  gatewayInstanceId,
  dispatchId,
  receiptId = null,
  requestId,
  model = null,
  usage = null,
  context = null,
} = {}) {
  if (!gatewayInstanceId || !dispatchId || !requestId) return null
  const stamp = now()
  const idValue = id('reconcile')
  return {
    id: idValue,
    params: [
      idValue,
      gatewayInstanceId,
      dispatchId,
      receiptId,
      requestId,
      model,
      context ? JSON.stringify(context) : null,
      usage ? JSON.stringify(usageForStorage(usage)) : null,
      stamp,
      stamp,
      stamp,
    ],
  }
}

export class GatewayWorkerRepo {
  constructor(db = null) {
    // Keep route factories safe to construct in isolated unit tests and during
    // server bootstrap before the database singleton is opened. The first
    // operation that actually needs persistence still resolves the singleton
    // and reports the normal database error if it is unavailable.
    this._db = db
  }

  get db() {
    if (!this._db) this._db = getDb()
    return this._db
  }

  // 数据访问经 DbClient 异步进行（R6 B5）；方法签名与返回值不变，调用方 await
  get c() {
    return dbClient(this.db)
  }

  async listInstances() {
    return (await this.c.many('SELECT * FROM gateway_worker_instances ORDER BY name, id')).map((row) => ({
      ...row,
      capabilities: parse(row.capabilities_json),
      capabilities_json: undefined,
      executor_events: parse(row.executor_events_json),
      executor_events_json: undefined,
      facts: row.facts_json ? parse(row.facts_json) : null,
      facts_json: undefined,
    }))
  }

  async getInstance(instanceId) {
    const row = await this.c.one('SELECT * FROM gateway_worker_instances WHERE id=?', instanceId)
    if (!row) return null
    return { ...row, capabilities: parse(row.capabilities_json) }
  }

  async upsertInstance(input = {}) {
    const stamp = now()
    const instanceId = String(input.id || id('gw')).trim()
    const existing = await this.getInstance(instanceId)
    const protocolVersion = Number(input.protocol_version || existing?.protocol_version || 1)
    const recovering =
      ['healthy', 'degraded'].includes(String(input.health_state || '')) && existing?.admission_state === 'expired'
    const admission = protocolVersion < 1 ? 'blocked' : input.admission_state || (recovering ? 'admitted' : null)
    if (existing) {
      await this.c.run(
        `UPDATE gateway_worker_instances SET name=?,base_url=?,transport=?,region=?,version=?,boot_id=?,protocol_version=?,capabilities_json=?,health_state=?,drain_state=?,active_concurrency=?,queue_depth=?,receipt_backlog=?,last_heartbeat_at=?,admission_state=COALESCE(?,admission_state),drain_deadline=COALESCE(?,drain_deadline),last_error=COALESCE(?,last_error),updated_at=? WHERE id=?`,
        input.name || existing.name || instanceId,
        input.base_url || existing.base_url,
        input.transport || existing.transport || 'http',
        input.region ?? existing.region ?? null,
        input.version ?? existing.version ?? null,
        input.boot_id ?? existing.boot_id ?? null,
        protocolVersion,
        JSON.stringify(input.capabilities || existing.capabilities || {}),
        input.health_state || existing.health_state || 'unknown',
        input.drain_state || existing.drain_state || 'accepting',
        Number(input.active_concurrency ?? existing.active_concurrency ?? 0),
        Number(input.queue_depth ?? existing.queue_depth ?? 0),
        Number(input.receipt_backlog ?? existing.receipt_backlog ?? 0),
        input.last_heartbeat_at || stamp,
        admission,
        input.drain_deadline || null,
        input.last_error || null,
        stamp,
        instanceId,
      )
    } else {
      await this.c.run(
        `INSERT INTO gateway_worker_instances(id,name,base_url,transport,region,version,boot_id,protocol_version,capabilities_json,health_state,drain_state,active_concurrency,queue_depth,receipt_backlog,last_heartbeat_at,admission_state,drain_deadline,last_error,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        instanceId,
        input.name || instanceId,
        input.base_url || '',
        input.transport || 'http',
        input.region || null,
        input.version || null,
        input.boot_id || null,
        protocolVersion,
        JSON.stringify(input.capabilities || {}),
        input.health_state || 'unknown',
        input.drain_state || 'accepting',
        Number(input.active_concurrency || 0),
        Number(input.queue_depth || 0),
        Number(input.receipt_backlog || 0),
        input.last_heartbeat_at || stamp,
        admission || 'admitted',
        input.drain_deadline || null,
        input.last_error || null,
        stamp,
        stamp,
      )
    }
    return this.getInstance(instanceId)
  }

  async setDrain(instanceId, draining, drainDeadline = null) {
    await this.c.run(
      "UPDATE gateway_worker_instances SET drain_state=?,admission_state=CASE WHEN ? THEN admission_state ELSE 'admitted' END,drain_deadline=?,updated_at=? WHERE id=?",
      draining ? 'draining' : 'accepting',
      draining ? 1 : 0,
      draining ? drainDeadline : null,
      now(),
      instanceId,
    )
    return this.getInstance(instanceId)
  }

  // 单 Worker 模式下占用执行面的实例：健康、接单且 45 秒内有心跳（与 pickInstance 的在线判定一致）
  async activeInstances() {
    await this.markStaleInstances()
    return (
      await this.c.many(`SELECT id FROM gateway_worker_instances
          WHERE health_state IN ('healthy','degraded')
            AND drain_state='accepting'
            AND (last_heartbeat_at IS NULL OR julianday(last_heartbeat_at)>=julianday('now','-45 seconds'))
          ORDER BY id`)
    ).map((row) => row.id)
  }

  async pickInstance({ operation = null, model = null, exclude = null, prefer = null } = {}) {
    await this.markStaleInstances()
    const rows = await this.c.many(`SELECT * FROM gateway_worker_instances
          WHERE health_state IN ('healthy','degraded')
            AND drain_state='accepting'
            AND COALESCE(admission_state,'admitted')='admitted'
            AND COALESCE(protocol_version,0)>=1
            AND (last_heartbeat_at IS NULL OR julianday(last_heartbeat_at)>=julianday('now','-45 seconds'))
          ORDER BY active_concurrency ASC,queue_depth ASC,last_heartbeat_at DESC`)
    // 逐个读取完整实例（与原实现一致），保持候选顺序
    const candidates = []
    for (const row of rows) candidates.push(await this.getInstance(row.id))
    // 入站 WS 连接优先回到上次的实例：连接内续接与控制帧依赖该实例上的上游 WS 绑定
    if (prefer) candidates.sort((a, b) => (b.id === prefer) - (a.id === prefer))
    return (
      candidates.find((item) => {
        if (exclude?.has?.(item.id)) return false
        const operations = item.capabilities?.operations || []
        if (operation && operations.length && !operations.includes(operation)) return false
        const models = item.capabilities?.models || []
        if (model && models.length && !models.includes(model)) return false
        return true
      }) || null
    )
  }

  async markStaleInstances() {
    try {
      await this.c.run(
        "UPDATE gateway_worker_instances SET health_state='offline',admission_state='expired',last_error='heartbeat_timeout',updated_at=? WHERE health_state IN ('healthy','degraded') AND last_heartbeat_at IS NOT NULL AND julianday(last_heartbeat_at) < julianday('now','-45 seconds')",
        now(),
      )
    } catch {}
  }

  async listCodexAccounts({ vendorId = null, includeArchived = false } = {}) {
    // 永久删除的墓碑（deleted_at）任何视图都不列出，「显示归档」也不例外
    const conditions = [
      `r.resource_type='account'`,
      'r.deleted_at IS NULL',
      `json_extract(r.config_json,'$.platform') IN ('openai','codex')`,
      `json_extract(r.config_json,'$.execution_kind')='gateway_worker'`,
    ]
    const params = []
    if (vendorId) {
      conditions.push('r.vendor_id=?')
      params.push(vendorId)
    }
    if (!includeArchived) conditions.push("r.status<>'archived'")
    const rows = await this.c.many(
      `SELECT r.*,
          (SELECT v.name FROM vendors v WHERE v.id=r.vendor_id) AS vendor_name,
          b.runtime_account_id, b.projection_status, b.last_seen_at,
          -- 凭据代次以凭据库为准（S1b：Worker 刷新后直接写回凭据库），绑定上记的只是授权时的值
          MAX(COALESCE(b.credential_revision, 0), COALESCE((SELECT c.revision FROM executor_credentials c
            WHERE c.account_resource_id=r.id AND c.grant_kind='native'), 0)) AS credential_revision,
          b.quota_json, b.runtime_status, b.last_error, b.credential_state, b.credential_error,
          -- 在途数由接单中的实例心跳整体改写（recordRuntimeLoad）；没有在线实例时按 0 显示
          CASE WHEN EXISTS (SELECT 1 FROM gateway_worker_instances i WHERE i.health_state IN ('healthy','degraded'))
            THEN COALESCE(b.inflight,0) ELSE 0 END AS inflight,
          -- 分组只以 group_resources 为准（迁移 128 起 config_json 不再存 group_ids），账号视图按它现算
          (SELECT json_group_array(g.group_id) FROM (SELECT group_id FROM group_resources
            WHERE resource_kind='gateway_worker_account' AND resource_id=r.id ORDER BY group_id) g) AS group_ids_json,
          -- 分组归属版本：编辑框据此带 expected_group_version，其他入口期间改过分组时保存返回 409
          COALESCE((SELECT v.version FROM resource_group_versions v
            WHERE v.resource_kind='gateway_worker_account' AND v.resource_id=r.id), 0) AS group_version
        FROM vendor_resources r LEFT JOIN gateway_worker_account_bindings b ON b.account_resource_id=r.id
        WHERE ${conditions.join(' AND ')} ORDER BY r.updated_at DESC`,
      ...params,
    )
    const usage = await this.codexAccountUsage(rows.map((row) => ({ id: row.id, quota: parse(row.quota_json, null) })))
    return rows.map((row) => {
      const config = { ...parse(row.config_json), group_ids: parse(row.group_ids_json, []) }
      if (config.proxy_endpoint) {
        try {
          const proxy = new URL(config.proxy_endpoint)
          config.proxy_endpoint = `${proxy.protocol}//${proxy.host}`
        } catch {
          config.proxy_endpoint = ''
        }
      }
      return {
        ...row,
        config,
        config_json: undefined,
        secret_json: undefined,
        group_ids_json: undefined,
        quota: parse(row.quota_json, null),
        usage: usage.get(row.id) || emptyAccountUsage(),
      }
    })
  }

  /** Same request/cost facts as the VM list, keyed by the Gateway account resource.
   * 5H/7D follow the account's own quota windows when the Worker reported a reset
   * (an elapsed reset starts the new window, as `extraWindowSince` does for VM rows);
   * otherwise they fall back to rolling windows. */
  async codexAccountUsage(accounts, at = Date.now()) {
    const out = new Map()
    if (!accounts.length) return out
    const start = (window, fallbackMinutes) => {
      const minutes = Number(window?.window_minutes) || fallbackMinutes
      return extraWindowSince(window?.reset_at, minutes * 60000, at) ?? at - fallbackMinutes * 60000
    }
    const ids = accounts.map((a) => a.id)
    // Whole hours from the hourly rollup (migration 093); each window's partial first hour from usage_logs.
    const hoursById = new Map(ids.map((id) => [id, []]))
    for (const row of await this.c.many(
      `SELECT resource_ref AS id, hour, ${rollupMeasures(SUCCESS_PRED, ERROR_PRED)} FROM ${ROLLUP_SOURCE}
          WHERE execution_kind='gateway_worker' AND account_resource_id IN (${ids.map(() => '?').join(',')})
          GROUP BY account_resource_id, hour`,
      ...ids,
    ))
      hoursById.get(row.id)?.push(row)
    const edgeSql = `SELECT ${rawMeasures(SUCCESS_PRED, ERROR_PRED)} FROM usage_logs
        WHERE account_resource_id=? AND execution_kind='gateway_worker' AND created_at>=? AND created_at<?`
    const day = Date.parse(shanghaiDayStartIso(new Date(at)))
    for (const account of accounts) {
      const hours = hoursById.get(account.id) || []
      const since = async (ms) => {
        const end = ceilHourMs(ms)
        const from = hourKey(end)
        const rows = hours.filter((row) => row.hour >= from)
        if (end > ms)
          rows.push(await this.c.one(edgeSql, account.id, new Date(ms).toISOString(), new Date(end).toISOString()))
        return addRollupBuckets(rows)
      }
      const [five, seven] = gatewayQuotaWindows(account.quota)
      const today = await since(day)
      const w5 = await since(start(five, 300))
      const w7 = await since(start(seven, 10080))
      const total = addRollupBuckets(hours)
      out.set(account.id, {
        ...usageFields('today', today),
        ...usageFields('window_5h', w5),
        ...usageFields('window_7d', w7),
        window_7d_success: w7.success,
        window_7d_errors: w7.errors,
        requests: total.requests,
        total_cost: total.total_cost,
        total_tokens: totalTokens(total),
      })
    }
    return out
  }

  // 账号绑定（每个账号一行；迁移 130 起不记承接实例，向 Worker 发请求时选当前接单的实例）
  async getAccountBinding(accountResourceId) {
    const row = await this.c.one(
      `SELECT b.*,r.vendor_id,r.name,r.status,r.config_json
           FROM gateway_worker_account_bindings b
           JOIN vendor_resources r ON r.id=b.account_resource_id
          WHERE b.account_resource_id=?`,
      accountResourceId,
    )
    return row ? { ...row, config: parse(row.config_json) } : null
  }

  // 只支持同机单个 Worker（迁移 130）：心跳里的账号运行态（在途、凭据终态、事实同步状态）只采信健康、接单中的实例，
  // 替换实例的接替窗口里 Drain 或不健康的旧实例不能覆盖新实例写入的状态
  async acceptingInstance(instanceId) {
    const instance = await this.c.one(
      'SELECT health_state, drain_state FROM gateway_worker_instances WHERE id=?',
      instanceId,
    )
    return ['healthy', 'degraded'].includes(instance?.health_state) && instance?.drain_state === 'accepting'
  }

  // 额度查询结果是上游账号的完整快照，写回该账号的绑定
  async recordAccountQuota(accountResourceId, quota) {
    if (!quota || typeof quota !== 'object') return 0
    return (
      await this.c.run(
        'UPDATE gateway_worker_account_bindings SET quota_json=?,last_seen_at=?,updated_at=? WHERE account_resource_id=?',
        JSON.stringify(quota),
        now(),
        now(),
        accountResourceId,
      )
    ).changes
  }

  // 订阅周期属于上游账号（Worker 读 /backend-api/subscriptions）：只保存到期、续订、计费周期与订阅渠道供列表展示。
  // 不进入投影配置，也不改 updated_at（账号列表按它排序）
  async recordAccountSubscription(accountResourceId, subscription) {
    const expires = Date.parse(subscription?.expires_at || '')
    if (!Number.isFinite(expires)) return 0
    const period = typeof subscription.billing_period === 'string' ? subscription.billing_period.trim() : ''
    const value = {
      expires_at: new Date(expires).toISOString(),
      will_renew: typeof subscription.will_renew === 'boolean' ? subscription.will_renew : null,
      billing_period: period ? period.slice(0, 32) : null,
      // 订阅渠道与 VM 槽位同一映射（accounts/check 的 purchase_origin_platform）
      billing_type: codexBillingType(subscription.purchase_origin_platform)?.slice(0, 32) || null,
      checked_at: now(),
    }
    return (
      await this.c.run(
        "UPDATE vendor_resources SET config_json=json_set(config_json,'$.subscription',json(?)) WHERE id=? AND resource_type='account'",
        JSON.stringify(value),
        accountResourceId,
      )
    ).changes
  }

  // 订阅补查候选：未归档、已有 Worker 绑定，且从未查到或上次查到早于 before（最久未查的在前）
  async listSubscriptionRefreshCandidates(before) {
    return (
      await this.c.many(
        `SELECT r.id FROM vendor_resources r
          WHERE r.resource_type='account' AND r.status<>'archived'
            AND json_extract(r.config_json,'$.platform') IN ('openai','codex')
            AND json_extract(r.config_json,'$.execution_kind')='gateway_worker'
            AND EXISTS (SELECT 1 FROM gateway_worker_account_bindings b WHERE b.account_resource_id=r.id)
            AND COALESCE(json_extract(r.config_json,'$.subscription.checked_at'),'') < ?
          ORDER BY COALESCE(json_extract(r.config_json,'$.subscription.checked_at'),''), r.id`,
        before,
      )
    ).map((row) => row.id)
  }

  // Worker 心跳上报的账号额度快照（已合并响应头、流内 rate_limits 与 /wham/usage）：
  // 控制面已有更新的快照（单账号查询、Receipt）时跳过，否则写回该账号的全部绑定
  async recordRuntimeQuotas(instanceId, items = []) {
    let changed = 0
    for (const item of Array.isArray(items) ? items : []) {
      const quota = item?.quota
      if (!quota || typeof quota !== 'object' || Array.isArray(quota)) continue
      const binding = await this.findAccountByRuntime(instanceId, String(item.account_id || ''))
      if (!binding) continue
      const current = parse(binding.quota_json, null)
      if (current && quotaStamp(current) > quotaStamp(quota)) continue
      changed += await this.recordAccountQuota(binding.account_resource_id, quota)
    }
    return changed
  }

  async recordRuntimeEvents(instanceId, events) {
    if (!events || typeof events !== 'object' || Array.isArray(events)) return
    const pick = {
      stream_id: String(events.stream_id || '').slice(0, 64),
      required: events.required === true,
      head: Number(events.head) || 0,
      acked: Number(events.acked) || 0,
      backlog_bytes: Number(events.backlog_bytes) || 0,
      healthy: events.healthy === true,
      ...(events.error ? { error: String(events.error).slice(0, 200) } : {}),
      reported_at: now(),
    }
    await this.c.run(
      'UPDATE gateway_worker_instances SET executor_events_json=? WHERE id=?',
      JSON.stringify(pick),
      instanceId,
    )
  }

  // 事实直读 primary（设计第 19 节 G3）：实例自己从库里读账号。它上报的读取进度不落后于库里的事实序列、且没有读取错误时，
  // 把它的绑定标为已同步（读取出错的账号标为 drifted）；墓碑账号的绑定直接去掉（Worker 按墓碑删除本地账号）
  async markFactsSynced(instanceId, facts) {
    if (!facts || typeof facts !== 'object' || facts.status?.last_error) return
    const seq = Number((await this.c.one('SELECT value FROM gateway_fact_seq WHERE id=1'))?.value || 0)
    if (!(Number(facts.status?.seq) >= seq)) return
    const listed = Array.isArray(facts.fact_errors) ? facts.fact_errors : []
    const errored = new Set(listed.map((item) => String(item?.account || '')))
    // 上报的出错列表不完整（截断）时，没列出的账号不能据此判为已同步：只更新列出的出错账号
    const complete = !(Number(facts.status?.with_errors) > listed.length)
    const at = now()
    // 只有健康、接单中的实例才标记（迁移 130 起绑定不记实例；不健康却自报接单、或 Drain 中的旧实例不能覆盖）
    if (!(await this.acceptingInstance(instanceId))) return
    await this.c.tx(async () => {
      await this.c.run(
        `DELETE FROM gateway_worker_account_bindings WHERE account_resource_id IN
           (SELECT id FROM vendor_resources WHERE deleted_at IS NOT NULL)`,
      )
      for (const binding of await this.c.many(
        'SELECT account_resource_id, projection_status, projection_error FROM gateway_worker_account_bindings',
      )) {
        const failed = errored.has(binding.account_resource_id)
        if (!failed && !complete) continue
        const status = failed ? 'drifted' : 'synced'
        const error = failed ? 'facts_unreadable' : null
        if (binding.projection_status === status && (binding.projection_error || null) === error) continue
        await this.c.run(
          'UPDATE gateway_worker_account_bindings SET projection_status=?, projection_error=?, last_projected_at=?, updated_at=? WHERE account_resource_id=?',
          status,
          error,
          at,
          at,
          binding.account_resource_id,
        )
      }
    })
  }

  // Gateway 事实直读（设计第 19 节）：心跳上报的读取状态与读不出的账号，只保留展示与排障需要的字段
  async recordFacts(instanceId, facts) {
    if (!facts || typeof facts !== 'object') {
      await this.c.run('UPDATE gateway_worker_instances SET facts_json=NULL WHERE id=?', instanceId)
      return
    }
    const status = facts.status || {}
    const items = (list) =>
      Array.isArray(list)
        ? list.slice(0, 20).map((item) => ({
            account: String(item?.account || '').slice(0, 80),
            fields: Array.isArray(item?.fields) ? item.fields.slice(0, 30).map((f) => String(f).slice(0, 60)) : [],
          }))
        : []
    const pick = {
      mode: String(facts.mode || '').slice(0, 20),
      contract: Number(status.contract) || 0,
      seq: Number(status.seq) || 0,
      accounts: Number(status.accounts) || 0,
      with_errors: Number(status.with_errors) || 0,
      ...(status.loaded_at ? { loaded_at: String(status.loaded_at).slice(0, 40) } : {}),
      ...(status.last_error ? { last_error: String(status.last_error).slice(0, 300) } : {}),
      fact_errors: items(facts.fact_errors),
      reported_at: now(),
    }
    await this.c.run('UPDATE gateway_worker_instances SET facts_json=? WHERE id=?', JSON.stringify(pick), instanceId)
  }

  // 心跳负载：实例峰值在途与各运行账号在途（每次心跳上报完整集合，未列出的账号视为 0；账号在途只采信接单中的实例）
  async recordRuntimeLoad(instanceId, { peak_concurrency: peak, account_inflight: inflight } = {}) {
    const accepting = await this.acceptingInstance(instanceId)
    await this.c.tx(async (tx) => {
      if (Number.isFinite(Number(peak)))
        await tx.run(
          'UPDATE gateway_worker_instances SET peak_concurrency=? WHERE id=?',
          Math.max(0, Math.trunc(Number(peak))),
          instanceId,
        )
      if (!Array.isArray(inflight) || !accepting) return
      await tx.run('UPDATE gateway_worker_account_bindings SET inflight=0 WHERE inflight<>0')
      for (const item of inflight) {
        const n = Math.trunc(Number(item?.in_flight))
        if (item?.account_id && n > 0)
          await tx.run(
            'UPDATE gateway_worker_account_bindings SET inflight=? WHERE runtime_account_id=?',
            n,
            String(item.account_id),
          )
      }
    })
  }

  // 心跳凭据终态：每次心跳上报完整集合，未列出的账号视为凭据可用（刷新成功、重新授权后自动清除）
  async recordRuntimeCredentials(instanceId, items) {
    if (!Array.isArray(items) || !(await this.acceptingInstance(instanceId))) return
    await this.c.tx(async (tx) => {
      await tx.run('UPDATE gateway_worker_account_bindings SET credential_state=NULL,credential_error=NULL')
      const text = (value, max) => String(value || '').slice(0, max) || null
      for (const item of items) {
        const state = text(item?.credential_state, 32)
        if (item?.account_id && state)
          await tx.run(
            'UPDATE gateway_worker_account_bindings SET credential_state=?,credential_error=? WHERE runtime_account_id=?',
            state,
            text(item.last_error, 256),
            String(item.account_id),
          )
      }
    })
  }

  // 重新授权成功：凭据库已换成新代次，原生凭据终态立即清除，不等下一次心跳或事件
  async clearRuntimeCredentialState(runtimeAccountId) {
    await this.c.run(
      'UPDATE gateway_worker_account_bindings SET credential_state=NULL,credential_error=NULL WHERE runtime_account_id=?',
      String(runtimeAccountId),
    )
  }

  // 账号错误保护冻结：Worker 每次心跳上报完整集合（替换旧记录），供应商门户据此显示冷却
  async recordAccountFreezes(instanceId, freezes = []) {
    const now = new Date().toISOString()
    // 先逐个解析运行账号到账号资源（与原实现一样在事务外读取），再在事务内整体替换
    const rows = []
    for (const item of Array.isArray(freezes) ? freezes : []) {
      const runtime = String(item?.account_id || '')
      const until = Date.parse(item?.frozen_until || '')
      if (!runtime || !Number.isFinite(until)) continue
      const binding = await this.c.one(
        'SELECT account_resource_id FROM gateway_worker_account_bindings WHERE runtime_account_id=?',
        runtime,
      )
      if (binding)
        rows.push({
          resource: binding.account_resource_id,
          until: new Date(until).toISOString(),
          reason: String(item?.reason || '').slice(0, 256) || null,
        })
    }
    await this.c.tx(async (tx) => {
      await tx.run('DELETE FROM gateway_account_freezes WHERE source_instance_id=?', instanceId)
      for (const row of rows)
        await tx.run(
          'INSERT OR REPLACE INTO gateway_account_freezes(account_resource_id,source_instance_id,frozen_until,reason,updated_at) VALUES(?,?,?,?,?)',
          row.resource,
          instanceId,
          row.until,
          row.reason,
          now,
        )
    })
  }

  // Gateway 账号的轻量列表（凭据收录脚本用）：不做账号列表页的用量聚合与关联子查询，不含永久删除的墓碑
  async listGatewayAccountRows() {
    return (
      await this.c.many(
        `SELECT id,status,config_json,secret_json FROM vendor_resources
          WHERE resource_type='account' AND json_extract(config_json,'$.platform') IN ('openai','codex')
            AND json_extract(config_json,'$.execution_kind')='gateway_worker' AND deleted_at IS NULL
          ORDER BY updated_at DESC`,
      )
    ).map((row) => ({ id: row.id, status: row.status, config: parse(row.config_json), secret_json: row.secret_json }))
  }

  // 账号绑定（每个账号一行，迁移 130 起不记实例）：运行账号 ID、凭据代次、Worker 是否已读到事实；
  // 同步状态由心跳读取进度更新（markFactsSynced）
  async recordAccountBinding({
    accountResourceId,
    runtimeAccountId,
    credentialRevision = 0,
    status = 'pending',
    error = null,
  } = {}) {
    if (!accountResourceId || !runtimeAccountId) return
    const stamp = now()
    await this.c.run(
      `INSERT INTO gateway_worker_account_bindings(id,account_resource_id,runtime_account_id,credential_revision,projection_status,projection_error,last_projected_at,last_seen_at,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(account_resource_id) DO UPDATE SET
         runtime_account_id=excluded.runtime_account_id,
         credential_revision=MAX(excluded.credential_revision,gateway_worker_account_bindings.credential_revision),
         projection_status=excluded.projection_status,
         projection_error=excluded.projection_error,
         last_projected_at=COALESCE(excluded.last_projected_at,gateway_worker_account_bindings.last_projected_at),
         last_seen_at=excluded.last_seen_at,
         updated_at=excluded.updated_at`,
      `binding_${accountResourceId}`,
      accountResourceId,
      runtimeAccountId,
      credentialRevision,
      status,
      error,
      status === 'synced' ? stamp : null,
      stamp,
      stamp,
      stamp,
    )
  }

  // 运行账号 ID 每个账号唯一（迁移 128）：回执、事件与额度按运行账号归属，不看上报的实例（替换实例后旧实例的
  // 回执仍记到同一账号）；instanceId 只用来拒绝空调用（上游文件 handle-protocol.mjs 等按两个参数调用）
  async findAccountByRuntime(instanceId, runtimeAccountId) {
    if (!instanceId || !runtimeAccountId) return null
    const row = await this.c.one(
      `SELECT b.*,r.vendor_id,r.name,r.status,r.config_json,r.deleted_at
           FROM gateway_worker_account_bindings b
           JOIN vendor_resources r ON r.id=b.account_resource_id
          WHERE b.runtime_account_id=? LIMIT 1`,
      runtimeAccountId,
    )
    return row ? { ...row, config: parse(row.config_json) } : null
  }

  async updateBindingFromReceipt(receipt = {}) {
    const binding = await this.findAccountByRuntime(receipt.gateway_instance_id, receipt.runtime_account_id)
    if (!binding) return null
    const revision = Number(receipt.credential_revision || binding.credential_revision || 0)
    await this.c.run(
      `UPDATE gateway_worker_account_bindings
            SET credential_revision=CASE WHEN ? > credential_revision THEN ? ELSE credential_revision END,
                quota_json=COALESCE(?,quota_json),runtime_status=COALESCE(?,runtime_status),last_error=COALESCE(?,last_error),last_seen_at=?,updated_at=?
          WHERE account_resource_id=?`,
      revision,
      revision,
      mergeReceiptQuota(binding.quota_json, receipt.quota),
      receipt.terminal_state || null,
      receipt.error_message || null,
      receipt.finished_at || now(),
      now(),
      binding.account_resource_id,
    )
    return {
      ...binding,
      credential_revision: Math.max(revision, Number(binding.credential_revision || 0)),
    }
  }

  async createDispatch({ requestId, attemptId, instanceId, scope = {}, protocol, model, nonce, expiresAt }) {
    const dispatchId = id('dispatch')
    await this.c.run(
      `INSERT INTO gateway_worker_dispatches(dispatch_id,request_id,attempt_id,gateway_instance_id,scope_json,protocol,model,nonce_hash,expires_at,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,'created',?)`,
      dispatchId,
      requestId,
      attemptId || null,
      instanceId,
      JSON.stringify(scope),
      protocol || null,
      model || null,
      crypto.createHash('sha256').update(String(nonce)).digest('hex'),
      expiresAt,
      now(),
    )
    return dispatchId
  }

  // instanceId：只改该实例的派发（回执路径传入，审查 P0-4）；控制面自己更新派发状态时不传
  async markDispatch(dispatchId, status, extra = {}, instanceId = null) {
    await this.c.run(
      `UPDATE gateway_worker_dispatches SET status=?,receipt_id=COALESCE(?,receipt_id),sent_at=COALESCE(?,sent_at),completed_at=COALESCE(?,completed_at) WHERE dispatch_id=? AND (? IS NULL OR gateway_instance_id=?)`,
      status,
      extra.receipt_id || null,
      extra.sent_at || null,
      extra.completed_at || null,
      dispatchId,
      instanceId,
      instanceId,
    )
  }

  async ingestReceipt(receipt = {}) {
    const stamp = now()
    const claimedHash = String(receipt.payload_hash || '').trim()
    const unsigned = { ...receipt }
    delete unsigned.payload_hash
    const payload = stableJson(unsigned)
    const hash = crypto.createHash('sha256').update(payload).digest('hex')
    if (claimedHash && claimedHash !== hash)
      return { rejected: true, code: 'receipt_integrity_failed', message: 'Receipt payload hash mismatch' }
    // 回执只能写回执实例自己的派发（审查 P0-4）：派发登记的实例与回执实例不一致时拒绝
    const dispatch = receipt.dispatch_id
      ? await this.c.one(
          'SELECT gateway_instance_id FROM gateway_worker_dispatches WHERE dispatch_id=?',
          String(receipt.dispatch_id),
        )
      : null
    if (dispatch && dispatch.gateway_instance_id !== String(receipt.gateway_instance_id || ''))
      return {
        rejected: true,
        status: 403,
        code: 'receipt_instance_mismatch',
        message: 'Receipt instance does not own the dispatch',
      }
    // 回执抢占（R19）：同一（实例, dispatch）的事件重放时只有 INSERT 成功的一方走首次入账；冲突方按重复回执处理
    // （只补技术事实、不重复写派发状态）。判定与写入在同一事务里。回执只经事件按序到达（2026-11-07 S2），不再判 late
    return this.c.tx(async () => {
      const integrityState = 'verified'
      const receiptId = String(receipt.receipt_id || id('receipt'))
      const claimed = await this.c.run(
        `INSERT INTO gateway_worker_receipts(receipt_id,dispatch_id,request_id,attempt_id,gateway_instance_id,sequence,payload_hash,runtime_account_id,credential_revision,send_state,terminal_state,upstream_status,upstream_model,usage_confidence,usage_json,quota_json,quota_confidence,headers_json,integrity_state,error_code,error_message,started_at,first_byte_at,finished_at,received_at,created_at,applied_at,replay_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(gateway_instance_id,dispatch_id) DO NOTHING`,
        receiptId,
        receipt.dispatch_id,
        receipt.request_id,
        receipt.attempt_id || null,
        receipt.gateway_instance_id,
        receipt.sequence || null,
        hash,
        receipt.runtime_account_id || null,
        receipt.credential_revision || null,
        receipt.send_state || null,
        receipt.terminal_state || null,
        receipt.upstream_status || null,
        receipt.upstream_model || null,
        receipt.usage_confidence || 'unknown',
        JSON.stringify(usageForStorage(receipt.usage || null)),
        receipt.quota ? JSON.stringify(receipt.quota) : null,
        receipt.quota_confidence || 'unknown',
        receipt.headers ? JSON.stringify(receipt.headers) : null,
        integrityState,
        receipt.error_code || null,
        receipt.error_message || null,
        receipt.started_at || null,
        receipt.first_byte_at || null,
        receipt.finished_at || null,
        stamp,
        stamp,
        stamp,
        receipt.payload_hash || hash,
      )
      if (!claimed.changes) {
        const existing = await this.c.one(
          'SELECT receipt_id FROM gateway_worker_receipts WHERE gateway_instance_id=? AND dispatch_id=?',
          receipt.gateway_instance_id,
          receipt.dispatch_id,
        )
        const usage = receipt.usage && typeof receipt.usage === 'object' ? receipt.usage : null
        await this.c.run(
          `UPDATE gateway_worker_receipts SET usage_json=COALESCE(?,usage_json),usage_confidence=CASE WHEN ?='complete' THEN 'complete' ELSE usage_confidence END,
              quota_json=COALESCE(?,quota_json),quota_confidence=CASE WHEN ? IN ('complete','explicit_zero') THEN ? ELSE quota_confidence END,
              headers_json=COALESCE(?,headers_json),upstream_status=COALESCE(?,upstream_status),upstream_model=COALESCE(?,upstream_model),terminal_state=COALESCE(?,terminal_state),finished_at=COALESCE(?,finished_at)
             WHERE receipt_id=?`,
          usage ? JSON.stringify(usageForStorage(usage)) : null,
          receipt.usage_confidence || null,
          receipt.quota ? JSON.stringify(receipt.quota) : null,
          receipt.quota_confidence || null,
          receipt.quota_confidence || null,
          receipt.headers ? JSON.stringify(receipt.headers) : null,
          receipt.upstream_status || null,
          receipt.upstream_model || null,
          receipt.terminal_state || null,
          receipt.finished_at || null,
          existing.receipt_id,
        )
        await this.applyReceiptToUsage(
          receipt,
          await this.findAccountByRuntime(receipt.gateway_instance_id, receipt.runtime_account_id),
        )
        return { duplicate: true, receipt_id: existing.receipt_id }
      }
      const binding = await this.updateBindingFromReceipt(receipt)
      await this.applyReceiptToUsage(receipt, binding)
      await this.attachReceiptToReconciliation({
        gatewayInstanceId: receipt.gateway_instance_id,
        dispatchId: receipt.dispatch_id,
        receiptId,
        model: receipt.upstream_model || null,
        usage: receipt.usage || null,
      })
      await this.markDispatch(
        receipt.dispatch_id,
        receipt.terminal_state === 'cancelled' ? 'cancelled' : 'completed',
        { receipt_id: receiptId, completed_at: stamp },
        String(receipt.gateway_instance_id || ''),
      )
      return { duplicate: false, receipt_id: receiptId, binding }
    })
  }

  // 回执只补齐已有的待结算任务（实时日志判定待结算时带计费上下文入队），不为已结算或不计量的请求新建任务；
  // 回执先于任务到达时，对账器处理任务时按 dispatch 读取回执表
  async attachReceiptToReconciliation({
    gatewayInstanceId,
    dispatchId,
    receiptId = null,
    model = null,
    usage = null,
  } = {}) {
    if (!gatewayInstanceId || !dispatchId) return
    const stamp = now()
    await this.c.run(
      `UPDATE gateway_worker_reconciliation_jobs SET receipt_id=COALESCE(?,receipt_id),model=COALESCE(model,?),usage_json=COALESCE(?,usage_json),
           status=CASE WHEN status='settled' THEN status ELSE 'pending' END,next_attempt_at=?,updated_at=?
         WHERE gateway_instance_id=? AND dispatch_id=?`,
      receiptId,
      model,
      usage ? JSON.stringify(usageForStorage(usage)) : null,
      stamp,
      stamp,
      gatewayInstanceId,
      dispatchId,
    )
  }

  async enqueueReconciliation(input = {}) {
    const job = reconciliationJob(input)
    if (!job) return null
    await this.c.run(ENQUEUE_RECONCILIATION_SQL, ...job.params)
    return job.id
  }

  // 租约过期仍是 running 的任务（抢到后进程崩溃，或收尾写入失败）也重新领取（R6 复审）：否则使用记录永远停在
  // settlement_pending，既不扣费也不进死信。重复结算由 billing_charges 主键抢占保证只扣一次（R4）。
  async dueReconciliation(limit = 25) {
    const at = now()
    return await this.c.many(
      "SELECT * FROM gateway_worker_reconciliation_jobs WHERE ((status='pending' AND (lease_until IS NULL OR lease_until<=?)) OR (status='running' AND lease_until IS NOT NULL AND lease_until<=?)) AND (next_attempt_at IS NULL OR next_attempt_at<=?) ORDER BY created_at LIMIT ?",
      at,
      at,
      at,
      limit,
    )
  }

  async leaseReconciliation(idValue, leaseUntil) {
    const at = now()
    const result = await this.c.run(
      "UPDATE gateway_worker_reconciliation_jobs SET status='running',lease_until=?,attempts=attempts+1,updated_at=? WHERE id=? AND (status='pending' OR (status='running' AND lease_until IS NOT NULL AND lease_until<=?))",
      leaseUntil,
      at,
      idValue,
      at,
    )
    return result.changes > 0
  }

  async finishReconciliation(idValue, status, { error = null, retryAt = null } = {}) {
    await this.c.run(
      'UPDATE gateway_worker_reconciliation_jobs SET status=?,last_error=?,next_attempt_at=?,lease_until=NULL,updated_at=? WHERE id=?',
      status,
      error,
      retryAt,
      now(),
      idValue,
    )
  }

  async applyReceiptToUsage(receipt = {}, binding = null) {
    // 入站回执带解析后的 usage；对账任务传入的是数据库行，usage 在 usage_json 里
    const stored = parse(receipt.usage_json, null)
    const raw =
      receipt.usage && typeof receipt.usage === 'object'
        ? receipt.usage
        : stored && typeof stored === 'object'
          ? stored
          : {}
    // 与 VM 路径和请求日志同一口径：OpenAI 包含式 usage 先转为不相交字段（input 扣除缓存读写，
    // reasoning 只作 output 的子集记录，不额外计费）
    const usage = normalizeUsage(disjointOpenaiUsage(raw) || {})
    const input = Number(usage.input_tokens ?? 0)
    const output = Number(usage.output_tokens ?? 0)
    const cacheRead = Number(usage.cache_read_tokens ?? 0)
    const cacheWrite = usage.cache_creation_tokens == null ? null : Number(usage.cache_creation_tokens)
    // 只改该实例自己派发的使用记录（审查 P0-4、复审 P2-6）：派发行必须存在且属于回执实例；派发行不存在（孤立记录）
    // 或回执没有实例时一律不改写；实时日志已记下实例时还必须一致
    const instanceId = receipt.gateway_instance_id ? String(receipt.gateway_instance_id) : null
    if (!instanceId) return null
    const row = await this.c.one(
      `SELECT * FROM usage_logs WHERE execution_kind='gateway_worker' AND dispatch_id=? AND (gateway_instance_id IS NULL OR gateway_instance_id=?)
          AND EXISTS (SELECT 1 FROM gateway_worker_dispatches d WHERE d.dispatch_id=usage_logs.dispatch_id AND d.gateway_instance_id=?) LIMIT 1`,
      receipt.dispatch_id,
      instanceId,
      instanceId,
    )
    if (!row) return null
    const accountResourceId = binding?.account_resource_id || row.account_resource_id || null
    // 没有 token 证据时不计价：0 元结果会经 COALESCE 覆盖实时日志已算好的成本。
    // 实时日志已按完整 usage 计价（含冻结报价与按张/按次的分组媒体规则）时，回执只补技术事实，不重算成本
    const hasTokens = input > 0 || output > 0 || cacheRead > 0 || (Number.isFinite(cacheWrite) && cacheWrite > 0)
    // 对账任务带着准入时冻结的报价：按它计价，与客户实扣同一口径（审计 P2-6）；入站回执没有上下文时按当前价目
    const frozen = parse(receipt.context_json, null)
    const pricing = frozen?.quote_json
      ? { resolvedPrice: parse(frozen.quote_json, null), media: parse(frozen.media_json, null) }
      : undefined
    const priced =
      receipt.usage_confidence === 'complete' && hasTokens && row.usage_confidence !== 'complete'
        ? costColumnsFromUsage(usage, receipt.upstream_model || row.model, null, pricing)
        : {}
    await this.c.run(
      `UPDATE usage_logs SET receipt_id=COALESCE(?,receipt_id),account_resource_id=COALESCE(?,account_resource_id),
          gateway_instance_id=COALESCE(?,gateway_instance_id),vm_id=COALESCE(vm_id,CASE WHEN ? IS NOT NULL THEN 'gateway:'||? END),usage_confidence=CASE WHEN ?='complete' OR usage_confidence IS NULL THEN ? ELSE usage_confidence END,
          input_tokens=CASE WHEN ? > 0 THEN ? ELSE input_tokens END,
          output_tokens=CASE WHEN ? > 0 THEN ? ELSE output_tokens END,
          cache_read_tokens=CASE WHEN ? > 0 THEN ? ELSE cache_read_tokens END,
          cache_creation_tokens=COALESCE(?,cache_creation_tokens),
          ${RECEIPT_COST_COLUMNS.map((c) => `${c}_micros=COALESCE(?,${c}_micros),${c}=COALESCE(?,${c})`).join(',')},pricing_model=COALESCE(?,pricing_model),price_source=COALESCE(?,price_source),price_version=COALESCE(?,price_version),
          upstream_model=COALESCE(?,upstream_model),
          final_state=CASE WHEN final_state IS NULL OR final_state='ambiguous' THEN COALESCE(?,final_state) ELSE final_state END
        WHERE execution_kind='gateway_worker' AND dispatch_id=? AND (gateway_instance_id IS NULL OR gateway_instance_id=?)
          AND EXISTS (SELECT 1 FROM gateway_worker_dispatches d WHERE d.dispatch_id=usage_logs.dispatch_id AND d.gateway_instance_id=?)`,
      receipt.receipt_id || null,
      accountResourceId,
      receipt.gateway_instance_id || null,
      accountResourceId,
      accountResourceId,
      receipt.usage_confidence || null,
      receipt.usage_confidence || null,
      input,
      input,
      output,
      output,
      cacheRead,
      cacheRead,
      Number.isFinite(cacheWrite) ? cacheWrite : null,
      // 金额（M6）：整数列为权威值，REAL 镜像同时写
      ...RECEIPT_COST_COLUMNS.flatMap((c) => [priced[c + '_micros'] ?? null, priced[c] ?? null]),
      priced.pricing_model ?? null,
      priced.price_source ?? null,
      priced.price_version ?? null,
      receipt.upstream_model || null,
      // 状态码与终态是 Node 交付给调用方的事实（流内失败时上游 HTTP 仍是 200），回执只补全未知终态
      receipt.terminal_state === 'completed' ? 'verified' : receipt.terminal_state || null,
      receipt.dispatch_id,
      instanceId,
      instanceId,
    )
    const updated = await this.c.one(
      "SELECT * FROM usage_logs WHERE execution_kind='gateway_worker' AND dispatch_id=? LIMIT 1",
      receipt.dispatch_id,
    )
    if (
      updated?.execution_kind === 'gateway_worker' &&
      updated.account_resource_id &&
      updated.status >= 200 &&
      updated.status < 300 &&
      updated.total_cost != null
    ) {
      const resource = await gatewayAccountResource(this.db, updated.account_resource_id)
      if (resource?.vendor_id) await insertUsageFact(this.db, updated, resource, { id: id('usage'), createdAt: now() })
    }
    return updated
  }

  async listReceipts(requestId) {
    return await this.c.many('SELECT * FROM gateway_worker_receipts WHERE request_id=? ORDER BY created_at', requestId)
  }

  // 账号详情：Receipt 只记录 Worker 实例与运行时账号，经绑定关联到账号资源
  async listAccountReceipts(accountResourceId, limit = 50) {
    return await this.c.many(
      `SELECT r.* FROM gateway_worker_receipts r
           JOIN gateway_worker_account_bindings b ON b.runtime_account_id=r.runtime_account_id
          WHERE b.account_resource_id=? ORDER BY r.created_at DESC LIMIT ?`,
      accountResourceId,
      Math.max(1, Math.min(500, Number(limit) || 50)),
    )
  }
}
