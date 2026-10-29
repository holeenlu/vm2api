# CPR 研究结论与能力矩阵

## 研究范围

本轮研究覆盖 CPR 的运行拓扑、`gateway-core` 请求执行、Provider 边界、账号和额度、并发、观测、计量、插件、备份、在线更新和管理 API；同时对照 tapmodels 的协议入口、VM/节点、调度、代理、请求日志、计费、备份和供应商平台。

研究依据是 CPR `main@958e13c3` 与 tapmodels `main@51955eb3` 的本地工作树。源码和文档位置集中列在 [证据索引](04-evidence-index.md)。

## 结论先行

CPR 最值得吸收的是一套稳定的业务事实模型：

```text
客户端请求
  -> 冻结权限与运行快照
  -> 客户准入与资源租约
  -> 一个或多个受控 attempt
  -> 明确的上游发送状态和下游交付提交点
  -> 幂等结算
  -> 有界、可标记完整性的观测与诊断
```

tapmodels 的核心优势仍然是 VM 级隔离、真实客户端进程、独立网络出口、跨 VPS 舰队、Claude/OpenAI 双平台和供应商运营能力。CPR 的单进程、单副本、固定 Provider 约束不能作为整体架构迁移。

最值得进入开发计划的三个主题是：

1. 将请求、attempt、发送状态、交付和结算收敛为一个跨 VM/API 的生命周期模型
2. 把账号错误保护从分散的熔断、冷却和错误分支提升为可编辑、可版本化的策略
3. 把观测、诊断和费用账本分别建模，并明确数据完整性、幂等和脱敏边界

## 能力矩阵

| 领域 | CPR 的方案 | tapmodels 当前对应 | 结论 | 优先级 |
| --- | --- | --- | --- | --- |
| Core/Provider 边界 | Core 只持有 operation、能力、路由、租约、交付和计量；Provider 持有凭据、目录、额度和 transport | Node 控制面、Go/Rust kernel、VM runtime、协议和供应商模块已经分层，但部分调用通过共享对象连接 | 为跨 VM/API 资源建立 typed port；保留现有运行时 | P0 |
| Runtime snapshot | 配置、Key 范围、模型权限、Provider 候选和调度在请求开始时冻结 | 路由、Key scope、池状态和配置读取分散在入口与调度器 | 改造采用；新增请求计划快照，减少热路径二次读取 | P0 |
| Config revision | 管理提交推进 revision，编译并原子发布快照；无法确认时暂停新请求 | 部分资源有 `updated_at`/revision，系统设置主要是 JSON key-value | 改造采用；增加统一运行配置 revision，资源 revision 继续独立 | P0 |
| Request/Attempt | 一个请求一条权威记录，attempt 是请求内事实；换号和重试不建第二个请求 | `request_logs`、`request_attempts`、`failover-runner` 已有事实，但 VM/API 仍有不同路径 | 直接采用概念，统一现有两条链 | P0 |
| Send state | `not_sent`、`sent`、`ambiguous` 单调推进，决定是否允许重放 | kernel client 已有 committed/incomplete/error 恢复判断，但名称和边界不完全统一 | 直接采用状态和不变量 | P0 |
| Delivery commit | 下游首个不可撤回交付后禁止换号、重试和 fallback | 流式响应已有 committed/terminalState 逻辑 | 补齐为公共契约，避免各协议自行解释 | P0 |
| Native continuation | continuation 绑定 Client Key、Provider、账号和 scope；opaque handle 不由 Core 解释 | `sticky-router`、session、Codex previous response 和 WS 已存在 | 改造采用，统一所有协议的归属和失效原因 | P1 |
| Admission/queue | 队列位置与 Redis lease 分离；同级 FIFO；TTL 不等于执行 deadline | pool scheduler、session queue、Key RPM、账号并发已存在 | 统一 VM/API 入口的准入、等待和租约 | P0 |
| Account error protection | 可编辑规则匹配 Provider/status/code/type/message；策略 fingerprint + Redis generation + 探测恢复 | `unit-circuit`、冷却、`upstream-error-policy` 和健康探测分散实现 | 直接采用核心设计，保留 tapmodels 的风险和供应商分类 | P0 |
| Quota forecast | 只读派生预测，不改变 quota 权威状态；按 reset window、采样段和回落中断计算 | `window-estimate`、quota window/history 已有 | 已有等效基础；吸收采样可信度和缺失语义 | P1 |
| Observation | RequestObservation/attempt/WS event 有类型化字段，异步投影允许丢失并显式标记 | request log、usage log、attempt repo 和导出已存在 | 改造采用，建立完整性字段和单一事实源 | P0 |
| Diagnostics | 有界 trace、证据保留、统一脱敏、body fingerprint、ZIP/JSON/text 导出 | debug log、error class、诊断路由和日志保留已存在 | 直接采用边界和导出语义，避免保存完整正文 | P0 |
| Metering | Provider 报告、网关计算、不可用三种费用来源；价格和倍率随请求冻结 | pricing、relay billing、usage logs 已有 | 改造采用，独立 settlement ledger | P0 |
| Model catalog | `/v1/models`、详情、Key 范围和 Provider 目录复用同一 snapshot；插件 alias 直接映射 | model policy、Codex catalog、API endpoint catalog 多处存在 | 统一目录事实；不复制 CPR 的 Provider 假设 | P1 |
| Chat compatibility | Chat Completions 转 Responses，共用执行链，出口只做协议投影 | tapmodels 已有 Chat/Responses/Anthropic 入口 | 已有等效能力；补充 shared lifecycle 和 contract tests | P1 |
| Account outbound proxy | 代理绑定账号，OAuth/额度/目录/推理共用出口；不可用不静默直连 | VM 与 proxy pool 已有更强的独立出口约束 | 已有等效基础；吸收 revision、池隔离和无回退契约 | P1 |
| Plugin runtime | SDK + subprocess Runtime + manifest + capability version + instance isolation | vendor、transport、cluster、slot provider 是内部扩展边界 | 暂缓完整插件；先定义 typed provider ports | P2 |
| Admin Key self-service | Client Key、组范围、用量、配置生成和客户端版本门禁 | API Key、组、用户、供应商平台和配置生成已存在 | 改造采用版本门禁和权限快照 | P1 |
| Backup/update | 业务备份、完整数据库、日志、插件包、Redis 分开；更新有摘要、锁和原子回滚 | SQLite/VM backup、release/update 已有 | 已有等效基础；吸收恢复边界和配置 revision 复核 | P1 |
| Single replica | CPR 明确不支持复制应用容器扩容 | tapmodels 已有多 VPS、节点、VM 和远程 Docker | 排除 | — |
| PostgreSQL/Redis/S3 topology | CPR 的集中式存储组合 | tapmodels 当前 SQLite、内存 transient state、文件和远程节点；没有 CPR 同样的 Redis 主协调组件 | 暂缓整体迁移；只按需求引入一致性契约 | P2 |

