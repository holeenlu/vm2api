-- 127_money_micros_rollups — the hourly rollups (093 usage_cost_hourly, 115 / 123 usage_stats_hourly) sum
-- the integer micros columns from 126 (technical-debt batch M6).
--
-- Rebuilt from 119 (usage_cost_hourly, upstream-account token basis) and 123 (usage_stats_hourly, all columns):
-- dimensions, NULL encoding and the non-money measures are unchanged. Each rollup gets *_micros measures that the
-- triggers add and subtract as integers; the REAL measures stay as display mirrors and are re-derived on every
-- change as micros / 1e6 (never accumulated as floats). The triggers read COALESCE(x_micros, ROUND(x * 1e6)), so a
-- writer that only sets the REAL column (the previous release after a rollback, or an upstream writer not yet
-- converted) still lands in the integer rollup; scripts/audit-money-micros.mjs reports such rows.
-- Both rollups are rebuilt from usage_logs in this transaction, so they stay exact for every existing row.

DROP TRIGGER IF EXISTS usage_cost_hourly_insert;
DROP TRIGGER IF EXISTS usage_cost_hourly_delete;
DROP TRIGGER IF EXISTS usage_cost_hourly_update;
DROP TRIGGER IF EXISTS usage_stats_hourly_insert;
DROP TRIGGER IF EXISTS usage_stats_hourly_delete;
DROP TRIGGER IF EXISTS usage_stats_hourly_update;

ALTER TABLE usage_cost_hourly ADD COLUMN input_cost_micros INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_cost_hourly ADD COLUMN output_cost_micros INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_cost_hourly ADD COLUMN cache_read_cost_micros INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_cost_hourly ADD COLUMN cache_creation_cost_micros INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_cost_hourly ADD COLUMN total_cost_micros INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_stats_hourly ADD COLUMN cost_micros INTEGER NOT NULL DEFAULT 0;

DELETE FROM usage_cost_hourly;

INSERT INTO usage_cost_hourly (hour, account_key, vm_id, execution_kind, account_resource_id, fable, status_code, error_code, requests, unpriced, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, input_cost_micros, output_cost_micros, cache_read_cost_micros, cache_creation_cost_micros, total_cost_micros, input_cost, output_cost, cache_read_cost, cache_creation_cost, total_cost)
SELECT
  substr(l.created_at, 1, 13),
  COALESCE(NULLIF(l.final_account_id, ''), NULLIF(l.account_id, ''), l.vm_id, '—'),
  COALESCE(l.vm_id, ''),
  COALESCE(l.execution_kind, ''),
  COALESCE(l.account_resource_id, ''),
  CASE WHEN instr(lower(COALESCE(NULLIF(trim(l.upstream_model), ''), trim(l.model), '')), 'fable') > 0 THEN 1 ELSE 0 END,
  COALESCE(l.status, -1),
  COALESCE(l.error_code, ''),
  COUNT(*),
  SUM(CASE WHEN l.pricing_model = 'unpriced'
      AND IFNULL(COALESCE(l.upstream_input_tokens, l.input_tokens), 0) + IFNULL(l.output_tokens, 0) + IFNULL(COALESCE(l.upstream_cache_read_tokens, l.cache_read_tokens), 0) + IFNULL(COALESCE(l.upstream_cache_creation_tokens, l.cache_creation_tokens), 0) > 0
      THEN 1 ELSE 0 END),
  SUM(IFNULL(COALESCE(l.upstream_input_tokens, l.input_tokens), 0)),
  SUM(IFNULL(l.output_tokens, 0)),
  SUM(IFNULL(COALESCE(l.upstream_cache_read_tokens, l.cache_read_tokens), 0)),
  SUM(IFNULL(COALESCE(l.upstream_cache_creation_tokens, l.cache_creation_tokens), 0)),
  SUM(IFNULL(COALESCE(l.input_cost_micros, CAST(ROUND(l.input_cost * 1000000) AS INTEGER)), 0)),
  SUM(IFNULL(COALESCE(l.output_cost_micros, CAST(ROUND(l.output_cost * 1000000) AS INTEGER)), 0)),
  SUM(IFNULL(COALESCE(l.cache_read_cost_micros, CAST(ROUND(l.cache_read_cost * 1000000) AS INTEGER)), 0)),
  SUM(IFNULL(COALESCE(l.cache_creation_cost_micros, CAST(ROUND(l.cache_creation_cost * 1000000) AS INTEGER)), 0)),
  SUM(IFNULL(COALESCE(l.total_cost_micros, CAST(ROUND(l.total_cost * 1000000) AS INTEGER)), 0)),
  SUM(IFNULL(COALESCE(l.input_cost_micros, CAST(ROUND(l.input_cost * 1000000) AS INTEGER)), 0)) / 1000000.0,
  SUM(IFNULL(COALESCE(l.output_cost_micros, CAST(ROUND(l.output_cost * 1000000) AS INTEGER)), 0)) / 1000000.0,
  SUM(IFNULL(COALESCE(l.cache_read_cost_micros, CAST(ROUND(l.cache_read_cost * 1000000) AS INTEGER)), 0)) / 1000000.0,
  SUM(IFNULL(COALESCE(l.cache_creation_cost_micros, CAST(ROUND(l.cache_creation_cost * 1000000) AS INTEGER)), 0)) / 1000000.0,
  SUM(IFNULL(COALESCE(l.total_cost_micros, CAST(ROUND(l.total_cost * 1000000) AS INTEGER)), 0)) / 1000000.0
