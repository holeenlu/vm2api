-- 124_gateway_account_facts — Gateway 事实直读的读取契约（设计第 19 节，G2）。
-- Gateway Worker 同机以只读方式直读本库：只读下面两个视图，不读其他表。视图的列是契约，改列须提升
-- gateway_fact_contract.version，并同步 Worker 支持的版本区间（worker/internal/codexgateway/facts_db.go）。
-- 变更感知：触发器在与账号事实相关的写入后推进全局序列 gateway_fact_seq，并把该账号的版本记为新的序列值；
-- Worker 轮询 PRAGMA data_version，变化后按版本增量读取。只加不改：不触碰上游表的结构与历史迁移。

-- Worker 心跳上报的事实读取状态与影子比对结果（G2；Gateway Worker 页展示）
ALTER TABLE gateway_worker_instances ADD COLUMN facts_json TEXT;

CREATE TABLE IF NOT EXISTS gateway_fact_contract (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL
);
INSERT OR IGNORE INTO gateway_fact_contract(id, version) VALUES (1, 1);

CREATE TABLE IF NOT EXISTS gateway_fact_seq (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  value INTEGER NOT NULL
);
INSERT OR IGNORE INTO gateway_fact_seq(id, value) VALUES (1, 0);

CREATE TABLE IF NOT EXISTS gateway_account_fact_revisions (
  account_resource_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  changed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gateway_account_fact_revisions_revision
  ON gateway_account_fact_revisions(revision);

-- 早期账号的运行账号 ID 只记在绑定表：回填到 config.runtime_account_id（取最近更新的绑定，没有绑定时按新账号的
-- 命名 gwacct_<资源 ID>）。新账号在授权完成时已写入。Worker 以它寻址续接归属、协议状态与回执。
UPDATE vendor_resources
SET config_json = json_set(
  config_json,
  '$.runtime_account_id',
  COALESCE(
    (SELECT b.runtime_account_id FROM gateway_worker_account_bindings b
      WHERE b.account_resource_id = vendor_resources.id ORDER BY b.updated_at DESC LIMIT 1),
    'gwacct_' || vendor_resources.id
  )
)
WHERE resource_type = 'account'
  AND json_extract(config_json, '$.execution_kind') = 'gateway_worker'
  AND json_extract(config_json, '$.runtime_account_id') IS NULL;

CREATE INDEX IF NOT EXISTS idx_vendor_resources_gateway_runtime
  ON vendor_resources(json_extract(config_json, '$.runtime_account_id'))
  WHERE resource_type = 'account';

-- 账号事实变化：只在 Worker 读取的配置键、状态、密文、归档或墓碑变化时推进（订阅、备注、BPS 目录等写入不推进）
CREATE TRIGGER IF NOT EXISTS gateway_facts_account_insert
AFTER INSERT ON vendor_resources
WHEN NEW.resource_type = 'account' AND json_extract(NEW.config_json, '$.execution_kind') = 'gateway_worker'
BEGIN
  UPDATE gateway_fact_seq SET value = value + 1 WHERE id = 1;
  INSERT INTO gateway_account_fact_revisions(account_resource_id, revision, changed_at)
  VALUES (NEW.id, (SELECT value FROM gateway_fact_seq WHERE id = 1), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT(account_resource_id) DO UPDATE SET revision = excluded.revision, changed_at = excluded.changed_at;
END;

CREATE TRIGGER IF NOT EXISTS gateway_facts_account_update
AFTER UPDATE ON vendor_resources
WHEN NEW.resource_type = 'account'
  AND (json_extract(NEW.config_json, '$.execution_kind') = 'gateway_worker'
    OR json_extract(OLD.config_json, '$.execution_kind') = 'gateway_worker')
  AND (
    NEW.status IS NOT OLD.status
    OR NEW.secret_json IS NOT OLD.secret_json
    OR NEW.archived_at IS NOT OLD.archived_at
    OR NEW.deleted_at IS NOT OLD.deleted_at
    OR NEW.name IS NOT OLD.name
    OR json_array(
      json_extract(OLD.config_json, '$.execution_kind'), json_extract(OLD.config_json, '$.platform'),
      json_extract(OLD.config_json, '$.max_concurrency'), json_extract(OLD.config_json, '$.max_rpm'),
      json_extract(OLD.config_json, '$.weight'), json_extract(OLD.config_json, '$.model_access'),
      json_extract(OLD.config_json, '$.reset_credit_auto'), json_extract(OLD.config_json, '$.bps'),
      json_extract(OLD.config_json, '$.bps_grant'), json_extract(OLD.config_json, '$.proxy_id'),
      json_extract(OLD.config_json, '$.email'), json_extract(OLD.config_json, '$.plan'),
      json_extract(OLD.config_json, '$.chatgpt_account_id'), json_extract(OLD.config_json, '$.runtime_account_id'),
      json_extract(OLD.config_json, '$.installation_id')
    ) IS NOT json_array(
      json_extract(NEW.config_json, '$.execution_kind'), json_extract(NEW.config_json, '$.platform'),
      json_extract(NEW.config_json, '$.max_concurrency'), json_extract(NEW.config_json, '$.max_rpm'),
      json_extract(NEW.config_json, '$.weight'), json_extract(NEW.config_json, '$.model_access'),
      json_extract(NEW.config_json, '$.reset_credit_auto'), json_extract(NEW.config_json, '$.bps'),
      json_extract(NEW.config_json, '$.bps_grant'), json_extract(NEW.config_json, '$.proxy_id'),
      json_extract(NEW.config_json, '$.email'), json_extract(NEW.config_json, '$.plan'),
      json_extract(NEW.config_json, '$.chatgpt_account_id'), json_extract(NEW.config_json, '$.runtime_account_id'),
      json_extract(NEW.config_json, '$.installation_id')
    )
  )
BEGIN
  UPDATE gateway_fact_seq SET value = value + 1 WHERE id = 1;
  INSERT INTO gateway_account_fact_revisions(account_resource_id, revision, changed_at)
  VALUES (NEW.id, (SELECT value FROM gateway_fact_seq WHERE id = 1), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT(account_resource_id) DO UPDATE SET revision = excluded.revision, changed_at = excluded.changed_at;
END;

CREATE TRIGGER IF NOT EXISTS gateway_facts_account_delete
AFTER DELETE ON vendor_resources
WHEN OLD.resource_type = 'account' AND json_extract(OLD.config_json, '$.execution_kind') = 'gateway_worker'
BEGIN
  UPDATE gateway_fact_seq SET value = value + 1 WHERE id = 1;
  INSERT INTO gateway_account_fact_revisions(account_resource_id, revision, changed_at)
  VALUES (OLD.id, (SELECT value FROM gateway_fact_seq WHERE id = 1), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT(account_resource_id) DO UPDATE SET revision = excluded.revision, changed_at = excluded.changed_at;
END;

-- 凭据库：授权、导入、轮换、撤销
CREATE TRIGGER IF NOT EXISTS gateway_facts_credential_insert
AFTER INSERT ON executor_credentials
BEGIN
  UPDATE gateway_fact_seq SET value = value + 1 WHERE id = 1;
  INSERT INTO gateway_account_fact_revisions(account_resource_id, revision, changed_at)
  VALUES (NEW.account_resource_id, (SELECT value FROM gateway_fact_seq WHERE id = 1), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT(account_resource_id) DO UPDATE SET revision = excluded.revision, changed_at = excluded.changed_at;
END;

CREATE TRIGGER IF NOT EXISTS gateway_facts_credential_update
AFTER UPDATE ON executor_credentials
BEGIN
  UPDATE gateway_fact_seq SET value = value + 1 WHERE id = 1;
  INSERT INTO gateway_account_fact_revisions(account_resource_id, revision, changed_at)
  VALUES (NEW.account_resource_id, (SELECT value FROM gateway_fact_seq WHERE id = 1), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT(account_resource_id) DO UPDATE SET revision = excluded.revision, changed_at = excluded.changed_at;
END;

CREATE TRIGGER IF NOT EXISTS gateway_facts_credential_delete
AFTER DELETE ON executor_credentials
BEGIN
  UPDATE gateway_fact_seq SET value = value + 1 WHERE id = 1;
  INSERT INTO gateway_account_fact_revisions(account_resource_id, revision, changed_at)
  VALUES (OLD.account_resource_id, (SELECT value FROM gateway_fact_seq WHERE id = 1), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT(account_resource_id) DO UPDATE SET revision = excluded.revision, changed_at = excluded.changed_at;
END;

-- 分组成员（只看 Gateway 账号）
CREATE TRIGGER IF NOT EXISTS gateway_facts_group_insert
AFTER INSERT ON group_resources
WHEN NEW.resource_kind = 'gateway_worker_account'
BEGIN
  UPDATE gateway_fact_seq SET value = value + 1 WHERE id = 1;
  INSERT INTO gateway_account_fact_revisions(account_resource_id, revision, changed_at)
  VALUES (NEW.resource_id, (SELECT value FROM gateway_fact_seq WHERE id = 1), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT(account_resource_id) DO UPDATE SET revision = excluded.revision, changed_at = excluded.changed_at;
END;

CREATE TRIGGER IF NOT EXISTS gateway_facts_group_delete
AFTER DELETE ON group_resources
WHEN OLD.resource_kind = 'gateway_worker_account'
BEGIN
  UPDATE gateway_fact_seq SET value = value + 1 WHERE id = 1;
  INSERT INTO gateway_account_fact_revisions(account_resource_id, revision, changed_at)
  VALUES (OLD.resource_id, (SELECT value FROM gateway_fact_seq WHERE id = 1), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT(account_resource_id) DO UPDATE SET revision = excluded.revision, changed_at = excluded.changed_at;
END;

CREATE TRIGGER IF NOT EXISTS gateway_facts_group_update
AFTER UPDATE ON group_resources
WHEN NEW.resource_kind = 'gateway_worker_account' OR OLD.resource_kind = 'gateway_worker_account'
BEGIN
  UPDATE gateway_fact_seq SET value = value + 1 WHERE id = 1;
  INSERT INTO gateway_account_fact_revisions(account_resource_id, revision, changed_at)
  SELECT id, (SELECT value FROM gateway_fact_seq WHERE id = 1), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM (SELECT OLD.resource_id AS id WHERE OLD.resource_kind = 'gateway_worker_account'
        UNION SELECT NEW.resource_id WHERE NEW.resource_kind = 'gateway_worker_account')
  WHERE true
  ON CONFLICT(account_resource_id) DO UPDATE SET revision = excluded.revision, changed_at = excluded.changed_at;
END;

-- 平台代理：只看随账号下发的 WS 连接上限与请求位置（探测写的延迟、状态等不推进）
CREATE TRIGGER IF NOT EXISTS gateway_facts_proxy_update
AFTER UPDATE ON proxies
WHEN json_array(
    OLD.max_websocket_connections, OLD.request_location_mode, OLD.location_country, OLD.location_region,
    OLD.location_city, OLD.location_timezone, OLD.geo_country_code, OLD.geo_region, OLD.geo_city, OLD.geo_timezone,
    OLD.geo_v6_country_code, OLD.geo_v6_region, OLD.geo_v6_city, OLD.geo_v6_timezone
  ) IS NOT json_array(
    NEW.max_websocket_connections, NEW.request_location_mode, NEW.location_country, NEW.location_region,
    NEW.location_city, NEW.location_timezone, NEW.geo_country_code, NEW.geo_region, NEW.geo_city, NEW.geo_timezone,
    NEW.geo_v6_country_code, NEW.geo_v6_region, NEW.geo_v6_city, NEW.geo_v6_timezone
  )
BEGIN
  UPDATE gateway_fact_seq SET value = value + 1 WHERE id = 1;
  INSERT INTO gateway_account_fact_revisions(account_resource_id, revision, changed_at)
  SELECT r.id, (SELECT value FROM gateway_fact_seq WHERE id = 1), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM vendor_resources r
  WHERE r.resource_type = 'account'
    AND json_extract(r.config_json, '$.execution_kind') = 'gateway_worker'
    AND json_extract(r.config_json, '$.proxy_id') = NEW.id
  ON CONFLICT(account_resource_id) DO UPDATE SET revision = excluded.revision, changed_at = excluded.changed_at;
END;

-- 读取契约 v1。分组只在这里取：以后统一分组关系服务只需重定义此视图，Worker 不用改。
CREATE VIEW IF NOT EXISTS gateway_account_groups_v1 AS
SELECT resource_id AS account_resource_id, group_id
FROM group_resources
WHERE resource_kind = 'gateway_worker_account';

-- 每个 Gateway 账号一行（含归档与墓碑，Worker 据状态移出调度）。口径与 listCodexAccounts、
-- desiredGatewayAccountConfig 一致；secret_json 与凭据库字段原样输出密文，由 Worker 解密。
CREATE VIEW IF NOT EXISTS gateway_account_facts_v1 AS
SELECT
  r.id AS account_resource_id,
  json_extract(r.config_json, '$.runtime_account_id') AS runtime_account_id,
  r.vendor_id AS vendor_id,
  r.name AS name,
  r.status AS status,
  r.archived_at AS archived_at,
  r.deleted_at AS deleted_at,
  json_extract(r.config_json, '$.email') AS email,
  json_extract(r.config_json, '$.plan') AS plan,
  json_extract(r.config_json, '$.chatgpt_account_id') AS chatgpt_account_id,
  json_extract(r.config_json, '$.max_concurrency') AS max_concurrency,
  json_extract(r.config_json, '$.max_rpm') AS max_rpm,
  json_extract(r.config_json, '$.weight') AS weight,
  json_extract(r.config_json, '$.model_access') AS model_access_json,
  json_extract(r.config_json, '$.reset_credit_auto') AS reset_credit_auto,
  json_extract(r.config_json, '$.bps') AS bps_settings_json,
  json_extract(r.config_json, '$.bps_grant.revision') AS bps_grant_revision,
  json_extract(r.config_json, '$.installation_id') AS installation_id,
  json_extract(r.config_json, '$.proxy_id') AS proxy_id,
  r.secret_json AS secret_json,
  n.revision AS native_revision,
  n.master_key_id AS native_master_key_id,
  n.wrapped_key AS native_wrapped_key,
  n.ciphertext AS native_ciphertext,
  n.expires_at AS native_expires_at,
  n.token_fingerprint AS native_fingerprint,
  b.revision AS bps_revision,
  b.master_key_id AS bps_master_key_id,
  b.wrapped_key AS bps_wrapped_key,
  b.ciphertext AS bps_ciphertext,
  b.expires_at AS bps_expires_at,
  p.max_websocket_connections AS proxy_max_websocket_connections,
  p.request_location_mode AS proxy_request_location_mode,
  p.location_country AS proxy_location_country,
  p.location_region AS proxy_location_region,
  p.location_city AS proxy_location_city,
  p.location_timezone AS proxy_location_timezone,
  p.geo_country_code AS proxy_geo_country_code,
  p.geo_region AS proxy_geo_region,
  p.geo_city AS proxy_geo_city,
  p.geo_timezone AS proxy_geo_timezone,
  p.geo_v6_country_code AS proxy_geo_v6_country_code,
  p.geo_v6_region AS proxy_geo_v6_region,
  p.geo_v6_city AS proxy_geo_v6_city,
  p.geo_v6_timezone AS proxy_geo_v6_timezone,
  (SELECT json_group_array(g.group_id) FROM gateway_account_groups_v1 g WHERE g.account_resource_id = r.id)
    AS group_ids_json,
  COALESCE(f.revision, 0) AS fact_revision
FROM vendor_resources r
LEFT JOIN executor_credentials n ON n.account_resource_id = r.id AND n.grant_kind = 'native'
LEFT JOIN executor_credentials b ON b.account_resource_id = r.id AND b.grant_kind = 'bps'
LEFT JOIN proxies p ON p.id = json_extract(r.config_json, '$.proxy_id')
LEFT JOIN gateway_account_fact_revisions f ON f.account_resource_id = r.id
WHERE r.resource_type = 'account'
  AND json_extract(r.config_json, '$.execution_kind') = 'gateway_worker'
  AND json_extract(r.config_json, '$.platform') IN ('openai', 'codex');
