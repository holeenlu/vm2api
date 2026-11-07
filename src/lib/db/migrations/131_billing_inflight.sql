-- 计费在途记录（审计阶段 1 W2，P1-B1 / P1-B3）。
-- 准入（RelayBilling.authorize）通过后写一行，收口（commitRelayLog）在同一事务里删除。
-- 进程崩溃或部署切断时留下的行由启动与定期扫描补结算：已结算的直接删除；带 Gateway dispatch 的补入对账队列；
-- 其余记一条 billing_status='interrupted' 的使用记录（不扣费、可见、可告警）。
-- 余额低于阈值时按钱包统计在途数，限制低余额下的并发透支。
CREATE TABLE IF NOT EXISTS billing_inflight (
  request_id TEXT PRIMARY KEY,
  boot_id TEXT NOT NULL,
  wallet_key TEXT NOT NULL,
  user_id TEXT,
  api_key_id TEXT,
  group_id TEXT,
  model TEXT,
  context_json TEXT NOT NULL,
  gateway_instance_id TEXT,
  dispatch_id TEXT,
  started_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_billing_inflight_wallet ON billing_inflight(wallet_key);
CREATE INDEX IF NOT EXISTS idx_billing_inflight_started ON billing_inflight(started_at);
