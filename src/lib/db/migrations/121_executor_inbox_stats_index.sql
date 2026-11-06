-- 121_executor_inbox_stats_index — 「Gateway Worker」页事件收件箱近 24 小时统计的覆盖索引（最终审计 U8 余项）。
-- countsSince（按 type/mode/status 分组）与 attemptStatesSince（request.finalized 的补齐状态）都按 received_at 取近 24 小时，
-- 只读 type、mode、status、attempts_state：以 received_at 开头、带齐这几列的索引让两个查询只做索引范围扫描、不回表；
-- 此前汇总缓存过期后每次要扫描整张收件箱（保留 7 天）。
CREATE INDEX IF NOT EXISTS idx_executor_event_inbox_stats
  ON executor_event_inbox(received_at, type, mode, status, attempts_state);
