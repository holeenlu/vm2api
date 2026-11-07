# 当前代码重构与最小改动优化方案

> 版本：2026-11-01
> 验收基线：main / 393ddc64b5b047a2137ad9ffa53bfd5a985bc778（本轮复核前源码快照）
> 当前定制父基线：eec6301cad8a6fcd3a077cb723fb997ade3b5333
> 当前 upstream/main 与父基线一致；父父提交为上游 5fecb37f。方案只针对当前代码树。
> 2026-11-07 注记：文中的 `retry-budget.mjs` 只计数、不约束任何重试，已删除（审计阶段 2 W13）；实际生效的上限是 failover 的 `max_total_attempts`。

本文用于指导后续重构、性能优化和 Bug 修复。核心目标是降低耦合、减少重复查询和重复状态投影，同时保持现有接口、权限、计费、调度、协议、数据库和部署契约。

## 1. 当前代码事实

相对当前定制父基线，当前提交包含约 1,250 个变更路径，新增约 111,998 行、删除约 23,230 行。代码主要分布在 web 668、test 237、src 222、docs 67、scripts 17、.github 10、worker 8、deploy 6。

主要热点：

| 文件 | 规模 | 现状问题 |
| --- | ---: | --- |
| src/lib/admin/panel-routes.mjs | 7,874 行 | 路由、权限、供应商、VM、日志、备份和响应混合 |
| src/lib/pool/pool-scheduler.mjs | 2,272 行 | 候选、资格、排序、座位、冷却和状态混合 |
| src/lib/protocol/handle-protocol.mjs | 2,241 行 | 协议解析、发送、流、usage 和错误映射交叉 |
| src/lib/protocol/handle-codex.mjs | 1,814 行 | Responses、Images、Search、SSE 和 Codex failover 共存 |
| src/lib/vm/proxy-pool.mjs | 1,813 行 | 解析、绑定、探测、质量、生命周期和 egress 共存 |
| src/lib/db/repos/usage-logs-repo.mjs | 1,716 行 | 日志事实、统计、筛选和导出耦合 |
| src/lib/pool/account-quota.mjs | 1,674 行 | 额度窗口、探测、缓存和展示字段耦合 |
| src/lib/pool/failover-runner.mjs | 1,305 行 | attempt、deadline、重试和终态清理耦合 |
| src/lib/vendor/vendor-platform.mjs | 985 行 | 供应商身份、能力、资源范围和投影混合 |
| web/src/features | 405 个 feature 文件 | query key、失效策略、筛选和列定义分散 |

当前测试护栏约为 359 个 unit 文件、41 个 E2E 文件、6 个 release 文件和 10 个 deploy 文件。后续重构应复用这些测试，不因拆文件重复建立同义测试。

## Gateway Worker 重构边界

Gateway Worker 规划必须独立于现有 VM 运行时：账号只保存 execution_kind；Fleet/Server 不写入 vm_id、不成为 group_resources 商业授权对象；Worker Composition Root 不复用完整 NewAPI server 或内部 UsageWorker。实现顺序、Receipt 和账务幂等以 docs/supplier-platform/15-gateway-worker-final-plan-20261101.md 为准。

## 2. 必须保持的不变量

1. 服务端 capability、资源 owner 和字段白名单是唯一权限边界。
2. runtime snapshot 和 config revision 冻结请求期权限、路由、模型、价格和账号保护策略。
3. attempt send_state 只能单向推进；ambiguous 不得重放正文。
4. downstream_committed 后不得换号、重放、改变客户端状态或重复结算。
5. 一个 request 可以有多个 attempt，但失败 attempt 不创建第二个 request。
6. 费用、finalizer、lease release 和 settlement allocation 必须幂等。
7. 未知费用、额度、用量和支付资料保持 null 或 unknown，不填零。
8. 历史迁移、账单、价格快照、usage facts 和旧 credential 数据不重写。
9. 供应商账号、配对 VM、代理和分组的创建及归档事务边界保持。
10. kin-eg 透明出口不得回退直连；有容器或受控进程的网络不得清理。
11. 普通 Claude OAuth 旧记录缺少 scope 镜像时仍可刷新 profile；明确 inference-only、Setup Token、API Key、has_access=false 和无凭证仍禁止。
12. 业务日期固定 Asia/Shanghai UTC+8，历史 epoch 不改变。
13. SQLite 和进程内锁仍是当前单控制面边界，不因重构引入 Redis、PostgreSQL 或插件 Runtime。
14. main 继续保持一个上游父提交加一个定制提交。

