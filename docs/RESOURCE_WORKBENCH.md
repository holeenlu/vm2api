# 账号资源统一管理（虚拟机 / Codex 账号 / 供应商账号池）

制定日期：2026-11-05。适用于面板「供应商平台 → 账号池」「资源管理 → 虚拟机」「资源管理 → Codex 账号」三个入口，以及它们背后的数据、凭证与权限。

## 1. 用户决定（2026-11-05）

| 主题 | 决定 |
| --- | --- |
| 页面形态 | 统一工作台，保留三个入口；入口只是预设过滤，排版、样式、内容与交互一致 |
| 权限主体 | 「查看 / 创建 / 编辑 / 管理」四项能力按用户勾选授予，存库，经 `/me` 下发，前后端统一校验 |
| 创建者 | 不因创建获得编辑权；能否修改只看能力与供应商归属（`created_by` 仍只做审计） |
| 凭证 | 合并重复的凭证写入路径；凭证默认脱敏，明文查看与导出只给「管理」 |

## 2. 数据模型（现状，作为统一依据）

- 供应商账号与 Codex（Gateway）账号是同一张 `vendor_resources` 表的 `account` 行；Codex 账号 `config.execution_kind='gateway_worker'`，平台自有时 `vendor_id IS NULL`。
- VM 的事实源是 `vms/<id>.json`；供应商的 VM 型账号由一对 `account` / `vm` 资源行与 VM 关联（`config.vm_resource_id`、`runtime_vm_id`、VM JSON 的 `vendor_account_resource_id`）。
- 因此三个入口看的是同一批资源的不同切片：

| 入口 | 类型 | 归属 |
| --- | --- | --- |
| 资源管理 → 虚拟机 | VM | 全部（平台 + 各供应商） |
| 资源管理 → Codex 账号 | Gateway 账号 | 全部（平台 + 各供应商） |
| 供应商平台 → 账号池 | VM + Gateway 账号 | 仅供应商自有，可按供应商筛选 |

同一条资源无论从哪个入口修改，都走同一套规则：

- 供应商自有资源统一校验供应商及父级为启用状态（`assertVendorOwnedWritable` → `requireActive`，否则 409 `vendor_inactive`）；平台自有资源不受供应商规则约束。
- 账号池接口的可改字段白名单（名称、备注、分组、代理、状态，`VENDOR_ACCOUNT_PATCH_FIELDS`）约束的是供应商身份；平台运营在虚拟机、Codex 账号入口仍可调整并发、权重等调度参数，VM 与 Gateway 账号一致。
- 供应商写的账号备注统一存 `config.vendor_notes`（门户展示读这里）；Gateway 账号此前误写到运营备注 `config.notes`，已改正，运营备注不再被覆盖。

## 3. 权限模型

实现：`src/lib/admin/resource-permissions.mjs`（能力、隐含关系、路由映射），`users.resource_permissions`（迁移 114，JSON 数组）。

| 能力 | 范围 | 隐含 |
| --- | --- | --- |
| `resources.read` 查看 | 三个入口、列表、详情、用量、额度；凭证只显示状态、过期时间与掩码 | — |
| `resources.create` 创建 | 新建 VM、导入 VM 凭证、新建或导入 Codex 账号、新建供应商账号 | 查看 |
| `resources.edit` 编辑 | 修改配置、分组、代理、调度、暂停恢复、测试、刷新额度、诊断恢复、重新授权或替换凭证、批量编辑 | 查看 |
| `resources.manage` 管理 | 删除 / 归档、重建、修改归属供应商、终端、打包导出、凭证明文查看与导出、全舰队操作 | 编辑、查看 |

