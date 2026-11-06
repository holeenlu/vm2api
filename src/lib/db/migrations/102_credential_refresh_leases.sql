-- 102_credential_refresh_leases — 凭据刷新租约（统一控制面重构 P3.1，设计第 6 节）。
--
-- OpenAI 的刷新令牌是一次性轮换：多个 Worker 持有同一账号副本时各自刷新，只有第一个成功，其余副本的令牌随即失效。
-- 开启 KIN_REFRESH_LEASE=on 后，Worker 刷新前向控制面申请租约，同一账号同一授权类别（native / bps）同一时刻只有一个持有者；
-- 刷新成功后报告新代次，控制面把新凭据投影到其他实例。租约 60 秒过期，过期后可被重新申请。
CREATE TABLE IF NOT EXISTS credential_refresh_leases (
  account_resource_id TEXT NOT NULL,
  grant_kind TEXT NOT NULL,
  holder_instance_id TEXT NOT NULL,
  runtime_account_id TEXT NOT NULL,
  lease_token TEXT NOT NULL,
  credential_revision INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL,
  outcome TEXT,
  expires_at TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_resource_id, grant_kind)
);
