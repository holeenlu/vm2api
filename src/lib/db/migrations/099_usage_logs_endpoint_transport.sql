-- 099_usage_logs_endpoint_transport — 使用记录的入站/上游端点与传输方式（超级管理员「端点」「类型」列）。
--
-- inbound_transport：客户端入站方式，http 或 websocket（Responses WebSocket 每个 response.create 记一行）。
-- upstream_path：实际发往上游的请求路径（仅 pathname，不含主机与查询串），由执行路径在发出请求时写入：
--   VM Claude 槽位 /v1/messages；API 端点取所配基址拼出的路径；Gateway Worker 由 Worker 回报
--   （原生 /backend-api/codex/responses、BPS /basispoints/api/responses 等）；未发往上游为 NULL。
-- upstream_transport：上游传输方式 http / websocket；无法确定为 NULL。
-- 只用于展示，不参与计费、调度与错误分类。历史行保持 NULL。

ALTER TABLE usage_logs ADD COLUMN inbound_transport TEXT;
ALTER TABLE usage_logs ADD COLUMN upstream_path TEXT;
ALTER TABLE usage_logs ADD COLUMN upstream_transport TEXT;