## 值得学习的设计细节

### 1. Core 不解释 Provider 私有协议

CPR 的 `gateway-core` 只理解稳定 operation、能力要求、Provider 候选、租约、错误、canonical event、计量和交付边界；OpenAI/xAI 的凭据、OAuth、模型目录、额度、transport 和正文兼容都在 Provider 内。

对 tapmodels 的启示是：VM、API endpoint、Claude kernel、Codex kernel 和未来供应商适配器都应实现同一组资源端口。Node/Go/Rust 之间传递稳定事实，不让控制面读取某个 Provider 的私有 wire 字段来决定通用重试。

建议保留的稳定事实包括：

- `OperationKind`：generate、image、search、count tokens、provider HTTP
- `CapabilityRequirements`：tools、vision、reasoning、JSON schema、native continuation
- `ResourceCandidate`：资源 ID、Provider、模型能力、健康、可等待状态
- `AttemptResult`：发送状态、响应状态、上游 request ID、用量、费用、恢复意图

### 2. RuntimeSnapshot 是请求一致性的核心

CPR 在请求开始时冻结 Client Key 的账号组、模型政策、模型映射、最低客户端版本、Provider 候选、调度策略和扩展集合。管理提交触发快照编译；后台目录刷新不能覆盖已提交的新配置。

tapmodels 目前在请求入口、Key scope、model policy、VM pool、API endpoint 和 scheduler 中分别读取事实。建议建立一份轻量的 `RequestPlanSnapshot`，不复制正文，只保存：

- 配置 revision
- Key、用户、分组和资源范围快照
- 模型与协议能力快照
- 选路策略和重试预算
- 计费价格 revision
- 风控和账号保护策略 revision

请求执行期间只使用这份快照；配置修改只影响新请求和下一次 WebSocket 轮次。

### 3. 重试安全性必须基于事实而不是错误文案

CPR 把发送状态、交付提交、外部副作用、continuation 绑定、剩余预算和 Provider 明确的恢复意图组合起来。单纯看到 429、502 或空响应，不能自动推导“可以换号”。

