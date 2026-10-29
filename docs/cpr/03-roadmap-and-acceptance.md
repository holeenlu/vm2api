# CPR 方案落地路线、开发任务与验收

本路线按风险和依赖排序，不按 CPR 的代码目录复制。每个阶段完成后都应有可独立验证的行为和回滚点。

## 阶段总览

| 阶段 | 目标 | 主要产物 | 依赖 | 优先级 |
| --- | --- | --- | --- | --- |
| P0-A | 统一请求事实和运行快照 | RequestPlanSnapshot、config revision、typed errors | 无 | 最高 |
| P0-B | 统一 attempt、发送状态和终态清理 | AttemptCoordinator、send state、delivery commit | P0-A | 最高 |
| P0-C | 账号错误保护与诊断事实 | 规则策略、冻结代次、bounded trace、诊断导出 | P0-A/P0-B | 最高 |
| P1-A | 统一 VM/API 准入和排队 | admission port、queue fairness、lease recovery | P0-A/P0-B | 高 |
| P1-B | 独立费用账本与价格快照 | settlement events、幂等结算、历史来源 | P0-A/P0-B | 高 |
| P1-C | 模型目录和协议合同收敛 | catalog snapshot、Chat/Responses contract tests | P0-A | 高 |
| P1-D | 备份、恢复和更新边界补齐 | restore manifest、revision lock、运行手册 | P0-A/P0-C | 高 |
| P2-A | typed Provider/Resource adapter | VM/API/供应商统一端口 | P0-B/P1-A | 中 |
| P2-B | 隔离插件 Runtime 评估 | 仅在有第三方发布需求时启动 | P2-A | 低 |

## 2026-10-29 实施状态

| 阶段 | 状态 | 已落地产物 | 当前边界 |
| --- | --- | --- | --- |
| P0-A | 已完成首版 | `runtime_config` revision/CAS、不可变 runtime snapshot、routing 管理接口 409 冲突、请求日志 `config_revision` | 仍兼容缺失 revision 的旧客户端；少数后台任务尚未统一迁移到 snapshot |
| P0-B | 已完成首版 | `request_attempts.send_state`、worker/kernel 全链路 `onSendState`、FailoverRunner 单调终态写入 | `ambiguous` 先只记录事实，暂不扩大重试策略 |
| P0-C | 已完成首版 | 规则编译/fingerprint、账号 runtime CAS 状态、FailoverRunner 冻结、SA 配置/清除接口、审计 | 默认关闭；自动后台 probe、跨节点共享存储和完整诊断 ZIP 后置 |
| P1+ | 未开始 | — | 等 P0 运行数据和产品决策后进入 |

## P0-A：请求计划和配置快照

### 工作包

- 定义 `RequestPlanSnapshot` 和 `ConfigRevision`
- 为 Messages、Chat、Responses、Images、Search 统一生成请求上下文
- 在请求开始时冻结 Key、用户、分组、资源、模型、策略、价格和风险版本
- 为会改变路由、安全、计费的管理写入增加 expected revision
- 发布失败时保留旧快照；无法确认安全权限时拒绝新请求

### 代码范围

- `src/server.mjs`
- `src/lib/core/config.mjs`
- `src/lib/admin/routing-runtime.mjs`
- `src/lib/db/repos/settings-repo.mjs`
- 受影响的 panel mutation route、audit 和 migrations

### 验收

- 请求开始后修改 Key 分组、模型白名单、价格或路由，不影响该请求的计划
- 并发管理写入中，过期 revision 返回明确冲突且不覆盖新值
- snapshot 编译失败时没有半成品进入调度
- VM 和 API endpoint 请求都能打印同一份 `config_revision`
- 重启后从持久化事实恢复 snapshot；运行时通知丢失不破坏最终一致性

## P0-B：Attempt、发送状态和终态清理

### 工作包

- 把现有 `failover-runner`、kernel response 状态和 request attempts 接入统一协调器
- 定义 `not_sent`、`sent`、`ambiguous` 和 `downstream_committed`
- 明确每种 Provider/VM transport 的安全重试边界
- 将费用、观测、lease release 绑定到一个终态清理责任
- 统一客户端取消、连接断开、响应流提前结束和后台 finalizer 行为

### 验收

