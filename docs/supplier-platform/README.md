# 供应商平台与统一角色模型

本目录是 `vm2api` 供应商平台的产品、架构、权限、数据、接口和验收基线。它参考了定制版 `sub2api` 重构资料，目标是把供应商运营、平台管理和终端用户放进同一套可审计的工程模型中。

## 文档状态

| 项目 | 结论 |
|---|---|
| 文档性质 | 设计基线、实施合同和验收资料 |
| 当前实现状态 | `vm2api` 已有 `super_admin/admin/user/vendor` 登录角色、供应商层级、供应商门户、服务提供商运营视图和按范围的账号/VM/用量链路；合同及双边结算继续按独立业务域扩展 |
| 参考来源 | `/Users/luhonglin/Git/sub2api/docs/vendor-console/`、`/Users/luhonglin/Git/sub2api/docs/architecture-rebuild/`、`/Users/luhonglin/Git/sub2api/docs/ENGINEERING.md` 的 R01/R12/R13 |
| 目标角色 | 超级管理员 `super_admin`、管理员 `admin`、用户 `user`、供应商 `vendor` |
| 目标边界 | SA 独占平台 VM 创建与管理并查看服务提供商；AD 只管理 U 并查看 U 的使用记录和数据；U 创建 Key 并查看自己的用量；供应商按主体 `tier=1/2` 创建账号/VM 并查看自己的用量；是否能创建下级由 `vendor.create_child` 控制 |

## 阅读顺序

1. [01-产品与角色模型](01-product-and-role-model.md)：定义身份、组织层级、资源边界和术语。
2. [02-权限矩阵与授权策略](02-permission-matrix.md)：定义角色、能力、字段和对象范围，以及下级供应商开户条件。
3. [03-领域模型与数据字典](03-domain-model.md)：定义核心实体、关系、状态和数据来源。
4. [04-接口与页面契约](04-api-and-portal-contract.md)：定义供应商门户、平台管理台和接口风格。
5. [05-业务流程与状态机](05-workflows-and-state-machines.md)：定义开户、资源运营、归档、结算和撤销流程。
6. [06-安全审计与隔离](06-security-audit-and-isolation.md)：定义认证、密钥、审计、敏感操作和数据隔离。
7. [07-实施拆分与验收计划](07-implementation-and-acceptance.md)：把设计拆成可交付工作包和最小验证集。
8. [08-资料索引与差距清单](08-source-index-and-gap-list.md)：记录现有代码证据、参考材料、目标差距和决策待办。
9. [09-菜单与角色规划](09-menu-and-role-plan.md)：本轮角色职责、兼容编码、默认入口、现有功能页面和供应商门户菜单合同。

## 一句话架构

```mermaid
flowchart LR
  SA[超级管理员 super_admin] --> OPS[平台管理与授权策略]
  AD[管理员 admin] --> USERS[用户 U 管理与用量查看]
  U[用户 user] --> USER[个人 Key / 用量]
  V[供应商 vendor] --> VPORTAL[供应商门户]
  VPORTAL -.tier=1 + vendor.create_child.-> V2[直属二级供应商]
  OPS --> AUTHZ[统一授权服务]
  VPORTAL --> AUTHZ
  AUTHZ --> RES[账号 / 代理 / 分组 / VM / Key]
  RES --> USAGE[用量事实]
  USAGE --> BILL[两条独立合同边结算]
  BILL --> AUDIT[审计与对账]
```

## 不变量

- UI 菜单只反映能力，不能承担授权；每个请求都必须在后端重新计算角色、能力、对象范围和状态。
- 角色、供应商层级、资源归属、合同付款边是四个独立维度，不能用一个 `role` 字段代替。
- 一级供应商对二级供应商的读取聚合不等于越级写权限；父级只能管理直属子级。
- 下级供应商的分组、平台、账号限额和代理限额必须是父级允许集合和额度的子集。
- 归档资源只读，历史用量、合同、账单和审计记录保留；归档不能通过普通更新恢复。
- 凭据、原始上游错误、完整模型目录和其他租户资料按最小字段投影返回。
- 消费事实、合同快照、结算单和付款流水必须持久化并幂等；历史账单不能按当前价格重算。

## 现状与目标的关系

当前面板规范编码为 `super_admin`（SA）、`admin`（AD）、`user`（U）和 `vendor`。迁移兼容旧数据时，旧 `admin` 转为 `super_admin`，旧 `super` 转为 `admin`，有效供应商成员由迁移 057 标记为 `vendor`；供应商主体的一级/二级层级保存在 `vendors.tier`。供应商通过门户和供应商资源范围实现。

本轮同时调整了普通面板的菜单和 SA/AD/U 授权边界，新增供应商角色、供应商开户流程、门户下级开户和服务提供商运营视图。