FROM usage_logs l
WHERE l.created_at IS NOT NULL
GROUP BY 1, 2, 3, 4, 5, 6, 7, 8;

DELETE FROM usage_stats_hourly;

INSERT INTO usage_stats_hourly (hour, user_id, api_key_id, model, vm_id, billing_group_id, path, status_code, error_code, requests, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cache_creation_5m_tokens, cache_creation_1h_tokens, cost_micros, cost, cost_n, duration_sum, duration_n, ttft_sum, ttft_n)
SELECT
  substr(l.created_at, 1, 13),
  COALESCE(l.user_id, ''),
  COALESCE(l.api_key_id, ''),
  COALESCE(l.model, ''),
  COALESCE(l.vm_id, ''),
  COALESCE(l.billing_group_id, -1),
  COALESCE(l.path, ''),
  COALESCE(l.status, -1),
  COALESCE(l.error_code, ''),
  COUNT(*),
  SUM(IFNULL(l.input_tokens, 0)),
  SUM(IFNULL(l.output_tokens, 0)),
  SUM(IFNULL(l.cache_read_tokens, 0)),
  SUM(IFNULL(l.cache_creation_tokens, 0)),
  SUM(IFNULL(l.cache_creation_5m_tokens, 0)),
  SUM(IFNULL(l.cache_creation_1h_tokens, 0)),
  SUM(IFNULL(COALESCE(l.actual_cost_micros, CAST(ROUND(l.actual_cost * 1000000) AS INTEGER)), 0)),
  SUM(IFNULL(COALESCE(l.actual_cost_micros, CAST(ROUND(l.actual_cost * 1000000) AS INTEGER)), 0)) / 1000000.0,
  SUM(CASE WHEN COALESCE(l.actual_cost_micros, CAST(ROUND(l.actual_cost * 1000000) AS INTEGER)) IS NULL THEN 0 ELSE 1 END),
  SUM(IFNULL(l.duration_ms, 0)),
  SUM(CASE WHEN l.duration_ms IS NULL THEN 0 ELSE 1 END),
  SUM(IFNULL(l.first_token_ms, 0)),
  SUM(CASE WHEN l.first_token_ms IS NULL THEN 0 ELSE 1 END)
FROM usage_logs l
WHERE l.created_at IS NOT NULL
GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9;