- 发送结果不明时不会自动切换到另一个账号重放正文
- 首个不可撤回业务帧交付后不会改变 HTTP 状态或换号
- 多次取消、超时和迟到 worker 结果只产生一次结算和一次 lease release
- 一个 request 下的多个 attempt 可以完整查询，失败 attempt 不产生第二个 request
- 空响应、真实 Provider 错误、客户端取消和 transport 断开拥有不同终态

## P0-C：账号错误保护与诊断

### 工作包

- 新增错误保护策略 JSON schema、验证和 fingerprint
- 在账号、credential revision 和 policy revision 维度维护运行时计数；当前先复用进程/节点协调状态，跨副本时再选择共享存储
- 增加冻结摘要、恢复探测和手动解除审计
- 将 request log、attempt 和诊断 evidence 分成三个投影
- 增加有界 trace、body fingerprint、脱敏 header 和诊断包导出

### 建议默认值

新安装默认关闭错误保护；规则为空时不能误启用。诊断默认只保存摘要和 fingerprint，完整 request dump 继续显式开启。

### 验收

- 同一失败命中多条规则时只计一次
- 修改规则或 credential 后，旧计数不能冻结新策略
- 迟到恢复探测不能覆盖管理员新冻结
- 诊断导出不包含真实 Key、Cookie、OAuth token 或完整用户正文
- 观测队列满时客户端响应仍保持原结果，接口显示数据缺口
- 诊断记录能关联 request、attempt、upstream request ID 和 send state

## P1-A：统一准入、队列和 lease

### 工作包

- 抽象 Key、用户、分组、VM、API endpoint 的准入端口
- 统一 FIFO/优先级、取消回收、等待预算和队列上限
- 运行时协调存储/节点 lease 只负责容量事实，队列只负责等待位置
- 启动时恢复未过期的运行事实，过期请求转为终态
- 把 VM/API 的 capacity、rate、quota、policy 和 protection 错误分开

### 验收

- 后来请求不能越过同级队首
- 取消和超时一定回收等待位置
- 运行 lease 丢失时请求停止执行或进入明确失败，不继续无约束占用资源
- API endpoint 和 VM 使用同一套用户/Key/分组预算规则
- 队列等待不重置请求总 deadline，也不把上游限流误记为本地容量错误

## P1-B：独立结算账本

### 工作包

- 新增 settlement event repository 和唯一幂等键
- 接入 Provider 报价、网关估算、倍率、价格 revision 和费用来源
- 将余额、套餐和 Key 额度变更关联到结算事件
- 让 usage log/analytics 从结算事实读取费用，而不是反过来决定费用
- 为重试写入、Store 暂不可用和进程退出设计可恢复状态

### 验收

- 同一 request/attempt 重复 finalizer 不重复扣费
- 价格修改不重算已完成历史
- 清理日志不改变余额和已确认账本
- 费用未知时保留 `unavailable`，不能无依据改写为零
- VM 和 API endpoint 的客户扣费都可以追溯到同一结算事件

## P1-C：模型目录与协议合同

### 工作包

- 建立一份按 snapshot 发布的模型目录事实
- `/v1/models`、Key scope、组模型白名单、API endpoint alias 和 VM 模型权限读取同一目录
- Chat/Responses/Anthropic 转换层只负责协议投影
- 为 unsupported field、tool call、图片、SSE、WebSocket 和 usage 追加 contract tests

### 验收

- 页面显示的模型都能通过同一 Key 实际路由，除非明确标记为暂不可用
- 切换模型白名单不会影响已经开始的请求
- Chat 和 Responses 的路由、重试、结算和取消事实一致
- 未支持字段在访问上游前返回稳定错误，不静默改变语义

## P1-D：备份、恢复和更新

### 工作包

- 在现有 backup manifest 中增加 schema、runtime revision、资源摘要和恢复范围
- 更新前冻结配置 revision，检查运行中的插件/资源/节点状态
- 恢复期间统一拒绝推理流量，并记录恢复任务状态
- 明确业务备份、完整数据库、VM 文件、日志、短期协调状态和 payload 的恢复关系
- 在部署文档中写出人工恢复前的任务游标和远端删除风险

### 验收

- 备份文件大小、SHA-256、内容清单和版本一致
- 恢复失败时旧数据库和 VM 文件可回退
- 恢复期间不会产生新的客户请求或重复扣费
- 只恢复业务备份时，接口明确哪些历史详情不可恢复
- 更新或回滚不会覆盖并发配置写入，也不会静默启用不兼容组件

## P2-A：Provider/Resource adapter

先定义内部接口，不引入外部插件包：

