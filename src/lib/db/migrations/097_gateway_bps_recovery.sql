-- 097_gateway_bps_recovery — BPS 通道的暂停与恢复信息（对应 sub2api 账号 BPS 恢复状态展示）。
--
-- gateway_worker_account_bindings：
--   bps_recovery：403 停用后的自动恢复状态（auto / stopped / off），未停用时为 NULL。
--   bps_next_probe_at：自动恢复的下次探测时刻（仅 auto）。
--   bps_cooldown_until：BPS 限流、按范围冷却与 usage-policy 退避中最晚的到期时刻。
-- 由心跳 account_credentials 整体替换写入；运营“手动解除 / 停止本次恢复”后由下一次心跳确认。历史行为 NULL。

ALTER TABLE gateway_worker_account_bindings ADD COLUMN bps_recovery TEXT;
ALTER TABLE gateway_worker_account_bindings ADD COLUMN bps_next_probe_at TEXT;
ALTER TABLE gateway_worker_account_bindings ADD COLUMN bps_cooldown_until TEXT;
