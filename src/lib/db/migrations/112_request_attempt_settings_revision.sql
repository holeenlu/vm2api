-- 112_request_attempt_settings_revision — 迁移 111 的列改名为 settings_revision（统一控制面重构 R4 审查 P1-2）：
-- 记录的是 Codex 本地设置的版本（executor_settings / config_revisions），与上游 usage_logs.config_revision
-- （routing.json 运行配置版本）不是一回事，同名会误导诊断。
ALTER TABLE request_attempts RENAME COLUMN config_revision TO settings_revision;
