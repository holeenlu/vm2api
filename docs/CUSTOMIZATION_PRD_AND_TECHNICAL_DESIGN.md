# TapModels/vm2api 定制版完整 PRD 与技术拆解

> 版本：2026-11-01
> 适用代码：main（当前交付提交）
> 上游基线：upstream/main / 8749e65c1c5536c22abb05a6d34f29f91c4da8ca（v1.4.030）
> 范围：上游基线到当前定制提交的累计差异。

本文把当前定制代码重新整理为一份可评审、可实施、可验收的产品需求文档和技术方案。它以实际代码、迁移、测试和最新 Release Note 为准；历史记录中的旧上游基线、旧接口说明或“尚未新增迁移”的描述，仅作为历史证据，不覆盖本文。

## 1. 产品目标与边界

TapModels 是一个面向多角色、多供应商、多模型和多运行资源的 AI 中转控制面。系统把用户请求映射到 API 上游、Claude/OpenAI/Codex 账号、VM/KVM 槽位或供应商托管资源，并同时处理权限、分组、代理出口、调度、额度、用量、结算、审计和发布。

本次定制的产品目标是：

1. 建立超级管理员、管理员、用户、一级供应商和二级供应商的清晰边界。
2. 让供应商可以独立完成账号授权、配对 VM、代理绑定、用量查看和结算草稿，而不暴露底层 VM 管理能力。
3. 让 VM、API Key、Codex/Claude、图片接口和供应商资源共享可追溯的调度、重试、额度与计费事实。
4. 将运行配置、请求 attempt、账号故障保护和费用结算从即时响应中抽离为可恢复事实。
5. 统一品牌、多语言界面、业务时间、发布流程和部署方式。

明确边界：SQLite、VM、代理池、现有 kernel/worker 和控制面仍是运行基础；没有因为 CPR 研究资料而引入 Redis、PostgreSQL、插件 Runtime 或整套新调度系统。真实 Linux guest/KVM、真实 OAuth 换票、外部供应商凭据、收费推理和生产部署不由本地 macOS 验收替代。

## 2. 当前基线、差异规模与证据规则

- 当前 main 为“上游 v1.4.030 + 一个 TapModels 定制提交”，工作树干净且 origin/main 与本地 main 一致。
- 现有业务定制相对上游共有 1,249 个变更路径，按顶层目录约为：web 668、test 238、src/lib 215、docs 65、scripts 17、.github 10、worker 8、deploy 6，其余为根配置、Docker 和共享文件。本次交付另外新增本 PRD 和当前文件映射两份文档，最终定制树相对上游为 1,251 个路径。
- 定制迁移覆盖 039–075 的累计演进，重点包括供应商平台、运行配置 revision、账号保护、请求发送状态、管理员数据域、供应商合同/结算、Codex response owner、全局价格和供应商用量缓存。
- 当前基线的完整逐文件差异见机器生成的 [CUSTOMIZATION_CURRENT_FILE_MAP.md](CUSTOMIZATION_CURRENT_FILE_MAP.md)；历史累计增删统计和交付背景见 [CUSTOMIZATION_FILE_INDEX.md](CUSTOMIZATION_FILE_INDEX.md)。本文增加功能、需求、调用链、接口、数据和验收映射。
- 现行功能证据以 [CUSTOMIZATION_RELEASE_NOTES.md](CUSTOMIZATION_RELEASE_NOTES.md) 的 2026-11-01 至今条目和实际源码为准；[CUSTOMIZATION_IMPLEMENTATION_RECORD.md](CUSTOMIZATION_IMPLEMENTATION_RECORD.md) 的旧基线说明不再作为当前基线。

状态标记：

- **已实现**：代码、接口和相关定向验证已具备。
- **已实现，待环境验收**：本地隔离测试已通过，但依赖 Linux guest、真实 OAuth、真实代理或生产资源。
- **规划/未实现**：文档中有设计或缺口，但当前代码没有完整实现。

## 3. 角色、资源与权限 PRD

