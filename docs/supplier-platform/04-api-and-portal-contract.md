# 接口与页面契约

## 1. 接口分区

供应商接口、平台管理接口和终端用户接口应保持路径和中间件边界清晰：

| 分区 | 建议前缀 | 主要调用者 | 说明 |
|---|---|---|---|
| 用户/现有面板 | `/api/panel/*` | `super_admin/admin/user` | `vm2api` 普通面板；继续由 `panel-acl` 和 owner scope 控制 |
| 供应商业务 | `/api/vendor/*` | 一级/二级供应商 | 只返回供应商范围投影；不能依赖前端隐藏字段 |
| 平台供应商管理 | `/api/admin/vendors/*` | `super_admin` 及被委派管理 | 供应商准入、全局聚合、合同和审计 |
| 供应商门户静态入口 | `/vendor/*` | 浏览器 | 只承载页面；不直接连接数据库或 Redis |

当前普通面板编码为：`super_admin=SA`、`admin=AD`、`user=U`。供应商使用单一 `vendor` 登录角色，一级/二级由供应商主体 `tier` 表示。SA 才能进入 VM 创建和管理页面及服务提供商运营视图；AD 只显示用户管理、用户使用记录、数据统计和账单；U 显示 Key、自己的使用记录、统计和账单。供应商通过独立门户进入，不混入普通面板菜单。

如果沿用 `sub2api` 的 `/api/v1/vendor/*` 命名，应在 API 版本合同中固定，不要同时保留多个语义相同但权限不同的别名。

## 2. 供应商最小 API 清单

| 方法 | 路径 | 用途 | 主要权限 |
|---|---|---|---|
| GET | `/api/vendor/me` | 当前供应商、层级、能力和范围 | 所有有效供应商 |
| GET | `/api/vendor/vendors` | 自己和直属下级列表 | 一级 + `vendor.create_child` |
| POST | `/api/vendor/vendors` | 创建直属二级供应商 | 一级 + `vendor.create_child` |
| GET/PATCH | `/api/vendor/vendors/:id` | 供应商详情/允许字段更新 | 自己；一级更新直属下级的策略字段 |
| GET | `/api/vendor/accounts` | 账号列表 | 自有范围 |
| POST | `/api/vendor/accounts` | 按开放参数创建账号，并自动预配配对 VM | `vendor.resource.manage` + `vendor.vm.create` |
| GET | `/api/vendor/vms` | 查看配对 VM 列表 | `vendor.resource.manage` |
| GET/PATCH | `/api/vendor/vms/:id` | 自有 VM 详情和允许字段更新 | 当前供应商 owner；排除平台运维字段 |
| POST | `/api/vendor/vms/:id/start`、`/stop` | 自有 VM 生命周期 | 当前供应商 owner + 状态检查 |
| DELETE | `/api/vendor/vms/:id` | 排空/删除自有 VM | 当前供应商 owner；保留历史数据 |
| GET | `/api/vendor/vms/:id/usage` | 自有 VM 使用状况和统计 | 当前供应商 owner |
| POST | `/api/vendor/accounts/:id/pause` | 暂停账号 | 资源 owner |
| POST | `/api/vendor/accounts/:id/resume` | 恢复账号 | 资源 owner；仍受系统资格约束 |
| DELETE | `/api/vendor/accounts/:id` | 归档账号 | 资源 owner；不可物理删除历史 |
| GET | `/api/vendor/proxies` | 代理列表 | 自有范围 |
| POST/PATCH | `/api/vendor/proxies` | 新建/更新代理 | `vendor.resource.manage` |
| POST | `/api/vendor/proxies/:id/test` | 测试代理 | 资源 owner |
| GET | `/api/vendor/usage/summary` | 聚合用量 | 自有；一级可看下游聚合 |
| GET | `/api/vendor/usage/accounts` | 账号维度用量 | 自有范围；不返回其他 owner |
| GET | `/api/vendor/audit-logs` | 操作审计 | 当前供应商范围 |
| GET | `/api/vendor/settlements` | 上游应收列表（已实现只读） | 收款方 + `vendor.settlement.read` |
| GET | `/api/vendor/payables` | 下游应付列表（已实现只读） | 一级付款方 + 下级能力 + 结算读取能力 |
| POST | `/api/vendor/settlements/:id/confirm` | 收款确认 | 收款方 + 状态条件 |
| POST | `/api/vendor/settlements/:id/payments` | 付款登记 | 付款方 + step-up |

平台侧接口补充：

```text
GET/POST/PATCH /api/admin/vendors
GET           /api/admin/vendors/usage
GET/POST      /api/admin/vendors/settlements
GET           /api/admin/vendors/audit-logs
POST          /api/admin/vendors/identity-reconciliation
GET           /api/panel/providers
```

接口注册只说明路由存在；handler/service 仍必须执行角色、能力、对象范围、状态、字段和幂等检查。

