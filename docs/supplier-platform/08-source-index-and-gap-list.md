# 资料索引与现状差距

## 1. `vm2api` 现有证据

| 资料 | 当前事实 | 对目标设计的用途 |
|---|---|---|
| `docs/PANEL_API.md` | 面板登录、`super_admin/admin/user`、用户 CRUD、VM/代理/Key/计费接口 | 兼容面板合同；明确供应商角色不直接复用普通面板角色 |
| `src/lib/admin/panel-acl.mjs` | 页面、capability 和路由按 `super_admin/admin/user` 裁剪 | 复用后端能力目录思路；新增 vendor scope |
| `src/lib/admin/panel-users.mjs` | scrypt、启停、最后管理员保护、软删除 | 复用身份生命周期和安全哈希规则 |
| `src/lib/admin/resource-owner.mjs` | VM owner/origin、平台池与 user owner 隔离 | 迁移到统一 `owner_type/owner_id` 时保留旧事实 |
| `src/lib/db/migrations/014_users_groups.sql` | `users`、`groups`、`account_groups`、角色迁移 | 作为供应商资源供给和用户体系的现有基础 |
| `src/lib/admin/panel-routes.mjs` | 面板认证、owner 过滤、管理员路由保护 | 作为权限落点审计对象；不在路由外推断授权 |

## 2. `sub2api` 参考资料

| 资料 | 可复用设计 |
|---|---|
| `docs/vendor-console/API-ROUTES.md` | 供应商、账号、代理、用量、审计、结算和 admin 入口的分区方式 |
| `docs/vendor-console/PORTAL-ROUTING.md` | 独立门户只代理后端、不持有数据库/Redis/JWT 密钥的部署边界 |
| `docs/vendor-console/prototype-hierarchy-model.js` | `tier/parentId/rootId`、有效父级、直属资源范围、子集限制、合同边和状态转换的设计示例 |
| `docs/ENGINEERING.md` R01 | `super_admin/admin/user/vendor` 登录角色与供应商 `tier` 分离；管理员按委派策略工作 |
| `docs/ENGINEERING.md` R12 | 用量、余额、结算、付款幂等和历史账务保护 |
| `docs/ENGINEERING.md` R13 | 两级供应商、资源范围、双边合同、独立结算和门户部署 |
| `docs/architecture-rebuild/CONTRACTS.md` | 以证据、契约、迁移、验证和退出条件组织重构资料 |

## 3. 差距清单

| 差距 | 当前状态 | 目标动作 | 优先级 |
|---|---|---|---:|
| 超级管理员身份 | 已通过迁移规范为 `super_admin` | 保留旧 `admin` → `super_admin` 的升级记录和审计 | P0 |
| 管理员职责 | 已通过迁移规范为 `admin` | 旧 `super` → `admin`，只管理 U 和 U 使用数据 | P0 |
| 用户职责 | 当前 `user` 曾可创建/管理自有 VM 和代理 | 已收紧为 Key、使用记录、统计和账单；VM 仅保留必要只读投影 | P0 |
| 供应商实体 | 当前没有完整 vendor 树 | 增加 vendor、member、parent/root/status | P0 |
| 下级开户 | 当前没有 `vendor.create_child` | 能力化、仅一级→直属二级、事务和审计 | P0 |
| 资源归属 | 当前主要是 user/platform owner | 引入 vendor owner 和 resource grant，兼容旧 VM 字段 | P0 |
| 供应商门户 | 当前没有供应商独立入口 | 独立前端构建和同源/反代部署 | P1 |
| 供应商用量投影 | 当前面板按 user owner | 增加 vendor scope 的汇总、明细字段投影 | P1 |
| 合同与双边结算 | 当前 `vm2api` 面板有个人/平台用量，但无供应商两条合同边 | 增加合同版本、用量快照、结算行、付款和冲正 | P1 |
| 审计 | 当前有运行日志和部分操作记录 | 统一 actor/target/policy revision/结果事件 | P1 |
| 多租户并发 | 当前 owner 过滤以面板角色为主 | 对供应商停用、能力撤销、旧异步任务补 revision/claim 保护 | P1 |

## 4. 已确定与待决策

### 已确定

- 供应商最多两层；一级只能创建直属二级；不能出现三级。
- 是否能创建下级由显式 `vendor.create_child` 决定，不由“一级”角色自动推断。
- 父级 groups/platforms 和资源额度对下级形成上限；下级不能扩大范围。
- 供应商门户不直连数据库或 Redis；后端是唯一鉴权和业务事实入口。
- 两条合同边独立结算，历史账单冻结合同、汇率和倍率快照。

### 实施前仍需产品确认

- 已确定 `super_admin/admin/user` 为规范角色编码，047 迁移一次性转换旧数据；
- 已确定 AD 只管理 U 并查看 U 数据，不授予供应商读写、账号/VM 或合同操作；
- 已确定供应商可以创建自有账号/VM；既有 VM 如何绑定/迁入供应商，需要迁移前盘点归属；
- 供应商计费按账号、分组、模型还是 usage fact 统一落账；
- 供应商登录是否复用当前面板 session，还是采用独立 JWT/MFA 会话；
- 结算付款是否只登记线下事实，还是接入支付服务。

这些问题不影响当前文档的核心不变量，但会影响迁移字段、API 版本和发布顺序；在确认前不应写入不可逆的业务迁移。
