-- foreign-keys: rebuild
-- 130_gateway_single_worker_cleanup — 同机单 Worker 收尾简化 S5（设计 19.5，破坏性，只能前滚）。
-- S1b–S4 删除了刷新租约、回执推送与补拉、实例密钥与引导、待批准实例、Redis 共享运行态，这里删除它们留下的表与列，
-- 并把账号绑定收缩为纯运行态表：
--   1. 账号绑定不再记承接实例（只支持同机的单个 Worker，向 Worker 发请求一律选当前接单的实例）：
--      重建 gateway_worker_account_bindings，去掉 gateway_instance_id 及其外键与索引；projection_status 去掉
--      投影时期的 blocked、archived（G4 起没有写入方，存量改为 pending，由下一次心跳重新标记）。
--      保留表名与 runtime_account_id（usage-logs-view 等按它 JOIN）。
--   2. 授权会话不再记实例（S1 起授权在控制面完成）：重建 gateway_worker_oauth_sessions，去掉 gateway_instance_id，
--      幂等键改为全局唯一（取值是授权草稿 ID）。
--   3. 删除表：gateway_worker_instance_keys、gateway_worker_bootstrap_grants（S4）、gateway_worker_receipt_offsets（S2）、
--      credential_refresh_leases（S1b）。
--   4. 删除实例表的 approval_state（S4）、shared_state_json（S3）列。
-- 入口不会自动快照数据库：部署前手工停写快照数据库并备份主密钥文件。

CREATE TABLE gateway_worker_account_bindings_s5 (
  id TEXT PRIMARY KEY,
  account_resource_id TEXT NOT NULL UNIQUE REFERENCES vendor_resources(id),
  runtime_account_id TEXT NOT NULL UNIQUE,
  credential_revision INTEGER NOT NULL DEFAULT 0,
  projection_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (projection_status IN ('pending','synced','drifted')),
  projection_error TEXT,
  last_projected_at TEXT,
  last_seen_at TEXT,
  quota_json TEXT,
  runtime_status TEXT,
  last_error TEXT,
  inflight INTEGER NOT NULL DEFAULT 0,
  credential_state TEXT,
  credential_error TEXT,
  bps_state TEXT,
  bps_error TEXT,
  bps_blocked_at TEXT,
  bps_recovery TEXT,
  bps_next_probe_at TEXT,
  bps_cooldown_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO gateway_worker_account_bindings_s5(
  id, account_resource_id, runtime_account_id, credential_revision, projection_status, projection_error,
  last_projected_at, last_seen_at, quota_json, runtime_status, last_error, inflight, credential_state, credential_error,
  bps_state, bps_error, bps_blocked_at, bps_recovery, bps_next_probe_at, bps_cooldown_until, created_at, updated_at
)
SELECT
  id, account_resource_id, runtime_account_id, credential_revision,
  CASE WHEN projection_status IN ('pending','synced','drifted') THEN projection_status ELSE 'pending' END,
  projection_error, last_projected_at, last_seen_at, quota_json, runtime_status, last_error, inflight, credential_state,
  credential_error, bps_state, bps_error, bps_blocked_at, bps_recovery, bps_next_probe_at, bps_cooldown_until,
  created_at, updated_at
FROM gateway_worker_account_bindings;

DROP INDEX IF EXISTS idx_gateway_worker_bindings_instance;
DROP TABLE gateway_worker_account_bindings;
ALTER TABLE gateway_worker_account_bindings_s5 RENAME TO gateway_worker_account_bindings;

CREATE TABLE gateway_worker_oauth_sessions_s5 (
  session_id TEXT PRIMARY KEY,
  account_resource_id TEXT REFERENCES vendor_resources(id),
  actor_user_id TEXT,
  state_hash TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'openai',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','completed','failed','expired','cancelled')),
  idempotency_key TEXT UNIQUE,
  expires_at TEXT NOT NULL,
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  session_json TEXT
);

-- 同一幂等键原来可能在不同实例下各有一行：保留最近更新的一行
INSERT INTO gateway_worker_oauth_sessions_s5(
  session_id, account_resource_id, actor_user_id, state_hash, provider, status, idempotency_key, expires_at,
  result_json, created_at, updated_at, session_json
)
SELECT
  s.session_id, s.account_resource_id, s.actor_user_id, s.state_hash, s.provider, s.status, s.idempotency_key,
  s.expires_at, s.result_json, s.created_at, s.updated_at, s.session_json
FROM gateway_worker_oauth_sessions s
WHERE s.idempotency_key IS NULL
   OR s.rowid = (
     SELECT k.rowid FROM gateway_worker_oauth_sessions k
      WHERE k.idempotency_key = s.idempotency_key
      ORDER BY k.updated_at DESC, k.rowid DESC
      LIMIT 1
   );

DROP INDEX IF EXISTS idx_gateway_worker_oauth_sessions_expiry;
DROP TABLE gateway_worker_oauth_sessions;
ALTER TABLE gateway_worker_oauth_sessions_s5 RENAME TO gateway_worker_oauth_sessions;
CREATE INDEX IF NOT EXISTS idx_gateway_worker_oauth_sessions_expiry
  ON gateway_worker_oauth_sessions(status, expires_at);

DROP TABLE IF EXISTS gateway_worker_instance_keys;
DROP TABLE IF EXISTS gateway_worker_bootstrap_grants;
DROP TABLE IF EXISTS gateway_worker_receipt_offsets;
DROP TABLE IF EXISTS credential_refresh_leases;

ALTER TABLE gateway_worker_instances DROP COLUMN approval_state;
ALTER TABLE gateway_worker_instances DROP COLUMN shared_state_json;
