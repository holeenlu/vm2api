-- 108_gateway_oauth_session_custody — 授权会话迁回控制面（统一控制面重构 P3.7，设计 6.3）。
-- 控制面生成 state 与 PKCE verifier，经 Worker 补上账号安装身份后整份加密保存在 session_json（maybeEncrypt），
-- 完成授权时随请求交给 Worker 换码；完成或过期后清空。Worker 不再落盘保存会话。
ALTER TABLE gateway_worker_oauth_sessions ADD COLUMN session_json TEXT;
