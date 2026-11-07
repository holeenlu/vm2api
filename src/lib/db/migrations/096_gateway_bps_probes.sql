-- 096_gateway_bps_probes — BPS 403 自动恢复探测的记录（对应 sub2api account_probe_usage 的 BPS 恢复探测）。
--
-- Worker 每次探测（用 BPS 名单第一个模型发一次极小请求）随心跳上报；控制面按账号保存时间、模型、结果、
-- 上游状态与错误码、token 用量和耗时，在账号详情与 BPS 对话框中展示。探测不是用户请求：不写 usage_logs、不计费。
-- 同一实例同一运行账号同一时刻只记一次；只保留 30 天。

CREATE TABLE gateway_bps_probes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_resource_id TEXT NOT NULL,
  gateway_instance_id TEXT NOT NULL,
  runtime_account_id TEXT NOT NULL,
  probed_at TEXT NOT NULL,
  model TEXT NOT NULL,
  ok INTEGER NOT NULL,
  status INTEGER,
  error_code TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (gateway_instance_id, runtime_account_id, probed_at)
);
CREATE INDEX idx_gateway_bps_probes_account ON gateway_bps_probes(account_resource_id, probed_at);
