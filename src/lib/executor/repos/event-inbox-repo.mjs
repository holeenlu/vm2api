/**
 * 执行事件收件箱与游标的仓储（executor_event_inbox、executor_event_cursors），以及事件比对时读取的旧通道记录
 * （gateway_worker_receipts、gateway_bps_probes）。只做数据访问；去重、比对、重试等规则在 event-ingest.mjs。
 */
import { statementCache } from './statement-cache.mjs'

export function eventInboxRepo(db) {
  const stmt = statementCache(db)
  return {
    cursorOf(instanceId) {
      return stmt(
        'SELECT stream_id,last_seq FROM executor_event_cursors WHERE instance_id=? ORDER BY updated_at DESC,rowid DESC LIMIT 1',
      ).get(instanceId)
    },
    cursorAt(instanceId, streamId) {
      return stmt('SELECT last_seq,updated_at FROM executor_event_cursors WHERE instance_id=? AND stream_id=?').get(
        instanceId,
        streamId,
      )
    },
    /** 回滚：游标回到指定位置（覆盖写） */
    resetCursor(instanceId, streamId, seq, updatedAt) {
      stmt(
        `INSERT INTO executor_event_cursors(instance_id,stream_id,last_seq,updated_at) VALUES(?,?,?,?)
       ON CONFLICT(instance_id,stream_id) DO UPDATE SET last_seq=excluded.last_seq,updated_at=excluded.updated_at`,
      ).run(instanceId, streamId, seq, updatedAt)
    },
    /** 游标只增不减，updated_at 每次刷新 */
    saveCursor(instanceId, streamId, seq, updatedAt) {
      stmt(
        `INSERT INTO executor_event_cursors(instance_id,stream_id,last_seq,updated_at) VALUES(?,?,?,?)
       ON CONFLICT(instance_id,stream_id) DO UPDATE SET last_seq=MAX(last_seq,excluded.last_seq),updated_at=excluded.updated_at`,
      ).run(instanceId, streamId, seq, updatedAt)
    },
    storedPayloadAt(instanceId, streamId, seq) {
      return stmt(
        "SELECT payload_json FROM executor_event_inbox WHERE instance_id=? AND stream_id=? AND seq=? AND status!='invalid' ORDER BY received_at DESC LIMIT 1",
      ).get(instanceId, streamId, seq)
    },
    /** 按 event_id 写入；已存在时只更新 mode、status、detail、checked_at */
    write(row) {
      stmt(
        `INSERT INTO executor_event_inbox(event_id,instance_id,stream_id,seq,type,occurred_at,subject_json,payload_json,mode,status,detail,received_at,checked_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(event_id) DO UPDATE SET mode=excluded.mode,status=excluded.status,detail=excluded.detail,checked_at=excluded.checked_at`,
      ).run(
        row.event_id,
        row.instance_id,
        row.stream_id,
        row.seq,
        row.type,
        row.occurred_at,
        row.subject_json,
        row.payload_json,
        row.mode,
        row.status,
        row.detail,
        row.received_at,
        row.checked_at,
      )
    },
    get(eventId) {
      return stmt('SELECT status,mode,payload_json FROM executor_event_inbox WHERE event_id=?').get(eventId)
    },
    receiptHash(instanceId, dispatchId) {
      return stmt('SELECT payload_hash FROM gateway_worker_receipts WHERE gateway_instance_id=? AND dispatch_id=?').get(
        instanceId,
        dispatchId,
      )
    },
    probeAt(instanceId, accountResourceId, probedAt) {
      return stmt(
        'SELECT ok,total_tokens FROM gateway_bps_probes WHERE gateway_instance_id=? AND account_resource_id=? AND probed_at=?',
      ).get(instanceId, accountResourceId, probedAt)
    },
    latestAppliedAccountStateAt(instanceId) {
      return stmt(
        "SELECT occurred_at FROM executor_event_inbox WHERE instance_id=? AND type='account.state' AND status='applied' ORDER BY received_at DESC,rowid DESC LIMIT 1",
      ).get(instanceId)?.occurred_at
    },
    pending() {
      return stmt("SELECT * FROM executor_event_inbox WHERE status='pending' ORDER BY received_at LIMIT 500").all()
    },
    markChecked(eventId, status, detail, checkedAt) {
      stmt('UPDATE executor_event_inbox SET status=?,detail=?,checked_at=? WHERE event_id=?').run(
        status,
        detail,
        checkedAt,
        eventId,
      )
    },
    /** 待补齐尝试的行；条件与迁移 104 的部分索引逐字一致，并以 INDEXED BY 指定 */
    attemptsTodo(receivedBefore) {
      return stmt(
        `SELECT event_id,payload_json,attempts_state FROM executor_event_inbox INDEXED BY idx_executor_inbox_attempts_todo
         WHERE attempts_state IS NULL AND type = 'request.finalized' AND mode = 'primary' AND status = 'applied'
           AND received_at < ?
         ORDER BY received_at LIMIT 200`,
      ).all(receivedBefore)
    },
    attemptsRetries() {
      return stmt(
        `SELECT event_id,attempts_state FROM executor_event_inbox INDEXED BY idx_executor_inbox_attempts_retry
         WHERE attempts_state LIKE 'retry:%'`,
      ).all()
    },
    payloadJson(eventId) {
      return stmt('SELECT payload_json FROM executor_event_inbox WHERE event_id=?').get(eventId)?.payload_json
    },
    markAttempts(eventId, state) {
      stmt('UPDATE executor_event_inbox SET attempts_state=? WHERE event_id=?').run(state, eventId)
    },
    /** 每行补齐用的保存点（在外层事务内使用） */
    savepoint() {
      db.exec('SAVEPOINT attempts_row')
    },
    release() {
      db.exec('RELEASE attempts_row')
    },
    rollbackToSavepoint() {
      db.exec('ROLLBACK TO attempts_row')
    },
    pruneBefore(receivedBefore) {
      stmt('DELETE FROM executor_event_inbox WHERE received_at < ?').run(receivedBefore)
    },
    countsSince(since) {
      return stmt(
        'SELECT type,mode,status,COUNT(*) AS n FROM executor_event_inbox WHERE received_at >= ? GROUP BY type,mode,status ORDER BY type,status',
      ).all(since)
    },
    attemptStatesSince(since) {
      return stmt(
        "SELECT CASE WHEN attempts_state LIKE 'retry:%' THEN 'retry' ELSE COALESCE(attempts_state,'pending') END AS state,COUNT(*) AS n FROM executor_event_inbox WHERE type='request.finalized' AND mode='primary' AND status='applied' AND received_at >= ? GROUP BY 1",
      ).all(since)
    },
  }
}
