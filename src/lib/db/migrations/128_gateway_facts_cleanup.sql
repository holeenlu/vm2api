-- foreign-keys: rebuild
-- 128_gateway_facts_cleanup — Gateway 事实直读 G5（设计第 19 节，破坏性，只能前滚）。
-- G4a/G4b 删除了投影推送、托管封装、多 Worker 与 mTLS，这里删除它们留下的表、列与配置键：
--   1. 投影任务与 Worker 分组映射：gateway_worker_projection_jobs、gateway_worker_scopes（G4 后没有读写方）；
--   2. 账号绑定改为每个账号一行（只支持同机的单个 Worker）：UNIQUE(account_resource_id)、UNIQUE(runtime_account_id)，
--      gateway_instance_id 记当前承接它的实例（替换实例时由新实例的心跳改指，见 gateway-repo markFactsSynced）；
--      同一账号原有多行时保留已同步、最近更新的一行；删去投影版本、指纹与运行版本列（没有读写方）；
--   3. 回执的 projection_revision 列；实例的托管公钥两列（custody_public_key、custody_key_pending）与证书两列
--      （tls_fingerprint、certificate_expires_at）；
--   4. Gateway 账号 config_json 里的 group_ids（分组只以 group_resources 为准，账号视图读取时现算）、
--      projection_revision、config_fingerprint。
-- 执行前备份数据库（升级入口每次启动前自动快照到 data/backups/auto/）。

DROP INDEX IF EXISTS idx_gateway_worker_projection_jobs_due;
DROP TABLE IF EXISTS gateway_worker_projection_jobs;
DROP INDEX IF EXISTS idx_gateway_worker_scopes_group;
DROP TABLE IF EXISTS gateway_worker_scopes;

CREATE TABLE gateway_worker_account_bindings_g5 (
  id TEXT PRIMARY KEY,
  account_resource_id TEXT NOT NULL UNIQUE REFERENCES vendor_resources(id),
  gateway_instance_id TEXT NOT NULL REFERENCES gateway_worker_instances(id),
  runtime_account_id TEXT NOT NULL UNIQUE,
  credential_revision INTEGER NOT NULL DEFAULT 0,
  projection_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (projection_status IN ('pending','synced','drifted','blocked','archived')),
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

INSERT INTO gateway_worker_account_bindings_g5(
  id, account_resource_id, gateway_instance_id, runtime_account_id, credential_revision, projection_status,
  projection_error, last_projected_at, last_seen_at, quota_json, runtime_status, last_error, inflight,
  credential_state, credential_error, bps_state, bps_error, bps_blocked_at, bps_recovery, bps_next_probe_at,
  bps_cooldown_until, created_at, updated_at
)
SELECT
  b.id, b.account_resource_id, b.gateway_instance_id, b.runtime_account_id,
  (SELECT MAX(o.credential_revision) FROM gateway_worker_account_bindings o
    WHERE o.account_resource_id = b.account_resource_id),
  b.projection_status, b.projection_error, b.last_projected_at, b.last_seen_at, b.quota_json, b.runtime_status,
  b.last_error, b.inflight, b.credential_state, b.credential_error, b.bps_state, b.bps_error, b.bps_blocked_at,
  b.bps_recovery, b.bps_next_probe_at, b.bps_cooldown_until, b.created_at, b.updated_at
FROM gateway_worker_account_bindings b
WHERE b.rowid = (
  SELECT k.rowid FROM gateway_worker_account_bindings k
   WHERE k.account_resource_id = b.account_resource_id
   ORDER BY (k.projection_status = 'synced') DESC, k.updated_at DESC, k.rowid DESC
   LIMIT 1
);

DROP INDEX IF EXISTS idx_gateway_worker_bindings_resource;
DROP TABLE gateway_worker_account_bindings;
ALTER TABLE gateway_worker_account_bindings_g5 RENAME TO gateway_worker_account_bindings;
CREATE INDEX IF NOT EXISTS idx_gateway_worker_bindings_instance
  ON gateway_worker_account_bindings(gateway_instance_id, runtime_account_id);

ALTER TABLE gateway_worker_receipts DROP COLUMN projection_revision;
ALTER TABLE gateway_worker_instances DROP COLUMN custody_public_key;
ALTER TABLE gateway_worker_instances DROP COLUMN custody_key_pending;
ALTER TABLE gateway_worker_instances DROP COLUMN tls_fingerprint;
ALTER TABLE gateway_worker_instances DROP COLUMN certificate_expires_at;

UPDATE vendor_resources
   SET config_json = json_remove(config_json, '$.group_ids', '$.projection_revision', '$.config_fingerprint')
 WHERE resource_type = 'account'
   AND json_extract(config_json, '$.execution_kind') = 'gateway_worker'
   AND (json_type(config_json, '$.group_ids') IS NOT NULL
     OR json_type(config_json, '$.projection_revision') IS NOT NULL
     OR json_type(config_json, '$.config_fingerprint') IS NOT NULL);
