-- 089_gateway_account_credential_state — Gateway Worker 心跳上报的凭据终态（expired/invalid/banned/unverified）
-- 与 Worker 最近错误（如 credential_refresh_failed）；NULL 表示凭据可用。没有请求的账号也能在列表显示凭据失效。
ALTER TABLE gateway_worker_account_bindings ADD COLUMN credential_state TEXT;
ALTER TABLE gateway_worker_account_bindings ADD COLUMN credential_error TEXT;
