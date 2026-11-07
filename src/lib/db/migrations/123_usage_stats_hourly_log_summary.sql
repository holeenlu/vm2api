-- 123_usage_stats_hourly_log_summary — extend the hourly rollup (115) for the usage-log page's summary, ranking and
-- overview (/api/panel/usage-logs/summary|ranking|overview, technical-debt batch M5).
--
-- New measures: cache_creation_5m_tokens / cache_creation_1h_tokens (the summary's TTL split) and cost_n (rows whose
-- actual_cost is not NULL, so a ranking entry without any priced row still reads cost = NULL). Dimensions and the NULL
-- encoding are unchanged. The three triggers are recreated with the new measures, and the rollup is rebuilt from
-- usage_logs in the same transaction (115's backfill plus the new columns), so it stays exact for every existing row.

DROP TRIGGER IF EXISTS usage_stats_hourly_insert;
DROP TRIGGER IF EXISTS usage_stats_hourly_delete;
DROP TRIGGER IF EXISTS usage_stats_hourly_update;

ALTER TABLE usage_stats_hourly ADD COLUMN cache_creation_5m_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_stats_hourly ADD COLUMN cache_creation_1h_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_stats_hourly ADD COLUMN cost_n INTEGER NOT NULL DEFAULT 0;

DELETE FROM usage_stats_hourly;

INSERT INTO usage_stats_hourly (hour, user_id, api_key_id, model, vm_id, billing_group_id, path, status_code, error_code, requests, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cache_creation_5m_tokens, cache_creation_1h_tokens, cost, cost_n, duration_sum, duration_n, ttft_sum, ttft_n)
SELECT
  substr(created_at, 1, 13),
  COALESCE(user_id, ''),
  COALESCE(api_key_id, ''),
  COALESCE(model, ''),
  COALESCE(vm_id, ''),
  COALESCE(billing_group_id, -1),
  COALESCE(path, ''),
  COALESCE(status, -1),
  COALESCE(error_code, ''),
  COUNT(*),
  SUM(IFNULL(input_tokens, 0)),
  SUM(IFNULL(output_tokens, 0)),
  SUM(IFNULL(cache_read_tokens, 0)),
  SUM(IFNULL(cache_creation_tokens, 0)),
  SUM(IFNULL(cache_creation_5m_tokens, 0)),
  SUM(IFNULL(cache_creation_1h_tokens, 0)),
  SUM(IFNULL(actual_cost, 0)),
  SUM(CASE WHEN actual_cost IS NULL THEN 0 ELSE 1 END),
  SUM(IFNULL(duration_ms, 0)),
  SUM(CASE WHEN duration_ms IS NULL THEN 0 ELSE 1 END),
  SUM(IFNULL(first_token_ms, 0)),
  SUM(CASE WHEN first_token_ms IS NULL THEN 0 ELSE 1 END)
FROM usage_logs
WHERE created_at IS NOT NULL
GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9;

CREATE TRIGGER IF NOT EXISTS usage_stats_hourly_insert AFTER INSERT ON usage_logs
WHEN NEW.created_at IS NOT NULL
BEGIN
  INSERT INTO usage_stats_hourly (hour, user_id, api_key_id, model, vm_id, billing_group_id, path, status_code, error_code, requests, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cache_creation_5m_tokens, cache_creation_1h_tokens, cost, cost_n, duration_sum, duration_n, ttft_sum, ttft_n)
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
    IFNULL(NEW.actual_cost, 0),
    CASE WHEN NEW.actual_cost IS NULL THEN 0 ELSE 1 END,
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
    cost = cost + excluded.cost,
    cost_n = cost_n + excluded.cost_n,
    duration_sum = duration_sum + excluded.duration_sum,
    duration_n = duration_n + excluded.duration_n,
    ttft_sum = ttft_sum + excluded.ttft_sum,
    ttft_n = ttft_n + excluded.ttft_n;
END;

CREATE TRIGGER IF NOT EXISTS usage_stats_hourly_delete AFTER DELETE ON usage_logs
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
    cost = cost - (IFNULL(OLD.actual_cost, 0)),
    cost_n = cost_n - (CASE WHEN OLD.actual_cost IS NULL THEN 0 ELSE 1 END),
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
CREATE TRIGGER IF NOT EXISTS usage_stats_hourly_update AFTER UPDATE OF
  created_at, user_id, api_key_id, model, vm_id, billing_group_id, path, status, error_code,
  input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cache_creation_5m_tokens, cache_creation_1h_tokens,
  actual_cost, duration_ms, first_token_ms
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
    cost = cost - (IFNULL(OLD.actual_cost, 0)),
    cost_n = cost_n - (CASE WHEN OLD.actual_cost IS NULL THEN 0 ELSE 1 END),
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
  INSERT INTO usage_stats_hourly (hour, user_id, api_key_id, model, vm_id, billing_group_id, path, status_code, error_code, requests, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cache_creation_5m_tokens, cache_creation_1h_tokens, cost, cost_n, duration_sum, duration_n, ttft_sum, ttft_n)
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
    IFNULL(NEW.actual_cost, 0),
    CASE WHEN NEW.actual_cost IS NULL THEN 0 ELSE 1 END,
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
    cost = cost + excluded.cost,
    cost_n = cost_n + excluded.cost_n,
    duration_sum = duration_sum + excluded.duration_sum,
    duration_n = duration_n + excluded.duration_n,
    ttft_sum = ttft_sum + excluded.ttft_sum,
    ttft_n = ttft_n + excluded.ttft_n;
END;
