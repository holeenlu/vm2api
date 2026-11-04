-- 090_usage_logs_safety_buffering — Codex 上游响应头 x-codex-safety-buffering-* 的原值。
--
-- safety_buffering_enabled：x-codex-safety-buffering-enabled，1 = true，0 = false，
-- NULL = 上游未返回该头（或值无法识别）。
-- safety_buffering_faster_model：x-codex-safety-buffering-faster-model 原值，未返回时为 NULL。
-- 只记录上游声明，不改写 response_model / model_mismatch，不参与计费与调度。历史行保持 NULL。

ALTER TABLE usage_logs ADD COLUMN safety_buffering_enabled INTEGER;
ALTER TABLE usage_logs ADD COLUMN safety_buffering_faster_model TEXT;
