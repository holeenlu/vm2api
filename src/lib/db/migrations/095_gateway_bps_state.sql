-- 095_gateway_bps_state — Gateway 账号 BPS（Excel Basispoints）附加授权的运行状态。
--
-- gateway_worker_account_bindings：
--   bps_state：Worker 上报的 BPS 通道终态（expired / invalid / blocked），可用时为 NULL。
--   bps_error：最近一次 BPS 错误分类。
--   bps_blocked_at：账号级 403 停用 BPS 的时刻；控制面按它对“403 自动移组”去重。
-- 由心跳 account_credentials 整体替换写入；历史行为 NULL。BPS 授权令牌只保存在 Worker。

ALTER TABLE gateway_worker_account_bindings ADD COLUMN bps_state TEXT;
ALTER TABLE gateway_worker_account_bindings ADD COLUMN bps_error TEXT;
ALTER TABLE gateway_worker_account_bindings ADD COLUMN bps_blocked_at TEXT;
