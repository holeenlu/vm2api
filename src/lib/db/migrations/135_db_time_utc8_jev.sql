-- 134 的续篇：jev 用量表的时间戳改为 UTC+8 存储形式。
-- 单独成文是因为 jev 用量（052）是可整体缺席的附加模块，而按表名改写的语句在表不存在时会让整个迁移失败。

UPDATE "jev_usage_events" SET "created_at" = strftime('%Y-%m-%dT%H:%M:%f', "created_at", '+8 hours') || '+08:00'
  WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';
UPDATE "jev_usage_meta" SET "started_at" = strftime('%Y-%m-%dT%H:%M:%f', "started_at", '+8 hours') || '+08:00'
  WHERE "started_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z';

-- 守卫：仍有 Z 值则回滚
CREATE TEMP TABLE db_time_utc8_jev__fix_rows_first (ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO db_time_utc8_jev__fix_rows_first(ok)
SELECT CASE WHEN
  EXISTS(SELECT 1 FROM "jev_usage_events" WHERE "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z') OR
  EXISTS(SELECT 1 FROM "jev_usage_meta" WHERE "started_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z')
THEN 0 ELSE 1 END;
DROP TABLE db_time_utc8_jev__fix_rows_first;
