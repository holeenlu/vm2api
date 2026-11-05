-- 098_api_key_codex_route — Key 级 Codex 通道策略（对齐 hloolx/codex2api 的按 Key 路由策略）。
-- codex_route：auto（NULL 等同 auto，按账号 BPS 模型名单先走 BPS 再回原生）/ native_only（只走原生 Codex）/
--   bps_only（只走 BPS，没有可用 BPS 账号时直接失败）。只影响 Gateway Worker 路径。
ALTER TABLE api_keys ADD COLUMN codex_route TEXT;
