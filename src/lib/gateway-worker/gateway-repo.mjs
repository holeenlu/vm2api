import crypto from 'node:crypto'
import { getDb, withTransaction } from '../db/database.mjs'
import { costColumnsFromUsage, normalizeUsage, shanghaiDayStartIso } from '../admin/pricing.mjs'
import { disjointOpenaiUsage } from '../protocol/openai-usage.mjs'
import { ERROR_PRED, SUCCESS_PRED, TOTAL_TOKENS_SQL } from '../db/repos/usage-log-preds.mjs'

const now = () => new Date().toISOString()
const id = (prefix) => `${prefix}_${crypto.randomUUID()}`
const parse = (value, fallback = {}) => {
  try {
    return value == null ? fallback : JSON.parse(value)
  } catch {
    return fallback
  }
}
const stableJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`
  return JSON.stringify(value)
}

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
  window_7d_requests: 0,
  window_7d_success: 0,
  window_7d_errors: 0,
  window_7d_cost: 0,
  window_7d_tokens: 0,
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

  pickInstance({ operation = null, model = null, forExecution = false, exclude = null, prefer = null } = {}) {
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
        // 未同步的绑定可能让实例按旧配置接单；已确认停用的归档绑定不会
        if (
          forExecution &&
          this.db
            .prepare(
              "SELECT 1 FROM gateway_worker_account_bindings WHERE gateway_instance_id=? AND projection_status NOT IN ('synced','archived') LIMIT 1",
            )
            .get(item.id)
        )
          return false
        const operations = item.capabilities?.operations || []
        if (operation && operations.length && !operations.includes(operation)) return false
        const models = item.capabilities?.models || []
        if (model && models.length && !models.includes(model)) return false
        return true
      }) || null
    )
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
          (SELECT b.last_error FROM gateway_worker_account_bindings b WHERE b.account_resource_id=r.id ORDER BY b.updated_at DESC LIMIT 1) AS last_error,
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
   * 5H/7D follow the account's own quota windows when the Worker reported a reset;
   * otherwise they fall back to rolling windows. */
  codexAccountUsage(accounts, at = Date.now()) {
    const out = new Map()
    if (!accounts.length) return out
    const start = (window, fallbackMinutes) => {
      const reset = Date.parse(window?.reset_at || '')
      const minutes = Number(window?.window_minutes) || fallbackMinutes
      const from = Number.isFinite(reset) && reset > at ? reset - minutes * 60000 : at - fallbackMinutes * 60000
      return new Date(from).toISOString()
    }
    // 5h/7d by window length, not primary/secondary position (same as the console's quotaWindows).
    const split = (quota) => {
      const primary = quota?.primary_window
      const secondary = quota?.secondary_window
      const pm = primary?.window_minutes
      const sm = secondary?.window_minutes
      const fiveFromPrimary =
        pm != null && sm != null ? pm < sm : pm != null ? pm <= 360 : sm != null ? sm > 360 : false
      return fiveFromPrimary ? [primary, secondary] : [secondary, primary]
    }
    const windows = accounts.map((a) => {
      const [five, seven] = split(a.quota)
      return [a.id, start(five, 300), start(seven, 10080)]
    })
    const day = shanghaiDayStartIso(new Date(at))
    const sum = (cond, value) => `COALESCE(SUM(CASE WHEN ${cond} THEN ${value} ELSE 0 END),0)`
    const rows = this.db
      .prepare(
        `WITH w(id,s5,s7) AS (VALUES ${windows.map(() => '(?,?,?)').join(',')})
         SELECT w.id,
           ${sum('u.created_at>=?', '1')} AS today_requests,
           ${sum('u.created_at>=?', 'COALESCE(u.total_cost,0)')} AS today_cost,
           ${sum('u.created_at>=?', TOTAL_TOKENS_SQL)} AS today_tokens,
           ${sum('u.created_at>=?', 'IFNULL(u.input_tokens,0)')} AS today_input_tokens,
           ${sum('u.created_at>=?', 'IFNULL(u.output_tokens,0)')} AS today_output_tokens,
           ${sum('u.created_at>=?', 'IFNULL(u.cache_read_tokens,0)')} AS today_cache_read_tokens,
           ${sum('u.created_at>=?', 'IFNULL(u.cache_creation_tokens,0)')} AS today_cache_creation_tokens,
           ${sum('u.created_at>=w.s5', '1')} AS window_5h_requests,
           ${sum('u.created_at>=w.s5', 'COALESCE(u.total_cost,0)')} AS window_5h_cost,
           ${sum('u.created_at>=w.s5', TOTAL_TOKENS_SQL)} AS window_5h_tokens,
           ${sum('u.created_at>=w.s7', '1')} AS window_7d_requests,
           ${sum(`u.created_at>=w.s7 AND ${SUCCESS_PRED}`, '1')} AS window_7d_success,
           ${sum(`u.created_at>=w.s7 AND ${ERROR_PRED}`, '1')} AS window_7d_errors,
           ${sum('u.created_at>=w.s7', 'COALESCE(u.total_cost,0)')} AS window_7d_cost,
           ${sum('u.created_at>=w.s7', TOTAL_TOKENS_SQL)} AS window_7d_tokens,
           COUNT(u.rowid) AS requests,
           COALESCE(SUM(u.total_cost),0) AS total_cost,
           COALESCE(SUM(${TOTAL_TOKENS_SQL}),0) AS total_tokens
         FROM w LEFT JOIN usage_logs u ON u.execution_kind='gateway_worker' AND u.account_resource_id=w.id
         GROUP BY w.id`,
      )
      .all(...windows.flat(), day, day, day, day, day, day, day)
    for (const row of rows) {
      const { id: accountId, ...rest } = row
      out.set(accountId, Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, Number(v) || 0])))
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
            usage ? JSON.stringify(usage) : null,
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
          JSON.stringify(receipt.usage || null),
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
      this.enqueueReconciliation({
        gatewayInstanceId: receipt.gateway_instance_id,
        dispatchId: receipt.dispatch_id,
        receiptId,
        requestId: receipt.request_id,
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
        usage ? JSON.stringify(usage) : null,
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
    const raw = receipt.usage && typeof receipt.usage === 'object' ? receipt.usage : {}
    // 与 VM 路径和请求日志同一口径：OpenAI 包含式 usage 先转为不相交字段（input 扣除缓存读写，
    // reasoning 只作 output 的子集记录，不额外计费）
    const usage = normalizeUsage(disjointOpenaiUsage(raw) || {})
    const input = Number(usage.input_tokens ?? 0)
    const output = Number(usage.output_tokens ?? 0)
    const cacheRead = Number(usage.cache_read_tokens ?? 0)
    const cacheWrite = usage.cache_creation_tokens == null ? null : Number(usage.cache_creation_tokens)
    const row = this.db.prepare('SELECT * FROM usage_logs WHERE dispatch_id=? LIMIT 1').get(receipt.dispatch_id)
    if (!row) return null
    const accountResourceId = binding?.account_resource_id || row.account_resource_id || null
    const priced =
      receipt.usage_confidence === 'complete' ? costColumnsFromUsage(usage, receipt.upstream_model || row.model) : {}
    this.db
      .prepare(
        `UPDATE usage_logs SET receipt_id=COALESCE(?,receipt_id),account_resource_id=COALESCE(?,account_resource_id),
          gateway_instance_id=COALESCE(?,gateway_instance_id),vm_id=COALESCE(vm_id,CASE WHEN ? IS NOT NULL THEN 'gateway:'||? END),usage_confidence=CASE WHEN ?='complete' OR usage_confidence IS NULL THEN ? ELSE usage_confidence END,
          input_tokens=CASE WHEN ? > 0 THEN ? ELSE input_tokens END,
          output_tokens=CASE WHEN ? > 0 THEN ? ELSE output_tokens END,
          cache_read_tokens=CASE WHEN ? > 0 THEN ? ELSE cache_read_tokens END,
          cache_creation_tokens=COALESCE(?,cache_creation_tokens),
          input_cost=COALESCE(?,input_cost),output_cost=COALESCE(?,output_cost),cache_read_cost=COALESCE(?,cache_read_cost),cache_creation_cost=COALESCE(?,cache_creation_cost),total_cost=COALESCE(?,total_cost),pricing_model=COALESCE(?,pricing_model),price_source=COALESCE(?,price_source),price_version=COALESCE(?,price_version),
          upstream_model=COALESCE(?,upstream_model),status=COALESCE(?,status),
          final_state=COALESCE(?,final_state)
        WHERE dispatch_id=?`,
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
        Number.isInteger(receipt.upstream_status) ? receipt.upstream_status : null,
        receipt.terminal_state || null,
        receipt.dispatch_id,
      )
    const updated = this.db.prepare('SELECT * FROM usage_logs WHERE dispatch_id=? LIMIT 1').get(receipt.dispatch_id)
    if (
      updated?.execution_kind === 'gateway_worker' &&
      updated.account_resource_id &&
      updated.status >= 200 &&
      updated.status < 300 &&
      updated.total_cost != null
    ) {
      const resource = this.db
        .prepare("SELECT id,vendor_id FROM vendor_resources WHERE id=? AND resource_type='account'")
        .get(updated.account_resource_id)
      if (resource?.vendor_id)
        this.db
          .prepare(`INSERT OR IGNORE INTO vendor_usage_facts
          (id,vendor_id,resource_id,model,input_tokens,output_tokens,cost_usd,occurred_at,source_request_id,created_at,cache_read_tokens,cache_creation_tokens,execution_kind,gateway_instance_id,dispatch_id,receipt_id,usage_confidence)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(
            id('usage'),
            resource.vendor_id,
            resource.id,
            updated.model,
            updated.input_tokens || 0,
            updated.output_tokens || 0,
            Math.max(0, Number(updated.total_cost)),
            updated.created_at,
            updated.request_id,
            now(),
            updated.cache_read_tokens ?? null,
            updated.cache_creation_tokens ?? null,
            updated.execution_kind,
            updated.gateway_instance_id || null,
            updated.dispatch_id || null,
            updated.receipt_id || null,
            updated.usage_confidence || null,
          )
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
