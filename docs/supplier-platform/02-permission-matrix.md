# 权限矩阵与授权策略

## 1. 授权判定公式

每次请求按以下顺序判定，不以前端按钮或单个角色字符串代替：

```text
allow = authenticated
     && session_not_revoked
     && role_policy_allows(action)
     && subject_scope_contains(target)
     && resource_state_allows(action)
     && field_policy_allows(requested_fields)
     && step_up_satisfied_for_sensitive_action
```

供应商请求额外执行 `vendor_scope`：当前供应商必须有效，目标资源的 `vendor_id` 必须是自己，或在一级供应商允许的直属二级只读聚合范围内；普通写操作不因聚合范围而放宽。

## 2. 高层权限矩阵

| 能力域 | 超级管理员 | 管理员 | 用户 | 一级供应商 | 二级供应商 |
|---|---:|---:|---:|---:|---:|
| 平台策略、角色和能力目录 | 全部 | 无 | 无 | 无 | 无 |
| 普通用户开户与管理 | 全部 | 全部 U | 无 | 无 | 无 |
| 一级供应商开户 | 全部 | 无 | 无 | 无 | 无 |
| 二级供应商开户 | 全部 | 默认无 | 无 | 仅 `vendor.create_child` 且直属 | 无 |
| 平台 VM 创建、删除、重建、分配和调度 | 全部 | 无 | 无 | 无 | 无 |
| 供应商账号/VM 创建、运营和统计 | 全部 | 无 | 无 | 自己的账号/VM | 自己的账号/VM |
| 自有账号、授权、代理和 VM | 全部 | 无 | 无 | 自己 | 自己 |
| 下级供应商资源 | 全部 | 无 | 无 | 只读聚合；不直接写 | 无 |
| 用户使用记录、统计和账单 | 全部 | 全部 U | 自己 | 自己与授权下游 | 自己 |
| 合同与结算 | 全部 | 无 | 个人账单 | 自己相关合同边 | 自己相关合同边 |
| 凭据完整导出 | step-up + 审计 | 默认禁止 | 禁止 | step-up + 自有范围 | step-up + 自有范围 |
| 平台池调度与系统运维 | 全部 | 禁止 | 禁止 | 禁止 | 禁止 |

## 3. 资源范围矩阵

| 资源 | 用户 | 一级供应商 | 二级供应商 | 管理员 | 超级管理员 |
|---|---|---|---|---|---|
| `vendor` | 无 | 自己；直属 child 的有限字段 | 自己 | 无 | 全部 |
| `upstream_account` | 无直接管理 | 自己 | 自己 | 无 | 全部 |
| `proxy` | 无直接管理 | 自己 | 自己 | 无 | 全部 |
| `group_supply` | 只读自身能力 | 自己及直属汇总 | 自己 | 无 | 全部 |
| `usage_log` | 自己 owner | 自己 vendor；下游仅聚合 | 自己 vendor | 全部 U | 全部 |
| `contract` | 无 | 作为 payer/payee 的合同 | 作为 payee 的合同 | 无 | 全部 |
| `settlement` | 个人账单投影 | 自己相关边 | 自己收款边 | 无 | 全部 |

## 4. 动作级策略

动作命名使用 `resource.action`，例如：

```text
vendor.read
vendor.create
vendor.update
vendor.create_child
vendor.disable
vendor.resource.manage
vendor.resource.export
vendor.usage.read
vendor.settlement.confirm
vendor.settlement.pay
admin.user.manage
admin.policy.delegate
```

授权策略记录：

| 字段 | 含义 |
|---|---|
| `grantee_type/id` | 被授予的用户、角色或供应商 |
| `permission` | 动作名 |
| `subject_scope` | 可作用的用户/供应商/组织范围 |
| `resource_scope` | 可作用的资源集合或标签 |
| `field_mask` | 可读取或写入的字段集合 |
| `conditions` | step-up、IP、时间、状态等条件 |
| `revision` | 并发更新和缓存失效版本 |
| `expires_at` | 委派有效期 |
| `created_by` | 授权人；超级管理员或有能力的上级管理员 |

## 5. 敏感字段策略

默认返回脱敏投影；只有明确能力并满足 step-up 才能读取敏感值：

| 字段类别 | 默认行为 | 允许者 |
|---|---|---|
| 密码、refresh token、setup token、Cookie | 永不出现在列表；详情也只返回状态摘要 | 业务服务内部；必要导出按专门流程生成 |
| 代理用户名/密码 | 列表隐藏；绑定和测试只返回结果 | 自有资源的授权角色，按字段能力 |
| 上游原始错误 | 显示稳定错误分类和 request id | 超级管理员及被授予诊断字段的管理员；供应商看脱敏分类 |
| 账单原始成本和合同价 | 供应商只看自己合同边 | 超级管理员、合同相关方的允许字段 |
| 用户个人资料 | 仅 owner 或授权管理范围 | 超级管理员、授权管理员、本人 |

## 6. 供应商创建下级的失败码

后端应稳定返回可翻译的错误码，而不是让前端解析文案：

| 错误码 | 条件 |
|---|---|
| `forbidden` | 角色、能力或对象范围不满足 |
| `vendor_inactive` | 当前供应商或父级不是 active |
| `child_limit_exceeded` | 超过 `child_limit` |
| `invalid_vendor_tier` | 请求试图创建非直属二级 |
| `parent_scope_violation` | groups/platforms 超出父级 |
| `parent_limit_violation` | account/proxy limit 超过父级 |
| `duplicate_vendor_identity` | 邮箱、用户名或外部编码重复 |
| `stale_policy_revision` | 授权策略版本过期，要求刷新后重试 |

## 7. 与 `vm2api` 现状的兼容说明

当前代码在 `src/lib/admin/panel-acl.mjs` 中提供 `super_admin/admin/user` 的页面和能力裁剪。旧数据库值 `admin/super/user` 通过迁移转换为 `super_admin/admin/user`。`src/lib/admin/resource-owner.mjs` 继续按 owner/origin 隔离资源；目标供应商策略应新增独立的 `vendor_scope` 和资源 owner 维度，不能把所有供应商塞进当前 `user` 的 owner filter，也不能把 AD 当成超级管理员。
