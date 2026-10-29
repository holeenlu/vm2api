# 领域模型与数据字典

更新于 2026-10-30。以下区分真实 SQLite 表与后续目标；原规划中的 resource_owners、settlement_lines 不能当作现有表。

## 当前实体与关系

| 实体 | 实际存储与关键字段 | 约束 |
| --- | --- | --- |
| 登录用户 | users：role/status/password_hash/deleted_at | 四种角色；供应商不等于层级 |
| 供应商 | vendors：tier/parent_id/root_id/status、groups_json/platforms_json、三个资源上限、policy_revision | 仅两层；archived 只读，历史保留 |
| 成员 | vendor_members：user_id/vendor_id/status/is_primary | 业务层拒绝管理员、无效用户和多主体有效绑定；下级开户必须独立新建登录 |
| 能力 | vendor_capabilities：capability/enabled/revision | 当前能力重新读取；目录预留项不代表已实现动作 |
| 账号/VM/代理 | vendor_resources：resource_type/vendor_id/status/config_json/secret_json | 单一 owner；账号↔VM 双向映射；归档、暂停成对同步 |
| VM 运行时 | vms JSON/文件：vendor_account_resource_id、运行/凭据/调度字段 | VM 创建者记录不替代 supplier owner；选号查 DB 归属和范围 |
| 代理池 | 统一池代理 + 065 vendor_id/vendor_resource_id 映射 | 供应商只绑定自己的代理；资源状态与池状态同步 |
| 合同 | vendor_contracts：leg/payer_vendor_id/payee_vendor_id/version/effective_at/price_cny_per_usd/fx_cny_per_usdt/multiplier/status | 平台付款方存 NULL；两条边独立，不使用保留 ID 0 |
| 请求事实 | vendor_usage_facts：vendor_id/resource_id/model/input_tokens/output_tokens/cost_usd/occurred_at/source_request_id | source_request_id 去重；当前只记录成功且已定价摘要 |
| 账单 | vendor_settlements：contract_id/period_start/period_end/status/amount_usdt/usage_snapshot_json | 唯一合同周期；重叠检测、冻结用量和账号维度明细 |
| 付款记录 | vendor_payments：settlement_id/idempotency_key/amount_usdt/action/reason/actor_user_id | payment 已运行；reversal/adjustment 为预留枚举，业务未实现 |
| 审计 | vendor_audit_events：actor/vendor/action/resource/idempotency_key/payload/created_at | 不存凭据正文；尚无所有失败事件的完整前后快照 |

迁移实际来源：054_panel_role_names、056_supplier_platform、057_supplier_login_role、062_vendor_billing_profile、065_vendor_proxy_pool_metadata。保留已应用迁移；057_runtime_config_revision 是另一既有文件，不混为供应商角色迁移。本轮不新增或修改 Schema。

## 合同与金额

`USDT = 官方价 USD 用量 × price_cny_per_usd × multiplier ÷ fx_cny_per_usdt`，输出 6 位小数，拒绝超出安全整数百万分单位的金额。结算参数变化创建新合同版本；单周期跨版本时要求拆分，初始合同用于可读取的初始历史用量。不是逐请求跨版本自动结算。

预览 token 包含付款对象、周期、合同、汇总及账号明细；提交时重新计算，旧预览不能悄悄切换明细。已创建账单重试返回原记录，不按当前合同重算。平台付款和下游付款使用同一状态机，但授权分别判定。

## 当前状态

供应商：active / disabled / archived。资源：provisioning（内部 VM 预配）/ active / paused / archived，普通 PATCH 不接受伪造预配状态。账单：review → confirmed → partial → paid；零金额确认后 paid；未付款的 draft/review/confirmed 可 void。confirmed 是付款方审核，不表示收款方签收。disputed 枚举暂未接入流程。

## 后续模型需求

vendor_resource_grants 已有表但未形成完整分组供给授权链；通用 resource_owners 归一化、逐 usage_fact 的 settlement_lines、完整缓存/分组/价格版本/结算根快照和冲正引用仍待设计落地。Redis/PostgreSQL 不属于当前该域实现，不应作为已部署依赖写入文档。

新请求事实与日志同事务写入，但仍依赖日志开启；留存旧日志按映射补充查询，已有事实去重。历史已删除日志不可重建，普通日志重定价不回写冻结事实或账单。后续独立消费事件流与迟到补单见差距清单。
