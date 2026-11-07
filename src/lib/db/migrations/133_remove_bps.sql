-- 133_remove_bps — BPS（Excel Basispoints）通道停止运营后删除其数据（2026-11-07，破坏性，只能前滚）。
-- 代码已删除 BPS 授权、设置、探测、恢复、移组、模型目录、Key 级通道策略与 BPS 用量下限结算，这里删除它们留下的数据：
--   1. 事实视图 gateway_account_facts_v1 去掉 BPS 列与 grant_kind='bps' 的凭据关联，读取契约版本 1 → 2
--      （Worker facts_db.go 只接受 2；旧版 Worker 读到版本 2 时拒绝加载事实，须与控制面同批升级）；
--      gateway_account_groups_v1 原样重建（视图依赖顺序）。
--   2. 账号事实触发器 gateway_facts_account_update 不再比对 config 里的 bps、bps_grant。
--   3. 凭据库删除 BPS 令牌（executor_credentials.grant_kind='bps'）。
--   4. Gateway 账号配置删除 bps（设置）、bps_grant（授权代次）、bps_catalog（模型目录）、bps_verification（严格探测）、
--      bps_moved（403 移组记录）。
--   5. 账号绑定删除 BPS 运行态列（迁移 095、097），删除 BPS 恢复探测记录表（迁移 096）。
--   6. Codex 本地设置删除 bps_enabled、bps_images、bps_defaults；API Key 删除 codex_route 列（迁移 098，Key 级
--      auto / native_only / bps_only 通道策略只为 BPS 而设）。
--   7. 执行事件收件箱删除 probe.recorded（BPS 恢复探测）事件。
-- 保留：usage_logs.authorization_mode 与 request_attempts.route 中的历史 bps 标记（只读展示历史请求），审计日志不改。

DROP VIEW IF EXISTS gateway_account_facts_v1;
DROP VIEW IF EXISTS gateway_account_groups_v1;
DROP TRIGGER IF EXISTS gateway_facts_account_update;

DELETE FROM executor_credentials WHERE grant_kind = 'bps';

UPDATE vendor_resources
SET config_json = json_remove(config_json, '$.bps', '$.bps_grant', '$.bps_catalog', '$.bps_verification', '$.bps_moved')
WHERE json_valid(config_json)
  AND (json_type(config_json, '$.bps') IS NOT NULL
    OR json_type(config_json, '$.bps_grant') IS NOT NULL
    OR json_type(config_json, '$.bps_catalog') IS NOT NULL
    OR json_type(config_json, '$.bps_verification') IS NOT NULL
    OR json_type(config_json, '$.bps_moved') IS NOT NULL);

DROP TABLE IF EXISTS gateway_bps_probes;

ALTER TABLE gateway_worker_account_bindings DROP COLUMN bps_state;
ALTER TABLE gateway_worker_account_bindings DROP COLUMN bps_error;
ALTER TABLE gateway_worker_account_bindings DROP COLUMN bps_blocked_at;
ALTER TABLE gateway_worker_account_bindings DROP COLUMN bps_recovery;
ALTER TABLE gateway_worker_account_bindings DROP COLUMN bps_next_probe_at;
ALTER TABLE gateway_worker_account_bindings DROP COLUMN bps_cooldown_until;

UPDATE executor_settings
SET values_json = json_remove(values_json, '$.bps_enabled', '$.bps_images', '$.bps_defaults')
WHERE json_valid(values_json)
  AND (json_type(values_json, '$.bps_enabled') IS NOT NULL
    OR json_type(values_json, '$.bps_images') IS NOT NULL
    OR json_type(values_json, '$.bps_defaults') IS NOT NULL);

ALTER TABLE api_keys DROP COLUMN codex_route;

DELETE FROM executor_event_inbox WHERE type = 'probe.recorded';

