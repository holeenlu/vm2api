# 主线程减负第二、三阶段计划

状态：计划，未实施。日期：2026-11-03。基线：`main` `d286a438`（上游 `f8f9ddf6` + 累计定制提交）。

本文承接第一阶段（出口进程检查改为进程内读 `/proc`、面板请求复用账号快照，见 `docs/CUSTOMIZATION_RELEASE_NOTES.md` 2026-11-03 条目）。和 [目标架构](../ARCHITECTURE_TARGET_20261102.md) 的关系：目标架构是 PostgreSQL + Redis 时代的多实例拓扑；本文是仍在 SQLite 上、先把一个进程拆成两个的过渡方案，接口边界按目标架构的 Gateway / Panel / Scheduler 划分，以便后续直接沿用。

本文不授权生产部署、数据迁移或发版。

## 0. 前置条件与决策门

第二、三阶段改动量大，且显著扩大与上游的定制差异（`server.mjs`、`panel-routes.mjs`、调度模块都是上游频繁修改的文件）。按项目“上游优先、最小定制差异”原则，必须有实测依据才启动。

**第一阶段部署后先复测**（服务器本机，峰值时段，各至少 30 分钟）：

| 指标 | 采集方式 | 启动第二阶段的门槛 |
| --- | --- | --- |
| `/healthz` 延迟 | 本机每 20ms 请求一次（方法见 `docs/performance/panel-loading.md`） | p99 > 200ms，或每分钟 ≥ 3 次 > 500ms 的停顿 |
| 事件循环利用率 | `GET /api/panel/database/metrics` 的 `runtime.last_window.event_loop.utilization` | 峰值窗口持续 > 0.6 |
| 停顿归因 | 停顿时刻对齐 nginx 面板请求、strace execve、bpftrace `sqlite3_step` | 停顿主要来自面板/后台任务，而非推理请求本身 |

判断：
- 停顿主要来自**面板与后台任务** → 做第二阶段。
- 停顿主要来自**推理请求自身的计算**（大请求体解析、协议转换）→ 跳过第二阶段，直接做第三阶段 3A。
- 两项门槛都不满足 → 两个阶段都不做，只处理零散热点。

已有证据（2026-11-02/03 只读排查）：峰值约 4,000–5,000 请求/小时、约 40 条并发流；SSE 逐行处理每请求 3–4ms CPU（峰值 < 1 核的 1%）；已定位的周期性停顿全部来自面板轮询和看门狗，修复已在第一阶段。

## 1. 第二阶段：网关与控制面拆成两个进程

### 1.1 目标拓扑

```text
nginx ──/v1/*、/responses、Responses WS────────────▶ gateway 进程（数据面）
     └─/api/panel、/api/vendor、/api/admin、/admin、
        /console、面板静态、slot shell WS、集群 WS ──▶ control 进程（控制面）

gateway ◀── 内部 unix socket（internal token）──▶ control
   └──────────── 共用 kin.db（WAL）、vms/*.json、routing.json ─────┘
```

同一代码库、同一镜像，用 `KIN_ROLE=gateway|control|all` 选择角色；默认 `all` 等于现状，作为回滚开关。明确不做 PM2/cluster 多开同角色进程（调度状态在进程内存，多开会重复调度）。

### 1.2 必须留在 gateway 的进程内状态

请求路径直接读写、且无法跨进程共享的状态，全部归 gateway 独占：

| 模块 | 进程内状态 | 用途 |
| --- | --- | --- |
| `pool/pool-scheduler.mjs` | `inflight`、`vmInflight`、`waiters`、`healthCache`、`cooldownTimers`、席位规划器 `seat-planner` | Claude 准入、排队、席位 |
| `pool/account-quota.mjs` | `inflight`、`rpmBuckets`、`reservationBand`、`vmQuota` | 并发与 RPM 计数 |
| `pool/openai-account-runtime.mjs` | `slots`、`waiters`、`grantedTurns`、`holds`、`feedback` | Codex 准入、等待队列、401/5xx 短冷却 |
| `pool/codex-session-overload.mjs` | `states` | 会话级过载冷却 |
| `protocol/cache-prefix.mjs`、`thread-betas.mjs`、`cache-ttl.mjs` | 会话缓存前缀、beta pins、会话 TTL | 每轮请求复用 |
| `transport/*-kernel-supervisor.mjs`、`kernel-router.mjs` | 内核启动/重载/wrap 回收状态、健康缓存 | 发请求前确认内核可用 |
| `cluster/cluster-manager.mjs` | SSH 链路、socket relay | 远程节点槽位的数据通道 |

