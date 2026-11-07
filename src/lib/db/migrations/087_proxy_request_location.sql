-- 087_proxy_request_location — 对齐 codex-proxy-rs 的代理请求位置（0011_proxy_request_location）。
-- request_location_mode：inherit（默认，账号回退全局请求位置）/ manual（使用下列手动字段）/
--   auto（跟随代理池探测到的出口国家、地区、城市与时区，IPv4/IPv6 时区冲突时不覆盖）。
-- 只影响经 Gateway Worker 发出的请求；全局请求位置保存在 settings.codex_request_location。
ALTER TABLE proxies ADD COLUMN request_location_mode TEXT NOT NULL DEFAULT 'inherit';
ALTER TABLE proxies ADD COLUMN location_country TEXT;
ALTER TABLE proxies ADD COLUMN location_region TEXT;
ALTER TABLE proxies ADD COLUMN location_city TEXT;
ALTER TABLE proxies ADD COLUMN location_timezone TEXT;