## 3. 按功能模块的重构边界

### 3.1 权限和管理路由

需求：四角色、管理员 domain、供应商上下级、资源 owner、字段白名单、审计和幂等保持。

核心文件：src/lib/admin/panel-routes.mjs、panel-acl.mjs、panel-tenant.mjs、resource-owner.mjs、panel-users.mjs、src/lib/vendor/vendor-platform.mjs。

建议新增：

- src/lib/admin/capability-policy.mjs
- src/lib/admin/resource-scope.mjs
- src/lib/admin/route-context.mjs
- src/lib/admin/project-resource.mjs

已完成的 P1 抽取：

- `capability-policy.mjs`：面板方法/路径授权矩阵；`panel-acl.mjs` 保留兼容导出。
- `resource-scope.mjs`：平台资源 owner scope；`resource-owner.mjs` 保留兼容导出，PoolScheduler 已迁移一个调用方。
- `route-context.mjs`：面板 handler 的公共依赖适配；`panel-routes.mjs` 已迁移一个调用方。
- `usage-facts.mjs`、`quota-window-projection.mjs`、`settlement-snapshot.mjs`：用量、配额和结算快照的 canonical 纯 facade。
- `request-facts.mjs`、`attempt-facts.mjs`、`delivery-commit.mjs`、`retry-budget.mjs`：请求、attempt、下游提交和重试预算事实 facade。
- `credential-facts.mjs`：账号资料刷新已迁移一个调用方，保留原 credential-mode 兼容规则。

上述抽取只移动纯策略和适配层，未改变 HTTP、数据库、权限、调度和构造签名；新增调用方继续以单模块、单批次方式迁移。

已完成的 P2 路由分层：

- `panel-user-routes.mjs`：承接 users domain 的四个方法；`panel-routes.mjs` 保留认证、能力门禁和聚合分发。
- `panel-api-key-routes.mjs`：承接 API Key 列表、创建、修改、诊断、轮换、配额重置和删除；`panel-routes.mjs` 保留认证、能力门禁和聚合分发。
- `panel-api-endpoint-routes.mjs`：承接 endpoint 列表、创建、修改、删除、模型发现和 endpoint key 管理；`panel-routes.mjs` 保留认证、能力门禁和聚合分发。
- `panel-backup-routes.mjs`：承接备份列表、创建、计划、下载、恢复和删除；`panel-routes.mjs` 保留认证、能力门禁和聚合分发。
- `panel-route-coverage.test.mjs` 同时扫描聚合路由与 domain factory，避免拆分后静态覆盖检查漏报。

当前 users、api-keys、api-endpoints、backups、VM 读写/生命周期/OAuth/package/provision/import/maintenance 入口均已由 route factory 承接；groups 由 `relay-routes.mjs` 承接，vendor usage/account/settlement 读写已接入 service facade，logs usage query 已接入 query service。仍保留在聚合处理器的逻辑主要是高耦合的 VM PATCH/pool-policy、发布前置流程和跨域 orchestration，不再作为单独 route factory 批量移动。

事实 facade 的主要真实读取方已完成迁移：usage/query、settlement snapshot、protocol/failover、Codex/Responses、VM/OAuth execution context 和 vendor usage projection 均接入；保留的旧函数只作为兼容适配或跨域编排入口。

P7 的 query key、invalidation、VM/vendor/logs model、列/导出 facade 已完成当前代码范围迁移；剩余未完成项属于真实 Linux/KVM/OAuth/egress/生产验收或产品范围之外的完整批量导入导出。

先抽纯函数：

- assertCapability
- resolveResourceScope
- visibleVendorIds
- projectResource
- normalizeMutationActor

panel-routes 保留 createPanelHandler、原 URL、状态码和 JSON 字段。先按 users/groups/keys/vm/vendor/logs/backup 建 route factory，最后才考虑物理文件移动。不得先改角色模型、session 格式或前端权限判断。

### 3.2 商业分组、Key、额度和钱包

需求：group_resources、模型白名单、用户/分组/Key 三层 RPM 和并发、Key scope/IP 规则、充值/转账/套餐、一次结算和未知值语义。

核心文件：groups-repo.mjs、key-scope.mjs、key-ip-rules.mjs、api-keys.mjs、relay-billing.mjs、pool-scheduler.mjs、seat-planner.mjs。

