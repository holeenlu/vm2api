-- 115_usage_stats_hourly — hourly rollup of usage_logs for the statistics page (/api/panel/statistics*).
--
-- One row per (hour, user, key, model, slot, billing group, path, status, error code). The dimensions are the
-- statistics page's group-by columns plus the columns its predicates read: ownerPred (user_id, api_key_id) and
-- SUCCESS_PRED / ERROR_PRED (status, error_code). NULLs are stored as '' (text) or -1 (integers) so the primary key
-- works; readers map them back with NULLIF and reuse the same predicate SQL. Averages keep sum and count so partial
-- windows can be combined. Triggers keep the rollup exact under insert, update and retention deletes; whole hours
-- are read from here and the partial hours at a window's edges from usage_logs (usage-stats-rollup.mjs).

CREATE TABLE IF NOT EXISTS usage_stats_hourly (
  hour TEXT NOT NULL,
  user_id TEXT NOT NULL,
  api_key_id TEXT NOT NULL,
  model TEXT NOT NULL,
  vm_id TEXT NOT NULL,
  billing_group_id INTEGER NOT NULL,
  path TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  error_code TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  duration_sum REAL NOT NULL DEFAULT 0,
  duration_n INTEGER NOT NULL DEFAULT 0,
  ttft_sum REAL NOT NULL DEFAULT 0,
  ttft_n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (hour, user_id, api_key_id, model, vm_id, billing_group_id, path, status_code, error_code)
) WITHOUT ROWID;

INSERT INTO usage_stats_hourly (hour, user_id, api_key_id, model, vm_id, billing_group_id, path, status_code, error_code, requests, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost, duration_sum, duration_n, ttft_sum, ttft_n)
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
  SUM(IFNULL(actual_cost, 0)),
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
  INSERT INTO usage_stats_hourly (hour, user_id, api_key_id, model, vm_id, billing_group_id, path, status_code, error_code, requests, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost, duration_sum, duration_n, ttft_sum, ttft_n)
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
    IFNULL(NEW.actual_cost, 0),
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
    cost = cost + excluded.cost,
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
    cost = cost - (IFNULL(OLD.actual_cost, 0)),
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
  input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, actual_cost, duration_ms, first_token_ms
ON usage_logs
BEGIN
  UPDATE usage_stats_hourly SET
    requests = requests - (1),
    input_tokens = input_tokens - (IFNULL(OLD.input_tokens, 0)),
    output_tokens = output_tokens - (IFNULL(OLD.output_tokens, 0)),
    cache_read_tokens = cache_read_tokens - (IFNULL(OLD.cache_read_tokens, 0)),
    cache_creation_tokens = cache_creation_tokens - (IFNULL(OLD.cache_creation_tokens, 0)),
    cost = cost - (IFNULL(OLD.actual_cost, 0)),
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
  INSERT INTO usage_stats_hourly (hour, user_id, api_key_id, model, vm_id, billing_group_id, path, status_code, error_code, requests, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost, duration_sum, duration_n, ttft_sum, ttft_n)
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
    IFNULL(NEW.actual_cost, 0),
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
    cost = cost + excluded.cost,
    duration_sum = duration_sum + excluded.duration_sum,
    duration_n = duration_n + excluded.duration_n,
    ttft_sum = ttft_sum + excluded.ttft_sum,
    ttft_n = ttft_n + excluded.ttft_n;
END;
