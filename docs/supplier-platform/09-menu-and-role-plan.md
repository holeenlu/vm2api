# 菜单信息架构与角色职责

更新于 2026-10-30。角色、菜单和接口以当前代码为准，后续完整功能状态见 [复核矩阵](11-system-review-20261030.md)。

## 登录角色与边界

- `super_admin`：平台与供应商治理，供应商后台五个入口及平台付款边。
- `admin`：按超级管理员直属根管理员划分的管理域，可创建下级管理员和普通用户、管理本域消费数据；不能管理超管、供应商和平台基础设施。管理员归属与共享域钱包按现行 RELAY_OPERATIONS 契约。
- `user`：自己的 Key、消费记录、统计、账单与允许目录，不创建 VM。
- `vendor`：绑定供应商主体，一级/二级由 vendors.tier 决定，不再拆登录角色。自有资源与直属聚合、付款边分别校验。

角色命名迁移 054 将旧 admin/super 转为 super_admin/admin，057_supplier_login_role 将有效供应商成员统一为 vendor。用户 ID、历史归属和账务不因此改写。

## 超管侧栏

| 分组 | 菜单顺序 | 路由 |
| --- | --- | --- |
| 运营管理 | 总览 → 统计 → 使用记录 → 用户 → API 密钥 → 充值记录 | /overview、/statistics、/logs、/users、/keys、/billing |
| 供应商平台 | 供应商管理 → 账号池 → 代理管理 → 用量统计 → 结算对账 | /suppliers/suppliers、accounts、proxies、usage、settlements |
| 资源管理 | 分组、集群、虚拟机、导入、规格、代理池 | 沿用原资源页面 |
| 系统管理 | 模型、上游 API、Anthropic、风险审计、系统提示词、设置、内核、数据库 | 沿用原系统页面 |

suppliers capability 仅授予超管；普通面板按 `/api/panel/me.views` 裁剪。供应商门户不混入超管侧栏。供应商账号统一在账号池展示，不显示平台自建资源；重复的服务提供商入口已移除。

## 供应商门户

| 入口 | 范围/能力 |
| --- | --- |
| /vendor/accounts | 自有账号、配对 VM 与授权；父级可按 create_child 只读筛选直属资源 |
| /vendor/proxies | 自有代理；允许的直属范围只读 |
| /vendor/vendors | 一级且有 create_child，创建独立下级登录；不能指定已有 user_id |
| /vendor/usage | usage.read，自有或明确允许的直属汇总 |
| /vendor/billing | settlement.read；上游账单、允许的下游账单；一级可预览生成，另有 settlement.pay 才显示确认/付款登记/作废 |
| /vendor/audit（已退役） | 自己的业务审计；有 create_child 才能读取直属聚合 |

超管编辑页显式开启“允许登记下游付款”；默认不开。父级看到子级资源不代表可以代修改。供应商授权终端仅固定官方登录程序，不提供普通交互 shell。

## 导航与身份行为

后端 views 控制侧栏、搜索和路由进入检查；无权限深链接回到允许页，接口仍单独拒绝。默认入口保持超管 overview、管理员 users、普通用户 keys、供应商 vendor。工作台保持移除，个人资料位于唯一右上角账号入口。

权限/成员变更在请求中重新读取；前端轮询只是更新展示，不承担安全判定。菜单不存在的规划功能不能通过手工 URL 获取权限。

## 升级与验收边界

本轮无 Schema 迁移，不改已应用历史迁移或生产数据。代码发布/推送不等于运行网站更新，也不授权本机容器替换、生产部署或数据迁移。真实部署与 Linux guest/KVM 授权验收需要单独证据。