先抽：

- group-policy.mjs
- key-scope-policy.mjs
- billing-facts.mjs
- admission-facts.mjs

策略模块只处理普通对象；SQL、钱包写入和座位分配暂不移动。保留钱包幂等键、已完成费用唯一性、超管计费豁免和历史 wallet_ledger/billing_charges 读取。

### 3.3 供应商平台和配对 VM

需求链路：

account draft → OAuth/import → vendor VM provisioner → vm-create-config → proxy/group bind → runtime boot → schedulable。

核心文件：vendor-account-draft.mjs、vendor-platform.mjs、vendor-vm-provisioner.mjs、vendor-admin.mjs、vendor-portal-view.mjs、vendor-runtime-policy.mjs、vendor-usage.mjs、vendor-account-usage.mjs、vendor-pricing.mjs、vendor-settlements.mjs。

先按命令和查询增加 facade：

- vendor/commands/account-command-service.mjs
- vendor/commands/proxy-command-service.mjs
- vendor/commands/settlement-command-service.mjs
- vendor/queries/account-query-service.mjs
- vendor/queries/usage-query-service.mjs
- vendor/queries/settlement-query-service.mjs
- vendor/projections/account-projection.mjs
- vendor/projections/usage-projection.mjs

保持 /api/vendor 和 /api/admin/vendors 契约、供应商不能直接操作 VM、归档保留历史、代理/分组绑定和 idempotency_key。付款冲正、争议、收款确认、跨合同拆单和结算导出不纳入重构。

### 3.4 代理、VM、集群和传输

需求：代理解析/质量/地区/生命周期、透明 egress、HTTP/HTTPS CONNECT/SOCKS5、KVM、remote slot、cluster direct link 和 worker 契约保持。

