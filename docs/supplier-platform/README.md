# 供应商平台与统一角色模型

本目录是 `vm2api` 供应商平台的产品、架构、权限、数据、接口和验收基线。它参考了定制版 `sub2api` 重构资料，目标是把供应商运营、平台管理和终端用户放进同一套可审计的工程模型中。

## 文档状态

| 项目 | 结论 |
|---|---|
| 文档性质 | 设计基线、实施合同和验收资料；Gateway Worker 以 15 号文档为唯一实施契约 |
| 当前实现状态 | `vm2api` 已有 `super_admin/admin/user/vendor` 登录角色、供应商层级、供应商门户、与门户一致的超管账号池和按范围的账号/VM/用量链路；超管五个入口与双边基础结算已落地。Gateway Worker 的 Node/Go 实施状态见 [18-gateway-worker-node-go-implementation.md](18-gateway-worker-node-go-implementation.md)，最终启用前仍需完成真实 OAuth、流式桥接和 Linux 验收 |
| 参考来源 | `/Users/luhonglin/Git/sub2api/docs/vendor-console/`、`/Users/luhonglin/Git/sub2api/docs/architecture-rebuild/`、`/Users/luhonglin/Git/sub2api/docs/ENGINEERING.md` 的 R01/R12/R13 |
| 目标角色 | 超级管理员 `super_admin`、管理员 `admin`、用户 `user`、供应商 `vendor` |
| 目标边界 | SA 独占平台 VM 与 Gateway Worker 运维并查看供应商账号池；AD 按现行管理域管理用户/管理员和消费数据，不能管理供应商；U 创建 Key 并查看自己的用量；供应商按主体 `tier=1/2` 创建被策略允许的 VM 或 Gateway Worker 账号并查看自己的用量；是否能创建下级由 `vendor.create_child` 控制 |

## 阅读顺序

1. [01-产品与角色模型](01-product-and-role-model.md)：定义身份、组织层级、资源边界和术语。
2. [02-权限矩阵与授权策略](02-permission-matrix.md)：定义角色、能力、字段和对象范围，以及下级供应商开户条件。
3. [03-领域模型与数据字典](03-domain-model.md)：定义核心实体、关系、状态和数据来源。
4. [04-接口与页面契约](04-api-and-portal-contract.md)：定义供应商门户、平台管理台和接口风格。
5. [05-业务流程与状态机](05-workflows-and-state-machines.md)：定义开户、资源运营、归档、结算和撤销流程。
6. [06-安全审计与隔离](06-security-audit-and-isolation.md)：定义认证、密钥、审计、敏感操作和数据隔离。
7. [07-实施拆分与验收计划](07-implementation-and-acceptance.md)：把设计拆成可交付工作包和最小验证集。
8. [08-资料索引与差距清单](08-source-index-and-gap-list.md)：记录现有代码证据、参考材料、目标差距和决策待办。
9. [09-菜单与角色规划](09-menu-and-role-plan.md)：当前导航与权限边界。
10. [10-超管平台移植记录](10-super-admin-platform.md)：上一轮实现与历史验证。
11. [11-完整需求复核](11-system-review-20261030.md)：历史复核、当前缺口和仍未实现清单。
12. [Gateway Worker 最终规划](15-gateway-worker-final-plan-20261101.md)：执行方式、共享 Worker 集群、API Key 分流、协议、账务和验收基线。
13. [Gateway Worker UI/UX 与业务交互](16-gateway-worker-ui-workflows.md)：沿 vm2api 现有布局的运营端、供应商端、账号表单和状态交互。
14. [Gateway Worker 技术实施、迁移与验收](17-gateway-worker-implementation.md)：数据迁移、内部协议、代码拆分、测试、发布和回滚。

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
  AUTHZ --> RES[账号 / 代理 / 分组 / VM / Gateway Worker / Key]
  RES --> EXEC[执行方式：VM 或 Gateway Worker]
  EXEC --> USAGE[用量事实]
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

本轮同时调整了普通面板的菜单和 SA/AD/U 授权边界，新增供应商角色、供应商开户流程、门户下级开户和供应商账号池；2026-10-30 已将旧服务提供商视图合并至账号池。Gateway Worker 只作为新的共享执行方式规划，不改变现有 VM 路径。

## 2026-10-29 超管后台已落地

新增五个超管供应商平台入口，与供应商门户共享主体、资源、请求用量和结算账单。现行实现、接口、清理及限制见 [超管供应商平台](10-super-admin-platform.md)。早期文档的待实现清单按该记录更新。

## 当前验收口径（2026-10-30）

本轮修复身份、范围、配对生命周期、授权终端与结算闭环的缺口；未实现项仍明确保留，不将规划表或上一轮截图视为完整系统验收。历史迁移及实际数据不改写，生产处置与部署仍单独授权。

## 2026-11-01 Gateway Worker 统一口径

- 账号创建时由供应商或超管代供应商选择被策略允许的执行方式：VM 或 Gateway Worker。
- Gateway Worker Server/Fleet 是共享运行容量，不是账号资源；账号不保存 Server/Fleet 绑定。
- API Key 只绑定分组；同一 Key 可以按模型和平台分别进入 VM 或 Gateway Worker。
- 供应商门户、超管账号池、用量、结算和权限布局继续沿用 vm2api；Worker 运维页只对超管或独立 ops capability 开放。