结论：`cluster-manager` 的 relay 是数据面通道，**必须随 gateway**；集群管理面板（节点增删、链路状态）通过 RPC 调 gateway。

### 1.3 控制面对 gateway 的依赖（需要 RPC）

| 方向 | 现有调用 | RPC 设计 |
| --- | --- | --- |
| control → gateway 读 | `poolScheduler.snapshot()/seatSnapshot()`（VM 列表、总览、`/api/panel/pool/stream`）、`accountQuota` 的进程内计数、`kernelWatchdog` 状态、集群链路状态 | `GET /internal/v1/runtime/snapshot`（一次返回 seats、inflight、rpm、健康缓存摘要）；`GET /internal/v1/runtime/stream`（SSE，替代面板直接订阅 scheduler `change` 事件） |
| control → gateway 写 | `poolScheduler.reloadConfig()`、`notifyCapacity()`、清冷却、`kernelWatchdog.hold/release`、内核重启、集群节点操作 | `POST /internal/v1/commands/<name>`，带幂等 `operation_id`；命令列表固定，不开放任意调用 |
| control → gateway 失效 | routing 保存、模型策略（`gpt-model-policy`/`model-policy` 进程内 `loaded` 缓存）、API Key `snapshot()` 缓存、分组授权 | 写 DB 后推进已有的 `runtime_config.revision`，再发 `POST /internal/v1/invalidate`；gateway 另每 2 秒比对 `revision` 兜底，RPC 丢失也能收敛 |
| gateway → control | `usageProbeMonitor.refreshAfterRequest()`（每请求）、`proxyPool.reportRuntimeFailure()`、`backupService.isRestoring` 检查 | 前两者改为 gateway 写轻量事件到 DB 表或经 RPC 投递，control 异步消费；恢复状态改为 DB 标志位 + RPC 通知 gateway 暂停 |

文件型状态（`vms/*.json` 用 mtime/size/inode 校验的读缓存、调度 hold 写 VM 文件、`panel-sessions.json`）天然跨进程可见，无需 RPC；面板会话文件需改为每次读或 mtime 校验。

### 1.4 后台任务归属

| 任务 | 归属 | 理由 |
| --- | --- | --- |
| 调度维护 `startMaintenance`、Codex 准入 | gateway | 读写 1.2 中的状态 |
| 内核看门狗 `kernel-watchdog`、出口桥自愈 | gateway | 依赖内核健康缓存与 relay；第一阶段后已无 fork 停顿 |
| `cli-node-guard`、内核 supervisor | gateway | 同上 |
| 凭证刷新 `credential-refresh-monitor` | control | 写凭证文件与 DB；gateway 通过文件 mtime 与失效通知感知 |
| 用量探测 `usage-probe-monitor` | control | gateway 侧 `refreshAfterRequest` 改为事件投递 |
| 健康探测 `health-probe`、通知 `notify`、模型目录 `catalog-monitor` | control | 只读池快照经 RPC |
| 代理池探测 `proxy-pool` | control | 回调写 VM hold 文件；`reportRuntimeFailure` 改事件 |
| 备份/恢复 `backup-service` | control | 恢复前经 RPC 令 gateway 停止接新请求并等待在途请求结束 |
| 请求日志清理、账单补价 | control | 纯 DB；统计线程 `usage-stats-worker` 随 control |
| VM 文件监视 `vm-db-sync` | 两边各自监视 | 只做本进程缓存失效 |

### 1.5 实施步骤

