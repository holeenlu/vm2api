# CPR 研究证据索引

## 基线

本轮核对命令使用本机工作树：

```text
CPR root:     /Users/luhonglin/Git/codex-proxy-rs
CPR commit:   958e13c3 (main, v3.35.0)
tapmodels:    /Users/luhonglin/Git/vm2api
tapmodels:    51955eb3 (main)
date:         2026-10-29
```

两边工作区在研究开始时均无未提交差异。本轮只读研究，没有修改 CPR。

## CPR 架构与 API

| 主题 | 文件 | 重点 |
| --- | --- | --- |
| 系统定位与运行拓扑 | `codex-proxy-rs/docs/architecture.md:14-96` | Core/Admin/API/Store/Host/Provider/Plugin 边界；PostgreSQL、Redis、S3/R2 的状态分工 |
| 插件职责与发布 | `codex-proxy-rs/docs/architecture.md:98-171` | SDK、Runtime、manifest、快照、实例隔离、故障处理和业务事实所有权 |
| 请求生命周期 | `codex-proxy-rs/docs/architecture.md:394-482` | snapshot、attempt、send state、delivery commit、retry/fallback 安全边界 |
| Provider 边界 | `codex-proxy-rs/docs/architecture.md:483-697` | OAuth、目录、额度、出站代理、导入和协议差异的 owner |
| 路由、continuation、排队 | `codex-proxy-rs/docs/architecture.md:698-880` | 智能调度、native continuation、会话亲和、队列、Key 预算和费用 |
| 控制面 revision | `codex-proxy-rs/docs/architecture.md:881-942` | 事务、审计、快照发布、Redis 通知和配置冲突 |
| 观测、预测和请求记录 | `codex-proxy-rs/docs/architecture.md:988-1085` | 有界观测、统计投影、quota forecast、attempt 完整性、费用来源 |
| Worker、错误保护和恢复 | `codex-proxy-rs/docs/architecture.md:1086-1196` | Worker 所有权、账号冻结、日志脱敏、在线更新、备份恢复 |
| 数据面协议 | `codex-proxy-rs/docs/api.md:15-80`, `208-380` | Client Key、版本门禁、Responses、Chat、Images、Search、模型目录 |
| Key/组/运行设置 | `codex-proxy-rs/docs/api.md:1473-1627`, `1757-1842` | 账号组、Client Key、并发、智能调度、亲和和限额 |
| 备份、更新、插件 | `codex-proxy-rs/docs/api.md:2068-2148`, `2423-2795` | 业务备份、系统更新、插件管理、实例和兼容性 |
| 部署与恢复 | `codex-proxy-rs/deploy/README.md:495-840` | 持久化、日志、在线更新、插件兼容、人工恢复 |

## CPR 关键源码

| 主题 | 文件 | 关键事实 |
| --- | --- | --- |
| Core 端口 | `backend/crates/gateway-core/src/lib.rs` | CoreStorePorts、ExecutionService、ProviderRegistry、SnapshotControl 和启动恢复 |
| Operation/能力 | `backend/crates/gateway-core/src/operation.rs` | Provider 无关 operation、Feature、opaque payload 和 continuation state |
| 客户准入 | `backend/crates/gateway-core/src/engine/admission.rs` | admission、lease maintain、abandon、release、启动恢复 |
| continuation | `backend/crates/gateway-core/src/engine/continuation.rs` | Client Key/Provider/账号 pin、opaque response ID、ownership mismatch |
| snapshot | `backend/crates/gateway-core/src/routing/snapshot.rs` | 配置事实、Key/组/账号、目录代次、模型能力和计划编译 |
| snapshot publisher | `backend/crates/gateway-core/src/runtime/publisher.rs` | committed refresh、后台刷新抢占、失败暂停和 revision 通知 |
| observation | `backend/crates/gateway-core/src/engine/observation.rs` | RequestObservation、WS observation、outcome、usage、cost、timing |
| diagnostics | `backend/crates/gateway-core/src/diagnostics/capture.rs`、`trace.rs` | 有界摘要、fingerprint、脱敏、evidence 预算和 trace 丢失计数 |
| error protection | `backend/crates/gateway-core/src/account/error_protection.rs` | 规则 DSL、校验、编译、fingerprint 和匹配 |
| metering | `backend/crates/gateway-core/src/metering/mod.rs`、`pricing.rs` | Decimal、Money、Usage、CostSource、价格覆盖和倍率 |
| Provider | `backend/crates/providers/openai/src`、`xai/src` | 凭据、目录、额度、transport、错误和上游适配 |
| plugin SDK | `backend/crates/gateway-plugin/sdk/docs/capabilities.md`、`upstream-adapters.md` | 中间件、目录、调度、重试、观测、服务和受管出站 |

