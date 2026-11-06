-- 118_vendor_resource_tombstone — 账号资源永久删除（墓碑）。
-- vendor_resources 被结算事实（vendor_usage_facts.resource_id）、授权、OAuth 会话、投影绑定与响应归属外键引用，
-- 永久删除不物理删行：写入 deleted_at，状态置为 archived，清空 secret_json、external_id 与配置里的凭据字段。
-- 不变量：deleted_at 非空的行 status 一定是 archived。面板、门户、调度与 Gateway 投影的列表和查找排除这些行
-- （含「显示归档」），结算与用量历史的关联照常按资源 ID 解析名称。历史行为 NULL。
ALTER TABLE vendor_resources ADD COLUMN deleted_at TEXT;