| 步骤 | 内容 | 验收 | 规模 |
| --- | --- | --- | --- |
| 2.1 组合根拆分 | 把 `server.mjs`（1,497 行）的装配拆成 `compose/gateway.mjs`、`compose/control.mjs`，`KIN_ROLE=all` 时两者装配进同一进程，行为与现状一致 | 全量单测、E2E 与现状一致；`all` 模式差分对比面板与推理响应 | 中 |
| 2.2 内部通道 | gateway 暴露 unix socket + internal token（沿用 kernel socket 的鉴权约定），实现 1.3 的 snapshot / stream / commands / invalidate | 单测覆盖鉴权、幂等、版本不匹配拒绝；`all` 模式也走同一接口（进程内直连实现） | 中 |
| 2.3 面板只读接口迁移 | 88 个 GET 路由中读 scheduler/quota 的改为经接口取快照；其余直接读 DB/文件 | 拆分模式下面板响应与 `all` 模式差分一致（排除时间戳与随机字段） | 大 |
| 2.4 面板写接口迁移 | 148 个写路由（POST/PUT/PATCH/DELETE）按“写 DB/文件 → 推进 revision → 通知”改造；需要改进程内状态的走 commands | 每类写操作有回归：gateway 在 2 秒内看到新配置；RPC 断开时靠 revision 兜底收敛 | 大 |
| 2.5 后台任务迁移 | 按 1.4 逐个迁移，每迁一个独立验证 | 迁移前后任务输出（DB 行、文件、通知）一致 | 中 |
| 2.6 进程托管与反代 | 容器入口用 tini 托管两个 node 进程，任一退出则容器退出由 Docker 重启；nginx 按 1.1 分流；健康检查分别探测 | 杀掉 control 时推理不受影响；杀掉 gateway 时面板显示数据面不可用 | 小 |
| 2.7 灰度与回滚 | 生产先以 `all` 部署 2.1–2.5 的代码，确认无回归后切 `gateway`+`control`；回滚只需改回 `all` | 切换后按第 0 节指标复测 | 小 |

### 1.6 风险

1. **跨进程 SQLite 写锁会阻塞事件循环。** `DatabaseSync` 是同步 API，`busy_timeout = 5000` 意味着拿不到写锁时线程最长空等 5 秒。拆分后 gateway 的计费写入可能等 control 的写事务。对策：control 的写事务保持短小、批量任务分片提交；给锁等待加计时指标；必要时 control 侧调低 `busy_timeout` 并重试。这是本阶段最主要的风险，2.3 起每步都要测锁等待。
2. **缓存不一致。** 任何漏掉的进程内缓存都会让 gateway 用旧配置。对策：2.4 前先列全进程内缓存清单（已知：`gpt-model-policy`、`model-policy`、`models`、`distill-detect`、`host-path`、API Key 快照、`panel-live-credentials`），并以 revision 兜底。
3. **内存翻倍。** 当前进程 RSS 约 800MB，两个进程预计增加 300–500MB。生产机 32GB，可接受。
4. **上游同步成本。** 组合根和面板路由是上游高频改动区，拆分后每次同步冲突面更大。对策：2.1 只移动装配代码不改逻辑；把内部通道和角色开关整理成可提交给上游的独立改动。
5. **集群节点操作。** 节点链路在 gateway，面板操作必须全部走 commands，不能在 control 里另起 SSH 连接，否则同一节点会有两条链路。

### 1.7 完成标准

- 峰值时段面板持续轮询下，gateway `/healthz` p99 < 50ms，且无面板请求对齐的停顿。
- 推理流量满载时，面板接口 p95 不劣于拆分前低峰时段。
- 计费、准入、调度行为与 `all` 模式一致（现有账务与调度回归全部通过，外加拆分模式下的同组用例）。
- `KIN_ROLE=all` 回滚路径经过一次实际演练。

## 2. 第三阶段：数据面计算移出 Node 主线程

### 2.1 对原方案的修正

原计划是“把流式逐行处理下沉到 Go”。实测与盘点后需要修正：

- **流式处理不是瓶颈。** 按生产形态（300 个事件、40 路并发、320KB 请求体）压测 `handleCodexProtocol` + `streamCodexKernel`，每请求 3–4ms CPU，峰值合计不到 1 核的 1%。
- **主要内核不在本仓库。** Claude 走 `kin-kernel`（Rust），Codex 走 `kin-codex-kernel`，两者都是 `deploy/payload.json` 按 sha256 锁定的上游 payload 二进制；本仓库只有 `kin-worker`、`kin-egress`、`kin-slot-gate`、`api-kernel`（API 直连，`server.go` 123 行）的 Go 源码。无法通过修改这两个内核把逐行处理移进去。
- **真正可能偏重的是请求侧计算。** 已知单次成本：`prepareCachePrefix` 1,200 条消息约 10–22ms（第一阶段前为 60–117ms）、大请求体 `JSON.parse`、Claude/Codex 整包转换、上下文预检。这些已有 `runtime-metrics` 分阶段计时（`json_parse`、`claude_convert`、`codex_convert`、`context_preflight`、`context_retry`）。

因此第三阶段拆成 3A（请求侧计算池，有数据即可做）和 3B（Go 数据面，长期方向，需先解决内核源码归属）。

### 2.2 3A：大请求计算池