核心文件：proxy-pool.mjs、proxy-quality.mjs、egress.mjs、proxy-policy*.mjs、cluster/*、transport/*、worker/internal/proxy/*、vm-runtime.mjs。

先定义事实契约：

- ProxyBinding：资源、代理、平台、绑定状态、脱敏地址
- ExecutionContext：projectRoot、VM、routing、proxy mode、credential capability
- TransportHealth：准备、健康、超时、发送状态和可恢复性
- OAuthExecutionContext：目标 VM、执行器、出口和凭据能力

只先用于测试注入和隔离运行；不重写 egress、KVM、Docker 网络和 guest payload。

### 3.5 账号池、额度、用量和结算

问题：usage-logs-repo、usage-logs-view、vendor-account-usage、vendor-usage 和 usage-projection 存在重复 SQL 和投影。

建议建立：

- src/lib/usage/usage-facts.mjs
- src/lib/usage/usage-projection.mjs
- src/lib/usage/quota-window-projection.mjs
- src/lib/usage/settlement-snapshot.mjs

数据流固定为：

usage_logs/vendor_usage_facts → UsageFacts → UsageProjection → UI 或 billing/settlement。

UsageFacts 保存输入、输出、cache read/write、成功/失败和价格是否已知。UsageProjection 负责七项指标、未知值、下限标记和 UTC+8 日桶。QuotaWindowProjection 负责 5H/7D/Fable、reset、冷却和 schedulable。SettlementSnapshot 只负责结算冻结，不反写 UI 字段。

迁移 039–075 不改写。查询优化先用旧 SQL 适配器输出同一 DTO，完成新旧结果对照后再替换。

### 3.6 请求、调度、协议和可靠性

核心文件：runtime-snapshot.mjs、routing-runtime.mjs、pool-scheduler.mjs、failover-runner.mjs、handle-protocol.mjs、handle-codex.mjs、go-worker-client.mjs。

先增加不可变事实：

- request-facts.mjs
- attempt-facts.mjs
- delivery-commit.mjs
- retry-budget.mjs
- usage-evidence facade

让旧 handler、scheduler、failover 和 worker 先产生这些 facts，再迁移读取方。不要第一步拆 handle-protocol 或 handle-codex 的物理文件，也不要同时改 SSE、WS、Images、工具调用或错误码。

协议迁移顺序建议为 Chat/Anthropic、Responses、Images、WebSocket、Codex Search/Images。每次只迁移一个入口，保留旧 facade。

### 3.7 OAuth 和账号资料

核心文件：credential-mode.mjs、account-profile.mjs、guest-oauth-helper.mjs、claude-auth-login.mjs、codex-oauth.mjs、usage-probe-monitor.mjs、identity/*。

先增加 CredentialFacts 和 OAuthExecutionContext。所有 profile、quota、refresh 和 guest helper 读取 facts，不自行解释原始 credential JSON。先用旧 fixture 做新旧结果对照，再切换一个调用方。不要在 OAuth 重构中修改 token 交换、代理协议、guest payload 和权限规则。

### 3.8 运维、备份、seed settings 和通知

需求：seed settings 的节点文件读取和符号链接拒绝、保存/发布/生效结果区分、backup manifest/SHA、恢复期间 503、通知、active-hours、VM test schedule 和管理员 profile 继续有效。

建议新增：

- admin/ops/seed-settings-query.mjs
- admin/ops/seed-settings-command.mjs
- admin/ops/backup-query.mjs
- admin/ops/backup-command.mjs
- admin/ops/notification-command.mjs

旧 panel route 只做 adapter，不改变备份格式、恢复状态、503 或 revision/CAS。

### 3.9 前端和多语言

先抽纯模型和查询，不先重写页面：

- web/src/lib/query-keys.ts
- web/src/lib/query-options.ts
- web/src/lib/query-invalidations.ts
- features/vendor/model.ts
- features/supplier-admin/model.ts
- features/vm/model.ts
- features/logs/model.ts

迁移顺序是 query key、invalidation、筛选/状态/列模型、CSV 导出模型，最后才拆组件。保持 URL、DOM、四语 key、UTC+8、未知值、供应商隐藏 supplier 列和超管保留列。

### 3.10 发布、部署和工作流

只对 release plan、publish、guard、payload 和 deploy 参数做纯输入/输出模块化。保持同版本不自动发版、上游版本递增才发布、payload SHA/版本 guard、guest/KVM 顺序和生产授权边界。

## 4. 分阶段实施

### P0 契约护栏

记录 API 路径、状态码、响应 DTO、错误码、迁移清单和测试入口。为 createPanelHandler、createHandleProtocol、PoolScheduler、FailoverRunner、VendorPlatform 保留现有构造签名，并建立 golden fixtures。无生产代码行为变化。

### P1 纯函数和 DTO

优先抽 capability/resource scope、CredentialFacts、UsageFacts、QuotaWindowProjection、AccountProjection、ProxyBinding、RequestFacts。每个模块先测试后迁移一个调用方；不改 schema、HTTP 和状态码。

### P2 管理路由分层

panel-routes 保留聚合注册器，按 users/groups/keys/vm/vendor/logs/backup 建 route factory。统一 RouteContext：

    db, identity, audit, scope, respond, errorMapper, runtime

一次只迁移一个领域，旧 handler 作为 wrapper。

### P3 数据访问和运行事实

统一只读 query/result type 和 transaction wrapper。usage facts 旁路对照；runtime snapshot、attempt、finalizer 通过 facade 接入。不在本阶段改变结算算法、价格 revision 或 send_state。

### P4 供应商和结算

迁移 account/proxy/usage/settlement command/query。对照旧新 projection、金额、价格 revision、idempotency 和付款边。未实现结算能力不新增。

### P5 协议和调度

从 pool-scheduler 的 normalization、candidate scoring、admission reason 开始，再处理 selection policy。为 protocol/failover 接入 AttemptFacts、DeliveryCommit、UsageEvidence。每次只切换一个协议入口。

### P6 VM、代理和 OAuth

只切换 ExecutionContext、ProxyBinding、TransportHealth、OAuthExecutionContext 的测试注入和隔离实现。真实 Linux/KVM/OAuth/egress 通过 CI 或服务器验收后再切生产路径。

### P7 前端和发布

统一 query/model/invalidation，再模块化 release/deploy 纯策略。最后才移动文件和删除 wrapper。

每阶段一个小提交、一个回滚点，不进行整文件重写。

## 5. Bug 修复最小改动流程

固定为：

1. 复现；
2. 锁定唯一真实入口；
3. 先补失败或边界回归；
4. 只修改 canonical policy 或 adapter；
5. 复验 unit → HTTP/SQLite → web/Go；
6. 确认旧路径无调用方后清理；
7. 记录兼容逻辑的退出条件。

典型修复位置：

| Bug | 首选位置 | 不顺手修改 |
| --- | --- | --- |
| 供应商越权 | resource-scope/capability policy | session、UI 路由、schema |
| 用量/费用错误 | UsageFacts 或 projection | settlement schema、价格版本 |
| OAuth 资料刷新 | CredentialFacts/profile policy | token 交换、guest payload |
| ambiguous 重试 | attempt/failover policy | 协议解析、账单算法 |
| 代理编辑 | proxy command/parser | egress 网络和 VM runtime |
| 前端旧数据 | query key/invalidation | 后端接口和数据库 |
| 状态标签 | shared status projection | 调度状态机和枚举 |

禁止用隐藏 UI、永久开关或第二套并行实现掩盖问题。

## 6. 验证矩阵

| 变更层 | 必做检查 | 需要扩大时 |
| --- | --- | --- |
| 纯函数/DTO | 相关 unit 和 golden 对照 | 跨模块 DTO 增加 HTTP |
| 权限/scope | ACL/tenant/vendor unit、HTTP、E2E | 角色或父级级联变化时扩大 |
| Usage/quota | usage logs、vendor usage、quota、UTC+8 | 影响计费时加隔离 SQLite |
| 结算/钱包 | pricing/settlement/admin wallet unit 和 E2E | schema 或付款边变化才做迁移 |
| request/attempt | failover、Codex reliability、worker send-state | 协议入口变化时加 HTTP/SSE/WS |
| 前端 | 受影响组件、i18n、TypeScript | route/query/build 变化时 web build |
| Go | 受影响包和 race | 依赖或跨包调用变化时模块全量 |
| VM/OAuth/egress | helper、transport、proxy tests | Linux/KVM/真实 OAuth 由 CI/服务器验收 |

现有入口优先复用：

    npm run test:unit
    npm run test:e2e
    npm run test:go
    npm run test:web
    pnpm -C web typecheck
    pnpm -C web build
    pnpm -C web test:i18n
    npm run format:check

不因重构提交数量增加而重复全量测试。

## 7. 回滚和删除

每阶段只允许一个新事实来源：

    旧入口 → adapter → 新模块

对照期可以旁路计算，但必须有差异指标、切换条件、回退路径和删除时间点。高风险 wrapper 至少保留到下一次稳定交付，并在搜索确认无调用方后删除。

没有独立退出条件的历史迁移、旧账单、旧 credential JSON、旧代理绑定和旧日志字段，只保留读取兼容，不做数据重写。

## 8. 不纳入本轮重构

- 跨进程 claim/CAS、多控制面 lease。
- Redis、PostgreSQL、S3 替换 SQLite。
- MFA、step-up、门户版本协商。
- 付款冲正、争议、收款确认、完整结算导出。
- 独立消费事件流。
- 完整账号/资源批量导入导出和主动额度刷新。
- 插件 Runtime。
- 真实 Linux/KVM/OAuth/iptables/收费推理部署。
- 通过整文件重写重新设计协议、调度、VM 或代理系统。

## 9. 完成判定

一个阶段只有同时满足以下条件才完成：

1. API、状态码、DTO、权限、迁移和运行语义保持。
2. 新模块有直接单测，旧入口有兼容回归。
3. 受影响的 HTTP、SQLite、前端或 Go 检查通过。
4. 没有永久双轨实现，删除条件已满足。
5. 变更可以用一个小提交回滚。
6. Release Note 记录范围、验证和限制。
7. 不破坏 main 的单一上游父提交和单一定制提交模型。

## 10. 2026-11-01 已执行批次

本轮继续执行了以下低风险重构批次：

- VM 只读面板路由：新增 `panel-vm-read-routes.mjs`，承接 VM 列表、详情、fleet-status 和 create-options；认证、能力门禁、租户边界、内核健康检查和原有 DTO 仍由现有 handler/context 提供。写操作继续留在聚合路由，避免同时改 VM runtime、Docker、KVM 或 guest payload。
- 供应商 service seam：新增 account、proxy、usage、settlement 的 command/query facade，并将真实 `/api/admin/vendors` 与 `/api/vendor` 的 usage、账号 runtime、账号授权草稿和结算路径接入 facade。SQL、幂等、付款边、归档和能力校验仍由既有服务实现。
- 前端 query invalidation：扩展 `query-keys.ts` 并新增 `query-invalidations.ts`，统一 VM、代理、供应商、供应商后台和用量视图的失效关系；代理写操作已迁移到共享 helper，缓存 key 和接口 URL 不变。

本批完成了直接单测、面板静态路由覆盖、Node 语法检查、Web Vitest 和 TypeScript 检查。该历史批次当时尚未完成的运行事实、VM 写路由、Transport/OAuth execution context、vendor projection 和 release/deploy facade 已在后续批次完成；当前仍需目标环境才能完成的只有真实 Linux/KVM/OAuth/egress/生产验收。

随后已在 `handle-protocol` 与 `handle-codex` 的 failover、Responses、Search、Images 和 WS 入口接入运行事实：请求进入记录 `RequestFacts` 和有界 `RetryBudget`，每次尝试更新 `AttemptFacts`，下游发送/keepalive/流事件统一推进 `DeliveryCommit`。这些 facts 旁路复用既有 runner 回调，不改变候选选择、SSE/WS、错误映射、重试正文或结算算法。

P6 又完成了执行上下文的最小收敛：`execution-context.mjs` 新增不可变 `createExecutionContext`，PoolScheduler 的一个真实构造调用方已迁移；新增 `proxy-binding.mjs` 统一脱敏代理绑定事实。两者只用于 per-attempt adapter/test seam，不改变 Docker、KVM、透明出口、guest payload 或代理协议。

VM command 分层随后继续完成 fleet update、fingerprint reconcile、启动/停止/重置、maintenance、OAuth mutation、create/import 等写入口；原 body 大小、routing、返回 envelope 和权限流程保持。高耦合 PATCH/pool-policy 仍由聚合 handler 统一编排，以避免拆分时复制运行时事务。

OAuth P6 继续新增 `oauth-execution-context.mjs`，并让账号资料刷新使用统一的凭据事实与脱敏代理绑定上下文；未改变 token exchange、guest payload、代理协议或真实凭据。

发布与部署脚本已补充纯 contract facade `scripts/release/release_contracts.py`，集中校验上游版本、定制版本、tag 和单一上游父提交关系；当前 workflow 的触发、payload guard、guest/KVM 顺序和生产部署边界保持不变。

Transport P6 新增 `transport-health.mjs`，统一准备/可达/进程/健康/ready 的只读投影，并保持未知状态为 `null`；只用于 adapter 和测试，未切换真实 kernel client。

VM 生命周期路由已继续拆出 `panel-vm-lifecycle-routes.mjs`，承接 start、recover、stop；供应商运行时启动、powerOnSlot、recoverSlot、stopSlot 仍使用原实现，公开 VM/boot/runtime/kernel envelope 和角色分支保持。

Usage/P3 已继续落地：新增 `panel-usage-query-service.mjs`，并将 usage-logs 的 keyset list、ranking、summary、filter-options、session suggestions、active sessions 和 export 读取方接入同一 query adapter；`UsageLogsView` SQL、分页、租户过滤和 DTO 不变。

VM 诊断只读入口也已迁移到 `panel-vm-diagnose-routes.mjs`，保留租户/超管诊断脱敏规则和 `diagnoseSlotServices` 原实现。

VM probe 入口继续拆分到 `panel-vm-probe-routes.mjs`，承接 inference probe 与 real-exit geo probe；probe status、代理出口和失败映射保持原实现。

VM quota/reset 入口已拆到 `panel-vm-quota-routes.mjs`，承接 OpenAI quota refresh/reset 与 Claude reset query/redeem，并保留原 idempotency、quota persistence 和公开 DTO。

P7 前端 model 已开始收敛：新增 VM、日志和供应商 feature model facade，并迁移 VM 列表与供应商账号工作台的真实调用方；查询 key/invalidation 继续使用既有兼容 key。

本批继续完成并关闭以下代码层阶段：

- VM 测试路由：`panel-vm-test-routes.mjs` 承接 test-chat、test-models、test-schedule 和默认计划同步；原 body 限制、错误码和 `{ ok, data }` envelope 保持。
- VM 凭据与身份写路由：`panel-vm-credential-routes.mjs` 承接 credential clear、reset-fingerprint、reconcile-fingerprint；凭据文件清理、kernel 重启、调度禁用、指纹生成和脱敏 DTO 保持原逻辑。
- Codex 事实层：`handle-codex.mjs` 的 Responses、Search、Images 入口接入 RequestFacts、AttemptFacts、RetryBudget 和 DeliveryCommit；Responses WebSocket 通过既有 `handle-protocol` 入口继承同一事实层。
- 结算投影：结算预览在价格计算前冻结 `SettlementSnapshot`，将未知金额显式保留为未知，不改历史迁移、结算 SQL 或价格算法。
- 前端查询模型：VM 和日志查询迁移到 `panelQueryKeys`，补充 credential/seed/official-cc/detail 级 key 和 VM/usage 失效关系；接口 URL、组件 DOM 和多语言键不变。
- 发布契约：`release_contracts.py` 新增资产边界与 linux/amd64 镜像契约，并接入 publish；同版本不发版、上游版本递增才发布、guest/KVM 顺序和生产边界保持。
- 供应商投影：新增 `vendor/projections/usage-projection.mjs` 并接入 usage query facade；统一未知费用、缓存不完整和 total_tokens 的输出语义，不改底层 SQL。
- 前端供应商后台：supplier-admin 的供应商、账号、代理、分组、创建代理、pricing 和列表 query key 已收敛到 `supplierQueryKeys`，接口 URL 与页面行为保持。
- VM/OAuth runtime：新增 `panel-vm-runtime-routes.mjs` 与 `panel-vm-oauth-query-routes.mjs`，分别承接 reload、shell-ticket、collect-identity、credential 查询和 setup-token session 查询；OAuth 路径、凭据状态和 refreshable 语义统一由 `oauth-route-context.mjs` 提供。
- 前端全局查询键：认证、用户、分组、模型、设置、风险、统计、订阅、供应商、VM 包和 branding 查询已继续迁移到 `panelQueryKeys`，未改变接口 URL 或缓存数据结构。
- 部署纯策略：`release_contracts.py` 新增部署 tag、宿主架构和镜像 tag 纯函数；guest image policy 复用相同 tag 解析，避免 release/deploy 各自解释版本和架构。
- 安装脚本：新增 `deploy/install_contracts.py`，`deploy/install.sh` 在本地源码安装和远程镜像安装中复用同一套 tag/架构/镜像 tag 规则；地址池、配置、槽位同步和生产边界不变。
- VM seed settings：新增 `panel-vm-seed-routes.mjs`，迁移 seed-settings 的读取、debug telemetry log、代理时区 CAS、native/remote seed publication 和锁；现有响应字段、状态码和发布顺序保持。
- VM package：新增 `panel-vm-package-routes.mjs`，迁移 package export、update 和 create/import；保留 owner scope、代理绑定、时区填充、worker reload、bring-up 和原有 package DTO。
- VM reset：新增 `panel-vm-reset-routes.mjs`，迁移 destroy/recreate、代理重新分配、运行启动、凭据清理和失败状态保留；不改变 reset 的 mode、状态码或 runtime envelope。
- VM maintenance：新增 `panel-vm-maintenance-routes.mjs`，迁移 schedule hold/resume、schedulable、cooldown/circuit reset、activate、旧 Claude CLI 410 入口和 VM 删除；保留调度保持、在途 drain、代理解绑、DB 镜像清理及原响应。
- OAuth mutation：新增 `panel-vm-oauth-mutation-routes.mjs`，迁移 generate-auth-url、exchange-code、credential PUT、to-setup-token 和 refresh；保留 OAuth/Setup Token/Codex 分支、VM 绑定校验、worker 换票和 profile 刷新契约。
- VM provision：新增 `panel-vm-provision-routes.mjs`，迁移 `/api/panel/vms/create`；保留 runtime/machine 校验、节点预检、KVM 探测、指纹与 locale、代理分配、时区跟随、启动失败落盘和公开 boot DTO。
- VM import：新增 `panel-vm-import-routes.mjs`，迁移 `/api/panel/vms/import` 的 Codex、Console API Key、sessionKey、Sub2API JSON 和 profile enrichment 分支；同时修正无 worker credential 时 OAuth 查询的空值投影。
- 前端 query 收口：所有生产前端 `queryKey` 与 `invalidateQueries` 直接数组已清零，日志分页/汇总/筛选/建议/overview 也统一由 `panelQueryKeys` 生成；已有缓存前缀和失效层级保持。
- 运行事实读方收口：`availability.mjs` 使用 `projectQuotaWindow` 规范化 5H/7D reset 事实，`slot-runtime.mjs` 在 Rust runtime 结果中附带 `transport_health` 投影；原字段继续保留，未知状态不填零。
- 供应商 usage projection：账号 query service 与 portal totals/today 读方统一经过 `projectVendorUsage`，补齐未知费用、缓存不完整和 total_tokens 的单一 DTO 语义；底层 SQL 和门户字段不变。
- 前端 query facade：集群节点/Docker/preflight/slot-image、统计图表和日志 ranking 改用 `panelQueryKeys`；供应商与 supplier-admin 的刷新失效也复用共享 key，接口 URL、组件 DOM 和缓存层级不变。
- 前端列/导出 facade：日志列可见性与 JSONL/CSV 导出查询由 `features/logs/model.ts` 统一转出，日志主表、全屏表和导出入口共用同一模型；CSV 字段、角色列白名单和导出参数不变。

上述批次已通过相关 Node/TypeScript/Python 定向验证。代码层重构项已完成；剩余是需要目标环境才能完成的真实 Linux/Docker/KVM/OAuth/egress/生产验收，本机不将其冒充为已完成。

## 11. 2026-11-01 复核与验收

本次复核以 `393ddc64b5b047a2137ad9ffa53bfd5a985bc778` 为基线，逐项检查 3.1–3.10、P0–P7 和完成判定 1–7，并对方案中“建议新增但代码树不存在”的模块做了等价实现核对。结论如下：

| 范围 | 结论 | 证据或限制 |
| --- | --- | --- |
| 3.1 权限、资源和管理路由 | 通过 | capability/resource scope/route context、project-resource adapter、users/keys/endpoints/backups/VM domain factories 均有真实调用方；旧入口保留兼容分发。 |
| 3.2 分组、Key、额度和钱包 | 通过 | 新增 `group-policy.mjs`、`key-scope-policy.mjs`；`key-scope.mjs` 只保留数据库读取和兼容入口，纯谓词已迁移；钱包/额度写入仍由原 repo/service 负责。 |
| 3.3 供应商和配对 VM | 通过 | command/query service、`account-projection.mjs`、usage projection 已接入真实账号/用量读方；结算冲正、争议和完整导出仍明确排除。 |
| 3.4 代理、VM、集群和传输 | 通过（代码层） | `ProxyBinding`、`ExecutionContext`、`TransportHealth` 已接入 adapter/test seam；真实 Linux/KVM/Docker/透明出口仍待目标环境。 |
| 3.5 用量、额度和结算 | 通过 | `UsageFacts`、`BillingFacts`、`QuotaWindowProjection`、`SettlementSnapshot` 和 vendor usage projection 已接入；未知金额保持 `null`。 |
| 3.6 请求、调度、协议和可靠性 | 通过 | Request/Attempt/Delivery/Retry facts 已进入 protocol/Codex/failover 入口；未重写 SSE、WS、工具调用、错误码或结算算法。 |
| 3.7 OAuth 和账号资料 | 通过（代码层） | CredentialFacts、OAuthExecutionContext、oauth route context 已接入；真实换票、guest helper 和 Linux 二进制仍待目标环境。 |
| 3.8 运维、备份、seed settings、通知 | 通过 | 新增 query/command facade 并接入 seed、backup、notify route；文件安全、CAS、manifest/SHA、restore 503 和状态 envelope 保持。 |
| 3.9 前端和多语言 | 通过 | query key/invalidation、VM/vendor/logs model、列/导出 facade 已迁移；新增 `web/src/lib/query-options.ts` 作为 TanStack query option 共享入口。 |
| 3.10 发布、部署和工作流 | 通过（代码层） | `release_contracts.py`、`install_contracts.py` 已接入；版本、tag、架构、guest/KVM 顺序保持。生产部署未执行。 |

阶段 P0–P7 均达到“代码层完成”条件；本轮补齐的 facade 均有直接单测或既有 route regression，并至少接入一个生产调用方。最后一组定向复核 Node 测试 121 项通过，新增 facade 专项 7 项通过，Web TypeScript 检查通过，query invalidation 测试 4 项通过。已有全量证据仍有效：Web Vitest 109 个文件/831 项、Web TypeScript、Node VM/OAuth/运行事实回归、Release 67 项通过。

以下项目不能在本机验收，保持未完成状态：真实 Linux/KVM guest 启动、真实 OAuth 换票、透明 egress/iptables、收费推理和生产部署。Deploy 测试仍有 1 项 macOS 环境差异：`/var` 为符号链接，测试先命中 managed-path symlink 拒绝分支；未修改业务代码掩盖该差异。

本轮新增的 facade 文件及迁移遵循“旧入口 → adapter → 新模块”单事实来源原则，没有新增 schema、迁移或外部运行时；完成后仍需按第 6 节的目标环境矩阵做 Linux/生产专项验收。
