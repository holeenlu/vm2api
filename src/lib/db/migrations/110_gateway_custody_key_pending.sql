-- 110_gateway_custody_key_pending — 实例托管公钥首次登记后固定（统一控制面重构 R3 审查 P1-5）。
-- 之后上报的不同公钥只记在 custody_key_pending，管理员确认后才替换 custody_public_key；
-- 待确认期间 control 托管的投影回退到实例间共享凭据包。
ALTER TABLE gateway_worker_instances ADD COLUMN custody_key_pending TEXT;
