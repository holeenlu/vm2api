-- 111_request_attempt_config_revision — 请求尝试记录本次请求依据的控制面配置版本（统一控制面重构 P4.3，设计第 10 节）。
-- 与心跳下发、请求信封中的 config_revision 一致，用于诊断“请求按哪一版配置执行”。
ALTER TABLE request_attempts ADD COLUMN config_revision INTEGER;
