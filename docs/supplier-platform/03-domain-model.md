# 领域模型与数据字典

更新于 2026-10-30。以下区分真实 SQLite 表与后续目标；原规划中的 resource_owners、settlement_lines 不能当作现有表。

## 当前实体与关系

| 实体 | 实际存储与关键字段 | 约束 |
| --- | --- | --- |
| 登录用户 | users：role/status/password_hash/deleted_at | 四种角色；供应商不等于层级 |
| 供应商 | vendors：tier/parent_id/root_id/status、groups_json/platforms_json、三个资源上限、policy_revision | 仅两层；archived 只读，历史保留 |
| 成员 | vendor_members：user_id/vendor_id/status/is_primary | 业务层拒绝管理员、无效用户和多主体有效绑定；下级开户必须独立新建登录 |
| 能力 | vendor_capabilities：capability/enabled/revision | 当前能力重新读取；目录预留项不代表已实现动作 |
| 账号与执行资源/代理 | accounts + vendor_resources + account_runtime：账号 owner、execution_kind、VM 可选映射；代理独立关联 | VM 账号保留配对 VM；Gateway Worker 账号不要求 VM，Server/Fleet 不进入商业 owner 关系 |
| VM 运行时 | vms JSON/文件：vendor_account_resource_id、运行/凭据/调度字段 | VM 创建者记录不替代 supplier owner；选号查 DB 归属和范围 |
| 代理池 | 统一池代理 + 065 vendor_id/vendor_resource_id 映射 | 供应商只绑定自己的代理；资源状态与池状态同步 |
| 价格版本/历史合同 | vendor_contracts：全局规则使用 payer_vendor_id/payee_vendor_id NULL、version/effective_at/group_prices_json/fx_cny_per_usdt；历史合同保留原 leg 和付款边 | 新规则全局共用；历史合同只读兼容首个全局生效日前的用量 |
| 请求事实 | vendor_usage_facts：vendor_id/resource_id/model/input_tokens/output_tokens/cost_usd/occurred_at/source_request_id | source_request_id 去重；当前只记录成功且已定价摘要 |
| 账单 | vendor_settlements：contract_id/payer_vendor_id/payee_vendor_id/period_start/period_end/status/amount_usdt/usage_snapshot_json | 付款边独立保存；价格版本、分段明细和金额冻结在快照中 |
| 付款记录 | vendor_payments：settlement_id/idempotency_key/amount_usdt/action/reason/actor_user_id | payment 已运行；reversal/adjustment 为预留枚举，业务未实现 |
| 审计 | vendor_audit_events：actor/vendor/action/resource/idempotency_key/payload/created_at | 不存凭据正文；尚无所有失败事件的完整前后快照 |

迁移实际来源：054_panel_role_names、056_supplier_platform、057_supplier_login_role、062_vendor_billing_profile、065_vendor_proxy_pool_metadata。保留已应用迁移；057_runtime_config_revision 是另一既有文件，不混为供应商角色迁移。本轮不新增或修改 Schema。

## 合同与金额

`USDT = 官方价 USD 用量 × 全局平台采购单价 CNY/USD ÷ 全局结算汇率 CNY/USDT`，输出 6 位小数，拒绝超出安全整数百万分单位的金额。价格版本只追加；每条用量按发生时间选择版本，单周期跨版本时按版本与平台自动拆分。已生成账单不随新价格重算。

预览 token 包含付款对象、周期、合同、汇总及账号明细；提交时重新计算，旧预览不能悄悄切换明细。已创建账单重试返回原记录，不按当前合同重算。平台付款和下游付款使用同一状态机，但授权分别判定。

## 当前状态

供应商：active / disabled / archived。资源：provisioning（内部 VM 预配）/ active / paused / archived，普通 PATCH 不接受伪造预配状态。账单：review → confirmed → partial → paid；零金额确认后 paid；未付款的 draft/review/confirmed 可 void。confirmed 是付款方审核，不表示收款方签收。disputed 枚举暂未接入流程。

## 2026-11-01 Gateway Worker 领域修订

账号与执行资源解耦：`accounts.execution_kind` 取值为 `vm` 或 `gateway_worker`。Gateway Worker 账号可以没有 `vm_resource_id`；它通过 `gateway_worker_servers` 的运行时选择执行。Fleet、Server、Drain、心跳和容量属于执行面，不属于供应商商业资源。

建议新增 `gateway_worker_fleets`、`gateway_worker_servers`、`gateway_worker_server_capabilities`、`gateway_worker_dispatch_leases`、`gateway_worker_receipts` 和 `gateway_worker_sessions`。usage_logs 和 vendor_usage_facts 增加 execution_kind、account_resource_id、worker_server_id、dispatch_id 和 attempt_id；历史 VM 日志继续保留 vm_id。

## 2026-11-01 状态字典补充

| 对象 | 目标状态 | 说明 |
| --- | --- | --- |
| Gateway Worker 账号 | draft / authorizing / ready / paused / error / archived | 不创建 VM；Server offline 不直接改变账号商业状态 |
| Worker Server | enrolling / healthy / draining / offline | draining 不接受新 Dispatch；恢复必须重新注册和上报能力 |
| Dispatch Lease | issued / accepted / prepared / sent / ambiguous / completed / failed / cancelled | sent 后不明只能进入 ambiguous，不自动重放 |
| Receipt | pending / applied / duplicate / conflict | 以 receipt_id + dispatch_id 幂等 |

现有 account_runtime.vm_id 为 VM 兼容字段；目标迁移允许 gateway_worker 账号为空，不能把 worker_server_id 写进 vm_id。历史 VM 迁移和账单保持不变。

## 后续模型需求

vendor_resource_grants 已有表但未形成完整分组供给授权链；通用 resource_owners 归一化、逐 usage_fact 的 settlement_lines、完整缓存/分组/价格版本/结算根快照和冲正引用仍待设计落地。Redis/PostgreSQL 不属于当前该域实现，不应作为已部署依赖写入文档。

新请求事实与日志同事务写入，但仍依赖日志开启；留存旧日志按映射补充查询，已有事实去重。历史已删除日志不可重建，普通日志重定价不回写冻结事实或账单。后续独立消费事件流与迟到补单见差距清单。
