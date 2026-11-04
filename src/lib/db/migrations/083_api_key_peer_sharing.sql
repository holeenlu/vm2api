-- 083_api_key_peer_sharing — CPR 互联只读协议（GET /v1/cpr/link）的 Key 级共享开关。
-- JSON：{ enabled, share_pool, share_plans, share_quota }；缺省全部关闭，存量 Key 不对外公开快照。
ALTER TABLE api_keys ADD COLUMN peer_sharing TEXT NOT NULL DEFAULT '{}';
