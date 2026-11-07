# 资料索引与现状差距

更新于 2026-10-30。以实际代码、当前测试与 [完整需求复核](11-system-review-20261030.md) 为准，取代旧文档中“没有 vendor 树/门户/合同”的过时描述。

## 已实现证据

| 需求 | 代码/数据入口 | 当前边界 |
| --- | --- | --- |
| 角色与登录 | admin/panel-acl.mjs、panel-users.mjs、迁移 054/057 | 单一 vendor 角色；管理员按管理域，不能操作供应商 |
| 供应商组织/成员/能力 | vendor/vendor-platform.mjs、迁移 056/062 | 两层树、独立成员、子集和配额、幂等开户；现有面板 session |
| 超管平台 | vendor/vendor-admin.mjs、features/supplier-admin、routes/_authenticated/suppliers | 五个入口；没有额外超管供给/审计/身份对账页面 |
| 供应商门户 | vendor/vendor-portal-view.mjs、features/vendor、routes/vendor | 自有与直属只读范围、账单与显式授权的下游付款 |
| 账号与执行资源 | vendor_resources、vendor-vm-provisioner.mjs、统一 proxy-pool、现有 accounts/account_runtime | 当前 VM 映射已存在；Gateway Worker 需要 execution_kind、独立 Server/Fleet、Dispatch Lease 和直接账号用量关联 |
| 运行时准入 | vendor-runtime-policy.mjs、vm-registry、codex-slot-pool | 当前资源/父级状态与范围在选号时复核；不以磁盘旗标替代 DB 事实 |
| 官方登录终端 | vm/slot-shell.mjs、assertVendorRuntimeVm | 固定 auth login、单次票据、权限复核；没有向供应商开放普通终端 |
| 用量与结算 | vendor-usage.mjs、UsageLogsRepo、vendor_contracts/settlements/payments | 记录时用量、留存旧日志、单合同周期快照、两边独立付款登记 |
| 审计 | vendor_audit_events | 有业务命令记录，尚无完整失败事件与 before/after 体系 |
| 缺陷用例 | vendor-review.test.mjs、vendor-review.e2e.test.mjs、slot-shell-rc.test.mjs | 具体输入、正常/拒绝/并发/回放边界见实施计划 |

以上路径以 `src/lib/`、`web/src/`、`test/unit/` 或 `test/e2e/` 为根。

## 参考来源

`holeenlu/sub2api@5804f679927b4101eccac18d96d0ca4dc15a626d` 的 `frontend/src/features/vendor`、`views/admin/VendorsView.vue`、`docs/vendor-console/API-ROUTES.md` 和 `backend/internal/server/routes/vendor.go`。API 注册、组件存在和实际权限分别审查；本项目按 Node/SQLite/React 适配，没有跨项目分支合并。

## 尚未完成的需求与建议顺序

| 优先级 | 差距 | 下一交付结果 |
| --- | --- | --- |
| P1 | 平台采购单价已进入合同；任意业务分组价格优先级与导出尚待完整落地 | 明确优先级与生效版本，统一两端预览/账单/导出，真实 DB 快照回归 |
| P1 | 消费事实依赖日志开关，历史失败/缓存事实保留仍待补全；现有详细日志指标及下游迟到补单已实现 | 独立消费事件、缺失检测、幂等补录/补单，禁止静默零费用 |
| P1 | 冲正、调整、收款确认/争议、结算导出 | 持久化可追溯流水、幂等引用、权限、历史快照及双方对账 |
| P1 | 多进程策略 CAS、异步 claim、预配失败补偿不完整 | 停用/归档/撤权与迟到回写竞争测试，文件/运行时半成品可恢复 |
| P1 | MFA/step-up 未接入 | 与会话、动作、对象绑定的短时验证，敏感动作统一执行 |
| P2 | 供应商门户侧代理诊断、代理批量导入/导出及更丰富的质量报告 | 延用运营后台的归属、脱敏、绑定同步和失败回滚契约；补齐门户入口及导入字段审计 |
| P2 | 批量账号导入预览/导出、授权撤销、额度主动刷新 | 复用现有 VM 底层能力但收紧允许字段，不直接开放超管接口 |
| P2 | 下级供应商自助编辑/停用 | 仅直属策略字段、范围不扩张，合同更新明确归属 |
| P2 | 超管审计、身份 reconciliation、供给明细、告警 | 清晰的数据来源、失败审计、差异报告和可审核修复命令 |
| P2 | 独立门户部署与版本协商 | 明确 origin/API 版本、反代权限、真实 Linux guest/KVM 验收 |

## 已决定的事项

供应商最多两级；create_child 是独立能力；供应商复用现有面板 session；普通管理员无供应商权限；付款只登记线下事实；平台与一级、一级与二级是独立付款边；归档保留历史；本轮不迁移生产数据。不要再把这些写为“实施前待确认”。

仍需设计的不是是否有供应商平台，而是分组价格优先级、冲正/调整细则、独立门户部署契约和异步恢复机制。现有实现限制不能自动充当这些设计的最终需求。

## 并行实现状态

账号池结构、统一双端组件、供应商端隐藏冗余供应商列、账号名称复制、按操作列打开统一详情侧栏、状态筛选区分授权撤销/归档异常与暂停调度停用、代理combobox、按平台授权/分组/VM、VM/Worker 执行方式、统一 VM 配置及自动命名、简化供应商表单、移除操作记录、完整详情/用量/编辑/删除和下游结算工作台均已纳入本次交付。复用了现有权限/状态/账务回归；详细证据及尚未执行的真实Linux/OAuth验收见 CUSTOMIZATION_IMPLEMENTATION_RECORD.md 最新章节。


## 2026-11-01 Gateway Worker 来源快照

vm2api 当前代码树为 v1.4.030 定制主线，sub2api/NewAPI 复核快照为 5804f679927b4101eccac18d96d0ca4dc15a626d。15 号文档是 Gateway Worker 的唯一目标契约；本页的差距表只表示未实现项，不表示已注册接口或已部署 Worker。

## 2026-11-01 Gateway Worker 差距清单

| 优先级 | 缺口 | 实施要求 |
|---|---|---|
| P0 | 账号创建仍强制配对 VM | 增加 execution_kind；Worker 账号不创建 VM；保留 VM 兼容路径 |
| P0 | 分组只支持 VM/API endpoint | 增加 gateway_worker_account，分组不授权 Fleet/Server |
| P0 | 没有外部 Worker 注册和 Dispatch | NewAPI 增加独立 Worker Composition Root 和内部协议 |
| P1 | 用量按 vm_id 反查供应商账号 | usage/request attempt 增加 account_resource_id、execution_kind、worker_server_id、dispatch_id |
| P1 | 供应商没有平台级执行方式策略 | 增加 vendor execution policy，区分 allow_create 和 allow_runtime |
| P1 | 没有 Server 容量与 Drain | 增加心跳、能力、容量、排空、版本和故障摘除 |
| P2 | 跨 Server 会话亲和和滚动升级 | 以 session lease 实现，不增加账号永久 Server 绑定 |

NewAPI 当前账号调度和账号容量是参考事实，不是外部 Worker Server API。实现不能把内部 UsageWorker 当成 Gateway Worker。
