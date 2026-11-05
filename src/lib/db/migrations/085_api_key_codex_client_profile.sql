-- 085_api_key_codex_client_profile — 对齐 codex-proxy-rs 的 Key 级上游客户端画像覆盖。
-- codex_client_profile：JSON 画像选择（预设或自定义），NULL 表示继承通用设置；只影响 Gateway Worker 路径。
ALTER TABLE api_keys ADD COLUMN codex_client_profile TEXT;
