-- 093_usage_cost_rollup — hourly cost rollup of usage_logs plus quota observation history.
--
-- usage_cost_hourly holds per-hour sums of usage_logs grouped by every dimension the
-- account cost readers filter on (billing account key, slot, Gateway resource, Fable,
-- status / error_code). Success / error classification is NOT frozen here: readers apply
-- the same usage-log-preds predicates over status / error_code at query time. Triggers
-- keep the rollup exact under insert, cost repricing, Gateway receipt rewrites and
-- retention pruning; partial edge hours are read from usage_logs through the indexes below.
--
-- quota_observations records each change of a VM slot's used% / reset per quota window,
-- the history the codex-proxy-rs style capacity forecast samples from.

CREATE TABLE IF NOT EXISTS usage_cost_hourly (
  hour TEXT NOT NULL,
  account_key TEXT NOT NULL,
  vm_id TEXT NOT NULL,
  execution_kind TEXT NOT NULL,
  account_resource_id TEXT NOT NULL,
  fable INTEGER NOT NULL,
  status_code INTEGER NOT NULL,
  error_code TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  unpriced INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  input_cost REAL NOT NULL DEFAULT 0,
  output_cost REAL NOT NULL DEFAULT 0,
  cache_read_cost REAL NOT NULL DEFAULT 0,
  cache_creation_cost REAL NOT NULL DEFAULT 0,
  total_cost REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (hour, account_key, vm_id, execution_kind, account_resource_id, fable, status_code, error_code)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_usage_cost_hourly_resource
  ON usage_cost_hourly(account_resource_id, hour);

CREATE INDEX IF NOT EXISTS idx_usage_logs_billing_key_created
  ON usage_logs(COALESCE(NULLIF(final_account_id, ''), NULLIF(account_id, ''), vm_id, '—'), created_at);

CREATE INDEX IF NOT EXISTS idx_usage_logs_resource_created
  ON usage_logs(account_resource_id, created_at);

INSERT INTO usage_cost_hourly (
  hour, account_key, vm_id, execution_kind, account_resource_id, fable, status_code, error_code,
  requests, unpriced, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
  input_cost, output_cost, cache_read_cost, cache_creation_cost, total_cost
)
SELECT
  substr(created_at, 1, 13),
  COALESCE(NULLIF(final_account_id, ''), NULLIF(account_id, ''), vm_id, '—'),
  COALESCE(vm_id, ''),
  COALESCE(execution_kind, ''),
  COALESCE(account_resource_id, ''),
  CASE WHEN instr(lower(COALESCE(NULLIF(trim(upstream_model), ''), trim(model), '')), 'fable') > 0 THEN 1 ELSE 0 END,
  COALESCE(status, -1),
  COALESCE(error_code, ''),
  COUNT(*),
  SUM(CASE WHEN pricing_model = 'unpriced'
    AND IFNULL(input_tokens, 0) + IFNULL(output_tokens, 0) + IFNULL(cache_read_tokens, 0) + IFNULL(cache_creation_tokens, 0) > 0
    THEN 1 ELSE 0 END),
  SUM(IFNULL(input_tokens, 0)),
  SUM(IFNULL(output_tokens, 0)),
  SUM(IFNULL(cache_read_tokens, 0)),
  SUM(IFNULL(cache_creation_tokens, 0)),
  SUM(IFNULL(input_cost, 0)),
  SUM(IFNULL(output_cost, 0)),
  SUM(IFNULL(cache_read_cost, 0)),
  SUM(IFNULL(cache_creation_cost, 0)),
  SUM(IFNULL(total_cost, 0))
FROM usage_logs
WHERE created_at IS NOT NULL
GROUP BY 1, 2, 3, 4, 5, 6, 7, 8;

CREATE TRIGGER IF NOT EXISTS usage_cost_hourly_insert AFTER INSERT ON usage_logs
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
      AND IFNULL(NEW.input_tokens, 0) + IFNULL(NEW.output_tokens, 0) + IFNULL(NEW.cache_read_tokens, 0) + IFNULL(NEW.cache_creation_tokens, 0) > 0
      THEN 1 ELSE 0 END,
    IFNULL(NEW.input_tokens, 0),
    IFNULL(NEW.output_tokens, 0),
    IFNULL(NEW.cache_read_tokens, 0),
    IFNULL(NEW.cache_creation_tokens, 0),
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

CREATE TRIGGER IF NOT EXISTS usage_cost_hourly_delete AFTER DELETE ON usage_logs
WHEN OLD.created_at IS NOT NULL
BEGIN
  UPDATE usage_cost_hourly SET
    requests = requests - 1,
    unpriced = unpriced - (CASE WHEN OLD.pricing_model = 'unpriced'
      AND IFNULL(OLD.input_tokens, 0) + IFNULL(OLD.output_tokens, 0) + IFNULL(OLD.cache_read_tokens, 0) + IFNULL(OLD.cache_creation_tokens, 0) > 0
      THEN 1 ELSE 0 END),
    input_tokens = input_tokens - IFNULL(OLD.input_tokens, 0),
    output_tokens = output_tokens - IFNULL(OLD.output_tokens, 0),
    cache_read_tokens = cache_read_tokens - IFNULL(OLD.cache_read_tokens, 0),
    cache_creation_tokens = cache_creation_tokens - IFNULL(OLD.cache_creation_tokens, 0),
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

-- An update moves the row out of its old bucket and into the new one. Only columns the
-- rollup reads fire it; settlement-only writes (billing_status, actual_cost, ...) do not.
CREATE TRIGGER IF NOT EXISTS usage_cost_hourly_update AFTER UPDATE OF
  created_at, final_account_id, account_id, vm_id, execution_kind, account_resource_id,
  model, upstream_model, pricing_model, status, error_code,
  input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
  input_cost, output_cost, cache_read_cost, cache_creation_cost, total_cost
ON usage_logs
BEGIN
  UPDATE usage_cost_hourly SET
    requests = requests - 1,
    unpriced = unpriced - (CASE WHEN OLD.pricing_model = 'unpriced'
      AND IFNULL(OLD.input_tokens, 0) + IFNULL(OLD.output_tokens, 0) + IFNULL(OLD.cache_read_tokens, 0) + IFNULL(OLD.cache_creation_tokens, 0) > 0
      THEN 1 ELSE 0 END),
    input_tokens = input_tokens - IFNULL(OLD.input_tokens, 0),
    output_tokens = output_tokens - IFNULL(OLD.output_tokens, 0),
    cache_read_tokens = cache_read_tokens - IFNULL(OLD.cache_read_tokens, 0),
    cache_creation_tokens = cache_creation_tokens - IFNULL(OLD.cache_creation_tokens, 0),
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
      AND IFNULL(NEW.input_tokens, 0) + IFNULL(NEW.output_tokens, 0) + IFNULL(NEW.cache_read_tokens, 0) + IFNULL(NEW.cache_creation_tokens, 0) > 0
      THEN 1 ELSE 0 END,
    IFNULL(NEW.input_tokens, 0),
    IFNULL(NEW.output_tokens, 0),
    IFNULL(NEW.cache_read_tokens, 0),
    IFNULL(NEW.cache_creation_tokens, 0),
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

CREATE TABLE IF NOT EXISTS quota_observations (
  id INTEGER PRIMARY KEY,
  vm_id TEXT NOT NULL,
  quota_window TEXT NOT NULL,
  used_percent REAL NOT NULL,
  reset_at TEXT,
  window_seconds INTEGER,
  observed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_quota_observations_vm_window
  ON quota_observations(vm_id, quota_window, observed_at);