| ID | 需求 | 角色/场景 | 业务规则 | 主要实现 | 状态 |
| --- | --- | --- | --- | --- | --- |
| R-01 | 四种登录角色 | super_admin 管全局；admin 管理域；user 使用个人 Key；vendor 管自有供应商资源 | 供应商层级由 tier、parent_id、root_id 表示，不拆登录角色 | src/lib/admin/panel-acl.mjs、panel-users.mjs、resource-owner.mjs、panel-routes.mjs；web/src/routes/_authenticated、web/src/routes/vendor | 已实现 |
| R-02 | 管理域隔离 | 管理员只能读取/修改授权数据域内的用户、Key、分组和账务 | 服务端先做 capability、字段白名单和资源范围裁剪 | src/lib/admin/panel-acl.mjs、panel-tenant.mjs、panel-users.mjs；迁移 063、064、066 | 已实现 |
| R-03 | 供应商上下级 | 一级供应商按 create_child 创建二级；二级只拥有直属资源 | 父级停用、账号范围和下游可见性级联 | src/lib/vendor/vendor-platform.mjs、vendor-admin.mjs、vendor-runtime-policy.mjs；迁移 056、057、062 | 已实现 |
| R-04 | 无权限访问体验 | 直接打开受限供应商地址或会话过期 | /api/vendor/me 的加载、401、403、网络错误和无效响应分别显示；切换账号清理会话和查询缓存 | web/src/features/vendor、web/src/routes/vendor、src/lib/admin/panel-routes.mjs | 已实现 |
| R-05 | 删除失效入口 | 旧工作台、旧 provider 单页、旧 GitHub 引导、供应商操作记录读取入口移除 | 保留业务审计写入和历史账单/日志 | web/src/routes、web/src/features、src/lib/vendor/vendor-portal-view.mjs、panel-routes.mjs | 已实现 |

### 技术方案

请求进入 src/server.mjs 后，经 panel-routes.mjs 统一分流。每个管理或供应商端点依次执行身份认证、capability 判断、资源所有者范围裁剪、字段白名单校验，再调用领域服务和 repository。前端不能扩大权限；隐藏按钮不构成安全边界。

供应商列表和详情使用资源所有者投影，避免把下游账号混入父级自身列表。供应商不能直接 POST /vms；账号创建必须通过账号草稿和配对 VM 服务完成。供应商对配对 VM 的直接 PATCH/DELETE 被拒绝，账号操作驱动关联资源状态。

验收重点：跨供应商读取、跨平台分组授权、父级停用级联、管理员数据域、无权限页面、过期会话清理和供应商直接访问 VM 接口均有拒绝回归。

## 4. 平台基础能力：商业分组、Key、额度与账务

供应商平台建立在更早的商业运营定制之上，这些能力仍属于当前产品契约，不能因为代码分散在 admin、pool 和 usage 模块就遗漏：

| ID | 需求 | 业务规则 | 主要实现 | 状态 |
| --- | --- | --- | --- | --- |
| B-01 | 商业分组和供给 | 一个分组可绑定多个 VM/API endpoint，用户按分组授权 | group_resources 多对多；平台、模型白名单和资源 owner 同时生效；mixed 分组按实际模型范围筛选 | src/lib/db/repos/groups-repo.mjs、src/lib/admin/panel-routes.mjs、src/lib/pool/schedule-eligibility.mjs、迁移 039、043 | 已实现 |
| B-02 | 三层 RPM 与并发 | 用户总量、分组、Key 各自有 RPM/并发约束 | 0/null 语义按现行配置解释；等待、容量和上游限流分开记录 | src/lib/pool/pool-scheduler.mjs、seat-planner.mjs、src/lib/admin/routing-runtime.mjs、迁移 053 | 已实现 |
| B-03 | 用户授权和 Key scope | Key 可限制平台、模型、分组、IP 和客户端配置 | 创建者数据域、Key scope、IP 白名单/黑名单和模型目录在服务端校验 | src/lib/admin/key-scope.mjs、key-connection.mjs、key-ip-rules.mjs、api-keys.mjs、迁移 064 | 已实现 |
| B-04 | 钱包、套餐和一次结算 | 用户/管理员充值、余额转账、套餐和消费归属可追溯 | 已完成费用只计一次；073 撤回运行时钱包流水依赖，保留历史数据和账单事实 | src/lib/admin/relay-billing.mjs、pricing.mjs、relay-routes.mjs、usage-logs-repo.mjs、迁移 039、048、066、069、073 | 已实现 |
| B-05 | 日志和统计 | 请求、响应、输入输出、图片、上游服务 tier 和结算事实分开投影 | 失败请求可记录请求事实但不计成功费用；未知值保持 null/未知 | src/lib/admin/usage-projection.mjs、src/lib/db/repos/usage-logs-view.mjs、statistics-repo.mjs、迁移 047、049、050、055、074 | 已实现 |
| B-06 | 风险拦截 | JEV/硬规则/平台安全问题可阻断或 fail-open | 密钥不回显；放行原因可解释；规则状态和 usage 事实可追溯 | src/lib/protocol/jev-intercept.mjs、intercept-gate.mjs、src/lib/core/refusal-guard.mjs、迁移 044、045、051、052 | 已实现 |

