/**
 * 执行事件链路健康检查用到的游标与收件箱读取（executor_event_cursors、executor_event_inbox）。
 */

export function eventCursor(db, ...params) {
  return db
    .prepare('SELECT last_seq,updated_at FROM executor_event_cursors WHERE instance_id=? AND stream_id=?')
    .get(...params)
}

export function recentAccountStateProblem(db, ...params) {
  return db
    .prepare(
      "SELECT 1 FROM executor_event_inbox WHERE instance_id=? AND type='account.state' AND status IN ('invalid','stale','failed') AND received_at>=? LIMIT 1",
    )
    .get(...params)
}