UPDATE gateway_fact_contract SET version = 2 WHERE id = 1;

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
      json_extract(OLD.config_json, '$.reset_credit_auto'), json_extract(OLD.config_json, '$.proxy_id'),
      json_extract(OLD.config_json, '$.email'), json_extract(OLD.config_json, '$.plan'),
      json_extract(OLD.config_json, '$.chatgpt_account_id'), json_extract(OLD.config_json, '$.runtime_account_id'),
      json_extract(OLD.config_json, '$.installation_id')
    ) IS NOT json_array(
      json_extract(NEW.config_json, '$.execution_kind'), json_extract(NEW.config_json, '$.platform'),
      json_extract(NEW.config_json, '$.max_concurrency'), json_extract(NEW.config_json, '$.max_rpm'),
      json_extract(NEW.config_json, '$.weight'), json_extract(NEW.config_json, '$.model_access'),
      json_extract(NEW.config_json, '$.reset_credit_auto'), json_extract(NEW.config_json, '$.proxy_id'),
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

CREATE VIEW gateway_account_groups_v1 AS
SELECT gr.resource_id AS account_resource_id, gr.group_id AS group_id
FROM group_resources gr
LEFT JOIN vendor_resources r ON r.id = gr.resource_id
LEFT JOIN vendors v ON v.id = r.vendor_id
LEFT JOIN vendors pv ON pv.id = v.parent_id
LEFT JOIN groups g ON g.id = gr.group_id
WHERE gr.resource_kind = 'gateway_worker_account'
  AND (
    r.vendor_id IS NULL
    OR (
      EXISTS (
        SELECT 1 FROM json_each(
          CASE WHEN json_array_length(COALESCE(v.groups_json, '[]')) > 0 THEN v.groups_json
               ELSE COALESCE(pv.groups_json, '[]') END
        ) e
        WHERE CAST(e.value AS TEXT) = CAST(gr.group_id AS TEXT) OR (g.name IS NOT NULL AND CAST(e.value AS TEXT) = g.name)
      )
      AND (
        v.parent_id IS NULL
        OR EXISTS (
          SELECT 1 FROM json_each(COALESCE(pv.groups_json, '[]')) e
          WHERE CAST(e.value AS TEXT) = CAST(gr.group_id AS TEXT) OR (g.name IS NOT NULL AND CAST(e.value AS TEXT) = g.name)
        )
      )
    )
  );

CREATE VIEW gateway_account_facts_v1 AS
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
  json_extract(r.config_json, '$.installation_id') AS installation_id,
  json_extract(r.config_json, '$.proxy_id') AS proxy_id,
  r.secret_json AS secret_json,
  n.revision AS native_revision,
  n.master_key_id AS native_master_key_id,
  n.wrapped_key AS native_wrapped_key,
  n.ciphertext AS native_ciphertext,
  n.expires_at AS native_expires_at,
  n.token_fingerprint AS native_fingerprint,
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
  COALESCE(f.revision, 0) AS fact_revision,
  CASE
    WHEN r.vendor_id IS NULL THEN 1
    WHEN v.id IS NULL OR v.status <> 'active' OR v.deleted_at IS NOT NULL THEN 0
    WHEN v.parent_id IS NOT NULL AND (pv.id IS NULL OR pv.status <> 'active' OR pv.deleted_at IS NOT NULL) THEN 0
    WHEN json_array_length(COALESCE(v.platforms_json, '[]')) > 0
      AND NOT EXISTS (SELECT 1 FROM json_each(v.platforms_json) e WHERE e.value IN ('openai', 'codex')) THEN 0
    WHEN v.parent_id IS NOT NULL AND json_array_length(COALESCE(pv.platforms_json, '[]')) > 0
      AND NOT EXISTS (SELECT 1 FROM json_each(pv.platforms_json) e WHERE e.value IN ('openai', 'codex')) THEN 0
    ELSE 1
  END AS vendor_active
FROM vendor_resources r
LEFT JOIN executor_credentials n ON n.account_resource_id = r.id AND n.grant_kind = 'native'
LEFT JOIN proxies p ON p.id = json_extract(r.config_json, '$.proxy_id')
LEFT JOIN gateway_account_fact_revisions f ON f.account_resource_id = r.id
LEFT JOIN vendors v ON v.id = r.vendor_id
LEFT JOIN vendors pv ON pv.id = v.parent_id
WHERE r.resource_type = 'account'
  AND json_extract(r.config_json, '$.execution_kind') = 'gateway_worker'
  AND json_extract(r.config_json, '$.platform') IN ('openai', 'codex');