CREATE TRIGGER usage_cost_hourly_insert AFTER INSERT ON usage_logs
WHEN NEW.created_at IS NOT NULL
BEGIN
  INSERT INTO usage_cost_hourly (hour, account_key, vm_id, execution_kind, account_resource_id, fable, status_code, error_code, requests, unpriced, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, input_cost_micros, output_cost_micros, cache_read_cost_micros, cache_creation_cost_micros, total_cost_micros, input_cost, output_cost, cache_read_cost, cache_creation_cost, total_cost)
  VALUES (
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
    IFNULL(COALESCE(NEW.input_cost_micros, CAST(ROUND(NEW.input_cost * 1000000) AS INTEGER)), 0),
    IFNULL(COALESCE(NEW.output_cost_micros, CAST(ROUND(NEW.output_cost * 1000000) AS INTEGER)), 0),
    IFNULL(COALESCE(NEW.cache_read_cost_micros, CAST(ROUND(NEW.cache_read_cost * 1000000) AS INTEGER)), 0),
    IFNULL(COALESCE(NEW.cache_creation_cost_micros, CAST(ROUND(NEW.cache_creation_cost * 1000000) AS INTEGER)), 0),
    IFNULL(COALESCE(NEW.total_cost_micros, CAST(ROUND(NEW.total_cost * 1000000) AS INTEGER)), 0),
    IFNULL(COALESCE(NEW.input_cost_micros, CAST(ROUND(NEW.input_cost * 1000000) AS INTEGER)), 0) / 1000000.0,
    IFNULL(COALESCE(NEW.output_cost_micros, CAST(ROUND(NEW.output_cost * 1000000) AS INTEGER)), 0) / 1000000.0,
    IFNULL(COALESCE(NEW.cache_read_cost_micros, CAST(ROUND(NEW.cache_read_cost * 1000000) AS INTEGER)), 0) / 1000000.0,
    IFNULL(COALESCE(NEW.cache_creation_cost_micros, CAST(ROUND(NEW.cache_creation_cost * 1000000) AS INTEGER)), 0) / 1000000.0,
    IFNULL(COALESCE(NEW.total_cost_micros, CAST(ROUND(NEW.total_cost * 1000000) AS INTEGER)), 0) / 1000000.0
  )
  ON CONFLICT (hour, account_key, vm_id, execution_kind, account_resource_id, fable, status_code, error_code) DO UPDATE SET
    requests = requests + excluded.requests,
    unpriced = unpriced + excluded.unpriced,
    input_tokens = input_tokens + excluded.input_tokens,
    output_tokens = output_tokens + excluded.output_tokens,
    cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
    cache_creation_tokens = cache_creation_tokens + excluded.cache_creation_tokens,
    input_cost_micros = input_cost_micros + excluded.input_cost_micros,
    input_cost = (input_cost_micros + excluded.input_cost_micros) / 1000000.0,
    output_cost_micros = output_cost_micros + excluded.output_cost_micros,
    output_cost = (output_cost_micros + excluded.output_cost_micros) / 1000000.0,
    cache_read_cost_micros = cache_read_cost_micros + excluded.cache_read_cost_micros,
    cache_read_cost = (cache_read_cost_micros + excluded.cache_read_cost_micros) / 1000000.0,
    cache_creation_cost_micros = cache_creation_cost_micros + excluded.cache_creation_cost_micros,
    cache_creation_cost = (cache_creation_cost_micros + excluded.cache_creation_cost_micros) / 1000000.0,
    total_cost_micros = total_cost_micros + excluded.total_cost_micros,
    total_cost = (total_cost_micros + excluded.total_cost_micros) / 1000000.0;
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
    input_cost_micros = input_cost_micros - IFNULL(COALESCE(OLD.input_cost_micros, CAST(ROUND(OLD.input_cost * 1000000) AS INTEGER)), 0),
    input_cost = (input_cost_micros - IFNULL(COALESCE(OLD.input_cost_micros, CAST(ROUND(OLD.input_cost * 1000000) AS INTEGER)), 0)) / 1000000.0,
    output_cost_micros = output_cost_micros - IFNULL(COALESCE(OLD.output_cost_micros, CAST(ROUND(OLD.output_cost * 1000000) AS INTEGER)), 0),
    output_cost = (output_cost_micros - IFNULL(COALESCE(OLD.output_cost_micros, CAST(ROUND(OLD.output_cost * 1000000) AS INTEGER)), 0)) / 1000000.0,
    cache_read_cost_micros = cache_read_cost_micros - IFNULL(COALESCE(OLD.cache_read_cost_micros, CAST(ROUND(OLD.cache_read_cost * 1000000) AS INTEGER)), 0),
    cache_read_cost = (cache_read_cost_micros - IFNULL(COALESCE(OLD.cache_read_cost_micros, CAST(ROUND(OLD.cache_read_cost * 1000000) AS INTEGER)), 0)) / 1000000.0,
    cache_creation_cost_micros = cache_creation_cost_micros - IFNULL(COALESCE(OLD.cache_creation_cost_micros, CAST(ROUND(OLD.cache_creation_cost * 1000000) AS INTEGER)), 0),
    cache_creation_cost = (cache_creation_cost_micros - IFNULL(COALESCE(OLD.cache_creation_cost_micros, CAST(ROUND(OLD.cache_creation_cost * 1000000) AS INTEGER)), 0)) / 1000000.0,
    total_cost_micros = total_cost_micros - IFNULL(COALESCE(OLD.total_cost_micros, CAST(ROUND(OLD.total_cost * 1000000) AS INTEGER)), 0),
    total_cost = (total_cost_micros - IFNULL(COALESCE(OLD.total_cost_micros, CAST(ROUND(OLD.total_cost * 1000000) AS INTEGER)), 0)) / 1000000.0
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
  input_cost, output_cost, cache_read_cost, cache_creation_cost, total_cost,
  input_cost_micros, output_cost_micros, cache_read_cost_micros, cache_creation_cost_micros, total_cost_micros
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
    input_cost_micros = input_cost_micros - IFNULL(COALESCE(OLD.input_cost_micros, CAST(ROUND(OLD.input_cost * 1000000) AS INTEGER)), 0),
    input_cost = (input_cost_micros - IFNULL(COALESCE(OLD.input_cost_micros, CAST(ROUND(OLD.input_cost * 1000000) AS INTEGER)), 0)) / 1000000.0,
    output_cost_micros = output_cost_micros - IFNULL(COALESCE(OLD.output_cost_micros, CAST(ROUND(OLD.output_cost * 1000000) AS INTEGER)), 0),
    output_cost = (output_cost_micros - IFNULL(COALESCE(OLD.output_cost_micros, CAST(ROUND(OLD.output_cost * 1000000) AS INTEGER)), 0)) / 1000000.0,
    cache_read_cost_micros = cache_read_cost_micros - IFNULL(COALESCE(OLD.cache_read_cost_micros, CAST(ROUND(OLD.cache_read_cost * 1000000) AS INTEGER)), 0),
    cache_read_cost = (cache_read_cost_micros - IFNULL(COALESCE(OLD.cache_read_cost_micros, CAST(ROUND(OLD.cache_read_cost * 1000000) AS INTEGER)), 0)) / 1000000.0,
    cache_creation_cost_micros = cache_creation_cost_micros - IFNULL(COALESCE(OLD.cache_creation_cost_micros, CAST(ROUND(OLD.cache_creation_cost * 1000000) AS INTEGER)), 0),
    cache_creation_cost = (cache_creation_cost_micros - IFNULL(COALESCE(OLD.cache_creation_cost_micros, CAST(ROUND(OLD.cache_creation_cost * 1000000) AS INTEGER)), 0)) / 1000000.0,
    total_cost_micros = total_cost_micros - IFNULL(COALESCE(OLD.total_cost_micros, CAST(ROUND(OLD.total_cost * 1000000) AS INTEGER)), 0),
    total_cost = (total_cost_micros - IFNULL(COALESCE(OLD.total_cost_micros, CAST(ROUND(OLD.total_cost * 1000000) AS INTEGER)), 0)) / 1000000.0
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
  INSERT INTO usage_cost_hourly (hour, account_key, vm_id, execution_kind, account_resource_id, fable, status_code, error_code, requests, unpriced, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, input_cost_micros, output_cost_micros, cache_read_cost_micros, cache_creation_cost_micros, total_cost_micros, input_cost, output_cost, cache_read_cost, cache_creation_cost, total_cost)
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
    IFNULL(COALESCE(NEW.input_cost_micros, CAST(ROUND(NEW.input_cost * 1000000) AS INTEGER)), 0),
    IFNULL(COALESCE(NEW.output_cost_micros, CAST(ROUND(NEW.output_cost * 1000000) AS INTEGER)), 0),
    IFNULL(COALESCE(NEW.cache_read_cost_micros, CAST(ROUND(NEW.cache_read_cost * 1000000) AS INTEGER)), 0),
    IFNULL(COALESCE(NEW.cache_creation_cost_micros, CAST(ROUND(NEW.cache_creation_cost * 1000000) AS INTEGER)), 0),
    IFNULL(COALESCE(NEW.total_cost_micros, CAST(ROUND(NEW.total_cost * 1000000) AS INTEGER)), 0),
    IFNULL(COALESCE(NEW.input_cost_micros, CAST(ROUND(NEW.input_cost * 1000000) AS INTEGER)), 0) / 1000000.0,
    IFNULL(COALESCE(NEW.output_cost_micros, CAST(ROUND(NEW.output_cost * 1000000) AS INTEGER)), 0) / 1000000.0,
    IFNULL(COALESCE(NEW.cache_read_cost_micros, CAST(ROUND(NEW.cache_read_cost * 1000000) AS INTEGER)), 0) / 1000000.0,
    IFNULL(COALESCE(NEW.cache_creation_cost_micros, CAST(ROUND(NEW.cache_creation_cost * 1000000) AS INTEGER)), 0) / 1000000.0,
    IFNULL(COALESCE(NEW.total_cost_micros, CAST(ROUND(NEW.total_cost * 1000000) AS INTEGER)), 0) / 1000000.0
  WHERE NEW.created_at IS NOT NULL
  ON CONFLICT (hour, account_key, vm_id, execution_kind, account_resource_id, fable, status_code, error_code) DO UPDATE SET
    requests = requests + excluded.requests,
    unpriced = unpriced + excluded.unpriced,
    input_tokens = input_tokens + excluded.input_tokens,
    output_tokens = output_tokens + excluded.output_tokens,
    cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
    cache_creation_tokens = cache_creation_tokens + excluded.cache_creation_tokens,
    input_cost_micros = input_cost_micros + excluded.input_cost_micros,
    input_cost = (input_cost_micros + excluded.input_cost_micros) / 1000000.0,
    output_cost_micros = output_cost_micros + excluded.output_cost_micros,
    output_cost = (output_cost_micros + excluded.output_cost_micros) / 1000000.0,
    cache_read_cost_micros = cache_read_cost_micros + excluded.cache_read_cost_micros,
    cache_read_cost = (cache_read_cost_micros + excluded.cache_read_cost_micros) / 1000000.0,
    cache_creation_cost_micros = cache_creation_cost_micros + excluded.cache_creation_cost_micros,
    cache_creation_cost = (cache_creation_cost_micros + excluded.cache_creation_cost_micros) / 1000000.0,
    total_cost_micros = total_cost_micros + excluded.total_cost_micros,
    total_cost = (total_cost_micros + excluded.total_cost_micros) / 1000000.0;
