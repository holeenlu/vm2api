-- 103_executor_inbox_attempts_index — 事件补齐请求尝试的待处理查询只扫描待处理行（R2 审查 P2-2）。
-- 收件箱保留 7 天；没有这个部分索引时，每 5 秒的补齐查询要越过全部已处理行。
CREATE INDEX IF NOT EXISTS idx_executor_event_inbox_attempts_pending
  ON executor_event_inbox(received_at)
  WHERE type = 'request.finalized' AND mode = 'primary' AND status = 'applied'
    AND (attempts_state IS NULL OR attempts_state LIKE 'retry:%');
