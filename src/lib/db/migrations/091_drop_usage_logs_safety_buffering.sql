-- 用户 2026-11-04 要求撤销 Gateway 使用记录的 safety-buffering 响应头记录并删除这两列；
-- 控制面已不再读写。已应用的 090 保持不变，由本迁移删除。
ALTER TABLE usage_logs DROP COLUMN safety_buffering_enabled;
ALTER TABLE usage_logs DROP COLUMN safety_buffering_faster_model;
