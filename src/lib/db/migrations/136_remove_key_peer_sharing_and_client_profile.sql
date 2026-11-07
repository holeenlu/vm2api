-- 136_remove_key_peer_sharing_and_client_profile — 下线 Key 级「CPR 互联共享」与「上游客户端画像」（2026-11-07，
-- 破坏性，只能前滚）。代码已删除 CPR 互联只读协议（GET /v1/cpr/link、cpr-peer-link.mjs、peer-sharing.mjs 与
-- ApiKeyStore.effectiveLimits）与 Key 级画像覆盖（keyClientProfile），Gateway Worker 请求一律使用设置页的通用画像，
-- 这里删除它们留下的列：
--   1. api_keys.peer_sharing（迁移 083）：互联共享开关 JSON，没有读取方后对外快照不再存在。
--   2. api_keys.codex_client_profile（迁移 085）：Key 级画像覆盖 JSON，继承通用设置即全部行为。
-- 保留：设置存储里的通用画像 codex_client_profile（executor_settings，设置页仍在用），审计日志不改。

ALTER TABLE api_keys DROP COLUMN peer_sharing;
ALTER TABLE api_keys DROP COLUMN codex_client_profile;
