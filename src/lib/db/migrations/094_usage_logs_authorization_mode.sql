-- 094_usage_logs_authorization_mode — Gateway 请求实际承接的授权方式。
--
-- usage_logs.authorization_mode：native（原生 Codex OAuth 账号）/ bps（Excel Basispoints 账号）。
-- 由 Worker 响应头 X-Kin-Gateway-Auth-Mode 写入；VM 与其他路径为 NULL。历史行保持 NULL，不回填。
-- 只用于运营查询与诊断，不参与计费与调度。

ALTER TABLE usage_logs ADD COLUMN authorization_mode TEXT;
