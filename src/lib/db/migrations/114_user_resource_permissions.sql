-- 114_user_resource_permissions — 账号资源（虚拟机、Codex 账号、供应商账号池）的逐用户授权。
-- JSON 数组，取值见 src/lib/admin/resource-permissions.mjs：
-- resources.read / resources.create / resources.edit / resources.manage。
-- 只有 super_admin 可以授予，且只对 admin 角色生效；super_admin 天然拥有全部能力。
ALTER TABLE users ADD COLUMN resource_permissions TEXT NOT NULL DEFAULT '[]';