**启动条件：** 峰值时段 `runtime.request_work_total` 中 `json_parse` + `*_convert` + `context_*` 合计占主线程活跃时间 > 20%，或单次 > 50ms 的次数每分钟 ≥ 10。

| 步骤 | 内容 |
| --- | --- |
| 3A.1 | 选定可移出的纯函数：入站体解析与清洗、Claude/Codex 整包转换、上下文预检/压缩。逐个确认无进程内状态依赖（`cache-prefix` 的会话表除外，它留在主线程，只把纯计算部分移出） |
| 3A.2 | `worker_threads` 固定 2 线程池，只处理解压后 > 256KB 的请求体，小请求仍在主线程（跨线程拷贝成本大于收益） |
| 3A.3 | 传输用原始 `Buffer`（transfer，零拷贝），线程内解析与转换后返回结构化结果；结果再序列化回主线程的成本要计入 |
| 3A.4 | 线程池满或超时回落主线程同步处理，不排队、不改变错误语义 |

**验收：** 同一组大请求回放，主线程每请求活跃时间下降 ≥ 50%；转换结果与主线程实现逐字节一致（差分回放，覆盖现有 `scripts/outbound-replay.mjs` 样本）；小请求延迟不变。

**风险：** 结构化克隆回传的开销可能抵消收益，3A.2 前先用回放数据测“线程内处理 + 回传”与“主线程处理”的总成本，收益 < 30% 则放弃。

### 2.3 3B：Go 数据面（长期）

仅在 3A 之后主线程仍饱和、且请求量预计继续增长时启动。

**前置决策（需用户确认）：** `kin-kernel` 与 `kin-codex-kernel` 的源码归属。三个选项：
1. 请上游在内核内实现所需的逐行处理（工具名还原、用量提取、错误重映射等），本地只改调用方式。定制差异最小，但依赖上游排期。
2. 不改内核，在 Node 与内核 socket 之间新增本仓库的 Go 流处理层（可扩展现有 `api-kernel`），负责逐行转换，Node 只收最终结果与用量摘要。
3. 维持 Node 处理，只做 3A。

**3B 迁移清单**（当前 Node 侧逐行处理，共 14 类调用点）：

| 处理 | 位置 | 说明 |
| --- | --- | --- |
| SSE 拼帧与提交判定（`flushCommit`） | `transport/go-worker-client.mjs` | 决定何时向下游提交、何时可重试，**和重试/计费语义强相关** |
| 消息拼装 `applyClaudeSSELineToMessage` | 同上、`handle-protocol.mjs` | 非流式客户端与最终用量来源 |
| 用量证据与计时 `usage-evidence`、`stream-timing` | `go-worker-client.mjs` | 计费依据，迁移后需逐字段对账 |
| 工具名还原、人设用量隐藏 | `handle-protocol.mjs` | Claude 路径 |
| 错误重映射、截断补尾、keepalive | `handle-protocol.mjs` | 客户端可见行为 |
| Claude → OpenAI Chat/Completions 转换 | `handle-protocol.mjs` | 兼容协议 |
| Responses → Anthropic/Chat 转换、事件命名 | `handle-codex.mjs` | Codex 路径 |
| 用量、服务档位、图片用量提取 | `handle-codex.mjs` | Codex 计费 |

**步骤：** 先定义 Node ↔ Go 的“流结果契约”（每个请求结束时返回：提交状态、终态、用量、模型、停止原因、计时）；按协议逐条迁移，每条用生产录制的 SSE 回放做新旧双跑比对，计费字段零差异才切换；保留 Node 实现作为回退开关直到稳定一个发布周期。

**规模：** 大，且引入第二种语言的数据面维护成本。只有在 3A 无法满足、请求量持续增长时才值得。

## 3. 总体顺序

```text
第一阶段部署 → 复测（第 0 节）
   ├─ 停顿来自面板/后台 → 第二阶段 2.1 → 2.7
   ├─ 停顿来自推理计算 → 第三阶段 3A
   └─ 都不满足 → 停止，按需处理零散热点
第二阶段完成后仍饱和 → 3A
3A 后仍饱和且流量增长 → 决定内核源码归属 → 3B
```

## 4. 待用户决定

1. 是否先部署第一阶段并按第 0 节复测（需要部署授权；当前 `main` 还包含其他会话的改动）。
2. 第二阶段带来的上游同步成本是否可以接受；是否要把角色开关与内部通道作为独立改动提交给上游。
3. 3B 的内核源码归属选项。
