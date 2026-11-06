-- 092_gateway_request_diagnostics — Gateway 请求记录的诊断事实（对齐 codex-proxy-rs 5100f633）。
--
-- usage_logs：
--   error_kind：网关错误分类（Worker 失败分类或流内失败分类），与上游原始 error_code 分开。
--   upstream_error_json：已保存的上游错误对象投影 {code,type,message,param,close_reason,last_event_type}，
--     只取上游声明的字段，不重新分类、不含请求正文或响应头；缺失时为 NULL。
--   websocket_close_code：上游 WS 在终态前断开时关闭帧的数字码；非 WS 或未断开为 NULL。
--   continuation_unavailable_reason：返回 previous_response_not_found 时的续接不可用原因。
--   upstream_connection_exit_reason：上游 WS 在终态前退出的原因（closed_by_upstream / stream_idle_timeout / read_error）。
--   retry_after_ms：失败响应携带的重试等待毫秒数。
-- request_attempts：upstream_request_id / cf_ray 关联上游日志。
-- 只用于受控诊断（超级管理员可见），不参与计费、调度与错误分类。历史行保持 NULL。

ALTER TABLE usage_logs ADD COLUMN error_kind TEXT;
ALTER TABLE usage_logs ADD COLUMN upstream_error_json TEXT;
ALTER TABLE usage_logs ADD COLUMN websocket_close_code INTEGER;
ALTER TABLE usage_logs ADD COLUMN continuation_unavailable_reason TEXT;
ALTER TABLE usage_logs ADD COLUMN upstream_connection_exit_reason TEXT;
ALTER TABLE usage_logs ADD COLUMN retry_after_ms INTEGER;
ALTER TABLE request_attempts ADD COLUMN upstream_request_id TEXT;
ALTER TABLE request_attempts ADD COLUMN cf_ray TEXT;