tapmodels 的 [failover-runner.mjs](../../src/lib/pool/failover-runner.mjs) 和 [go-worker-client.mjs](../../src/lib/transport/go-worker-client.mjs) 已有很多正确判断，下一步应统一命名和状态转移：

```text
prepared
  -> not_sent
  -> sent
  -> ambiguous

downstream_uncommitted
  -> downstream_committed
```

只有 Provider 明确声明的恢复路径能改变状态；协议层只能投影错误和 retry-after，不能自行改写重试资格。

### 4. 错误保护要和额度冷却、熔断、风控分开

CPR 的错误保护记录结构化失败事实，不保存原始错误正文；策略变更通过 fingerprint 让旧计数失效；恢复探测使用冻结代次，迟到探测不能解除新冻结。

tapmodels 需要保留以下独立概念：

- **客户内容风控**：进入资源池前判断请求是否允许
- **Provider quota/rate cooldown**：上游明确给出的时间窗口
- **Transport circuit**：连接、TLS、socket 或 worker 故障
- **Account error protection**：某账号连续出现可配置的错误事实
- **Resource schedulable**：管理员是否允许资源接受新请求

它们可以共同影响调度，但不能共用一列 `status` 或相同恢复逻辑。

### 5. 观测允许不完整，但必须诚实

CPR 的请求观测、WS 事件和诊断 trace 都使用有界容量；队列满、Store 暂不可用或进程退出可能导致观测缺失，但不会改变已经提交的客户端响应和结算结果。接口会标记 `attemptsComplete`、丢失事件和导出缺口。

tapmodels 的 debug 记录已经有敏感字段脱敏和保留窗口，建议再增加：

- `observation_complete`
- `attempts_expected` / `attempts_recorded`
- `diagnostic_dropped_events`
- `send_state`
- `settlement_state`
- `upstream_request_ids[]`

这样运营人员能区分“没有发生”“发生但没有观测到”和“请求尚未结束”。

### 6. 费用账本不能依赖日志

CPR 将费用事件、Key 预算和请求观测分开，价格和倍率在请求开始时冻结，费用事件以 request ID 幂等写入。

tapmodels 当前已经有 `pricing.mjs`、`relay-billing.mjs` 和 usage logs。建议增加单独的 `settlement_events` 事实：

```text
request_id + attempt_id + settlement_kind -> one event
```

事件保存费用来源、价格版本、倍率版本、Provider 报价、网关估算和最终结算状态。日志清理、重新计价和历史聚合重建不能改变已经确认的客户余额。

## 与 tapmodels 的实际差异判断

### tapmodels 已经更强的领域

- VM/KVM/容器槽位和多 VPS 节点舰队
- 每槽独立网络出口和代理池
- 官方 Claude Code / Codex 真实进程与 kernel 转发
- 硬件、系统、时区、遥测和身份拟真
- 供应商平台、用户、分组、Key、余额、套餐和角色权限
- 风险审计、拒答缓存、设备封禁和多层调度
- 运行中槽位管理、远程终端和节点级运维

这些能力不应因为参考 CPR 而改成 CPR 的单机 Provider 网关模型。

### CPR 明显更成熟的领域

- Core/Provider/Store/API 的稳定端口边界
- 请求 snapshot 与 config revision 的一致性
- attempt、发送状态和下游提交的公共语义
- 账号错误保护策略化
- 诊断 evidence、trace 限额和导出完整性
- 费用账本与请求观测分离
- 插件能力版本、实例生命周期和故障隔离

这些是本计划的主要吸收范围。

## 不采用的方案及原因

| CPR 方案 | 不采用原因 | 替代方式 |
| --- | --- | --- |
| 单进程、单副本 | 与 tapmodels 的跨 VPS 和远程槽位模型冲突 | 保留控制面 + 节点 + 槽位的拓扑；只吸收状态所有权 |
| 全面 PostgreSQL 化 | 当前 SQLite/文件/节点同步已经形成运行契约，迁移成本和数据风险高 | 在现有存储上增加事务、revision、幂等和恢复语义 |
| 固定 OpenAI/xAI Provider | tapmodels 的主资源是 Anthropic/Claude/Codex VM 和 API endpoint | 建立通用 Provider/Resource port，不限定 Provider 数量 |
| 完整插件系统一次性落地 | 会引入供应链信任、子进程、包发布和兼容矩阵 | 先做内部 typed adapter；出现第三方扩展需求再拆 SDK |
| 完整 Rust 重写 | 不能自动解决现有业务事实和运行边界，且会打断 kernel/VM 生产链 | 在 Node/Go/Rust 之间先统一合同和状态模型 |
