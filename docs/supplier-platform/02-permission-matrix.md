# 权限矩阵与授权策略

更新于 2026-10-30。当前行为见下表；未来的字段委派和 step-up 不得写成已实现。复核缺陷与用例见 [完整复核](11-system-review-20261030.md)。

## 当前权限矩阵

| 能力 | super_admin | admin / user | 一级供应商 | 二级供应商 |
| --- | --- | --- | --- | --- |
| 超管供应商五个后台入口 | 允许 | 禁止 | 禁止 | 禁止 |
| 新建/配置一级供应商 | 允许 | 禁止 | 禁止 | 禁止 |
| 新建二级供应商登录 | 通过供应商业务流程治理 | 禁止 | active + create_child，仅新建独立账号 | 禁止 |
| 自有账号/配对 VM/代理 | 全量管理 | 禁止 | resource.manage；开户另需 vm.create | 同左，范围仅自己 |
| 直属下级资源/用量/审计 | 全量 | 禁止 | create_child；只读，不等于写权限 | 禁止 |
| 个人消费 Key/账单 | 按普通面板契约 | 管理员按管理域；用户本人 | 供应商门户不授予普通用户消费管理权限 | 同左 |
| 平台→一级结算 | 平台付款方管理 | 禁止 | 自己收款边只读 | 不可见其他主体 |
| 一级→二级结算 | 只读，不代付 | 禁止 | create_child + settlement.read 可预览生成；另需 settlement.pay 才可确认/登记/作废 | 自己收款边只读 |
| 官方授权终端 | 保留原运维能力 | 禁止 | 自有未归档资源，仅固定 auth login | 同左 |
| 普通交互 shell、平台集群/内核/数据库 | 原超管权限 | 禁止 | 禁止 | 禁止 |
| 完整凭据导出、退款冲正、争议 | 无本轮供应商专用实现 | 禁止 | 未实现 | 未实现 |

`vendor.resource.export`、`vendor.settlement.confirm` 在能力目录中属于预留能力，不代表存在导出或收款确认接口。`vendor.settlement.pay` 默认不授予，超管在供应商编辑页显式开启“允许登记下游付款”。

账号池“导出所选账号”是现有 `vendor.resource.manage` 工作台对可管理账号的列表摘要 CSV 下载，使用已授权读取的展示数据，不含授权令牌、代理认证或可重导入的账号材料；不等同于预留的凭据导出/step-up 能力。父级聚合可见的子级账号不可选，超管按管理范围选择。暂停/恢复所选账号逐条调用原状态接口，每条均重新校验权限和归属；部分失败单独报告。

## 判定顺序

认证 → 角色 → 当前成员/用户状态 → 当前供应商及父级状态 → capability → 资源 owner/合同付款边 → 字段/状态 → 幂等/事务。读取请求体后再次使用领域服务时会重读身份和能力，不把最初的身份快照当作最终授权。

一级读取下级必须有 create_child；没有能力时汇总和审计只返回自己。父级业务写入不允许修改子级资源；下游付款是明确独立的付款边权限。超管后台可以选择现有未绑定普通账号，供应商开户不得传 user_id 绑定他人。

## 范围与状态

根供应商空平台/分组表示沿用平台默认允许范围；新子级空选择继承父级，旧子级空值也受当前父级范围限制。平台别名在开户时规范化，账号平台、分组与代理均须属于允许范围；供应商和直属下级资源共同占用父级额度。0 上限表示不限，有限父级不能被子级的“0”绕过。

账号与配对 VM 同步暂停/恢复/归档，归档不可普通恢复。供应商暂停独立于操作员停调，恢复不清除凭据错误或其他保护。Claude/Codex 选号再查当前供应商资源与父级策略，权限撤销不依赖更新全部磁盘记录成功。

## 字段和失败码

列表/详情不返回 token、代理密码或上游原始错误；供应商账单只返回自己相关的合同边及脱敏用量。代理端点移除用户名/密码，密钥按既有数据库密钥配置保存；不保证未配置密钥时已有明文会自动加密。

常见拒绝码：`vendor_forbidden`、`vendor_inactive`、`capability_required`、`vendor_scope_forbidden`、`member_binding_forbidden`、`capability_scope_forbidden`、`parent_scope_violation`、`quota_exceeds_parent`、`resource_limit_exceeded`、`resource_archived`、`idempotency_conflict`、`settlement_payer_scope`。`stale_policy_revision` 是未来 CAS 计划，当前不能宣称已返回该错误。

## 尚未实现的策略层

通用 subject_scope/resource_scope/field_mask 委派、MFA/step-up、跨进程 expected_revision 和全任务 claim/nonce 仍待实现。它们不是现有 SQLite 表中已经运行的统一权限引擎。原有管理域权限由普通面板实现，不能借这些规划向 admin 放开供应商入口。