供应商账号创建采用 `sub2api` 供应商平台的开户思路：前端只提交可选账号名称、授权方式、代理和分组；平台类型由授权方式推导，运行时、内核、语言、区域和机器规格采用系统默认值。后端在同一业务流程中创建账号资源、VM 资源和运行时 `vms/<id>.json`，绑定所选代理与分组，尝试自动启动，并通过 `runtime_vm_id` 建立映射。创建成功后直接进入对应 Claude/Codex 授权操作。供应商不能直接调用运营后台的 `/api/panel/vms/create`，`POST /api/vendor/vms` 固定返回 `account_creation_required`。

供应商门户接口已经注册在 `vm2api`：`/api/vendor/*` 和超级管理员的 `/api/admin/vendors/*`。创建 VM 必须先校验供应商 active、资源配额、账号/代理归属和平台授权；不得把宿主机终端、平台内核发布或任意文件操作暴露给供应商。供应商代理创建后同步到统一代理池，并写入供应商归属；供应商只能绑定自己的代理，运营超级管理员可以查看全量代理并按 `vendor_id`、`platform` 查询。运行时 VM 初始带 `no_credential`，创建流程会尝试自动启动；完成账号授权后再进入可调度生命周期。超级管理员通过 `/api/panel/providers` 查看全部服务提供商账号、授权状态、VM、额度窗口、重置时间、Token、消耗和调度信息。

## 3. 请求与响应约定

请求体只接受后端 DTO 定义的字段。响应采用稳定信封：

```json
{
  "ok": true,
  "data": {},
  "meta": { "request_id": "...", "policy_revision": 12 }
}
```

失败返回稳定 `code`、面向用户的 `message` 和可选 `details`：

```json
{
  "ok": false,
  "error": {
    "code": "parent_scope_violation",
    "message": "下级供应商的分组超出父级范围",
    "request_id": "..."
  }
}
```

分页、排序和时间范围必须在服务端校验；供应商用量的默认时区和金额精度写进 API 合同。列表响应只能返回当前角色的字段投影，不能先返回完整对象再由前端删除字段。

## 4. 供应商门户页面

| 页面 | 供应商可见内容 |
|---|---|
| `/vendor/dashboard` | 自有资源健康、用量摘要、待处理结算 |
| `/vendor/vendors` | 仅在 `/me.views` 含 `vendors` 时显示；一级且具备 `vendor.create_child` 才能创建直属二级供应商 |
| `/vendor/accounts` | 账号、配对 VM、授权状态、额度、暂停/恢复/归档；创建入口同时显示“创建账号并生成 VM” |
| `/vendor/proxies` | 代理状态、测试、绑定关系 |
| `/vendor/usage` | 按日期、模型、账号、下游供应商聚合的用量 |
| `/vendor/settlements` | 合同边、结算单、确认、付款登记、冲正历史 |
| `/vendor/audit-logs` | 自己范围的操作证据 |

前端导航由 `/me` 返回的 `views/capabilities` 投影控制：缺少 `vendor.create_child` 或非一级供应商时不渲染“供应商管理”和下游结算，供应商筛选仅显示自己；缺少结算读取能力时不渲染“结算”。每个 API 仍做后端校验。受限入口返回 API 真实的 401/403/409，不返回 SPA HTML 伪装成功。

## 5. 独立门户部署边界

门户容器只持有 `BACKEND_ORIGIN`、公开 origin 和受信代理配置；不持有数据库、Redis、JWT 签名或 TOTP 密钥。后端负责 JWT/session、MFA、范围过滤、审计、限流和业务状态。门户和后端应记录兼容版本，部署升级时先验证 API 契约再切换静态资源。

## 6. 与当前面板的兼容

当前文档 [PANEL_API.md](../PANEL_API.md) 仍是 `vm2api` 面板接口的现状合同。供应商平台落地后，不能将供应商接口直接复用成“admin 看全部、user 看自己”的旧分支；应新建 `vendor_scope`，并在所有供应商账号、代理、用量、账单查询中显式传入和校验供应商范围。

### 2026-10-29 本轮接口实测边界

本页前述 API 表含目标合同，不代表每个写接口均已实现。本轮供应商门户使用 `/vendor/accounts`、`/vendor/proxies`、`/vendor/vendors`、`/vendor/usage`、`/vendor/audit` 子页面；结算读取按能力开放。授权向导、导入导出、代理质量检测和结算写入仍待实现。资源 PATCH 只允许 name/status，不能变更内部 VM 映射。

### 最新界面决定：统一供应商管理

取消“下级供给”分组及独立二级账号池/二级代理页面。`/vendor/vendors` 统一显示“供应商管理”，仅一级且有 `vendor.create_child` 时可见。账号池和 IP 代理共同接受 `vendor_id`：省略或当前 id 为自己；`all` 为自己和直属下级；具体 id 必须是直属下级。跨树、二级查询父级、无能力查询下级均返回 403。下级资源行只读，后端写入仍校验 owner。门户将 `/vendor/settlements` 与 `/vendor/payables` 合并为“账单”：GET `/api/vendor/billing` 返回上游账单、一级供应商的下游账单和结算档案；一级供应商可 POST `/api/vendor/settlements` 创建直属下游周期结算。