- `super_admin` 天然拥有全部能力；`admin` 只拥有被授予的能力；`user`、`vendor` 永远没有。供应商门户继续使用 `vendor.resource.manage`，不受本模型影响。
- 只有 `super_admin` 能授予或撤销；只对 `admin` 角色生效，角色改离 `admin` 时授予记录清空。
- `/me` 与登录响应新增 `resource_permissions`；拥有查看能力时 `views` 追加 `vm`、`codex-accounts`、`supplier-accounts`，`capabilities` 追加对应能力。供应商平台其余页面（供应商、代理、用量、定价、结算）仍只属于 `super_admin`。
- 路由校验顺序：认证 → 角色 → `resourceRouteRequirement(method, path)` → 处理函数内的字段级要求（改归属、归档、凭证明文需要「管理」）→ 供应商归属与状态。前端隐藏不构成安全边界。
- 取代：`vm_create_quota`（迁移 019 起始终为 0、无读取方）从 `/me` 移除；数据库列保留，不改写历史迁移。前端 `vmPermsFor(role)` 按角色猜权限的做法由服务端下发的能力取代。

## 4. 凭证统一

- Claude 粘贴解析：`src/lib/oauth/credential-paste.mjs` 的 `classifyClaudePaste` / `sessionKeyOauth`，VM 导入与供应商草稿共用；供应商草稿因此也识别 sub2api 导出、console 型 API Key，并为 Setup Token 型 sessionKey 标记类型。
- Codex JSON 与 RT 换 AT：VM 导入与供应商 VM 草稿共用 `resolveCodexPaste`；Gateway 账号的换票由 Worker 托管完成，统一在 `GatewayAccountManagement.import`。
- OAuth 生成与换码：VM 与供应商非 Gateway 草稿本就共用同一组库函数（差别只是执行环境），保持不变；供应商草稿里重复实现的 Gateway 分支已删除，改走 Codex 草稿流程（`start` / `complete`），一并获得控制面会话、state 校验与凭证版本下限。
- Gateway 账号落库、更新与归档：只由 `GatewayAccountManagement`（`createDraft` 的 `owner`、`saveAuthorized`、`update`）实现；供应商层先做策略检查（启用状态、`allow_create` / `allow_runtime`、分组与代理归属、字段），再委托写入。`secret_json` 只写一次，绑定只经投影写入；运行账号名统一为 `gwacct_<资源 ID>`（仅影响新建账号）。
- 显示分级：查看与编辑只得到状态（是否已授权、类型、过期时间、最近错误、掩码标识）；编辑可以重新授权或替换，但读不到已存凭证的明文；只有管理能读取 `GET /api/panel/vms/:id/oauth/credential` 的 `export` 字段、调用 `POST /api/panel/codex-accounts/export`、打开终端或导出打包。

## 5. 统一工作台

- 三个路由渲染同一个 `ResourceWorkbench`（`web/src/features/resources/`），`preset` 只决定数据范围：`vm` 读 `/api/panel/vms`，`codex` 读 `/api/panel/codex-accounts`，`supplier` 合并两者并只保留 `vendor_id` 非空的行。标题、描述、概览（FleetPulse）、工具栏、筛选栏、机柜 / 表格、详情卡、凭证弹窗、批量编辑 / 批量删除和空态一致。供应商与分组两项筛选与状态、授权方式、调度、创建时间、故障分布同在筛选栏（`account-filter-bar.tsx` 的 `leading`），由「重置」一并清空。
- 账号池混排 VM 与 Gateway 账号，操作上下文按行解析（`VmActions.resolve`）：VM 行走 VM 接口，Gateway 行走 Codex 账号接口；批量编辑要求同一类型，混选时给出提示。批量删除不受此限制，逐行走各自的删除接口。新建供应商账号仍使用供应商账号创建表单（`POST /api/admin/vendors/accounts`），归属供应商默认取当前筛选。
- 基座采用 VM 的机柜 / 表格骨架（源自上游，Codex 页已复用）；账号池不再使用 `features/vendor/account-workbench.tsx` 的管理员模式。供应商门户仍使用该组件的供应商模式。
- 按钮、字段、页签按 `resource_permissions` 显示：无创建能力不显示新建 / 导入；无编辑能力时编辑入口隐藏、表单只读；无管理能力时删除、重建、终端、导出、明文凭证与归属选择隐藏。

## 6. 归档与永久删除（2026-11-06）

用户决定：保留可逆的**归档**（「显示归档」可见），另加与上游 VM 删除同一原则的**永久删除**，三个入口一致；两者都需要「管理」。