END;

CREATE TRIGGER usage_stats_hourly_insert AFTER INSERT ON usage_logs
WHEN NEW.created_at IS NOT NULL
BEGIN
  INSERT INTO usage_stats_hourly (hour, user_id, api_key_id, model, vm_id, billing_group_id, path, status_code, error_code, requests, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cache_creation_5m_tokens, cache_creation_1h_tokens, cost_micros, cost, cost_n, duration_sum, duration_n, ttft_sum, ttft_n)
  VALUES (
    substr(NEW.created_at, 1, 13),
    COALESCE(NEW.user_id, ''),
    COALESCE(NEW.api_key_id, ''),
    COALESCE(NEW.model, ''),
    COALESCE(NEW.vm_id, ''),
    COALESCE(NEW.billing_group_id, -1),
    COALESCE(NEW.path, ''),
    COALESCE(NEW.status, -1),
    COALESCE(NEW.error_code, ''),
    1,
    IFNULL(NEW.input_tokens, 0),
    IFNULL(NEW.output_tokens, 0),
    IFNULL(NEW.cache_read_tokens, 0),
    IFNULL(NEW.cache_creation_tokens, 0),
    IFNULL(NEW.cache_creation_5m_tokens, 0),
    IFNULL(NEW.cache_creation_1h_tokens, 0),
    IFNULL(COALESCE(NEW.actual_cost_micros, CAST(ROUND(NEW.actual_cost * 1000000) AS INTEGER)), 0),
    IFNULL(COALESCE(NEW.actual_cost_micros, CAST(ROUND(NEW.actual_cost * 1000000) AS INTEGER)), 0) / 1000000.0,
    CASE WHEN COALESCE(NEW.actual_cost_micros, CAST(ROUND(NEW.actual_cost * 1000000) AS INTEGER)) IS NULL THEN 0 ELSE 1 END,
    IFNULL(NEW.duration_ms, 0),
    CASE WHEN NEW.duration_ms IS NULL THEN 0 ELSE 1 END,
    IFNULL(NEW.first_token_ms, 0),
    CASE WHEN NEW.first_token_ms IS NULL THEN 0 ELSE 1 END
  )
  ON CONFLICT (hour, user_id, api_key_id, model, vm_id, billing_group_id, path, status_code, error_code) DO UPDATE SET
    requests = requests + excluded.requests,
    input_tokens = input_tokens + excluded.input_tokens,
    output_tokens = output_tokens + excluded.output_tokens,
    cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
    cache_creation_tokens = cache_creation_tokens + excluded.cache_creation_tokens,
    cache_creation_5m_tokens = cache_creation_5m_tokens + excluded.cache_creation_5m_tokens,
    cache_creation_1h_tokens = cache_creation_1h_tokens + excluded.cache_creation_1h_tokens,
    cost_micros = cost_micros + excluded.cost_micros,
    cost = (cost_micros + excluded.cost_micros) / 1000000.0,
    cost_n = cost_n + excluded.cost_n,
    duration_sum = duration_sum + excluded.duration_sum,
    duration_n = duration_n + excluded.duration_n,
    ttft_sum = ttft_sum + excluded.ttft_sum,
    ttft_n = ttft_n + excluded.ttft_n;
