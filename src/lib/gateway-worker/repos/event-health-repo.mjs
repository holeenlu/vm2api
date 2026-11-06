/**
 * 执行事件链路健康检查用到的游标与收件箱读取（executor_event_cursors、executor_event_inbox）。经 DbClient 异步访问（R6 B5）。
 */
import { dbClient } from '../../db/db-client.mjs'

export async function eventCursor(db, instanceId, streamId) {
  return dbClient(db).one(
    'SELECT last_seq,updated_at FROM executor_event_cursors WHERE instance_id=? AND stream_id=?',
    instanceId,
    streamId,
  )
}

export async function recentAccountStateProblem(db, instanceId, receivedAt) {
  return dbClient(db).one(
    "SELECT 1 FROM executor_event_inbox WHERE instance_id=? AND type='account.state' AND status IN ('invalid','stale','failed') AND received_at>=? LIMIT 1",
    instanceId,
    receivedAt,
  )
}
