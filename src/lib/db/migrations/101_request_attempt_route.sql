-- 101_request_attempt_route — 请求尝试补充执行通道信息（统一控制面重构 P2.2）。
-- route：Gateway Worker 尝试的通道（native / bps），其他执行方式为 NULL。
-- stage：BPS 尝试到达的阶段（prepare / images / attachments / compaction / responses / images_endpoint / stream），用于定位失败环节。
-- credential_revision：尝试使用的账号凭据代次。
-- 历史行为 NULL。
ALTER TABLE request_attempts ADD COLUMN route TEXT;
ALTER TABLE request_attempts ADD COLUMN stage TEXT;
ALTER TABLE request_attempts ADD COLUMN credential_revision INTEGER;

-- executor_event_inbox.attempts_state：主来源模式下 request.finalized 补齐请求尝试的进度（统一结果写入器，P2.1）。
-- NULL 表示尚未处理；done 表示已按事件补齐或补注；skipped 表示载荷没有 request_id 或尝试列表。
ALTER TABLE executor_event_inbox ADD COLUMN attempts_state TEXT;

-- gateway_worker_instances.executor_events_json：Worker 心跳上报的事件发件箱水位（stream_id、required、head、acked、
-- backlog_bytes、healthy、error），用于积压告警、面板展示与“事件链路是否健康”的判断（R1 审查 P1-3、P1-5）。
ALTER TABLE gateway_worker_instances ADD COLUMN executor_events_json TEXT;