END;

CREATE TRIGGER usage_stats_hourly_delete AFTER DELETE ON usage_logs
WHEN OLD.created_at IS NOT NULL
BEGIN
  UPDATE usage_stats_hourly SET
    requests = requests - (1),
    input_tokens = input_tokens - (IFNULL(OLD.input_tokens, 0)),
    output_tokens = output_tokens - (IFNULL(OLD.output_tokens, 0)),
    cache_read_tokens = cache_read_tokens - (IFNULL(OLD.cache_read_tokens, 0)),
    cache_creation_tokens = cache_creation_tokens - (IFNULL(OLD.cache_creation_tokens, 0)),
    cache_creation_5m_tokens = cache_creation_5m_tokens - (IFNULL(OLD.cache_creation_5m_tokens, 0)),
    cache_creation_1h_tokens = cache_creation_1h_tokens - (IFNULL(OLD.cache_creation_1h_tokens, 0)),
    cost_micros = cost_micros - (IFNULL(COALESCE(OLD.actual_cost_micros, CAST(ROUND(OLD.actual_cost * 1000000) AS INTEGER)), 0)),
    cost = (cost_micros - (IFNULL(COALESCE(OLD.actual_cost_micros, CAST(ROUND(OLD.actual_cost * 1000000) AS INTEGER)), 0))) / 1000000.0,
    cost_n = cost_n - (CASE WHEN COALESCE(OLD.actual_cost_micros, CAST(ROUND(OLD.actual_cost * 1000000) AS INTEGER)) IS NULL THEN 0 ELSE 1 END),
    duration_sum = duration_sum - (IFNULL(OLD.duration_ms, 0)),
    duration_n = duration_n - (CASE WHEN OLD.duration_ms IS NULL THEN 0 ELSE 1 END),
    ttft_sum = ttft_sum - (IFNULL(OLD.first_token_ms, 0)),
    ttft_n = ttft_n - (CASE WHEN OLD.first_token_ms IS NULL THEN 0 ELSE 1 END)
  WHERE hour = substr(OLD.created_at, 1, 13)
    AND user_id = COALESCE(OLD.user_id, '')
    AND api_key_id = COALESCE(OLD.api_key_id, '')
    AND model = COALESCE(OLD.model, '')
    AND vm_id = COALESCE(OLD.vm_id, '')
    AND billing_group_id = COALESCE(OLD.billing_group_id, -1)
    AND path = COALESCE(OLD.path, '')
    AND status_code = COALESCE(OLD.status, -1)
    AND error_code = COALESCE(OLD.error_code, '');
  DELETE FROM usage_stats_hourly
  WHERE requests <= 0
    AND hour = substr(OLD.created_at, 1, 13)
    AND user_id = COALESCE(OLD.user_id, '')
    AND api_key_id = COALESCE(OLD.api_key_id, '')
    AND model = COALESCE(OLD.model, '')
    AND vm_id = COALESCE(OLD.vm_id, '')
    AND billing_group_id = COALESCE(OLD.billing_group_id, -1)
    AND path = COALESCE(OLD.path, '')
    AND status_code = COALESCE(OLD.status, -1)
    AND error_code = COALESCE(OLD.error_code, '');
