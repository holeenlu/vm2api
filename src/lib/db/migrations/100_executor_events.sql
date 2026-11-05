-- 100_executor_events — 执行契约 v1 的事件发件箱（docs/ARCHITECTURE_CONTROL_PLANE_EXECUTORS_20261105.md 5.6）。
--
-- executor_event_cursors：控制面对每个执行实例每条事件流（Worker 数据目录重建即换新流）已处理到的序号。
-- executor_event_inbox：已拉取事件的去重与处理结果。mode 为拉取时的 KIN_EXECUTOR_EVENTS（shadow / primary）；
--   status：recorded（只记录）、matched / diff / pending / missing（影子比对结果）、applied（主来源已生效）、failed（处理失败待重试）。
--   保留 7 天，只用于比对、诊断与重放核查，不是计费依据。
CREATE TABLE IF NOT EXISTS executor_event_cursors (
  instance_id TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  last_seq INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (instance_id, stream_id)
);

CREATE TABLE IF NOT EXISTS executor_event_inbox (
  event_id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  subject_json TEXT,
  payload_json TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT,
  received_at TEXT NOT NULL,
  checked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_executor_event_inbox_status ON executor_event_inbox(status, received_at);
CREATE INDEX IF NOT EXISTS idx_executor_event_inbox_stream ON executor_event_inbox(instance_id, stream_id, seq);
