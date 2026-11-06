import { getDb } from '../database.mjs'
import { dbClient } from '../db-client.mjs'
import { redactSecretText } from '../../core/security.mjs'
import { usageForStorage } from '../../core/usage-persist.mjs'
import { enqueueWrite, writeBehindArmed } from '../write-behind.mjs'

function parse(value, fallback = null) {
  if (value == null) return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

/** 尝试的上游错误原文（迁移 117）：只收字符串，凭证形态的文本脱敏（同 usage_logs.error_message），去首尾空白，最多 500 字符。 */
export function attemptErrorMessage(value) {
  if (typeof value !== 'string') return null
  const text = redactSecretText(value).trim().slice(0, 500)
  return text || null
}

function rowToAttempt(row) {
  if (!row) return null
  return {
    id: row.id,
    request_id: row.request_id,
    attempt_no: row.attempt_no,
    vm_id: row.vm_id,
    account_id: row.account_id,
    model: row.model,
    selection_reason: row.selection_reason,
    started_at: row.started_at,
    completed_at: row.completed_at,
    upstream_status: row.upstream_status,
    error_scope: row.error_scope,
    action: row.action,
    cooldown_until: row.cooldown_until,
    downstream_committed: !!row.downstream_committed,
    terminal_state: row.terminal_state,
    usage: parse(row.usage_json),
    wait_ms: row.wait_ms,
    queue_wait_ms: row.queue_wait_ms,
    scheduling_ms: row.scheduling_ms,
    ttft_ms: row.ttft_ms,
    latency_ms: row.latency_ms,
    route: row.route ?? null,
    stage: row.stage ?? null,
    error_message: row.error_message ?? null,
    credential_revision: row.credential_revision ?? null,
    settings_revision: row.settings_revision ?? null,
  }
}

const INSERT_SQL = `
      INSERT INTO request_attempts (
        request_id, attempt_no, vm_id, account_id, model, selection_reason,
        started_at, completed_at, upstream_status, error_scope, action,
        cooldown_until, downstream_committed, terminal_state, usage_json,
        wait_ms, ttft_ms, latency_ms, queue_wait_ms, scheduling_ms, upstream_request_id, cf_ray,
        route, stage, credential_revision, settings_revision, error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
const COMPLETE_SQL = `
      UPDATE request_attempts SET
        completed_at = ?, upstream_status = ?, error_scope = ?, action = ?,
        cooldown_until = ?, downstream_committed = ?, terminal_state = ?,
        usage_json = ?, ttft_ms = ?, latency_ms = ?
      WHERE request_id = ? AND attempt_no = ?
    `
const LIST_SQL = 'SELECT * FROM request_attempts WHERE request_id = ? ORDER BY attempt_no'
const REMOVE_OLD_SQL = 'DELETE FROM request_attempts WHERE started_at < ?'

/**
 * 数据访问经 DbClient 异步执行（R6 B7b）。写回队列启用时（服务进程），写入仍以同步闭包入队、在写回批事务里执行
 * （`runSync`，同步的 flushWrites 需要等它们，改 async 随 B8 的 closeDatabase）；未启用时直接 await 写入并读回。
 */
export class RequestAttemptsRepo {
  constructor(db = getDb()) {
    this.db = db
    this.client = dbClient(db)
  }

  async _write(sql, params, { deferred = writeBehindArmed() } = {}) {
    if (deferred) {
      enqueueWrite(() => {
        this.client.runSync(sql, ...params)
      })
      return false
    }
    await this.client.run(sql, ...params)
    return true
  }

  async _readBack(requestId, attemptNo) {
    return (await this.list(requestId)).find((item) => item.attempt_no === attemptNo) || null
  }

  async begin({
    requestId,
    attemptNo,
    vmId,
    accountId,
    model,
    selectionReason,
    waitMs = 0,
    queueWaitMs = null,
    schedulingMs = null,
  }) {
    const startedAt = new Date().toISOString()
    const written = await this._write(INSERT_SQL, [
      requestId,
      attemptNo,
      vmId ?? null,
      accountId ?? null,
      model ?? null,
      selectionReason ?? null,
      startedAt,
      null,
      null,
      null,
      null,
      null,
      0,
      'started',
      null,
      waitMs ?? 0,
      null,
      null,
      queueWaitMs,
      schedulingMs,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    ])
    return written ? this._readBack(requestId, attemptNo) : null
  }

  /** 一次写入结果已知的尝试（免去 begin + complete 两次写入）。 */
  async record({
    requestId,
    attemptNo,
    vmId,
    accountId,
    model,
    selectionReason,
    waitMs = 0,
    queueWaitMs = null,
    schedulingMs = null,
    immediate = false,
    ...result
  }) {
    const at = new Date().toISOString()
    const written = await this._write(
      INSERT_SQL,
      [
        requestId,
        attemptNo,
        vmId ?? null,
        accountId ?? null,
        model ?? null,
        selectionReason ?? null,
        at,
        at,
        result.upstreamStatus ?? null,
        result.errorScope ?? null,
        result.action ?? null,
        result.cooldownUntil ?? null,
        result.downstreamCommitted ? 1 : 0,
        result.terminalState ?? null,
        result.usage != null ? JSON.stringify(usageForStorage(result.usage)) : null,
        waitMs ?? 0,
        result.ttftMs ?? null,
        result.latencyMs ?? null,
        queueWaitMs,
        schedulingMs,
        result.upstreamRequestId ?? null,
        result.cfRay ?? null,
        result.route ?? null,
        result.stage ?? null,
        result.credentialRevision ?? null,
        result.settingsRevision ?? null,
        attemptErrorMessage(result.errorMessage),
      ],
      { deferred: writeBehindArmed() && !immediate },
    )
    return written ? this._readBack(requestId, attemptNo) : null
  }

  async complete(requestId, attemptNo, result = {}) {
    const completedAt = new Date().toISOString()
    const written = await this._write(COMPLETE_SQL, [
      completedAt,
      result.upstreamStatus ?? null,
      result.errorScope ?? null,
      result.action ?? null,
      result.cooldownUntil ?? null,
      result.downstreamCommitted ? 1 : 0,
      result.terminalState ?? null,
      result.usage != null ? JSON.stringify(usageForStorage(result.usage)) : null,
      result.ttftMs ?? null,
      result.latencyMs ?? null,
      requestId,
      attemptNo,
    ])
    return written ? this._readBack(requestId, attemptNo) : null
  }

  async list(requestId) {
    return (await this.client.many(LIST_SQL, requestId)).map(rowToAttempt)
  }

  async cleanup(retainDays = 7) {
    const days = Math.max(1, Number(retainDays) || 7)
    const cutoff = new Date(Date.now() - days * 86400_000).toISOString()
    return (await this.client.run(REMOVE_OLD_SQL, cutoff)).changes
  }
}