END;

-- An update moves the row out of its old bucket and into the new one. Only columns the rollup reads fire it.
CREATE TRIGGER usage_stats_hourly_update AFTER UPDATE OF
  created_at, user_id, api_key_id, model, vm_id, billing_group_id, path, status, error_code,
  input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cache_creation_5m_tokens, cache_creation_1h_tokens,
  actual_cost, actual_cost_micros, duration_ms, first_token_ms
ON usage_logs
BEGIN
  UPDATE usage_stats_hourly SET
    requests = requests - (1),
    input_tokens = input_tokens - (IFNULL(OLD.input_tokens, 0)),
    output_tokens = output_tokens - (IFNULL(OLD.output_tokens, 0)),
    cache_read_tokens = cache_read_tokens - (IFNULL(OLD.cache_read_tokens, 0)),
    cache_creation_tokens = cache_creation_tokens - (IFNULL(OLD.cache_creation_tokens, 0)),
    cache_creation_5m_tokens = cache_creation_5m_tokens - (IFNULL(OLD.cache_creation_5m_tokens, 0)),
    cache_creation_1h_tokens = cache_creation_1h_tokens - (IFNULL(OLD.cache_creation_1h_tokens, 0)),
    cost_micros = cost_micros - (IFNULL(COALESCE(OLD.actual_cost_micros, CAST(ROUND(OLD.actual_cost * 1000000) AS INTEGER)), 0)),
    cost = (cost_micros - (IFNULL(COALESCE(OLD.actual_cost_micros, CAST(ROUND(OLD.actual_cost * 1000000) AS INTEGER)), 0))) / 1000000.0,
    cost_n = cost_n - (CASE WHEN COALESCE(OLD.actual_cost_micros, CAST(ROUND(OLD.actual_cost * 1000000) AS INTEGER)) IS NULL THEN 0 ELSE 1 END),
    duration_sum = duration_sum - (IFNULL(OLD.duration_ms, 0)),
    duration_n = duration_n - (CASE WHEN OLD.duration_ms IS NULL THEN 0 ELSE 1 END),
    ttft_sum = ttft_sum - (IFNULL(OLD.first_token_ms, 0)),
    ttft_n = ttft_n - (CASE WHEN OLD.first_token_ms IS NULL THEN 0 ELSE 1 END)
  WHERE OLD.created_at IS NOT NULL
    AND hour = substr(OLD.created_at, 1, 13)
    AND user_id = COALESCE(OLD.user_id, '')
    AND api_key_id = COALESCE(OLD.api_key_id, '')
    AND model = COALESCE(OLD.model, '')
    AND vm_id = COALESCE(OLD.vm_id, '')
    AND billing_group_id = COALESCE(OLD.billing_group_id, -1)
    AND path = COALESCE(OLD.path, '')
    AND status_code = COALESCE(OLD.status, -1)
    AND error_code = COALESCE(OLD.error_code, '');
  DELETE FROM usage_stats_hourly
  WHERE OLD.created_at IS NOT NULL
    AND requests <= 0
    AND hour = substr(OLD.created_at, 1, 13)
    AND user_id = COALESCE(OLD.user_id, '')
    AND api_key_id = COALESCE(OLD.api_key_id, '')
    AND model = COALESCE(OLD.model, '')
    AND vm_id = COALESCE(OLD.vm_id, '')
    AND billing_group_id = COALESCE(OLD.billing_group_id, -1)
    AND path = COALESCE(OLD.path, '')
    AND status_code = COALESCE(OLD.status, -1)
    AND error_code = COALESCE(OLD.error_code, '');
  INSERT INTO usage_stats_hourly (hour, user_id, api_key_id, model, vm_id, billing_group_id, path, status_code, error_code, requests, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cache_creation_5m_tokens, cache_creation_1h_tokens, cost_micros, cost, cost_n, duration_sum, duration_n, ttft_sum, ttft_n)
  SELECT
    substr(NEW.created_at, 1, 13),
    COALESCE(NEW.user_id, ''),
    COALESCE(NEW.api_key_id, ''),
    COALESCE(NEW.model, ''),
    COALESCE(NEW.vm_id, ''),
    COALESCE(NEW.billing_group_id, -1),
    COALESCE(NEW.path, ''),
    COALESCE(NEW.status, -1),
    COALESCE(NEW.error_code, ''),
    1,
    IFNULL(NEW.input_tokens, 0),
    IFNULL(NEW.output_tokens, 0),
    IFNULL(NEW.cache_read_tokens, 0),
    IFNULL(NEW.cache_creation_tokens, 0),
    IFNULL(NEW.cache_creation_5m_tokens, 0),
    IFNULL(NEW.cache_creation_1h_tokens, 0),
    IFNULL(COALESCE(NEW.actual_cost_micros, CAST(ROUND(NEW.actual_cost * 1000000) AS INTEGER)), 0),
    IFNULL(COALESCE(NEW.actual_cost_micros, CAST(ROUND(NEW.actual_cost * 1000000) AS INTEGER)), 0) / 1000000.0,
    CASE WHEN COALESCE(NEW.actual_cost_micros, CAST(ROUND(NEW.actual_cost * 1000000) AS INTEGER)) IS NULL THEN 0 ELSE 1 END,
    IFNULL(NEW.duration_ms, 0),
    CASE WHEN NEW.duration_ms IS NULL THEN 0 ELSE 1 END,
    IFNULL(NEW.first_token_ms, 0),
    CASE WHEN NEW.first_token_ms IS NULL THEN 0 ELSE 1 END
  WHERE NEW.created_at IS NOT NULL
  ON CONFLICT (hour, user_id, api_key_id, model, vm_id, billing_group_id, path, status_code, error_code) DO UPDATE SET
    requests = requests + excluded.requests,
    input_tokens = input_tokens + excluded.input_tokens,
    output_tokens = output_tokens + excluded.output_tokens,
    cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
    cache_creation_tokens = cache_creation_tokens + excluded.cache_creation_tokens,
    cache_creation_5m_tokens = cache_creation_5m_tokens + excluded.cache_creation_5m_tokens,
    cache_creation_1h_tokens = cache_creation_1h_tokens + excluded.cache_creation_1h_tokens,
    cost_micros = cost_micros + excluded.cost_micros,
    cost = (cost_micros + excluded.cost_micros) / 1000000.0,
    cost_n = cost_n + excluded.cost_n,
    duration_sum = duration_sum + excluded.duration_sum,
    duration_n = duration_n + excluded.duration_n,
    ttft_sum = ttft_sum + excluded.ttft_sum,
    ttft_n = ttft_n + excluded.ttft_n;
END;
