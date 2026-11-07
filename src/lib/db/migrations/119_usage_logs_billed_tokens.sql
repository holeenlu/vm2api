-- 119_usage_logs_billed_tokens — usage_logs token columns carry the customer-billed basis.
--
-- input_tokens / cache_read_tokens / cache_creation_tokens (+ the 5m / 1h split) now hold
-- the usage the customer is billed for (protocol/customer-usage.mjs: gateway-injected
-- tokens deducted, cache re-bucketed by the customer's own cache_control intent), so every
-- panel view, export and rollup reads one basis. output_tokens never differs.
-- upstream_* keep the raw upstream consumption only when it differs from the billed value;
-- NULL means "same as the main column". Upstream-account readers (cost repricing,
-- usage_cost_hourly, quota forecasts, supplier settlement) read COALESCE(upstream_x, x).

ALTER TABLE usage_logs ADD COLUMN upstream_input_tokens INTEGER;
ALTER TABLE usage_logs ADD COLUMN upstream_cache_read_tokens INTEGER;
ALTER TABLE usage_logs ADD COLUMN upstream_cache_creation_tokens INTEGER;
ALTER TABLE usage_logs ADD COLUMN upstream_cache_creation_5m_tokens INTEGER;
ALTER TABLE usage_logs ADD COLUMN upstream_cache_creation_1h_tokens INTEGER;

-- usage_cost_hourly is the upstream-account rollup: rebuild its triggers on the upstream basis
-- BEFORE the backfill below rewrites the main columns, so the rollup stays unchanged.
DROP TRIGGER IF EXISTS usage_cost_hourly_insert;
DROP TRIGGER IF EXISTS usage_cost_hourly_delete;
DROP TRIGGER IF EXISTS usage_cost_hourly_update;

CREATE TRIGGER usage_cost_hourly_insert AFTER INSERT ON usage_logs
WHEN NEW.created_at IS NOT NULL
BEGIN
  INSERT INTO usage_cost_hourly (
    hour, account_key, vm_id, execution_kind, account_resource_id, fable, status_code, error_code,
    requests, unpriced, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
    input_cost, output_cost, cache_read_cost, cache_creation_cost, total_cost
  ) VALUES (
    substr(NEW.created_at, 1, 13),
    COALESCE(NULLIF(NEW.final_account_id, ''), NULLIF(NEW.account_id, ''), NEW.vm_id, '—'),
    COALESCE(NEW.vm_id, ''),
    COALESCE(NEW.execution_kind, ''),
    COALESCE(NEW.account_resource_id, ''),
    CASE WHEN instr(lower(COALESCE(NULLIF(trim(NEW.upstream_model), ''), trim(NEW.model), '')), 'fable') > 0 THEN 1 ELSE 0 END,
    COALESCE(NEW.status, -1),
    COALESCE(NEW.error_code, ''),
    1,
    CASE WHEN NEW.pricing_model = 'unpriced'
      AND IFNULL(COALESCE(NEW.upstream_input_tokens, NEW.input_tokens), 0) + IFNULL(NEW.output_tokens, 0) + IFNULL(COALESCE(NEW.upstream_cache_read_tokens, NEW.cache_read_tokens), 0) + IFNULL(COALESCE(NEW.upstream_cache_creation_tokens, NEW.cache_creation_tokens), 0) > 0
      THEN 1 ELSE 0 END,
    IFNULL(COALESCE(NEW.upstream_input_tokens, NEW.input_tokens), 0),
    IFNULL(NEW.output_tokens, 0),
    IFNULL(COALESCE(NEW.upstream_cache_read_tokens, NEW.cache_read_tokens), 0),
    IFNULL(COALESCE(NEW.upstream_cache_creation_tokens, NEW.cache_creation_tokens), 0),
    IFNULL(NEW.input_cost, 0),
    IFNULL(NEW.output_cost, 0),
    IFNULL(NEW.cache_read_cost, 0),
    IFNULL(NEW.cache_creation_cost, 0),
    IFNULL(NEW.total_cost, 0)
  )
  ON CONFLICT (hour, account_key, vm_id, execution_kind, account_resource_id, fable, status_code, error_code) DO UPDATE SET
    requests = requests + excluded.requests,
    unpriced = unpriced + excluded.unpriced,
    input_tokens = input_tokens + excluded.input_tokens,
    output_tokens = output_tokens + excluded.output_tokens,
    cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
    cache_creation_tokens = cache_creation_tokens + excluded.cache_creation_tokens,
    input_cost = input_cost + excluded.input_cost,
    output_cost = output_cost + excluded.output_cost,
    cache_read_cost = cache_read_cost + excluded.cache_read_cost,
    cache_creation_cost = cache_creation_cost + excluded.cache_creation_cost,
    total_cost = total_cost + excluded.total_cost;
END;

CREATE TRIGGER usage_cost_hourly_delete AFTER DELETE ON usage_logs
WHEN OLD.created_at IS NOT NULL
BEGIN
  UPDATE usage_cost_hourly SET
    requests = requests - 1,
    unpriced = unpriced - (CASE WHEN OLD.pricing_model = 'unpriced'
      AND IFNULL(COALESCE(OLD.upstream_input_tokens, OLD.input_tokens), 0) + IFNULL(OLD.output_tokens, 0) + IFNULL(COALESCE(OLD.upstream_cache_read_tokens, OLD.cache_read_tokens), 0) + IFNULL(COALESCE(OLD.upstream_cache_creation_tokens, OLD.cache_creation_tokens), 0) > 0
      THEN 1 ELSE 0 END),
    input_tokens = input_tokens - IFNULL(COALESCE(OLD.upstream_input_tokens, OLD.input_tokens), 0),
    output_tokens = output_tokens - IFNULL(OLD.output_tokens, 0),
    cache_read_tokens = cache_read_tokens - IFNULL(COALESCE(OLD.upstream_cache_read_tokens, OLD.cache_read_tokens), 0),
    cache_creation_tokens = cache_creation_tokens - IFNULL(COALESCE(OLD.upstream_cache_creation_tokens, OLD.cache_creation_tokens), 0),
    input_cost = input_cost - IFNULL(OLD.input_cost, 0),
    output_cost = output_cost - IFNULL(OLD.output_cost, 0),
    cache_read_cost = cache_read_cost - IFNULL(OLD.cache_read_cost, 0),
    cache_creation_cost = cache_creation_cost - IFNULL(OLD.cache_creation_cost, 0),
    total_cost = total_cost - IFNULL(OLD.total_cost, 0)
  WHERE hour = substr(OLD.created_at, 1, 13)
    AND account_key = COALESCE(NULLIF(OLD.final_account_id, ''), NULLIF(OLD.account_id, ''), OLD.vm_id, '—')
    AND vm_id = COALESCE(OLD.vm_id, '')
    AND execution_kind = COALESCE(OLD.execution_kind, '')
    AND account_resource_id = COALESCE(OLD.account_resource_id, '')
    AND fable = (CASE WHEN instr(lower(COALESCE(NULLIF(trim(OLD.upstream_model), ''), trim(OLD.model), '')), 'fable') > 0 THEN 1 ELSE 0 END)
    AND status_code = COALESCE(OLD.status, -1)
    AND error_code = COALESCE(OLD.error_code, '');
  DELETE FROM usage_cost_hourly
  WHERE requests <= 0
    AND hour = substr(OLD.created_at, 1, 13)
    AND account_key = COALESCE(NULLIF(OLD.final_account_id, ''), NULLIF(OLD.account_id, ''), OLD.vm_id, '—')
    AND vm_id = COALESCE(OLD.vm_id, '')
    AND execution_kind = COALESCE(OLD.execution_kind, '')
    AND account_resource_id = COALESCE(OLD.account_resource_id, '')
    AND fable = (CASE WHEN instr(lower(COALESCE(NULLIF(trim(OLD.upstream_model), ''), trim(OLD.model), '')), 'fable') > 0 THEN 1 ELSE 0 END)
    AND status_code = COALESCE(OLD.status, -1)
    AND error_code = COALESCE(OLD.error_code, '');
END;

CREATE TRIGGER usage_cost_hourly_update AFTER UPDATE OF
  created_at, final_account_id, account_id, vm_id, execution_kind, account_resource_id,
  model, upstream_model, pricing_model, status, error_code,
  input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
  upstream_input_tokens, upstream_cache_read_tokens, upstream_cache_creation_tokens,
  input_cost, output_cost, cache_read_cost, cache_creation_cost, total_cost
ON usage_logs
BEGIN
  UPDATE usage_cost_hourly SET
    requests = requests - 1,
    unpriced = unpriced - (CASE WHEN OLD.pricing_model = 'unpriced'
      AND IFNULL(COALESCE(OLD.upstream_input_tokens, OLD.input_tokens), 0) + IFNULL(OLD.output_tokens, 0) + IFNULL(COALESCE(OLD.upstream_cache_read_tokens, OLD.cache_read_tokens), 0) + IFNULL(COALESCE(OLD.upstream_cache_creation_tokens, OLD.cache_creation_tokens), 0) > 0
      THEN 1 ELSE 0 END),
    input_tokens = input_tokens - IFNULL(COALESCE(OLD.upstream_input_tokens, OLD.input_tokens), 0),
    output_tokens = output_tokens - IFNULL(OLD.output_tokens, 0),
    cache_read_tokens = cache_read_tokens - IFNULL(COALESCE(OLD.upstream_cache_read_tokens, OLD.cache_read_tokens), 0),
    cache_creation_tokens = cache_creation_tokens - IFNULL(COALESCE(OLD.upstream_cache_creation_tokens, OLD.cache_creation_tokens), 0),
    input_cost = input_cost - IFNULL(OLD.input_cost, 0),
    output_cost = output_cost - IFNULL(OLD.output_cost, 0),
    cache_read_cost = cache_read_cost - IFNULL(OLD.cache_read_cost, 0),
    cache_creation_cost = cache_creation_cost - IFNULL(OLD.cache_creation_cost, 0),
    total_cost = total_cost - IFNULL(OLD.total_cost, 0)
  WHERE OLD.created_at IS NOT NULL
    AND hour = substr(OLD.created_at, 1, 13)
    AND account_key = COALESCE(NULLIF(OLD.final_account_id, ''), NULLIF(OLD.account_id, ''), OLD.vm_id, '—')
    AND vm_id = COALESCE(OLD.vm_id, '')
    AND execution_kind = COALESCE(OLD.execution_kind, '')
    AND account_resource_id = COALESCE(OLD.account_resource_id, '')
    AND fable = (CASE WHEN instr(lower(COALESCE(NULLIF(trim(OLD.upstream_model), ''), trim(OLD.model), '')), 'fable') > 0 THEN 1 ELSE 0 END)
    AND status_code = COALESCE(OLD.status, -1)
    AND error_code = COALESCE(OLD.error_code, '');
  DELETE FROM usage_cost_hourly
  WHERE OLD.created_at IS NOT NULL
    AND requests <= 0
    AND hour = substr(OLD.created_at, 1, 13)
    AND account_key = COALESCE(NULLIF(OLD.final_account_id, ''), NULLIF(OLD.account_id, ''), OLD.vm_id, '—')
    AND vm_id = COALESCE(OLD.vm_id, '')
    AND execution_kind = COALESCE(OLD.execution_kind, '')
    AND account_resource_id = COALESCE(OLD.account_resource_id, '')
    AND fable = (CASE WHEN instr(lower(COALESCE(NULLIF(trim(OLD.upstream_model), ''), trim(OLD.model), '')), 'fable') > 0 THEN 1 ELSE 0 END)
    AND status_code = COALESCE(OLD.status, -1)
    AND error_code = COALESCE(OLD.error_code, '');
  INSERT INTO usage_cost_hourly (
    hour, account_key, vm_id, execution_kind, account_resource_id, fable, status_code, error_code,
    requests, unpriced, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
    input_cost, output_cost, cache_read_cost, cache_creation_cost, total_cost
  )
  SELECT
    substr(NEW.created_at, 1, 13),
    COALESCE(NULLIF(NEW.final_account_id, ''), NULLIF(NEW.account_id, ''), NEW.vm_id, '—'),
    COALESCE(NEW.vm_id, ''),
    COALESCE(NEW.execution_kind, ''),
    COALESCE(NEW.account_resource_id, ''),
    CASE WHEN instr(lower(COALESCE(NULLIF(trim(NEW.upstream_model), ''), trim(NEW.model), '')), 'fable') > 0 THEN 1 ELSE 0 END,
    COALESCE(NEW.status, -1),
    COALESCE(NEW.error_code, ''),
    1,
    CASE WHEN NEW.pricing_model = 'unpriced'
      AND IFNULL(COALESCE(NEW.upstream_input_tokens, NEW.input_tokens), 0) + IFNULL(NEW.output_tokens, 0) + IFNULL(COALESCE(NEW.upstream_cache_read_tokens, NEW.cache_read_tokens), 0) + IFNULL(COALESCE(NEW.upstream_cache_creation_tokens, NEW.cache_creation_tokens), 0) > 0
      THEN 1 ELSE 0 END,
    IFNULL(COALESCE(NEW.upstream_input_tokens, NEW.input_tokens), 0),
    IFNULL(NEW.output_tokens, 0),
    IFNULL(COALESCE(NEW.upstream_cache_read_tokens, NEW.cache_read_tokens), 0),
    IFNULL(COALESCE(NEW.upstream_cache_creation_tokens, NEW.cache_creation_tokens), 0),
    IFNULL(NEW.input_cost, 0),
    IFNULL(NEW.output_cost, 0),
    IFNULL(NEW.cache_read_cost, 0),
    IFNULL(NEW.cache_creation_cost, 0),
    IFNULL(NEW.total_cost, 0)
  WHERE NEW.created_at IS NOT NULL
  ON CONFLICT (hour, account_key, vm_id, execution_kind, account_resource_id, fable, status_code, error_code) DO UPDATE SET
    requests = requests + excluded.requests,
    unpriced = unpriced + excluded.unpriced,
    input_tokens = input_tokens + excluded.input_tokens,
    output_tokens = output_tokens + excluded.output_tokens,
    cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
    cache_creation_tokens = cache_creation_tokens + excluded.cache_creation_tokens,
    input_cost = input_cost + excluded.input_cost,
    output_cost = output_cost + excluded.output_cost,
    cache_read_cost = cache_read_cost + excluded.cache_read_cost,
    cache_creation_cost = cache_creation_cost + excluded.cache_creation_cost,
    total_cost = total_cost + excluded.total_cost;
END;

-- Backfill settled Anthropic-shaped rows since the customer view went live (2026-11-05 22:00 UTC)
-- from billing_charges.usage_json (the billed usage). Mirrors request-log normalization and
-- cacheCreationBreakdown. Only rows whose billed basis differs are touched; usage_stats_hourly
-- follows through its update trigger, usage_cost_hourly nets to zero (upstream basis).
UPDATE usage_logs SET
  upstream_input_tokens = input_tokens,
  upstream_cache_read_tokens = cache_read_tokens,
  upstream_cache_creation_tokens = cache_creation_tokens,
  upstream_cache_creation_5m_tokens = cache_creation_5m_tokens,
  upstream_cache_creation_1h_tokens = cache_creation_1h_tokens,
  input_tokens = b.bi,
  cache_read_tokens = b.bcr,
  cache_creation_tokens = b.bcc,
  cache_creation_5m_tokens = b.b5,
  cache_creation_1h_tokens = b.b1
FROM (
  SELECT request_id, bi, bcr, bcc,
    CASE WHEN v5 = 0 AND v1 = 0 THEN NULL ELSE v5 END AS b5,
    CASE WHEN v5 = 0 AND v1 = 0 THEN NULL ELSE v1 END AS b1
  FROM (
  SELECT request_id, bi, bcr, bcc,
    f + (CASE WHEN u > 0 AND ttl IS NOT '1h' THEN u ELSE 0 END) AS v5,
    h + (CASE WHEN u > 0 AND ttl = '1h' THEN u ELSE 0 END) AS v1
  FROM (
    SELECT request_id, bi, bcr, bcc, f, h, ttl, IFNULL(bcc, 0) - f - h AS u
    FROM (
      SELECT bc.request_id,
        IFNULL(json_extract(bc.usage_json, '$.input_tokens'), 0) AS bi,
        COALESCE(json_extract(bc.usage_json, '$.cache_read_tokens'), json_extract(bc.usage_json, '$.cache_read_input_tokens'), 0) AS bcr,
        COALESCE(json_extract(bc.usage_json, '$.cache_creation_tokens'), json_extract(bc.usage_json, '$.cache_creation_input_tokens')) AS bcc,
        IFNULL(json_extract(bc.usage_json, '$.cache_creation.ephemeral_5m_input_tokens'), 0) AS f,
        IFNULL(json_extract(bc.usage_json, '$.cache_creation.ephemeral_1h_input_tokens'), 0) AS h,
        json_extract(bc.usage_json, '$.cache_ttl') AS ttl
      FROM billing_charges bc
      WHERE bc.settlement_source IS NULL
        AND bc.created_at >= '2026-11-05T22:00:00'
        AND json_valid(bc.usage_json)
        AND json_extract(bc.usage_json, '$.input_tokens_details') IS NULL
        AND json_extract(bc.usage_json, '$.prompt_tokens') IS NULL
    )
  )
  )
) AS b
WHERE usage_logs.request_id = b.request_id
  AND usage_logs.created_at >= '2026-11-05T22:00:00'
  AND usage_logs.upstream_input_tokens IS NULL
  AND (IFNULL(usage_logs.input_tokens, 0) <> b.bi
    OR IFNULL(usage_logs.cache_read_tokens, 0) <> b.bcr
    OR IFNULL(usage_logs.cache_creation_tokens, 0) <> IFNULL(b.bcc, 0)
    OR IFNULL(usage_logs.cache_creation_5m_tokens, 0) <> IFNULL(b.b5, 0)
    OR IFNULL(usage_logs.cache_creation_1h_tokens, 0) <> IFNULL(b.b1, 0));
