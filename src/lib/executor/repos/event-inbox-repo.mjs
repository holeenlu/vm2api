/**
 * 执行事件收件箱与游标的仓储（executor_event_inbox、executor_event_cursors），以及事件比对时读取的旧通道记录
 * （gateway_worker_receipts、gateway_bps_probes）。只做数据访问；去重、比对、重试等规则在 event-ingest.mjs。
 * 经 DbClient 异步访问（R6 B3）；逐行保存点由调用方用嵌套 tx 实现。
 */
import { dbClient } from '../../db/db-client.mjs'

export function eventInboxRepo(db) {
  const c = dbClient(db)
  return {
    async cursorOf(instanceId) {
      return c.one(
        'SELECT stream_id,last_seq FROM executor_event_cursors WHERE instance_id=? ORDER BY updated_at DESC,rowid DESC LIMIT 1',
        instanceId,
      )
    },
    async cursorAt(instanceId, streamId) {
      return c.one(
        'SELECT last_seq,updated_at FROM executor_event_cursors WHERE instance_id=? AND stream_id=?',
        instanceId,
        streamId,
      )
    },
    /** 回滚：游标回到指定位置（覆盖写） */
    async resetCursor(instanceId, streamId, seq, updatedAt) {
      await c.run(
        `INSERT INTO executor_event_cursors(instance_id,stream_id,last_seq,updated_at) VALUES(?,?,?,?)
       ON CONFLICT(instance_id,stream_id) DO UPDATE SET last_seq=excluded.last_seq,updated_at=excluded.updated_at`,
        instanceId,
        streamId,
        seq,
        updatedAt,
      )
    },
    /** 游标只增不减，updated_at 每次刷新 */
    async saveCursor(instanceId, streamId, seq, updatedAt) {
      await c.run(
        `INSERT INTO executor_event_cursors(instance_id,stream_id,last_seq,updated_at) VALUES(?,?,?,?)
       ON CONFLICT(instance_id,stream_id) DO UPDATE SET last_seq=MAX(last_seq,excluded.last_seq),updated_at=excluded.updated_at`,
        instanceId,
        streamId,
        seq,
        updatedAt,
      )
    },
    async storedPayloadAt(instanceId, streamId, seq) {
      return c.one(
        "SELECT payload_json FROM executor_event_inbox WHERE instance_id=? AND stream_id=? AND seq=? AND status!='invalid' ORDER BY received_at DESC LIMIT 1",
        instanceId,
        streamId,
        seq,
      )
    },
    /** 按 event_id 写入；已存在时只更新 mode、status、detail、checked_at */
    async write(row) {
      await c.run(
        `INSERT INTO executor_event_inbox(event_id,instance_id,stream_id,seq,type,occurred_at,subject_json,payload_json,mode,status,detail,received_at,checked_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(event_id) DO UPDATE SET mode=excluded.mode,status=excluded.status,detail=excluded.detail,checked_at=excluded.checked_at`,
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
    async get(eventId) {
      return c.one('SELECT status,mode,payload_json FROM executor_event_inbox WHERE event_id=?', eventId)
    },
    async receiptHash(instanceId, dispatchId) {
      return c.one(
        'SELECT payload_hash FROM gateway_worker_receipts WHERE gateway_instance_id=? AND dispatch_id=?',
        instanceId,
        dispatchId,
      )
    },
    async probeAt(instanceId, accountResourceId, probedAt) {
      return c.one(
        'SELECT ok,total_tokens FROM gateway_bps_probes WHERE gateway_instance_id=? AND account_resource_id=? AND probed_at=?',
        instanceId,
        accountResourceId,
        probedAt,
      )
    },
    async latestAppliedAccountStateAt(instanceId) {
      return (
        await c.one(
          "SELECT occurred_at FROM executor_event_inbox WHERE instance_id=? AND type='account.state' AND status='applied' ORDER BY received_at DESC,rowid DESC LIMIT 1",
          instanceId,
        )
      )?.occurred_at
    },
    async pending() {
      return c.many("SELECT * FROM executor_event_inbox WHERE status='pending' ORDER BY received_at LIMIT 500")
    },
    async markChecked(eventId, status, detail, checkedAt) {
      await c.run(
        'UPDATE executor_event_inbox SET status=?,detail=?,checked_at=? WHERE event_id=?',
        status,
        detail,
        checkedAt,
        eventId,
      )
    },
    /** 待补齐尝试的行；条件与迁移 104 的部分索引逐字一致，并以 INDEXED BY 指定 */
    async attemptsTodo(receivedBefore) {
      return c.many(
        `SELECT event_id,payload_json,attempts_state FROM executor_event_inbox INDEXED BY idx_executor_inbox_attempts_todo
         WHERE attempts_state IS NULL AND type = 'request.finalized' AND mode = 'primary' AND status = 'applied'
           AND received_at < ?
         ORDER BY received_at LIMIT 200`,
        receivedBefore,
      )
    },
    async attemptsRetries() {
      return c.many(
        `SELECT event_id,attempts_state FROM executor_event_inbox INDEXED BY idx_executor_inbox_attempts_retry
         WHERE attempts_state LIKE 'retry:%'`,
      )
    },
    async payloadJson(eventId) {
      return (await c.one('SELECT payload_json FROM executor_event_inbox WHERE event_id=?', eventId))?.payload_json
    },
    async markAttempts(eventId, state) {
      await c.run('UPDATE executor_event_inbox SET attempts_state=? WHERE event_id=?', state, eventId)
    },
    async pruneBefore(receivedBefore) {
      await c.run('DELETE FROM executor_event_inbox WHERE received_at < ?', receivedBefore)
    },
    async countsSince(since) {
      return c.many(
        'SELECT type,mode,status,COUNT(*) AS n FROM executor_event_inbox WHERE received_at >= ? GROUP BY type,mode,status ORDER BY type,status',
        since,
      )
    },
    async attemptStatesSince(since) {
      return c.many(
        "SELECT CASE WHEN attempts_state LIKE 'retry:%' THEN 'retry' ELSE COALESCE(attempts_state,'pending') END AS state,COUNT(*) AS n FROM executor_event_inbox WHERE type='request.finalized' AND mode='primary' AND status='applied' AND received_at >= ? GROUP BY 1",
        since,
      )
    },
  }
}
