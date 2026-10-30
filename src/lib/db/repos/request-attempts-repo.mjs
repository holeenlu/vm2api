import { getDb } from '../database.mjs'

export const ATTEMPT_SEND_STATES = Object.freeze(['not_sent', 'sent', 'ambiguous'])

const ATTEMPT_SEND_STATE_RANK = Object.freeze({ not_sent: 0, ambiguous: 1, sent: 2 })

function normalizeSendState(value, fallback = null) {
  const state = String(value || '').trim()
  return ATTEMPT_SEND_STATES.includes(state) ? state : fallback
}

function mergeSendState(current, next) {
  const currentState = normalizeSendState(current, 'not_sent')
  const nextState = normalizeSendState(next)
  if (!nextState) return currentState
  return ATTEMPT_SEND_STATE_RANK[nextState] >= ATTEMPT_SEND_STATE_RANK[currentState] ? nextState : currentState
}

function parse(value, fallback = null) {
  if (value == null) return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
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
    send_state: normalizeSendState(row.send_state, 'not_sent'),
    terminal_state: row.terminal_state,
    usage: parse(row.usage_json),
    wait_ms: row.wait_ms,
    queue_wait_ms: row.queue_wait_ms,
    scheduling_ms: row.scheduling_ms,
    ttft_ms: row.ttft_ms,
    latency_ms: row.latency_ms,
  }
}

export class RequestAttemptsRepo {
  constructor(db = getDb()) {
    this.db = db
    this._insert = db.prepare(`
      INSERT INTO request_attempts (
        request_id, attempt_no, vm_id, account_id, model, selection_reason,
        started_at, completed_at, upstream_status, error_scope, action,
        cooldown_until, downstream_committed, send_state, terminal_state, usage_json,
        wait_ms, ttft_ms, latency_ms, queue_wait_ms, scheduling_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    this._complete = db.prepare(`
      UPDATE request_attempts SET
        completed_at = ?, upstream_status = ?, error_scope = ?, action = ?,
        cooldown_until = ?,
        downstream_committed = CASE WHEN downstream_committed = 1 OR ? = 1 THEN 1 ELSE 0 END,
        send_state = CASE
          WHEN send_state = 'sent' OR ? = 'sent' THEN 'sent'
          WHEN send_state = 'ambiguous' OR ? = 'ambiguous' THEN 'ambiguous'
          ELSE 'not_sent'
        END,
        terminal_state = ?,
        usage_json = ?, ttft_ms = ?, latency_ms = ?
      WHERE request_id = ? AND attempt_no = ?
    `)
    this._get = db.prepare(`
      SELECT * FROM request_attempts WHERE request_id = ? AND attempt_no = ?
    `)
    this._list = db.prepare(`
      SELECT * FROM request_attempts WHERE request_id = ? ORDER BY attempt_no
    `)
    this._removeOld = db.prepare(`
      DELETE FROM request_attempts WHERE started_at < ?
    `)
  }

  begin({
    requestId,
    attemptNo,
    vmId,
    accountId,
    model,
    selectionReason,
    waitMs = 0,
    queueWaitMs = null,
    schedulingMs = null,
    sendState = 'not_sent',
  }) {
    const startedAt = new Date().toISOString()
    this._insert.run(
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
      normalizeSendState(sendState, 'not_sent'),
      'started',
      null,
      waitMs ?? 0,
      null,
      null,
      queueWaitMs,
      schedulingMs,
    )
    return this.list(requestId).find((item) => item.attempt_no === attemptNo) || null
  }

  complete(requestId, attemptNo, result = {}) {
    const current = this._get.get(requestId, attemptNo)
    let inferredSendState = normalizeSendState(result.sendState)
    if (result.downstreamCommitted) {
      // A committed downstream response proves the hop was at least sent. Keep
      // an explicitly ambiguous observation because it records the remaining
      // uncertainty about whether the provider accepted the request.
      inferredSendState = inferredSendState === 'ambiguous' ? 'ambiguous' : 'sent'
    } else if (!inferredSendState && Number(result.upstreamStatus) > 0) {
      inferredSendState = 'sent'
    }
    const sendState = mergeSendState(current?.send_state, inferredSendState)
    const downstreamCommitted = current?.downstream_committed || result.downstreamCommitted ? 1 : 0
    this._complete.run(
      new Date().toISOString(),
      result.upstreamStatus ?? null,
      result.errorScope ?? null,
      result.action ?? null,
      result.cooldownUntil ?? null,
      downstreamCommitted,
      sendState,
      sendState,
      result.terminalState ?? null,
      result.usage != null ? JSON.stringify(result.usage) : null,
      result.ttftMs ?? null,
      result.latencyMs ?? null,
      requestId,
      attemptNo,
    )
    return this.list(requestId).find((item) => item.attempt_no === attemptNo) || null
  }

  list(requestId) {
    return this._list.all(requestId).map(rowToAttempt)
  }

  cleanup(retainDays = 7) {
    const days = Math.max(1, Number(retainDays) || 7)
    const cutoff = new Date(Date.now() - days * 86400_000).toISOString()
    return this._removeOld.run(cutoff).changes
  }
}
