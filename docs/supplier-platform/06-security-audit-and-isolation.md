# 安全、审计与隔离

## 1. 信任边界

浏览器、CLI、供应商门户、管理 API、模型 API、支付回调和设备导入都视为不可信输入。以下凭据分离：

| 凭据 | 用途 | 不能替代 |
|---|---|---|
| 面板 session | 现有 `vm2api` 面板 | 模型 API Key、供应商 JWT |
| 供应商 session/JWT | 供应商门户和供应商 API | 平台超级管理员会话 |
| 模型 API Key | `/v1/*` 请求 | 面板或供应商管理 API |
| 管理访问密钥 | 受限机器管理调用 | 用户 Key、超级管理员 JWT |
| 上游 OAuth/setup token | 具体上游账号出站 | 任意供应商或平台身份 |

门户不直接访问 PostgreSQL/Redis；设备导入工具不成为服务器后台 worker；供应商账号不因共享网关接口而获得平台管理权限。

## 2. 登录与会话

- 密码沿用安全哈希，登录失败不泄露账号是否存在。
- session/JWT 绑定 `user_id`、角色、供应商成员、policy revision 和认证时间。
- 停用账号、移除成员、角色下降和能力撤销必须使当前会话立即失效，或在每次请求按 revision 拒绝。
- 导出、付款、授权撤销、批量删除和合同调整需 step-up；step-up 结果绑定操作、主体、目标和短有效期。
- 供应商门户跨源调用只信任显式 origin；不允许任意 Origin 携带凭据。

## 3. 审计事件

每个敏感命令至少记录：

```text
event_id, request_id, actor_user_id, actor_role, vendor_id,
action, target_type, target_id, before_projection, after_projection,
policy_revision, ip, user_agent, reason, result, created_at
```

凭据明文、完整 token、密码、代理密码和模型请求正文不进入普通审计。导出事件记录导出字段、数量、过滤条件、step-up 时间和下载结果；必要的受控文件使用短时签名和一次性消费。

## 4. 数据隔离检查表

每个查询和命令都要回答：

1. actor 当前身份是谁？
2. actor 的平台角色、供应商成员和当前 policy revision 是什么？
3. target resource 的 owner、vendor、root 和状态是什么？
4. 当前请求是自有、直属聚合、委派范围还是平台范围？
5. 是否需要字段能力或 step-up？
6. 异步执行前是否重新检查授权和 revision？
7. 写入是否带幂等键和审计事件？

## 5. 供应商越权反例

| 反例 | 正确结果 |
|---|---|
| 一级供应商把 `parent_id` 改成其他树 | 403 `forbidden`，不写入 |
| 一级供应商创建第三层供应商 | 400 `invalid_vendor_tier` |
| 二级供应商读取兄弟账号明细 | 404 或 403，不能用存在性差异泄露数据 |
| 一级供应商把子级 groups 扩大到自身之外 | 409 `parent_scope_violation` |
| 供应商导出其他供应商 token | 403，审计失败事件 |
| 前端隐藏“创建下级”按钮但直接调用接口 | 后端仍按 `vendor.create_child` 拒绝 |
| 旧异步任务在供应商停用后恢复资源 | revision/claim 失效，拒绝提交 |
| 通过当前合同重算历史账 | 使用结算行冻结的合同版本 |

## 6. 观测与告警

至少观测：供应商登录失败、权限拒绝、策略版本冲突、跨树访问尝试、批量导出、凭据撤销、结算重复提交、付款冲正、异步旧 claim、供应商资源被系统自动禁调度。日志脱敏，指标按供应商聚合时不能把个人资料或凭据作为 label。
