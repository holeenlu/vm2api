-- 129_gateway_facts_vendor_gate — Gateway 账号按供应商状态与授权范围调度（设计第 19 节，审查补漏）。
-- VM 资源在选号时核对供应商（vendorRuntimeBlock：供应商或上级停用、平台不再授权、所在分组不在授权范围）；
-- Gateway 账号由 Worker 直读事实调度，此前视图不含供应商信息，供应商停用或收回分组后账号仍接单。这里：
--   1. gateway_account_groups_v1 只给出供应商授权范围内的分组（口径同 vendorAllowsGroup：按分组 ID 或名称匹配，
--      自身为空时继承上级，有上级时还须在上级范围内）；平台账号（vendor_id 为空）不受限；
--   2. gateway_account_facts_v1 增加 vendor_active 列：供应商及其上级都启用、平台授权含 OpenAI 时为 1；
--   3. 供应商的状态、上级、分组、平台或墓碑变化，以及分组改名时，推进受影响 Gateway 账号的事实版本。
-- 只增列不改列，读取契约版本不变（Worker 以列名读取，旧版 Worker 忽略新列，回滚镜像不受影响）。
-- group_resources 里的成员关系不动：供应商重新授权后账号随即恢复，与 VM 的处理一致。

DROP VIEW IF EXISTS gateway_account_facts_v1;
DROP VIEW IF EXISTS gateway_account_groups_v1;

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
LEFT JOIN executor_credentials b ON b.account_resource_id = r.id AND b.grant_kind = 'bps'
LEFT JOIN proxies p ON p.id = json_extract(r.config_json, '$.proxy_id')
LEFT JOIN gateway_account_fact_revisions f ON f.account_resource_id = r.id
LEFT JOIN vendors v ON v.id = r.vendor_id
LEFT JOIN vendors pv ON pv.id = v.parent_id
WHERE r.resource_type = 'account'
  AND json_extract(r.config_json, '$.execution_kind') = 'gateway_worker'
  AND json_extract(r.config_json, '$.platform') IN ('openai', 'codex');

-- 供应商变化：本供应商及其下级的 Gateway 账号
CREATE TRIGGER IF NOT EXISTS gateway_facts_vendor_update
AFTER UPDATE ON vendors
WHEN NEW.status IS NOT OLD.status
  OR NEW.parent_id IS NOT OLD.parent_id
  OR NEW.groups_json IS NOT OLD.groups_json
  OR NEW.platforms_json IS NOT OLD.platforms_json
  OR NEW.deleted_at IS NOT OLD.deleted_at
BEGIN
  UPDATE gateway_fact_seq SET value = value + 1 WHERE id = 1;
  INSERT INTO gateway_account_fact_revisions(account_resource_id, revision, changed_at)
  SELECT r.id, (SELECT value FROM gateway_fact_seq WHERE id = 1), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM vendor_resources r
  WHERE r.resource_type = 'account'
    AND json_extract(r.config_json, '$.execution_kind') = 'gateway_worker'
    AND (r.vendor_id = NEW.id OR r.vendor_id IN (SELECT c.id FROM vendors c WHERE c.parent_id = NEW.id))
  ON CONFLICT(account_resource_id) DO UPDATE SET revision = excluded.revision, changed_at = excluded.changed_at;
END;

-- 分组改名：供应商授权可按名称匹配，该组里的供应商 Gateway 账号
CREATE TRIGGER IF NOT EXISTS gateway_facts_group_rename
AFTER UPDATE OF name ON groups
WHEN NEW.name IS NOT OLD.name
BEGIN
  UPDATE gateway_fact_seq SET value = value + 1 WHERE id = 1;
  INSERT INTO gateway_account_fact_revisions(account_resource_id, revision, changed_at)
  SELECT r.id, (SELECT value FROM gateway_fact_seq WHERE id = 1), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM group_resources gr
  JOIN vendor_resources r ON r.id = gr.resource_id
  WHERE gr.group_id = NEW.id
    AND gr.resource_kind = 'gateway_worker_account'
    AND r.vendor_id IS NOT NULL
  ON CONFLICT(account_resource_id) DO UPDATE SET revision = excluded.revision, changed_at = excluded.changed_at;
END;