这些基础能力的前端入口分布在 web/src/features/groups、users、keys、billing、logs、settings 和 vm；删除某个旧菜单不等于删除其仍被供应商、API 或调度调用的业务能力。

### 现行管理与供应商 API 契约摘要

管理端以 panel-routes.mjs 为统一入口，核心端点包括：

- 供应商和账号：GET/ PATCH /api/admin/vendors、GET /api/admin/vendors/accounts、GET /api/admin/vendors/usage。
- 代理：GET /api/admin/vendors/proxies；POST /proxies/{id}/probe、quality-check、geo、enable、disable、archive，以及批量 probe/quality-check/geo。
- 定价与结算：GET/POST /api/admin/vendors/pricing、POST /api/admin/vendors/settlements/preview、POST /api/admin/vendors/settlements、POST /settlements/{id}/confirm、payments、void。
- 资源与权限：GET /api/admin/vendors/account-groups、GET/PATCH /api/admin/vendors/{id}；所有响应先按管理员数据域和资源 owner 投影。

供应商端核心端点包括：

- 身份和门户：GET /api/vendor/me、/billing、/usage、/vendors。
- 开户授权：POST /api/vendor/account-drafts；POST /account-drafts/{id}/oauth/generate-auth-url、exchange-code、/import。
- 账号：GET /api/vendor/accounts；POST/PATCH /accounts/{id}/pause、resume、usage、groups、cooldown/clear、profile/refresh；DELETE 语义为归档。
- 代理和结算：GET /api/vendor/proxies；代理测试/质量/地区/编辑/删除；POST /api/vendor/settlements/preview、/settlements、/vendors。

供应商前缀的端点始终受 capability、vendor member 状态、父级状态和资源范围保护；端点存在不代表供应商可以直接操作底层 VM 或管理员配置。

## 5. 供应商平台与账号生命周期 PRD

