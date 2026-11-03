-- 086_gateway_account_freezes — 账号错误保护冻结跨 Worker 共享（对齐 codex-proxy-rs 单进程内的全局冻结）。
-- 每个 Worker 在心跳中上报本实例冻结的账号；控制面按账号资源记录，并在其他实例的心跳策略中下发，
-- 让同一上游账号在所有实例上都暂停接单。到期、解冻或来源实例失联后不再下发。
CREATE TABLE IF NOT EXISTS gateway_account_freezes (
  account_resource_id TEXT NOT NULL,
  source_instance_id TEXT NOT NULL,
  frozen_until TEXT NOT NULL,
  reason TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_resource_id, source_instance_id)
);