| 操作 | VM | Codex（Gateway）账号 | 账号池账号 |
| --- | --- | --- | --- |
| 归档（可逆） | — | `PATCH /api/panel/codex-accounts/:id` `{status:'archived'}` | `PATCH /api/admin/vendors/accounts/:id` `{status:'archived'}`；供应商门户 `DELETE /api/vendor/accounts/:id` 仍为归档 |
| 永久删除 | `DELETE /api/panel/vms/:id` | `DELETE /api/panel/codex-accounts/:id` | `DELETE /api/admin/vendors/accounts/:id` |

- 上游原则（`DELETE /api/panel/vms/:id`）：校验 ID、不存在 404；活跃槽且还有其他槽位时 409「先切换活跃槽」；集群节点销毁失败 409 并保留一切；只解除本 VM 的代理绑定；删除运行目录（凭据）与记录、失效缓存、移除定时测试、清活跃指针、删 DB 镜像行与分组 / 池成员、删旁路文件。实现为 `panel-routes.mjs` 的 `removeRuntimeVm`，VM 页删除、账号池删除 VM 型账号、供应商账号归档销毁 VM 三处共用。
- 供应商自有资源统一要求供应商及父级启用（`vendor_inactive`），平台自有不受约束。从 VM 页删除供应商 VM 后，其账号 / 虚拟机资源对一并写成墓碑（`retireVendorVmPair`）。
- Gateway 账号（`GatewayAccountManagement.remove`）：一个事务内清空分组、删除凭据库各授权类别记录与刷新租约、作废 OAuth 会话、写墓碑并审计；随后丢弃内存中的重新授权草稿，逐实例调用 Worker `DELETE /internal/v1/accounts/:id`（`account-removal.mjs`）。Worker 删除或明确回答 `account_not_found` 后去掉该实例绑定；不可达时绑定留作待删除（`drifted` / `pending_delete`，执行时排除该账号），由心跳投影 `removeDeletedAccount` 补删，心跳回报已无该账号时直接去掉绑定；不支持删除的旧版 Worker（405）先停用并清空分组与代理，升级后补删。
- 墓碑（迁移 118 `vendor_resources.deleted_at`）：`vendor_resources` 被结算事实、授权、OAuth 会话、投影绑定与响应归属引用，不物理删行。删除时状态置为 `archived`、写 `deleted_at`，清空 `secret_json`、`external_id`（释放幂等键，可重新开户；`gw-NN` 编号不复用）与配置里的代理字段（BPS 授权字段已随 BPS 下线由迁移 133 整体删除），保留 `runtime_vm_id`、`vm_resource_id` 等关联。不变量：墓碑的状态一定是 `archived`，已按 `status<>'archived'` 过滤的查询天然排除墓碑；会列出归档行或没有状态条件的查找显式加 `deleted_at IS NULL`（`listCodexAccounts`、`getResource`、`listResourcesByVendors`、`listAdminResources`、`getVendorVmResource`、`getResourceVendorByType`、`getVendorResourceConfig`、运行时 VM 归属查找、门户配对 VM、调度准入）。`listProjectableAccounts` 只在仍有待删除绑定时带出墓碑。结算、用量与请求日志的名称解析不过滤，历史照常显示。
- 数据处置：墓碑行与历史用量保留，不做物理清除；需要彻底清除另行授权。
- 前端：工作台与 Codex 账号详情页在归档旁提供「删除」（`vm-danger-dialogs.tsx`），弹窗二次确认即可，不要求输入 ID（与 VM 详情页的删除一致；输入 ID 只保留给重建）。文案说明不可恢复、会删除凭据、可逆下线请用归档。
- 批量删除（2026-11-07）：选择工具条在「批量编辑」旁提供「批量删除」，需要「管理」；三个入口一致。不新增批量接口，`bulk-delete-model.ts` 排好顺序后逐条调用上面表里的单条删除接口，权限、审计与清理与单条删除完全相同；一条失败不影响其余，失败项留在对话框里保持勾选，可直接重试。活跃槽位（`active.json`）排到最后删，接管候选只在本次不删的槽位里挑，没有候选时跳过它并在确认框里列出。已归档账号可以勾选并批量删除，但不能批量编辑（勾选时给出提示）。