| ID | 需求 | 用户流程 | 规则/验收 | 主要文件 | 状态 |
| --- | --- | --- | --- | --- | --- |
| V-01 | 账号草稿 | 供应商选择平台、名称、授权方式、分组和代理，先保存草稿 | 草稿只保存必要授权字段；不允许机器规格、并发、权重等控制面字段 | src/lib/vendor/vendor-account-draft.mjs、web/src/features/vendor、迁移 056 | 已实现 |
| V-02 | 账号即配对 VM | 授权后创建同一资源下的账号和 VM | 共用 vm-create-config.mjs 的 buildNewVmRecord；平台、默认并发/RPM/会话/权重和初始调度状态由服务端生成 | vendor-vm-provisioner.mjs、vm-create-config.mjs、vendor-platform.mjs、groups-repo.mjs | 已实现，待环境验收 |
| V-03 | 自动命名 | 名称留空时生成标准 vm-NN | 现有 VM 和历史保留账号参与编号；旧 vendor-vm-* 记录不迁移 | src/lib/vm/vm-create-config.mjs、供应商创建服务、前端表单 | 已实现 |
| V-04 | 授权后启动 | Claude/Codex/OpenAI 授权完成后准备运行环境并启动 | 操作幂等；失败显示真实 runtime_boot；成功后才恢复调度 | vendor-vm-provisioner.mjs、oauth/*、slot-runtime.mjs、panel-routes.mjs | 已实现，待环境验收 |
| V-05 | 生命周期操作 | 重新授权、清除可解除冷却、归档、删除 | 删除先停调度、停止运行环境、解绑代理，再归档账号和配对 VM；保留历史日志和账单 | vendor-admin.mjs、vendor-portal-view.mjs、account-error-protection.mjs、proxy-pool.mjs | 已实现 |
| V-06 | 归档可见性 | 默认列表排除归档；显式读取完整集合 | archived=all/only 只返回当前授权范围；历史数据保持可查询 | vendor-portal-view.mjs、panel-routes.mjs、共享筛选模块 | 已实现 |

Anthropic/OpenAI 平台决定授权入口、分组范围和 VM 类型。切换平台清理不适用的分组与授权条件；服务端拒绝跨平台授权、不匹配分组和伪造平台字段。OpenAI 只显示 OAuth 入口，Setup Token、Console API Key 等授权方式按当前凭据投影展示。

Claude OAuth 的控制面入口把 exec、projectRoot、routing 传入目标 VM 的 slotExec；prepareSlotOAuth 按实际嵌套 boot.rust.rust.health 契约判断就绪。透明 kin-eg-* 网络由 guest 网络接管外部出口时，OAuth payload 不再重复传入代理 URL；显式出口仍要求代理，禁止无代理回退。

相关文件：src/lib/oauth、src/lib/vm/slot-shell.mjs、guest-oauth-helper.mjs、src/lib/admin/panel-routes.mjs、src/lib/admin/relay-routes.mjs、web/src/features/vendor。真实 Linux OAuth helper 和外网换票仍需部署环境验收。

## 6. 代理池与出口 PRD

| ID | 需求 | 实现规则 | 关键文件/迁移 | 状态 |
| --- | --- | --- | --- | --- |
| P-01 | 统一代理资源 | 运营和供应商使用同一 ProxyPool 持久化、探测、绑定和归属模型 | src/lib/vm/proxy-pool.mjs、src/lib/db/repos/proxies-repo.mjs、迁移 065 | 已实现 |
| P-02 | 供应商隔离 | 供应商只能使用自身或授权范围内代理 | owner、platform、resource 过滤在服务端完成 | vendor-platform.mjs、panel-acl.mjs、panel-routes.mjs | 已实现 |
| P-03 | 五项操作 | 测试、质量、地区、编辑、删除在两端一致 | 支持批量检测；删除/解绑不影响仍被其他 VM 使用的代理 | web/src/features/proxies、web/src/features/vendor、proxy-quality.mjs | 已实现 |
| P-04 | 粘贴和编辑 | 支持 URL、IP:port:username:password 和已有代理选择 | 地址重复复用；认证信息加密存储并脱敏；地址留空只改变名称，不解绑 | proxy-address.mjs、proxy-agent.mjs、vendor-admin.mjs、proxies-repo.mjs | 已实现 |
| P-05 | 出口回收 | 换代理或归档后解绑旧池；旧代理不再共享时停止出口 | egress、proxy-pool、reclaimUnusedEgressNetworks | 已实现，待环境验收 |
| P-06 | Docker 地址池 | 多代理出口不能因默认地址池耗尽而创建失败 | configure-docker-address-pools.py 配置约 10.200.0.0/16 的 /24 池；安装脚本处理备份和重启 | 已实现，待 Linux 验收 |

清理策略只触碰 kin-eg-*、无容器、无当前受控 egress 进程的网络；有容器或活跃助手的网络不删除。真实 Docker 网络回收和代理出口连通性不能由静态测试证明。

## 7. 账号池、身份与用量 PRD

超级管理员和供应商端渲染同一 AccountWorkbench：相同概览、筛选、列显隐、排序/分页、配额/费用/缓存列、详情、用量和编辑布局；角色只改变资源范围、写权限和超管 VM 入口。旧简化 AccountTable 和专属详情弹窗已清理。

身份展示采用两行：第一行显示邮箱或保存名称与资源 ID；第二行显示已采集套餐/档位、支付方式和授权方式。未知字段不猜测、不发起额外上游查询。搜索覆盖账号 ID、保存名称、邮箱、VM ID 和脱敏代理。

src/shared/vendor-account-filters.mjs 是浏览器和两个 GET 列表入口共用的纯筛选实现。可组合平台、状态、分组、授权方式、冷却、调度、归档、创建日期、故障和消耗排序。创建日期按 Asia/Shanghai 自然日；金额、配额和用量未知时排序置后或显示未知，不渲染虚构的 0。

| ID | 需求 | 规则 | 关键实现 | 状态 |
| --- | --- | --- | --- | --- |
| U-01 | 5H/7D/Fable 窗口 | 显示剩余比例、解除时间和调度可用性 | 未知配额不等于已满；窗口重置时间和健康状态分离 | account-quota.mjs、window-estimate.mjs、claude-reset-credits.mjs | 已实现 |
| U-02 | 7D 预计总量 | 有足够样本和定价时估算；否则显示未知 | 不满足样本或价格条件时不虚构数值 | weekly-split.mjs、window-estimate.mjs、panel-api.mjs | 已实现 |
| U-03 | 重置后刷新 | 额度动作成功后立即写 SQLite 并刷新缓存/列表 | 避免只更新进程内状态 | claude-reset-credits.mjs、usage-persist.mjs、usage-logs-repo.mjs | 已实现 |
| U-04 | 七项用量 | 请求数、输入、输出、缓存读、缓存写、缓存命中率、费用 | 运营端和供应商端共用请求投影；按账号明细、每日桶、UTC+8 展示 | vendor-account-usage.mjs、vendor-usage.mjs、usage-projection.mjs、usage-logs-view.mjs | 已实现 |
| U-05 | 缓存事实 | 日志裁剪后从 vendor_usage_facts 补齐缓存读写 | 缓存字段可缺失；成功请求才计费用；未知价格费用为 null | 迁移 075、vendor-account-usage.mjs、usage-logs-repo.mjs | 已实现 |
| U-06 | 日期范围 | 今日、自然日和自定义范围按统一业务时区 | 业务口径统一 Asia/Shanghai UTC+8；历史 epoch 不改写 | src/shared/system-time.mjs、web/src/lib/system-time.ts、usage/settlement repositories | 已实现 |

## 8. 供应商价格、账单与结算 PRD

### 8.1 全局价格

所有供应商共用超级管理员维护的 OpenAI 单价、Claude 单价、结算汇率和北京时间生效日。价格版本按请求发生时间选取；跨版本、跨平台账期拆分。账单和付款边保存价格、汇率、合同和事实快照，历史账单不因新价格重算。

实现文件：src/lib/vendor/vendor-pricing.mjs、vendor-settlements.mjs、vendor-admin.mjs、src/lib/admin/panel-routes.mjs、web/src/features/supplier-admin/pricing.tsx、迁移 067、068、072、073。

### 8.2 预览到付款

1. 付款方选择直属下游、包含首尾日的账期和统一业务日期。
2. 服务端固定实际用量、合同、价格版本、汇率和调整项，生成 15 分钟预览令牌。
3. 预览绑定操作者、付款方、价格/事实水位；数据变化后令牌失效并要求重新预览。
4. 使用唯一 idempotency_key 生成结算草稿，逐请求分配费用，迟到事实可补单。
5. 确认后下游可见；付款登记记录线下付款完成状态，付款边按服务端权限隔离。
6. 状态支持 review、confirmed、partial、paid 和未付款 void；已付款历史保留占用周期。

实现文件：src/lib/vendor/vendor-settlements.mjs、vendor-portal-view.mjs、vendor-admin.mjs、web/src/features/vendor、web/src/features/supplier-admin、迁移 069、070、072、074、075。

已知限制：付款冲正、收款争议、跨合同周期自动拆单和结算导出尚未实现。

## 9. 请求、调度、重试和运行事实 PRD

### 9.1 请求生命周期

协议入口为 handle-protocol.mjs、handle-codex.mjs、api-protocol.mjs、api-images.mjs 和 WebSocket 处理器。routing-runtime.mjs 在请求开始时生成不可变 runtime snapshot，冻结路由、Key、分组、资源、模型、策略、价格和账号保护 revision。

请求和 attempt 采用以下事实：

    request: received -> authenticated -> planned -> queued -> admitted
             -> executing -> downstream_committed -> finalizing -> finalized
    attempt: selected -> prepared -> not_sent -> sent -> ambiguous
             -> response_started -> response_committed -> completed/failed/cancelled

downstream_committed 后不得换号、重放、改变 HTTP 状态或重复计费。ambiguous 只记录发送不明事实，不能自动把正文重放到另一个账号。一个 request 可有多个 attempt，但失败 attempt 不创建第二个 request。

关键实现：src/lib/core/runtime-snapshot.mjs、src/lib/admin/routing-runtime.mjs、src/lib/pool/pool-scheduler.mjs、failover-runner.mjs、request-attempts-repo.mjs、src/lib/transport、迁移 053、057、058、060、071。

### 9.2 调度策略

PoolScheduler 原子保留候选资源，综合 Key、用户、商业分组、平台、账号/VM、代理、5H/7D/Fable、会话亲和和资源 owner。GPT/Codex 具备 Smart、权重和亲和策略；Claude schedule_level、Codex weight、Smart 评分和 group_resources.priority 保持不同作用域。

队列、容量、RPM、配额、账号错误保护和上游限流分别记录，不能把所有等待归为同一类。请求总 deadline、队列等待预算、lease TTL、单次 attempt 超时和流空闲超时分别保存。

关键实现：codex-scheduling-policy.mjs、codex-slot-pool.mjs、openai-account-selector.mjs、schedule-eligibility.mjs、schedule-state.mjs、sticky-router.mjs、weekly-split.mjs。

### 9.3 账号错误保护

account-error-protection.mjs 编译规则并生成 fingerprint；运行时按账号、credential revision 和 policy revision 进行 SQLite CAS 状态更新。默认关闭，账号保护与调度 circuit、真实额度、客户 Key 余额和账务事实分离。管理员可审计冻结、清除可解除冷却和恢复状态。

当前限制：跨控制面共享存储、后台自动 probe、完整诊断 ZIP 尚未完成；本地实现不代表多副本生产环境已验证。

## 10. API Key、模型目录、协议与图片接口 PRD

官方 Claude/OpenAI 模型目录、API Key 模式、分组模型白名单和 /v1/models 投影统一受授权范围控制。用户看到的模型必须能通过当前 Key 实际路由，未授权模型稳定拒绝。关键实现：key-scope.mjs、key-models.mjs、codex-catalog.mjs、codex-model-mapping.mjs 和相关前端表单。

OpenAI Images 支持 /v1/images/generations 和 /v1/images/edits：multipart 输入由 image-edit-multipart.mjs 转为内部 JSON，再进入既有 scheduler/kernel 运行链；复用 Key 权限、并发/RPM、授权、价格和一次结算规则；SSE usage 和错误终态统一写入 usage evidence。关键文件：src/lib/pool/api-images.mjs、src/lib/protocol/handle-protocol.mjs、usage-evidence.mjs、src/lib/transport、test/unit/api-images.test.mjs。Codex 原生 Images 路径和 x-codex-image-turn-id 保持独立，不与 API Key Images 混用。

Anthropic Messages、OpenAI Chat/Responses、Codex Responses 和 WebSocket 共享 attempt、usage、响应 owner、缓存前缀和终态规则。多行 SSE、工具调用、图片、usage、取消、部分失败和上游错误分别测试。核心入口：api-protocol.mjs、handle-codex.mjs、handle-protocol.mjs、responses-ws.mjs、go-worker-client.mjs。

## 11. VM、集群、KVM 与网络运行时 PRD

请求运行上下文由 VM 运行时生成，控制面通过 Go/Rust worker、kernel supervisor、KVM host、remote slot、socket relay 和 cluster placement 连接 guest。代理有透明出口和显式出口两种契约；透明 kin-eg-* 网络不把代理 URL 重复写入 guest，显式路径保持 proxy_required，禁止直连回退。

关键文件：src/lib/vm、src/lib/cluster、src/lib/transport、worker、docker/kin-kvm、docker/kin-os、deploy。节点预检按创建内存校验，代理槽位在 Docker 重启后不能抢先直连；地址池扩容脚本负责预留远程代理出口容量。

真实 guest/KVM、iptables、外网 egress 和 Linux 原生 CLI 仍需部署验收，当前静态分析不能替代端到端运行证据。

## 12. 日志、审计、错误与安全 PRD

- 管理员、用户、供应商使用记录按登录角色显示不同列；筛选区紧凑化，响应模型显示真实请求模型和响应模型。
- 请求体处理区分超时 408、客户端断开 499 和其他 malformed body 400；业务 body timeout 可配置。
- 代理、OAuth、Key、Cookie、完整用户正文和授权码不得进入普通日志、诊断导出或 UI 提示；代理错误不回显地址、用户名或密码。
- 请求日志、attempt、usage evidence、结算事实和业务审计是不同投影；日志清理不改变已确认费用和账单。
- JEV/风险拦截按配置启用，密钥 GET 脱敏，错误放行原因可解释。

关键实现：src/lib/admin/request-log.mjs、src/lib/db/repos/usage-logs-*、src/lib/protocol/log-fields.mjs、src/lib/core/errors.mjs、src/lib/http/respond.mjs、src/lib/core/runtime-secrets.mjs。

## 13. 前端、品牌、多语言和时间 PRD

欢迎页按 TapModels 原稿和项目规范重构，提供真实管理员截图、主题、CTA 和控制台入口；侧栏 Logo、favicon、网站副标题和登录焦点统一。入口按身份分流，直接访问登录地址不返回 404。关键目录：web/src/features/welcome、web/src/features/settings、web/src/features/vendor、web/src/features/supplier-admin、web/src/routes、web/public/welcome、web/src/assets。

四语资源覆盖新增角色、供应商、结算、错误、状态、授权和欢迎页文案；界面不能留下直接写入的业务文案。关键目录：web/src/i18n、web/src/lib/i18n、供应商/运营组件和 i18n 测试。

业务日期、今日范围、账单账期、用量桶、额度重置、到期时间和 UI 展示统一按 Asia/Shanghai UTC+8；历史 epoch 不改写。后端入口为 src/shared/system-time.mjs，前端入口为 web/src/lib/system-time.ts。供应商接口文档中允许任意 IANA timezone 的旧描述已被本文现行契约覆盖。

## 14. 发布、部署与工程治理 PRD

同版本定制推送只跑 CI，不自动发版；上游版本实际递增且基线核验通过时，按原上游版本号自动发布应用、guest/KVM 镜像和配套资产。GitHub Release 说明只展示最近 10 个定制版本条目，完整说明留在仓库文档。

关键文件：.github/workflows/release.yml、guest-images.yml、test.yml、upstream-sync.yml、scripts/release/plan.py、publish.py、guest_image_policy.py、upstream_release_guard.py、smoke_image.py。

Dockerfile/Compose 支持控制面、ARM64、payload 校验和反代 HOST；安装脚本处理环境初始化、地址池、备份和必要重启。在线更新把 GitHub 检查和升级状态解耦，展示阶段和失败原因。

关键文件：Dockerfile、docker-compose.yml、docker-compose.arm64.yml、deploy/install.sh、deploy/configure-docker-address-pools.py、scripts/panel-upgrade.sh、scripts/docker-entrypoint.sh、scripts/fetch-payload.mjs。

同步任务默认采用上游方案并清理被替代定制；正式 main 保持一个上游父提交加一个定制提交。完整规则见 CHANGE_DELIVERY.md 和 UPSTREAM_SYNC.md。这些文件属于交付工程治理，不与运行时业务需求混为一谈。

## 15. 数据模型与迁移总览

已应用迁移不可改写；新需求只能追加迁移并保留历史数据。当前定制迁移按功能归类如下：

| 迁移 | 领域 | 目的 |
| --- | --- | --- |
| 039–055 | 代理、集群、用户分组、用量、JEV、窗口、角色 | 建立基础运行、统计和权限事实 |
| 056–060 | 供应商平台、runtime config revision、账号保护、请求日志 revision | 供应商资源与 CPR P0 运行事实 |
| 062–068 | 供应商账单档案、管理员数据域、代理元数据、钱包、合同价格、运营备注 | 供应商隔离和合同管理 |
| 069–070 | 完成用量收费、结算预览/分配/幂等 | 结算终态和付款边事实 |
| 071 | Codex response owner | continuation/response 归属持久化 |
| 072–075 | 全局供应商价格、移除旧钱包账本、响应模型、供应商用量缓存 | 当前价格、用量和 UI 契约 |

数据库访问统一经过 src/lib/db/database.mjs、src/lib/db/repos 和迁移加载器；领域服务不应直接拼接跨域 SQL。供应商列表、用量、账单和代理操作必须同时校验 owner、角色和状态。

## 16. 验证与验收矩阵

| 风险域 | 最小验收 | 当前证据 | 仍需环境验收 |
| --- | --- | --- | --- |
| 权限和数据域 | 角色矩阵、跨供应商拒绝、父级隔离、无权限页面 | Node/HTTP/前端定向回归、浏览器隔离账号 | 生产身份系统 |
| 供应商账号 | 草稿、平台联动、自动命名、幂等、归档、历史保留 | 供应商/VM/前端回归 | Linux guest 自动启动和真实 OAuth |
| 代理和出口 | 绑定、批量探测、脱敏、解绑、地址池配置 | ProxyPool/HTTP/部署脚本测试 | Docker 多网络和真实出站 |
| 用量和结算 | 七项统计、未知值、自然日、价格版本、预览 token、幂等 | 数据库/供应商/前端定向回归 | 真实供应商账单事实 |
| 调度和重试 | snapshot、发送状态、ambiguous 禁止重放、response owner | CPR/Codex/协议回归 | 多控制面并发和长时运行 |
| 协议和图片 | Chat/Responses/Anthropic/WS/Images、SSE usage、部分失败 | unit/e2e/协议夹具 | 真实付费模型 |
| 发布和部署 | TypeScript/Vite、CI 工作流、payload/ARM 合约 | 本地和 CI 定向检查 | GitHub 完整发布、ARM/KVM 镜像 |
| 多语言和时间 | 四语键完整、UTC+8 日期桶、错误文案 | i18n/前端回归 | 生产浏览器时区组合 |

本任务只新增文档，不重新运行与业务代码无关的全量测试。文档验证使用 git diff --check、链接/路径核对和当前 Git 基线核对；已有行为证据沿用匹配源码、依赖和输入未变化的定向验证。

## 17. 尚未完成、不能宣称已交付的范围

1. 真实 Linux guest/KVM、/dev/kvm、iptables、代理出口和外部 OAuth 换票。
2. 真实供应商凭据、收费推理、生产部署和生产数据库迁移。
3. 支付冲正、收款争议、跨合同周期自动拆单、结算导出和完整对账审批。
4. CPR P1 的跨节点统一 lease、独立结算账本、全量 Provider/Resource adapter 和插件 Runtime。
5. 完整的自动恢复 probe、跨控制面账号保护和诊断 ZIP。
6. sub2api 的全套批量导入导出、全站 RPM/TPM 统一模型和未被当前需求引用的 OAuth 兼容路径。

## 18. 技术实施顺序

| 阶段 | 依赖 | 交付内容 |
| --- | --- | --- |
| P0 数据与权限 | SQLite、迁移、repository | 迁移、资源 owner、角色 capability、字段白名单、审计和 revision |
| P1 运行资源 | P0 | VM、代理池、egress、cluster、transport、OAuth 执行上下文 |
| P2 调度与协议 | P0、P1 | snapshot、PoolScheduler、FailoverRunner、send_state、usage evidence、图片和 WS |
| P3 供应商门户 | P0、P1、P2 | account draft、配对 VM、AccountWorkbench、用量、价格和结算 |
| P4 前端和多语言 | P0–P3 | 路由、权限投影、欢迎页、品牌、四语、UTC+8 组件 |
| P5 CI、发布和部署 | P0–P4 | 工作流、payload、ARM64、地址池、在线更新和回滚证据 |

每个实现任务必须说明输入/输出契约、事务边界、状态机、幂等键、缓存失效、审计点和测试范围。涉及权限、账务、协议流、持久化或运行资源时，不能以编译通过代替契约回归。

## 19. 风险和长期演进

- SQLite 加进程内缓存/锁不能提供多实例协调；在没有多控制面需求前不为引入 Redis 而引入 Redis。
- 请求在响应已提交后无法无损换号；ambiguous 发送必须禁止正文重放。
- 供应商账号暂停、归档和父级停用需要关闭调度，但保留历史事实和账单。
- usage_logs 裁剪后只能由 vendor_usage_facts 补齐已持久化缓存事实；不能从缺失数据推算。
- 未知价格、额度、用量和支付资料必须显示未知或 null，不能回退为 0。
- 供应商账号列表当前采用全量传输后的本地筛选，大账号量下有带宽和首屏开销。
- 全局价格按北京时间生效，历史账单使用冻结快照；任何改价都不能重算已确认历史。

## 20. 完整文件覆盖索引

本文按领域列出关键入口；当前 1,249 个定制路径的逐文件清单见 [CUSTOMIZATION_CURRENT_FILE_MAP.md](CUSTOMIZATION_CURRENT_FILE_MAP.md)，历史累计增删行数和二进制资源见 [CUSTOMIZATION_FILE_INDEX.md](CUSTOMIZATION_FILE_INDEX.md)。当前技术层覆盖如下：

| 技术层 | 覆盖路径 | 主要职责 |
| --- | --- | --- |
| 控制面与权限 | src/server.mjs、src/lib/admin、src/lib/http | HTTP 路由、角色、数据域、品牌、日志和管理 API |
| 供应商领域 | src/lib/vendor、web/src/features/vendor、web/src/features/supplier-admin | 账号、配对 VM、代理、用量、价格、结算和门户 |
| 调度与协议 | src/lib/pool、src/lib/protocol、src/lib/transport | Key、模型、请求、SSE/WS、图片、重试和终态 |
| OAuth 与 VM | src/lib/oauth、src/lib/vm、src/lib/cluster、worker | 授权、运行时、KVM/容器、代理和 egress |
| 数据层 | src/lib/db、src/shared | SQLite、迁移、repository、共享时间和筛选契约 |
| 前端 | web/src/features、web/src/routes、web/src/components、web/src/i18n | 控制台、供应商门户、欢迎页、四语和 UI 状态 |
| 部署与发布 | .github、deploy、docker、docker-compose、scripts、Dockerfile | CI、发布、payload、ARM64、地址池和在线更新 |
| 回归与验收 | test | unit、HTTP、E2E、部署、发布和上游预检 |
| 需求和交付文档 | docs、AGENTS.md、PRODUCT.md、README.md | 产品、契约、交付、风险、部署和历史证据 |

若需逐个文件定位某项需求，先按本文领域表确定服务入口，再用 CUSTOMIZATION_FILE_INDEX.md 查找完整路径，最后回到对应测试和迁移；不要只按文件名或目录名判断功能归属。
