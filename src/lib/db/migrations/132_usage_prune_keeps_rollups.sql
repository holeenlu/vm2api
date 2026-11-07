-- 132_usage_prune_keeps_rollups — 审计阶段 1 W5：使用记录按保留期清理时，小时汇总不再随明细扣减。
-- 127 的两个 AFTER DELETE 触发器在任何删除时都从 usage_cost_hourly / usage_stats_hourly 扣回该行，
-- 保留期清理一跑，超出保留期的小时汇总也跟着归零，统计页、账号 5h/7d 窗口与成本报表就丢了历史。
-- 这里加标记表 usage_prune_marker：保留期清理（usage-logs-repo `_pruneUsage`）在同一事务里先写标记行、
-- 再分批删除、最后清标记；触发器在标记存在时不扣减。人工删除、恢复等其他删除没有标记，仍按原逻辑扣减。
-- 标记只在清理事务内可见（事务提交前已清空），其他连接读不到。可重复执行：标记表 IF NOT EXISTS，触发器先删后建。

CREATE TABLE IF NOT EXISTS usage_prune_marker (
  id INTEGER PRIMARY KEY CHECK (id = 1)
);
DELETE FROM usage_prune_marker;

DROP TRIGGER IF EXISTS usage_cost_hourly_delete;
CREATE TRIGGER usage_cost_hourly_delete AFTER DELETE ON usage_logs
WHEN OLD.created_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM usage_prune_marker)
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

DROP TRIGGER IF EXISTS usage_stats_hourly_delete;
CREATE TRIGGER usage_stats_hourly_delete AFTER DELETE ON usage_logs
WHEN OLD.created_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM usage_prune_marker)
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