## CPR 近期演进证据

| 提交 | 主题 | 说明 |
| --- | --- | --- |
| `736eca65` | configurable account error protection | 从容量冻结升级为规则、策略 revision、Redis generation 和恢复探测 |
| `005466bc` | Chat Completions through Responses | 协议投影复用 Responses 执行链，新增大量 request/response contract tests |
| `3f95f8b0` | diagnostic evidence and ZIP bundles | 保留 evidence、导出 ZIP、统一可用性和缺口语义 |
| `2f3c1787` | WebSocket lifecycle | 心跳、连接归属、续接和回收边界持续修正 |
| `60e6bc01` | remove model catalog v1 | 插件目录合同主动收敛，旧版本不永久兼容 |
| `af9790ac` | managed HTTP replay safety | 只对证明安全的受管 HTTP 429 允许有限重放 |

## tapmodels 对照证据

| 主题 | 文件 | 当前能力 |
| --- | --- | --- |
| 产品与隔离目标 | `README.md:69-168` | VM/KVM、真实客户端、独立出口、风险审计、集群、Key/额度 |
| 运营模型 | `docs/RELAY_OPERATIONS.md:7-140` | VM/API 供给、商业分组、用户、Key、钱包、套餐、结算和权限设计 |
| 请求恢复 | `src/lib/pool/failover-runner.mjs` | 账号切换、重试 deadline、session queue、容量/限流错误和恢复动作 |
| kernel 错误恢复 | `src/lib/transport/go-worker-client.mjs:367-436` | committed、incomplete、错误状态恢复和空响应处理 |
| API 调度 | `src/lib/pool/api-scheduler.mjs` | endpoint/model/key 轮询和模型目录 |
| 代理池 | `src/lib/vm/proxy-pool.mjs:1-63` | 多协议代理、容量、探测、失败禁用、绑定 VM 和出口时区 |
| 请求日志与计费字段 | `src/lib/admin/request-log.mjs:1-220` | normal/debug、脱敏、usage、图片、搜索、价格来源和保留 |
| 备份 | `src/lib/admin/backup-service.mjs:1-36` | 在线一致性快照、manifest、SHA、worker、restore 期间 503 |
| 在线更新 | `src/lib/admin/release.mjs` | 版本解析、架构、下载、更新和发布信息 |
| 供应商平台 | `docs/supplier-platform/02-permission-matrix.md`、`07-implementation-and-acceptance.md` | 角色、能力范围、资源、结算、验收和回退边界 |

## 本轮核查命令

以下命令用于生成研究范围和现状索引；它们不是业务验证：

```text
git -C /Users/luhonglin/Git/codex-proxy-rs status --short --branch
git -C /Users/luhonglin/Git/codex-proxy-rs log -8 --date=short --pretty='%h %ad %s'
git -C /Users/luhonglin/Git/vm2api status --short --branch
git -C /Users/luhonglin/Git/vm2api log -8 --date=short --pretty='%h %ad %s'
rg --files /Users/luhonglin/Git/codex-proxy-rs
rg --files /Users/luhonglin/Git/vm2api
rg -n '^#{1,4} ' codex-proxy-rs/docs codex-proxy-rs/deploy
rg -n 'revision|snapshot|attempt|continuation|diagnostic|quota|backup|plugin' vm2api/src vm2api/docs
```

## 证据限制

- 研究依据是本地源码和文档，没有把 CPR 的远程 CI、生产配置或线上预览当作行为证明
- CPR 文档非常详细，但规划采用前仍需回到对应源码和测试确认边界
- tapmodels 的一些功能分散在 Node、Go、Rust、VM 和控制台，名称相同不代表语义等效
- 本目录没有执行真实供应商推理、生产数据库迁移、Docker 部署或远程节点操作