```text
ResourceCatalog
ResourceEligibility
ResourceLease
ProviderRequest
ProviderAttempt
ProviderObservation
ProviderCredential
```

VM、API endpoint 和未来供应商分别实现这些接口；Core 只接受稳定事实。等内部接口稳定后，再评估是否把某个适配器移到隔离进程。

## P2-B：插件 Runtime 评估门槛

只有出现以下需求才启动：

- 第三方需要独立发布 Provider/协议适配器
- 插件故障必须和控制面隔离
- 插件需要管理页面、账号资源和模型目录扩展
- 宿主已经具备 manifest、版本、信任、审计、资源预算和回滚合同

如果只是增加一个内部供应商，不应先建完整插件系统。

## 验证矩阵

| 风险 | 最小验证 |
| --- | --- |
| 快照/权限 | 并发更新冲突、请求期权限冻结、重启恢复 |
| 重试/流 | not-sent、ambiguous、首帧提交、取消、断连、迟到结果 |
| 结算 | 重复 finalizer、未知费用、价格变更、日志清理 |
| 账号保护 | 规则匹配、generation、冻结、探测恢复、手动解除 |
| 排队 | FIFO、优先级、取消回收、队列满、lease 丢失 |
| 诊断 | 脱敏、上限、缺口、导出、完整正文开关 |
| 目录/协议 | 模型范围、Chat/Responses 投影、SSE/WS、图片和工具 |
| 恢复/更新 | manifest、SHA、旧版本回退、恢复期间 503、任务游标 |

文档和纯规划变更只需要 Markdown 结构、引用和 `git diff --check` 验证。真正实现时按 [CHANGE_DELIVERY.md](../CHANGE_DELIVERY.md) 的风险矩阵执行定向测试，不把全量测试当默认清单。

## 运行指标

建议新增或统一以下指标：

- `request_snapshot_publish_failures`
- `request_attempts_total{provider,resource,outcome}`
- `request_send_state_total{state}`
- `request_replay_blocked_total{reason}`
- `admission_queue_wait_ms`
- `lease_lost_total`
- `account_protection_freezes_total{rule}`
- `diagnostic_dropped_events_total`
- `settlement_duplicate_total`
- `settlement_pending_total`
- `catalog_snapshot_revision`

## 发布和回滚策略

每个阶段都应先旁路记录事实，再切换读取方：

1. 写入新事实，旧路径继续服务
2. 对比新旧结果并记录差异
3. 只对内部测试 Key 或指定分组开启新读取路径
4. 观察错误、延迟、费用和资源占用
5. 扩大范围后删除旧解释路径

涉及权限、计费、重试或持久化的阶段必须保留可逆配置和数据库回退方案；生产数据库处置和外部部署仍需要独立授权。

## 当前不需要做的工作

- 不为研究资料新增一个 CPR 风格完整插件系统
- 不把 SQLite 直接整体迁移到 PostgreSQL
- 不重写现有 VM、kernel 或 cluster runtime
- 不把 CPR 的 OpenAI/xAI 测试用例原样复制为没有真实缺陷覆盖的重复测试
- 不因为方案文档存在就自动打开遥测、额度探测、在线更新或生产部署

## 开发前必须冻结的决策

这些问题会改变数据归属或兼容边界，不能在实现过程中用临时开关拖延：

1. **Request ID 的统一范围**：VM、API endpoint、Images、Search 和内部测试是否共享同一请求表；建议共享请求事实，协议入口作为 `protocol` 维度区分
2. **客户结算主体**：用户余额、商业分组、套餐和 Key 限额的扣费顺序；建议由现有供应商平台账务服务定义，Provider 成本只作为独立来源
3. **运行 lease 的跨节点边界**：现有单控制面/多节点是否需要多个控制面副本；在没有多副本需求前，不为引入 Redis 而引入 Redis
4. **Continuation 的跨资源语义**：哪些请求允许 VM/API endpoint 之间切换；默认只允许明确声明可重放的协议，不把完整历史自动转给另一个资源
5. **历史数据精度**：旧 usage log 没有价格 revision、send state 或完整 attempt 时，查询显示“未知/历史格式”，不伪造为新事实
6. **错误保护默认策略**：新安装默认关闭；已有部署是否迁移旧 circuit/cooldown 需要按字段语义逐项决定，不能整表改名

每个决策在进入对应阶段前写入交付记录；一旦实现开始，后续代码、迁移和测试只能引用冻结后的唯一语义。
