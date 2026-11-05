import crypto from 'node:crypto'
import { getDb, withTransaction } from '../db/database.mjs'
import { usageForStorage } from '../core/usage-persist.mjs'
import { costColumnsFromUsage, normalizeUsage, shanghaiDayStartIso } from '../admin/pricing.mjs'
import { disjointOpenaiUsage } from '../protocol/openai-usage.mjs'
import { ERROR_PRED, SUCCESS_PRED, totalTokens } from '../db/repos/usage-log-preds.mjs'
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

  listInstances() {
    return this.db
      .prepare('SELECT * FROM gateway_worker_instances ORDER BY name, id')
      .all()
      .map((row) => ({
        ...row,
        capabilities: parse(row.capabilities_json),
        capabilities_json: undefined,
        executor_events: parse(row.executor_events_json),
        executor_events_json: undefined,
        shared_state: parse(row.shared_state_json),
        shared_state_json: undefined,
      }))
  }

  getInstance(instanceId) {
    const row = this.db.prepare('SELECT * FROM gateway_worker_instances WHERE id=?').get(instanceId)
    if (!row) return null
    return { ...row, capabilities: parse(row.capabilities_json) }
  }

  upsertInstance(input = {}) {
    const stamp = now()
    const instanceId = String(input.id || id('gw')).trim()
    const existing = this.getInstance(instanceId)
    const protocolVersion = Number(input.protocol_version || existing?.protocol_version || 1)
    const recovering =
      ['healthy', 'degraded'].includes(String(input.health_state || '')) && existing?.admission_state === 'expired'
    const admission = protocolVersion < 1 ? 'blocked' : input.admission_state || (recovering ? 'admitted' : null)
    if (existing) {
      this.db
        .prepare(
          `UPDATE gateway_worker_instances SET name=?,base_url=?,transport=?,region=?,version=?,boot_id=?,protocol_version=?,capabilities_json=?,health_state=?,drain_state=?,active_concurrency=?,queue_depth=?,receipt_backlog=?,last_heartbeat_at=?,tls_fingerprint=COALESCE(?,tls_fingerprint),admission_state=COALESCE(?,admission_state),drain_deadline=COALESCE(?,drain_deadline),certificate_expires_at=COALESCE(?,certificate_expires_at),last_error=COALESCE(?,last_error),updated_at=? WHERE id=?`,
        )
        .run(
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
          input.tls_fingerprint || null,
          admission,
          input.drain_deadline || null,
          input.certificate_expires_at || null,
          input.last_error || null,
          stamp,
          instanceId,
        )
    } else {
      this.db
        .prepare(
          `INSERT INTO gateway_worker_instances(id,name,base_url,transport,region,version,boot_id,protocol_version,capabilities_json,health_state,drain_state,active_concurrency,queue_depth,receipt_backlog,last_heartbeat_at,tls_fingerprint,admission_state,drain_deadline,certificate_expires_at,last_error,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
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
          input.tls_fingerprint || null,
          admission || 'admitted',
          input.drain_deadline || null,
          input.certificate_expires_at || null,
          input.last_error || null,
          stamp,
          stamp,
        )
    }
    return this.getInstance(instanceId)
  }

  setDrain(instanceId, draining, drainDeadline = null) {
    this.db
      .prepare(
        "UPDATE gateway_worker_instances SET drain_state=?,admission_state=CASE WHEN ? THEN admission_state ELSE 'admitted' END,drain_deadline=?,updated_at=? WHERE id=?",
      )
      .run(draining ? 'draining' : 'accepting', draining ? 1 : 0, draining ? drainDeadline : null, now(), instanceId)
    return this.getInstance(instanceId)
  }

  // 单 Worker 模式下占用执行面的实例：健康、接单且 45 秒内有心跳（与 pickInstance 的在线判定一致）
  activeInstances() {
    this.markStaleInstances()
    return this.db
      .prepare(
        `SELECT id FROM gateway_worker_instances
          WHERE health_state IN ('healthy','degraded')
            AND drain_state='accepting'
            AND (last_heartbeat_at IS NULL OR julianday(last_heartbeat_at)>=julianday('now','-45 seconds'))
          ORDER BY id`,
      )
      .all()
      .map((row) => row.id)
  }

  pickInstance({ operation = null, model = null, exclude = null, prefer = null } = {}) {
    this.markStaleInstances()
    const candidates = this.db
      .prepare(
        `SELECT * FROM gateway_worker_instances
          WHERE health_state IN ('healthy','degraded')
            AND drain_state='accepting'
            AND COALESCE(admission_state,'admitted')='admitted'
            AND COALESCE(protocol_version,0)>=1
            AND (certificate_expires_at IS NULL OR julianday(certificate_expires_at) >= julianday('now'))
            AND (last_heartbeat_at IS NULL OR julianday(last_heartbeat_at)>=julianday('now','-45 seconds'))
          ORDER BY active_concurrency ASC,queue_depth ASC,last_heartbeat_at DESC`,
      )
      .all()
      .map((row) => this.getInstance(row.id))
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

  // 实例上尚未同步（pending/drifted/blocked）的运行账号：可能按旧配置接单，执行时逐个排除，
  // 不再因为单个账号未同步就跳过整个实例（单 Worker 部署下会让整个 Gateway 不可用）
  unsyncedRuntimeAccounts(instanceId) {
    return this.db
      .prepare(
        "SELECT runtime_account_id FROM gateway_worker_account_bindings WHERE gateway_instance_id=? AND projection_status NOT IN ('synced','archived')",
      )
      .all(instanceId)
      .map((row) => row.runtime_account_id)
      .filter(Boolean)
  }

  markStaleInstances() {
    try {
      this.db
        .prepare(
          "UPDATE gateway_worker_instances SET health_state='offline',admission_state='expired',last_error='heartbeat_timeout',updated_at=? WHERE health_state IN ('healthy','degraded') AND last_heartbeat_at IS NOT NULL AND julianday(last_heartbeat_at) < julianday('now','-45 seconds')",
        )
        .run(now())
    } catch {}
  }

  listCodexAccounts({ vendorId = null, includeArchived = false } = {}) {
    const conditions = [
      `r.resource_type='account'`,
      `json_extract(r.config_json,'$.platform') IN ('openai','codex')`,
      `json_extract(r.config_json,'$.execution_kind')='gateway_worker'`,
    ]
    const params = []
    if (vendorId) {
      conditions.push('r.vendor_id=?')
      params.push(vendorId)
    }
    if (!includeArchived) conditions.push("r.status<>'archived'")
    const rows = this.db
      .prepare(
        `SELECT r.*,
          (SELECT v.name FROM vendors v WHERE v.id=r.vendor_id) AS vendor_name,
          (SELECT b.gateway_instance_id FROM gateway_worker_account_bindings b WHERE b.account_resource_id=r.id ORDER BY b.updated_at DESC LIMIT 1) AS gateway_instance_id,
          (SELECT b.runtime_account_id FROM gateway_worker_account_bindings b WHERE b.account_resource_id=r.id ORDER BY b.updated_at DESC LIMIT 1) AS runtime_account_id,
          (SELECT b.credential_revision FROM gateway_worker_account_bindings b WHERE b.account_resource_id=r.id ORDER BY b.updated_at DESC LIMIT 1) AS credential_revision,
          (SELECT b.projection_status FROM gateway_worker_account_bindings b WHERE b.account_resource_id=r.id ORDER BY b.updated_at DESC LIMIT 1) AS projection_status,
          (SELECT b.last_seen_at FROM gateway_worker_account_bindings b WHERE b.account_resource_id=r.id ORDER BY b.updated_at DESC LIMIT 1) AS last_seen_at,
          (SELECT b.quota_json FROM gateway_worker_account_bindings b WHERE b.account_resource_id=r.id ORDER BY b.updated_at DESC LIMIT 1) AS quota_json,
          (SELECT b.runtime_status FROM gateway_worker_account_bindings b WHERE b.account_resource_id=r.id ORDER BY b.updated_at DESC LIMIT 1) AS runtime_status,
          (SELECT COALESCE(SUM(b.inflight),0) FROM gateway_worker_account_bindings b JOIN gateway_worker_instances i ON i.id=b.gateway_instance_id
            WHERE b.account_resource_id=r.id AND i.health_state IN ('healthy','degraded')) AS inflight,
          (SELECT b.last_error FROM gateway_worker_account_bindings b WHERE b.account_resource_id=r.id ORDER BY b.updated_at DESC LIMIT 1) AS last_error,
          (SELECT b.credential_state FROM gateway_worker_account_bindings b WHERE b.account_resource_id=r.id ORDER BY b.updated_at DESC LIMIT 1) AS credential_state,
          (SELECT b.credential_error FROM gateway_worker_account_bindings b WHERE b.account_resource_id=r.id ORDER BY b.updated_at DESC LIMIT 1) AS credential_error,
          (SELECT b.bps_state FROM gateway_worker_account_bindings b WHERE b.account_resource_id=r.id ORDER BY b.updated_at DESC LIMIT 1) AS bps_state,
          (SELECT b.bps_error FROM gateway_worker_account_bindings b WHERE b.account_resource_id=r.id ORDER BY b.updated_at DESC LIMIT 1) AS bps_error,
          (SELECT b.bps_blocked_at FROM gateway_worker_account_bindings b WHERE b.account_resource_id=r.id ORDER BY b.updated_at DESC LIMIT 1) AS bps_blocked_at,
          (SELECT b.bps_recovery FROM gateway_worker_account_bindings b WHERE b.account_resource_id=r.id ORDER BY b.updated_at DESC LIMIT 1) AS bps_recovery,
          (SELECT b.bps_next_probe_at FROM gateway_worker_account_bindings b WHERE b.account_resource_id=r.id ORDER BY b.updated_at DESC LIMIT 1) AS bps_next_probe_at,
          (SELECT b.bps_cooldown_until FROM gateway_worker_account_bindings b WHERE b.account_resource_id=r.id ORDER BY b.updated_at DESC LIMIT 1) AS bps_cooldown_until,
          (SELECT COUNT(*) FROM gateway_worker_account_bindings b WHERE b.account_resource_id=r.id) AS gateway_instance_count,
          (SELECT COUNT(*) FROM gateway_worker_account_bindings b WHERE b.account_resource_id=r.id AND b.projection_status='synced') AS synced_instance_count
        FROM vendor_resources r WHERE ${conditions.join(' AND ')} ORDER BY r.updated_at DESC`,
      )
      .all(...params)
    const usage = this.codexAccountUsage(rows.map((row) => ({ id: row.id, quota: parse(row.quota_json, null) })))
    return rows.map((row) => {
      const config = parse(row.config_json)
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
        quota: parse(row.quota_json, null),
        usage: usage.get(row.id) || emptyAccountUsage(),
      }
    })
  }

  /** Same request/cost facts as the VM list, keyed by the Gateway account resource.
   * 5H/7D follow the account's own quota windows when the Worker reported a reset
   * (an elapsed reset starts the new window, as `extraWindowSince` does for VM rows);
   * otherwise they fall back to rolling windows. */
  codexAccountUsage(accounts, at = Date.now()) {
    const out = new Map()
    if (!accounts.length) return out
    const start = (window, fallbackMinutes) => {
      const minutes = Number(window?.window_minutes) || fallbackMinutes
      return extraWindowSince(window?.reset_at, minutes * 60000, at) ?? at - fallbackMinutes * 60000
    }
    const ids = accounts.map((a) => a.id)
    // Whole hours from the hourly rollup (migration 093); each window's partial first hour from usage_logs.
    const hoursById = new Map(ids.map((id) => [id, []]))
    for (const row of this.db
      .prepare(
        `SELECT resource_ref AS id, hour, ${rollupMeasures(SUCCESS_PRED, ERROR_PRED)} FROM ${ROLLUP_SOURCE}
          WHERE execution_kind='gateway_worker' AND account_resource_id IN (${ids.map(() => '?').join(',')})
          GROUP BY account_resource_id, hour`,
      )
      .all(...ids))
      hoursById.get(row.id)?.push(row)
    const edge = this.db.prepare(
      `SELECT ${rawMeasures(SUCCESS_PRED, ERROR_PRED)} FROM usage_logs
        WHERE account_resource_id=? AND execution_kind='gateway_worker' AND created_at>=? AND created_at<?`,
    )
    const day = Date.parse(shanghaiDayStartIso(new Date(at)))
    for (const account of accounts) {
      const hours = hoursById.get(account.id) || []
      const since = (ms) => {
        const end = ceilHourMs(ms)
        const from = hourKey(end)
        const rows = hours.filter((row) => row.hour >= from)
        if (end > ms) rows.push(edge.get(account.id, new Date(ms).toISOString(), new Date(end).toISOString()))
        return addRollupBuckets(rows)
      }
      const [five, seven] = gatewayQuotaWindows(account.quota)
      const today = since(day)
      const w5 = since(start(five, 300))
      const w7 = since(start(seven, 10080))
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

  getAccountBinding(accountResourceId, instanceId = null) {
    const row = this.db
      .prepare(
        `SELECT b.*,r.vendor_id,r.name,r.status,r.config_json
           FROM gateway_worker_account_bindings b
           JOIN vendor_resources r ON r.id=b.account_resource_id
          WHERE b.account_resource_id=? ${instanceId ? 'AND b.gateway_instance_id=?' : ''}
          ORDER BY b.updated_at DESC LIMIT 1`,
      )
      .get(...(instanceId ? [accountResourceId, instanceId] : [accountResourceId]))
    return row ? { ...row, config: parse(row.config_json) } : null
  }

  // 额度查询结果是上游账号的完整快照，写回该账号的全部 Worker 绑定
  recordAccountQuota(accountResourceId, quota) {
    if (!quota || typeof quota !== 'object') return 0
    return this.db
      .prepare(
        'UPDATE gateway_worker_account_bindings SET quota_json=?,last_seen_at=?,updated_at=? WHERE account_resource_id=?',
      )
      .run(JSON.stringify(quota), now(), now(), accountResourceId).changes
  }

  // 订阅周期属于上游账号（Worker 读 /backend-api/subscriptions）：只保存到期、续订与计费周期供列表展示。
  // 不进入投影配置，也不改 updated_at（账号列表按它排序）
  recordAccountSubscription(accountResourceId, subscription) {
    const expires = Date.parse(subscription?.expires_at || '')
    if (!Number.isFinite(expires)) return 0
    const period = typeof subscription.billing_period === 'string' ? subscription.billing_period.trim() : ''
    const value = {
      expires_at: new Date(expires).toISOString(),
      will_renew: typeof subscription.will_renew === 'boolean' ? subscription.will_renew : null,
      billing_period: period ? period.slice(0, 32) : null,
      checked_at: now(),
    }
    return this.db
      .prepare(
        "UPDATE vendor_resources SET config_json=json_set(config_json,'$.subscription',json(?)) WHERE id=? AND resource_type='account'",
      )
      .run(JSON.stringify(value), accountResourceId).changes
  }

  // 订阅补查候选：未归档、已有 Worker 绑定，且从未查到或上次查到早于 before（最久未查的在前）
  listSubscriptionRefreshCandidates(before) {
    return this.db
      .prepare(
        `SELECT r.id FROM vendor_resources r
          WHERE r.resource_type='account' AND r.status<>'archived'
            AND json_extract(r.config_json,'$.platform') IN ('openai','codex')
            AND json_extract(r.config_json,'$.execution_kind')='gateway_worker'
            AND EXISTS (SELECT 1 FROM gateway_worker_account_bindings b WHERE b.account_resource_id=r.id)
            AND COALESCE(json_extract(r.config_json,'$.subscription.checked_at'),'') < ?
          ORDER BY COALESCE(json_extract(r.config_json,'$.subscription.checked_at'),''), r.id`,
      )
      .all(before)
      .map((row) => row.id)
  }

  // Worker 心跳上报的账号额度快照（已合并响应头、流内 rate_limits 与 /wham/usage）：
  // 控制面已有更新的快照（单账号查询、Receipt）时跳过，否则写回该账号的全部绑定
  recordRuntimeQuotas(instanceId, items = []) {
    let changed = 0
    for (const item of Array.isArray(items) ? items : []) {
      const quota = item?.quota
      if (!quota || typeof quota !== 'object' || Array.isArray(quota)) continue
      const binding = this.findAccountByRuntime(instanceId, String(item.account_id || ''))
      if (!binding) continue
      const current = parse(binding.quota_json, null)
      if (current && quotaStamp(current) > quotaStamp(quota)) continue
      changed += this.recordAccountQuota(binding.account_resource_id, quota)
    }
    return changed
  }

  // 心跳上报的事件发件箱水位（迁移 101）：只保存已知字段
  // 实例托管公钥（P3.5）：上报的公钥一律先记为待确认，由管理员在「Gateway Worker」页核对指纹并确认后才固定；
  // 新实例的首个公钥也一样（终审 B2：只持有内部令牌的一方不能靠注册一个新实例 ID 拿到托管封装）。
  // trusted：控制面自己拉起的同机 Worker，公钥从本机数据目录直接读出，直接固定。
  // 待确认期间投影回退到实例间共享凭据包（与 worker 托管相同）。
  recordCustodyKey(instanceId, publicKey, { trusted = false } = {}) {
    if (typeof publicKey !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(publicKey)) return
    const row = this.db
      .prepare('SELECT custody_public_key,custody_key_pending FROM gateway_worker_instances WHERE id=?')
      .get(instanceId)
    if (!row) return
    if (trusted && row.custody_public_key !== publicKey)
      this.db
        .prepare('UPDATE gateway_worker_instances SET custody_public_key=?,custody_key_pending=NULL WHERE id=?')
        .run(publicKey, instanceId)
    else if (row.custody_public_key === publicKey) {
      if (row.custody_key_pending)
        this.db.prepare('UPDATE gateway_worker_instances SET custody_key_pending=NULL WHERE id=?').run(instanceId)
    } else if (row.custody_key_pending !== publicKey)
      this.db.prepare('UPDATE gateway_worker_instances SET custody_key_pending=? WHERE id=?').run(publicKey, instanceId)
  }

  // 管理员确认替换托管公钥（待确认的公钥必须与确认时看到的一致）
  acceptCustodyKey(instanceId, publicKey) {
    const result = this.db
      .prepare(
        'UPDATE gateway_worker_instances SET custody_public_key=custody_key_pending,custody_key_pending=NULL WHERE id=? AND custody_key_pending=?',
      )
      .run(instanceId, String(publicKey || ''))
    return Number(result.changes || 0) > 0
  }

  recordRuntimeEvents(instanceId, events) {
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
    this.db
      .prepare('UPDATE gateway_worker_instances SET executor_events_json=? WHERE id=?')
      .run(JSON.stringify(pick), instanceId)
  }

  // 心跳上报的共享运行态（P5，迁移 113）：只保存已知字段，供「Gateway Worker」页展示
  recordSharedState(instanceId, state) {
    if (!state || typeof state !== 'object' || Array.isArray(state)) return
    const pick = {
      backend: state.backend === 'redis' ? 'redis' : 'local',
      ...(state.backend === 'redis'
        ? {
            healthy: state.healthy === true,
            encrypted: state.encrypted === true,
            ...(state.last_error ? { last_error: String(state.last_error).slice(0, 200) } : {}),
            ...(state.last_error_at ? { last_error_at: String(state.last_error_at).slice(0, 40) } : {}),
            leases_held: Number(state.leases?.held) || 0,
            leases_lost_renewed: Number(state.leases?.lost_renewed) || 0,
            remote_holds: Number(state.remote_holds) || 0,
          }
        : {}),
      reported_at: now(),
    }
    this.db
      .prepare('UPDATE gateway_worker_instances SET shared_state_json=? WHERE id=?')
      .run(JSON.stringify(pick), instanceId)
  }

  // 心跳负载：实例峰值在途与各运行账号在途（每次心跳上报完整集合，未列出的账号视为 0）
  recordRuntimeLoad(instanceId, { peak_concurrency: peak, account_inflight: inflight } = {}) {
    withTransaction(this.db, () => {
      if (Number.isFinite(Number(peak)))
        this.db
          .prepare('UPDATE gateway_worker_instances SET peak_concurrency=? WHERE id=?')
          .run(Math.max(0, Math.trunc(Number(peak))), instanceId)
      if (!Array.isArray(inflight)) return
      this.db
        .prepare('UPDATE gateway_worker_account_bindings SET inflight=0 WHERE gateway_instance_id=?')
        .run(instanceId)
      const update = this.db.prepare(
        'UPDATE gateway_worker_account_bindings SET inflight=? WHERE gateway_instance_id=? AND runtime_account_id=?',
      )
      for (const item of inflight) {
        const n = Math.trunc(Number(item?.in_flight))
        if (item?.account_id && n > 0) update.run(n, instanceId, String(item.account_id))
      }
    })
  }

  // BPS 403 恢复探测记录（迁移 096）：按运行账号映射到账号资源，重复上报按（实例、运行账号、时刻）去重，保留 30 天
  recordBpsProbes(instanceId, items) {
    if (!Array.isArray(items) || !items.length) return
    const now = new Date().toISOString()
    const binding = this.db.prepare(
      'SELECT account_resource_id FROM gateway_worker_account_bindings WHERE gateway_instance_id=? AND runtime_account_id=?',
    )
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO gateway_bps_probes(account_resource_id,gateway_instance_id,runtime_account_id,probed_at,model,ok,status,error_code,input_tokens,output_tokens,total_tokens,duration_ms,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    const count = (value) => (Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : 0)
    withTransaction(this.db, () => {
      for (const item of items.slice(0, 200)) {
        const runtimeId = String(item?.account_id || '')
        const probedAt = Date.parse(item?.probed_at)
        const resource = runtimeId && binding.get(instanceId, runtimeId)
        if (!resource || !Number.isFinite(probedAt)) continue
        insert.run(
          resource.account_resource_id,
          instanceId,
          runtimeId,
          new Date(probedAt).toISOString(),
          String(item.model || '').slice(0, 128),
          item.ok === true ? 1 : 0,
          Number.isInteger(item.status) ? item.status : null,
          item.error_code ? String(item.error_code).slice(0, 64) : null,
          count(item.input_tokens),
          count(item.output_tokens),
          count(item.total_tokens),
          count(item.duration_ms),
          now,
        )
      }
      this.db
        .prepare('DELETE FROM gateway_bps_probes WHERE probed_at < ?')
        .run(new Date(Date.now() - 30 * 86400_000).toISOString())
    })
  }

  listBpsProbes(accountResourceId, limit = 20) {
    return this.db
      .prepare(
        'SELECT probed_at,model,ok,status,error_code,input_tokens,output_tokens,total_tokens,duration_ms FROM gateway_bps_probes WHERE account_resource_id=? ORDER BY probed_at DESC LIMIT ?',
      )
      .all(accountResourceId, limit)
      .map((row) => ({ ...row, ok: row.ok === 1 }))
  }

  // 心跳凭据终态：每次心跳上报完整集合，未列出的账号视为凭据可用（刷新成功、重新授权后自动清除）
  recordRuntimeCredentials(instanceId, items) {
    if (!Array.isArray(items)) return
    withTransaction(this.db, () => {
      this.db
        .prepare(
          'UPDATE gateway_worker_account_bindings SET credential_state=NULL,credential_error=NULL,bps_state=NULL,bps_error=NULL,bps_blocked_at=NULL,bps_recovery=NULL,bps_next_probe_at=NULL,bps_cooldown_until=NULL WHERE gateway_instance_id=?',
        )
        .run(instanceId)
      const update = this.db.prepare(
        'UPDATE gateway_worker_account_bindings SET credential_state=?,credential_error=?,bps_state=?,bps_error=?,bps_blocked_at=?,bps_recovery=?,bps_next_probe_at=?,bps_cooldown_until=? WHERE gateway_instance_id=? AND runtime_account_id=?',
      )
      const text = (value, max) => String(value || '').slice(0, max) || null
      for (const item of items) {
        const state = text(item?.credential_state, 32)
        // BPS 附加授权的终态与原生凭据分开记录（迁移 095）；暂停与恢复信息见迁移 097
        const bpsState = text(item?.bps_state, 32)
        const recovery = ['auto', 'stopped', 'off'].includes(item?.bps_recovery) ? item.bps_recovery : null
        const cooldown = text(item?.bps_cooldown_until, 40)
        const bps = bpsState || cooldown
        if (item?.account_id && (state || bps))
          update.run(
            state,
            state ? text(item.last_error, 256) : null,
            bpsState,
            bps ? text(item.bps_error, 64) : null,
            bpsState ? text(item.bps_blocked_at, 40) : null,
            bpsState ? recovery : null,
            bpsState && recovery === 'auto' ? text(item.bps_next_probe_at, 40) : null,
            cooldown,
            instanceId,
            String(item.account_id),
          )
      }
    })
  }

  // 重新授权成功：Worker 已换入新凭据代次并清除终态，绑定立即同步，不等下一次心跳或事件（BPS 状态独立，保留）
  clearRuntimeCredentialState(instanceId, runtimeAccountId) {
    this.db
      .prepare(
        'UPDATE gateway_worker_account_bindings SET credential_state=NULL,credential_error=NULL WHERE gateway_instance_id=? AND runtime_account_id=?',
      )
      .run(instanceId, String(runtimeAccountId))
  }

  // 账号错误保护冻结的跨实例共享：来源实例每次心跳上报完整集合（替换旧记录）
  recordAccountFreezes(instanceId, freezes = []) {
    const now = new Date().toISOString()
    const rows = (Array.isArray(freezes) ? freezes : [])
      .map((item) => {
        const runtime = String(item?.account_id || '')
        const until = Date.parse(item?.frozen_until || '')
        if (!runtime || !Number.isFinite(until)) return null
        const binding = this.db
          .prepare(
            'SELECT account_resource_id FROM gateway_worker_account_bindings WHERE gateway_instance_id=? AND runtime_account_id=?',
          )
          .get(instanceId, runtime)
        return binding
          ? {
              resource: binding.account_resource_id,
              until: new Date(until).toISOString(),
              reason: String(item?.reason || '').slice(0, 256) || null,
            }
          : null
      })
      .filter(Boolean)
    withTransaction(this.db, () => {
      this.db.prepare('DELETE FROM gateway_account_freezes WHERE source_instance_id=?').run(instanceId)
      const insert = this.db.prepare(
        'INSERT OR REPLACE INTO gateway_account_freezes(account_resource_id,source_instance_id,frozen_until,reason,updated_at) VALUES(?,?,?,?,?)',
      )
      for (const row of rows) insert.run(row.resource, instanceId, row.until, row.reason, now)
    })
  }

  // 下发给 instanceId 的其他实例冻结：按本实例的运行时账号 ID 投影，只取仍在线来源的未到期冻结
  peerAccountFreezes(instanceId, { staleMs = 90_000 } = {}) {
    const now = Date.now()
    return this.db
      .prepare(
        `SELECT f.frozen_until,f.reason,f.source_instance_id,b.runtime_account_id,i.last_heartbeat_at
           FROM gateway_account_freezes f
           JOIN gateway_worker_account_bindings b ON b.account_resource_id=f.account_resource_id AND b.gateway_instance_id=?
           JOIN gateway_worker_instances i ON i.id=f.source_instance_id
          WHERE f.source_instance_id<>?`,
      )
      .all(instanceId, instanceId)
      .filter((row) => Date.parse(row.frozen_until) > now && now - Date.parse(row.last_heartbeat_at || 0) < staleMs)
      .map((row) => ({
        account_id: row.runtime_account_id,
        frozen_until: row.frozen_until,
        reason: row.reason,
        source_instance: row.source_instance_id,
      }))
  }

  // 投影用的轻量账号列表：只取投影需要的字段，不做账号列表页的用量聚合与关联子查询（心跳每 15 秒调用）
  listProjectableAccounts({ id = null } = {}) {
    return this.db
      .prepare(
        `SELECT id,status,config_json,secret_json FROM vendor_resources
          WHERE resource_type='account' AND json_extract(config_json,'$.platform') IN ('openai','codex')
            AND json_extract(config_json,'$.execution_kind')='gateway_worker'${id ? ' AND id=?' : ''}
          ORDER BY updated_at DESC`,
      )
      .all(...(id ? [id] : []))
      .map((row) => ({ id: row.id, status: row.status, config: parse(row.config_json), secret_json: row.secret_json }))
  }

  // 全部账号绑定（与 listAccountBindings 同序），供心跳投影一次取出后按账号分组
  listAllAccountBindings() {
    return this.db
      .prepare(
        `SELECT b.*,r.vendor_id,r.name,r.status,r.config_json
           FROM gateway_worker_account_bindings b
           JOIN vendor_resources r ON r.id=b.account_resource_id
          ORDER BY b.updated_at DESC`,
      )
      .all()
      .map((row) => ({ ...row, config: parse(row.config_json) }))
  }

  listAccountBindings(accountResourceId) {
    return this.db
      .prepare(
        `SELECT b.*,r.vendor_id,r.name,r.status,r.config_json
           FROM gateway_worker_account_bindings b
           JOIN vendor_resources r ON r.id=b.account_resource_id
          WHERE b.account_resource_id=? ORDER BY b.updated_at DESC`,
      )
      .all(accountResourceId)
      .map((row) => ({ ...row, config: parse(row.config_json) }))
  }

  recordProjection({
    accountResourceId,
    instanceId,
    runtimeAccountId,
    projectionRevision = 1,
    credentialRevision = 0,
    status = 'pending',
    error = null,
  } = {}) {
    if (!accountResourceId || !instanceId || !runtimeAccountId) return
    const stamp = now()
    this.db
      .prepare(
        `INSERT INTO gateway_worker_account_bindings(id,account_resource_id,gateway_instance_id,runtime_account_id,credential_revision,projection_status,projection_revision,projection_error,last_projected_at,last_seen_at,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(account_resource_id,gateway_instance_id) DO UPDATE SET
         runtime_account_id=CASE WHEN excluded.projection_revision>=gateway_worker_account_bindings.projection_revision THEN excluded.runtime_account_id ELSE gateway_worker_account_bindings.runtime_account_id END,
         credential_revision=CASE WHEN excluded.credential_revision>gateway_worker_account_bindings.credential_revision THEN excluded.credential_revision ELSE gateway_worker_account_bindings.credential_revision END,
         projection_status=CASE WHEN excluded.projection_revision>=gateway_worker_account_bindings.projection_revision THEN excluded.projection_status ELSE gateway_worker_account_bindings.projection_status END,
         projection_revision=CASE WHEN excluded.projection_revision>gateway_worker_account_bindings.projection_revision THEN excluded.projection_revision ELSE gateway_worker_account_bindings.projection_revision END,
         projection_error=CASE WHEN excluded.projection_revision>=gateway_worker_account_bindings.projection_revision THEN excluded.projection_error ELSE gateway_worker_account_bindings.projection_error END,
         last_projected_at=CASE WHEN excluded.projection_revision>=gateway_worker_account_bindings.projection_revision THEN excluded.last_projected_at ELSE gateway_worker_account_bindings.last_projected_at END,
         last_seen_at=CASE WHEN excluded.projection_revision>=gateway_worker_account_bindings.projection_revision THEN excluded.last_seen_at ELSE gateway_worker_account_bindings.last_seen_at END,
         updated_at=excluded.updated_at`,
      )
      .run(
        `binding_${accountResourceId}_${instanceId}`,
        accountResourceId,
        instanceId,
        runtimeAccountId,
        credentialRevision,
        status,
        projectionRevision,
        error,
        status === 'synced' ? stamp : null,
        stamp,
        stamp,
        stamp,
      )
  }

  findAccountByRuntime(instanceId, runtimeAccountId) {
    if (!instanceId || !runtimeAccountId) return null
    const row = this.db
      .prepare(
        `SELECT b.*,r.vendor_id,r.name,r.status,r.config_json
           FROM gateway_worker_account_bindings b
           JOIN vendor_resources r ON r.id=b.account_resource_id
          WHERE b.gateway_instance_id=? AND b.runtime_account_id=? LIMIT 1`,
      )
      .get(instanceId, runtimeAccountId)
    return row ? { ...row, config: parse(row.config_json) } : null
  }

  updateBindingFromReceipt(receipt = {}) {
    const binding = this.findAccountByRuntime(receipt.gateway_instance_id, receipt.runtime_account_id)
    if (!binding) return null
    const revision = Number(receipt.credential_revision || binding.credential_revision || 0)
    const projectionRevision = Number(receipt.projection_revision || binding.projection_revision || 0)
    this.db
      .prepare(
        `UPDATE gateway_worker_account_bindings
            SET credential_revision=CASE WHEN ? > credential_revision THEN ? ELSE credential_revision END,
                projection_revision=CASE WHEN ? > projection_revision THEN ? ELSE projection_revision END,
                projection_status=CASE WHEN ? >= projection_revision THEN 'synced' ELSE projection_status END,
                quota_json=COALESCE(?,quota_json),runtime_status=COALESCE(?,runtime_status),last_error=COALESCE(?,last_error),last_seen_at=?,updated_at=?
          WHERE account_resource_id=? AND gateway_instance_id=?`,
      )
      .run(
        revision,
        revision,
        projectionRevision,
        projectionRevision,
        projectionRevision,
        mergeReceiptQuota(binding.quota_json, receipt.quota),
        receipt.terminal_state || null,
        receipt.error_message || null,
        receipt.finished_at || now(),
        now(),
        binding.account_resource_id,
        binding.gateway_instance_id,
      )
    return {
      ...binding,
      credential_revision: Math.max(revision, Number(binding.credential_revision || 0)),
      projection_revision: Math.max(projectionRevision, Number(binding.projection_revision || 0)),
    }
  }

  createDispatch({ requestId, attemptId, instanceId, scope = {}, protocol, model, nonce, expiresAt }) {
    const dispatchId = id('dispatch')
    this.db
      .prepare(
        `INSERT INTO gateway_worker_dispatches(dispatch_id,request_id,attempt_id,gateway_instance_id,scope_json,protocol,model,nonce_hash,expires_at,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,'created',?)`,
      )
      .run(
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

  markDispatch(dispatchId, status, extra = {}) {
    this.db
      .prepare(
        `UPDATE gateway_worker_dispatches SET status=?,receipt_id=COALESCE(?,receipt_id),sent_at=COALESCE(?,sent_at),completed_at=COALESCE(?,completed_at) WHERE dispatch_id=?`,
      )
      .run(status, extra.receipt_id || null, extra.sent_at || null, extra.completed_at || null, dispatchId)
  }

  ingestReceipt(receipt = {}) {
    const stamp = now()
    const claimedHash = String(receipt.payload_hash || '').trim()
    const unsigned = { ...receipt }
    delete unsigned.payload_hash
    const payload = stableJson(unsigned)
    const hash = crypto.createHash('sha256').update(payload).digest('hex')
    if (claimedHash && claimedHash !== hash)
      return { rejected: true, code: 'receipt_integrity_failed', message: 'Receipt payload hash mismatch' }
    return withTransaction(this.db, () => {
      const existing = this.db
        .prepare('SELECT receipt_id FROM gateway_worker_receipts WHERE gateway_instance_id=? AND dispatch_id=?')
        .get(receipt.gateway_instance_id, receipt.dispatch_id)
      if (existing) {
        const usage = receipt.usage && typeof receipt.usage === 'object' ? receipt.usage : null
        this.db
          .prepare(
            `UPDATE gateway_worker_receipts SET usage_json=COALESCE(?,usage_json),usage_confidence=CASE WHEN ?='complete' THEN 'complete' ELSE usage_confidence END,
              quota_json=COALESCE(?,quota_json),quota_confidence=CASE WHEN ? IN ('complete','explicit_zero') THEN ? ELSE quota_confidence END,
              projection_revision=CASE WHEN COALESCE(?,0)>COALESCE(projection_revision,0) THEN ? ELSE projection_revision END,
              headers_json=COALESCE(?,headers_json),upstream_status=COALESCE(?,upstream_status),upstream_model=COALESCE(?,upstream_model),terminal_state=COALESCE(?,terminal_state),finished_at=COALESCE(?,finished_at)
             WHERE receipt_id=?`,
          )
          .run(
            usage ? JSON.stringify(usageForStorage(usage)) : null,
            receipt.usage_confidence || null,
            receipt.quota ? JSON.stringify(receipt.quota) : null,
            receipt.quota_confidence || null,
            receipt.quota_confidence || null,
            receipt.projection_revision || null,
            receipt.projection_revision || null,
            receipt.headers ? JSON.stringify(receipt.headers) : null,
            receipt.upstream_status || null,
            receipt.upstream_model || null,
            receipt.terminal_state || null,
            receipt.finished_at || null,
            existing.receipt_id,
          )
        this.applyReceiptToUsage(
          receipt,
          this.findAccountByRuntime(receipt.gateway_instance_id, receipt.runtime_account_id),
        )
        return { duplicate: true, receipt_id: existing.receipt_id }
      }
      const offset = this.db
        .prepare('SELECT last_sequence FROM gateway_worker_receipt_offsets WHERE gateway_instance_id=?')
        .get(receipt.gateway_instance_id)
      const sequence = Number(receipt.sequence || 0)
      const integrityState =
        offset && sequence > 0 && sequence <= Number(offset.last_sequence || 0) ? 'late' : 'verified'
      const receiptId = String(receipt.receipt_id || id('receipt'))
      this.db
        .prepare(
          `INSERT INTO gateway_worker_receipts(receipt_id,dispatch_id,request_id,attempt_id,gateway_instance_id,sequence,payload_hash,runtime_account_id,credential_revision,projection_revision,send_state,terminal_state,upstream_status,upstream_model,usage_confidence,usage_json,quota_json,quota_confidence,headers_json,integrity_state,error_code,error_message,started_at,first_byte_at,finished_at,received_at,created_at,applied_at,replay_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          receiptId,
          receipt.dispatch_id,
          receipt.request_id,
          receipt.attempt_id || null,
          receipt.gateway_instance_id,
          receipt.sequence || null,
          hash,
          receipt.runtime_account_id || null,
          receipt.credential_revision || null,
          receipt.projection_revision || null,
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
      this.db
        .prepare(
          `INSERT INTO gateway_worker_receipt_offsets(gateway_instance_id,stream_name,last_sequence,updated_at,last_hash,replay_state) VALUES(?,?,?,? ,?,'active')
           ON CONFLICT(gateway_instance_id) DO UPDATE SET last_sequence=CASE WHEN excluded.last_sequence > last_sequence THEN excluded.last_sequence ELSE last_sequence END,updated_at=excluded.updated_at,last_hash=CASE WHEN excluded.last_sequence > last_sequence THEN excluded.last_hash ELSE last_hash END`,
        )
        .run(receipt.gateway_instance_id, 'default', sequence, stamp, receipt.payload_hash || hash)
      const binding = this.updateBindingFromReceipt(receipt)
      this.applyReceiptToUsage(receipt, binding)
      this.attachReceiptToReconciliation({
        gatewayInstanceId: receipt.gateway_instance_id,
        dispatchId: receipt.dispatch_id,
        receiptId,
        model: receipt.upstream_model || null,
        usage: receipt.usage || null,
      })
      this.markDispatch(receipt.dispatch_id, receipt.terminal_state === 'cancelled' ? 'cancelled' : 'completed', {
        receipt_id: receiptId,
        completed_at: stamp,
      })
      return { duplicate: false, receipt_id: receiptId, binding }
    })
  }

  // 回执只补齐已有的待结算任务（实时日志判定待结算时带计费上下文入队），不为已结算或不计量的请求新建任务；
  // 回执先于任务到达时，对账器处理任务时按 dispatch 读取回执表
  attachReceiptToReconciliation({ gatewayInstanceId, dispatchId, receiptId = null, model = null, usage = null } = {}) {
    if (!gatewayInstanceId || !dispatchId) return
    const stamp = now()
    this.db
      .prepare(
        `UPDATE gateway_worker_reconciliation_jobs SET receipt_id=COALESCE(?,receipt_id),model=COALESCE(model,?),usage_json=COALESCE(?,usage_json),
           status=CASE WHEN status='settled' THEN status ELSE 'pending' END,next_attempt_at=?,updated_at=?
         WHERE gateway_instance_id=? AND dispatch_id=?`,
      )
      .run(
        receiptId,
        model,
        usage ? JSON.stringify(usageForStorage(usage)) : null,
        stamp,
        stamp,
        gatewayInstanceId,
        dispatchId,
      )
  }

  enqueueReconciliation({
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
    this.db
      .prepare(
        `INSERT INTO gateway_worker_reconciliation_jobs(id,gateway_instance_id,dispatch_id,receipt_id,request_id,model,context_json,usage_json,status,attempts,next_attempt_at,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,'pending',0,?,?,?)
         ON CONFLICT(gateway_instance_id,dispatch_id) DO UPDATE SET receipt_id=COALESCE(excluded.receipt_id,receipt_id),model=COALESCE(excluded.model,model),usage_json=COALESCE(excluded.usage_json,usage_json),context_json=COALESCE(excluded.context_json,context_json),status=CASE WHEN status='settled' THEN status ELSE 'pending' END,updated_at=excluded.updated_at`,
      )
      .run(
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
      )
    return idValue
  }

  dueReconciliation(limit = 25) {
    return this.db
      .prepare(
        "SELECT * FROM gateway_worker_reconciliation_jobs WHERE status='pending' AND (next_attempt_at IS NULL OR next_attempt_at<=?) AND (lease_until IS NULL OR lease_until<=?) ORDER BY created_at LIMIT ?",
      )
      .all(now(), now(), limit)
  }

  leaseReconciliation(idValue, leaseUntil) {
    return (
      this.db
        .prepare(
          "UPDATE gateway_worker_reconciliation_jobs SET status='running',lease_until=?,attempts=attempts+1,updated_at=? WHERE id=? AND status='pending'",
        )
        .run(leaseUntil, now(), idValue).changes > 0
    )
  }

  finishReconciliation(idValue, status, { error = null, retryAt = null } = {}) {
    this.db
      .prepare(
        'UPDATE gateway_worker_reconciliation_jobs SET status=?,last_error=?,next_attempt_at=?,lease_until=NULL,updated_at=? WHERE id=?',
      )
      .run(status, error, retryAt, now(), idValue)
  }

  applyReceiptToUsage(receipt = {}, binding = null) {
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
    const row = this.db
      .prepare("SELECT * FROM usage_logs WHERE execution_kind='gateway_worker' AND dispatch_id=? LIMIT 1")
      .get(receipt.dispatch_id)
    if (!row) return null
    const accountResourceId = binding?.account_resource_id || row.account_resource_id || null
    // 没有 token 证据时不计价：0 元结果会经 COALESCE 覆盖实时日志已算好的成本。
    // 实时日志已按完整 usage 计价（含冻结报价与按张/按次的分组媒体规则）时，回执只补技术事实，不重算成本
    const hasTokens = input > 0 || output > 0 || cacheRead > 0 || (Number.isFinite(cacheWrite) && cacheWrite > 0)
    const priced =
      receipt.usage_confidence === 'complete' && hasTokens && row.usage_confidence !== 'complete'
        ? costColumnsFromUsage(usage, receipt.upstream_model || row.model)
        : {}
    this.db
      .prepare(
        `UPDATE usage_logs SET receipt_id=COALESCE(?,receipt_id),account_resource_id=COALESCE(?,account_resource_id),
          gateway_instance_id=COALESCE(?,gateway_instance_id),vm_id=COALESCE(vm_id,CASE WHEN ? IS NOT NULL THEN 'gateway:'||? END),usage_confidence=CASE WHEN ?='complete' OR usage_confidence IS NULL THEN ? ELSE usage_confidence END,
          input_tokens=CASE WHEN ? > 0 THEN ? ELSE input_tokens END,
          output_tokens=CASE WHEN ? > 0 THEN ? ELSE output_tokens END,
          cache_read_tokens=CASE WHEN ? > 0 THEN ? ELSE cache_read_tokens END,
          cache_creation_tokens=COALESCE(?,cache_creation_tokens),
          input_cost=COALESCE(?,input_cost),output_cost=COALESCE(?,output_cost),cache_read_cost=COALESCE(?,cache_read_cost),cache_creation_cost=COALESCE(?,cache_creation_cost),total_cost=COALESCE(?,total_cost),pricing_model=COALESCE(?,pricing_model),price_source=COALESCE(?,price_source),price_version=COALESCE(?,price_version),
          upstream_model=COALESCE(?,upstream_model),
          final_state=CASE WHEN final_state IS NULL OR final_state='ambiguous' THEN COALESCE(?,final_state) ELSE final_state END
        WHERE execution_kind='gateway_worker' AND dispatch_id=?`,
      )
      .run(
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
        priced.input_cost ?? null,
        priced.output_cost ?? null,
        priced.cache_read_cost ?? null,
        priced.cache_creation_cost ?? null,
        priced.total_cost ?? null,
        priced.pricing_model ?? null,
        priced.price_source ?? null,
        priced.price_version ?? null,
        receipt.upstream_model || null,
        // 状态码与终态是 Node 交付给调用方的事实（流内失败时上游 HTTP 仍是 200），回执只补全未知终态
        receipt.terminal_state === 'completed' ? 'verified' : receipt.terminal_state || null,
        receipt.dispatch_id,
      )
    const updated = this.db
      .prepare("SELECT * FROM usage_logs WHERE execution_kind='gateway_worker' AND dispatch_id=? LIMIT 1")
      .get(receipt.dispatch_id)
    if (
      updated?.execution_kind === 'gateway_worker' &&
      updated.account_resource_id &&
      updated.status >= 200 &&
      updated.status < 300 &&
      updated.total_cost != null
    ) {
      const resource = gatewayAccountResource(this.db, updated.account_resource_id)
      if (resource?.vendor_id) insertUsageFact(this.db, updated, resource, { id: id('usage'), createdAt: now() })
    }
    return updated
  }

  listReceipts(requestId) {
    return this.db
      .prepare('SELECT * FROM gateway_worker_receipts WHERE request_id=? ORDER BY created_at')
      .all(requestId)
  }

  // 账号详情：Receipt 只记录 Worker 实例与运行时账号，经绑定关联到账号资源
  listAccountReceipts(accountResourceId, limit = 50) {
    return this.db
      .prepare(
        `SELECT r.* FROM gateway_worker_receipts r
           JOIN gateway_worker_account_bindings b
             ON b.gateway_instance_id=r.gateway_instance_id AND b.runtime_account_id=r.runtime_account_id
          WHERE b.account_resource_id=? ORDER BY r.created_at DESC LIMIT ?`,
      )
      .all(accountResourceId, Math.max(1, Math.min(500, Number(limit) || 50)))
  }
}
