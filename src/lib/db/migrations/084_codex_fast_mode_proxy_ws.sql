-- 084_codex_fast_mode_proxy_ws — 对齐 codex-proxy-rs 的分组 Fast 三态与代理 WS 连接预算。
-- codex_fast_mode：default 保留客户端档位；enabled 把未指定/default 档位改为 priority（目录声明支持时）；
--   disabled 把 priority/fast 改回 default。存量分组为 default，行为不变。
-- max_websocket_connections：同一代理出口共享的上游 Codex WS 物理连接上限，0 表示不限。
ALTER TABLE groups ADD COLUMN codex_fast_mode TEXT NOT NULL DEFAULT 'default';
ALTER TABLE proxies ADD COLUMN max_websocket_connections INTEGER NOT NULL DEFAULT 0;
