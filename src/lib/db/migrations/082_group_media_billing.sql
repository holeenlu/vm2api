-- 082_group_media_billing — Codex 生图与网页搜索的分组计费规则（对齐 sub2api 分组配置）。
-- allow_image_generation：分组是否允许生图（Images 端点与 Responses image_generation 工具），存量分组保持允许。
-- image_count_billing：Images 端点按张计费；关闭时沿用 token 计价。
-- image_rate_independent / image_rate_multiplier：生图费用使用独立倍率，关闭时沿用分组有效倍率。
-- image_price_1k/2k/4k：按张单价（USD），NULL 使用默认价。
-- web_search_price_per_call：Codex 独立网页搜索单次价（USD），NULL 使用默认价，0 表示免费。
ALTER TABLE groups ADD COLUMN allow_image_generation INTEGER NOT NULL DEFAULT 1;
ALTER TABLE groups ADD COLUMN image_count_billing INTEGER NOT NULL DEFAULT 0;
ALTER TABLE groups ADD COLUMN image_rate_independent INTEGER NOT NULL DEFAULT 0;
ALTER TABLE groups ADD COLUMN image_rate_multiplier REAL NOT NULL DEFAULT 1.0;
ALTER TABLE groups ADD COLUMN image_price_1k REAL;
ALTER TABLE groups ADD COLUMN image_price_2k REAL;
ALTER TABLE groups ADD COLUMN image_price_4k REAL;
ALTER TABLE groups ADD COLUMN web_search_price_per_call REAL;
