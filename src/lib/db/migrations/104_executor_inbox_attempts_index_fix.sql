-- 104_executor_inbox_attempts_index_fix — 修正 103 的部分索引（R2 复审 N1）。
-- 103 的索引条件含 OR，与查询条件不能互相推出，SQLite 从不使用它，只增加写入维护。
-- 改为两个条件单一的部分索引：待补齐行（attempts_state 为空）与待重试行（retry:），查询以 INDEXED BY 指定并与索引条件逐字一致。
DROP INDEX IF EXISTS idx_executor_event_inbox_attempts_pending;
CREATE INDEX IF NOT EXISTS idx_executor_inbox_attempts_todo
  ON executor_event_inbox(received_at)
  WHERE attempts_state IS NULL AND type = 'request.finalized' AND mode = 'primary' AND status = 'applied';
CREATE INDEX IF NOT EXISTS idx_executor_inbox_attempts_retry
  ON executor_event_inbox(received_at)
  WHERE attempts_state LIKE 'retry:%';
