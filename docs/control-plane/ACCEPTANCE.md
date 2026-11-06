# 统一控制面重构 · 整体验收记录（PF.1）

依据设计 [第 17 节](../ARCHITECTURE_CONTROL_PLANE_EXECUTORS_20261105.md) 的 6 条验收标准，逐条记录证据或未满足项。证据中的测试均在交付提交上运行通过；生产切换记录见末节“生产相关”。

状态：定稿（2026-11-05），同日按最终审计（`reviews/AUDIT.md`）修正第 1、5 条结论；2026-11-06 中期技术债 M3 补齐第 5 条缺的两项演练并改结论。P1–P6 阶段审查（`reviews/P1.md`–`P5.md`）与 PF.2 两个独立终审（`reviews/PF.md`）均已复核通过；交付提交见 [PROGRESS.md](PROGRESS.md) 的交付记录。所有新能力的开关默认关闭；代码随 `v1.4.038.20` 起的发布版本进入镜像（迁移 100 起、设置迁入数据库等与开关无关的部分随版本生效，清单见运维文档 `docs/CODEX_GATEWAY_WORKER_SETUP.md` 第 12 节）。生产切换已于 2026-11-05 经授权执行，记录见 [PROGRESS.md](PROGRESS.md) 的 P1.10、P3.10 与 P5 部署记录；本文其余证据都来自测试，不是生产观察。

## 1. 单一事实来源

**标准**：任一执行实例的数据目录清空、重建后，无需人工操作即可恢复接单；控制面数据库备份即可恢复全部账号、凭据、设置与账本。

**结论**：满足。2026-11-06 起凭据固定以控制面凭据库为准（G1），Worker 同机只读直读控制面数据库（Gateway 事实直读，设计第 19 节）：数据目录清空后重启，账号配置、分组与凭据从库里读回，无需人工操作；只丢运行状态（冷却、额度观测、Cookie），由后续请求重新观测。

- 数据目录清空后恢复：Worker 每次读到事实变化就把账号合并进本地账号表，库里有、本地没有的账号直接加入（Go `TestFactsReaderLoadsTheContractViewAndFollowsChanges`、`TestApplyFactsTakesConfigFromFactsAndCredentialsOnlyForward`、`TestFactsPrimaryModeAppliesDatabaseChangesToTheStore`）。实例密钥随数据目录丢失时，同机托管的 Worker 吊销后重启控制面即重新引导（真实 Worker e2e `instance key issued at registration, used, rotated online and re-bootstrapped after revocation`）。
- 历史：G4 之前由多 Worker e2e（`gateway-worker-multi`）与“凭据库重建投影”（最终审计 F1）覆盖；投影机制与多 Worker 分别于 2026-11-07 随 G4a、G4b 删除，对应用例一并删除。
- 控制面数据库可恢复的内容：
  - 账号与绑定：`vendor_resources`、`gateway_worker_account_bindings`；
  - 凭据：`executor_credentials`，解密需要主密钥文件；
  - 设置：`executor_settings` 与 `config_revisions`（P4）；
  - 账本：`usage_logs`、`request_attempts`、`gateway_worker_receipts`。
- 备份要求：主密钥文件必须与数据库分开备份，否则凭据库无法解密。面板备份不包含主密钥文件、`runtime-secrets.json`（含自动生成的数据库字段加密密钥）与 Worker 数据目录；恢复轮换前的数据库备份时，要先把旧主密钥合并回主密钥文件（`--retire` 退役的旧主密钥归档在 `credential-master-keys.retired/`，`docs/CODEX_GATEWAY_WORKER_SETUP.md` 第 10 节，最终审计 U6）；主密钥丢失时用 `scripts/credential-master-key-doctor.mjs` 诊断，确认找不回再重置（U7）。
- 现有备份 e2e：`test/e2e/backup.e2e.test.mjs` 通过；它只覆盖路由、计费与 API 调度，没有覆盖 `executor_settings`、`executor_credentials` 的恢复。

## 2. 单一账本

**标准**：Claude 与 Codex 的每个客户端请求在 `model_requests` 中只有一条记录；尝试、用量、费用以 `request_id` 幂等；回放样本计费零差异。

**结论**：满足调整后的目标（用户 2026-11-05 认可）。

- 按 D8（数据库跟随上游），不新建 `model_requests`。Claude 与 Codex 共用上游的 `usage_logs` 与 `request_attempts`：Claude 由 `failover-runner` 写入，Codex 由 `recordGatewayAttempts` 写入，事件补齐 Codex 缺失的尝试（P2）。
- P2.4（Claude 进程内适配器）skipped，用户 2026-11-05 认可（`reviews/P2.md`）。
- 幂等：
  - 回执按（实例, dispatch）幂等；
  - 尝试按（`request_id`, `attempt_no`）唯一；
  - 补齐写入以保存点逐行原子执行。
  - 测试：`executor-result-writer`、`executor-events`。
- 回放计费零差异：`scripts/executor-replay-diff.mjs` 比对三个方向（终审 A1 改造）：
  - 事件 → 回执逐字段一致。两边都源自 Worker 同一份回执，这一项只证明入库完整；
  - 回执 → 事件：已开始消费事件的实例，每张回执都要有 `request.finalized`，能发现事件丢失；
  - 回执 → 账本：有使用记录的分发，用量可信度、token 与成本必须与回执一致，能发现计费差异。
  收件箱的 `invalid` / `failed` / `missing` / `diff` 计入退出码；账本检查还包括结算状态（对账死信、回执到达 1 小时后仍待结算）；“回执 → 事件”只检查各实例的事件消费窗口（第一条收件到控制面最后一次成功拉取）；账号测试对话与已回退 VM 的请求不比较尝试条数。单测覆盖“有回执无事件”“仍在拉取但尾部缺事件”“切回 off 后不报”“账本 token 不一致、缺成本”“死信与超时待结算”“信封无效”“非客户端请求”；真实 Worker e2e 在 shadow 与 primary 下断言三个方向都零差异（`gateway-worker-real.e2e.test.mjs`）。
- BPS 断流（最终审计 C1 修正）：上游在终态前断开时，Worker 回执的用量一律记 `partial`（此前中途 `in_progress` 的计数会被记成 `complete`，流式路径还因响应体被包了一层而从未带上转换累计的用量）；断流后本地补出的完成带 `bps_cutoff_completed`，与中断、取消、复制中断一样按已消耗用量下限结算，没有用量时明确不计量（此前每次进死信、比对工具报差异）；实时路径记为 incomplete 的 BPS 截断也等回执结算（此前不写对账任务）。测试：Go `TestBPSCutoffCompletionReceiptIsPartialAndMarked`、`TestBPSInterruptedStreamReceiptCarriesPartialUsage`，Node 对账用例 `reconciler bills interrupted and cut-off-completed BPS streams…`。
- 已知盲区：有回执、用量完整，但控制面没有对应使用记录的分发（例如控制面在交付途中重启）按现有设计不计费，比对工具看不到，需从回执表单独核查。

## 3. 凭据安全

**标准**：同一刷新令牌不会被两个实例同时使用（压力测试 + 故障注入）；凭据只以加密封装形式离开控制面；导出与授权全部有审计。

**结论**：满足。刷新租约恒开、凭据固定由控制面凭据库托管（2026-11-06 G1，原开关 `KIN_REFRESH_LEASE`、`KIN_CREDENTIAL_CUSTODY` 已删除）。

- 并发刷新：同一账号、同一授权类别同一时刻只有一个租约持有者（Node `executor-refresh-lease`、Go `refresh_lease_test.go`）；成功轮换在释放租约的同一事务里写凭据库，其他实例从库里读到新令牌。只支持单个 Worker 后（G4b），并发刷新只出现在替换实例的接替窗口；原来的双 Worker 真实 e2e 已删除。
- 故障注入：
  - 结果不明（已发出没收到响应）：Go `TestRefreshSentWithoutResponseIsReportedAmbiguous`；Node 租约与路由测试保持 10 分钟。
  - 租约被拒、控制面不可达：`TestDeniedLeaseWaitsForNewCredentialsAndNeverUsesTheRefreshToken`。
  - 轮换报告丢失后凭据库仍能追上：`executor-credential-custody`。
  - 数据目录清空：见第 1 条。
- 加密封装：
  - 凭据库为信封加密；
  - Worker 只读直读凭据库并在本机解密（主密钥文件只读、不创建）；导出与刷新报告使用控制面与 Worker 共享密钥的凭据包；
  - Worker 的明文凭据接口已删除；
  - 事件页响应有签名。
- 审计：
  - 账号导出 `gateway.account.exported`；
  - BPS 授权与撤销 `gateway.account.bps_*`；
  - 凭据迁移 `gateway.credentials.migrated`；
  - 设置修改 `executor.settings.updated`。
- 托管公钥与按实例封装（终审 B2）随投影一起于 2026-11-07 删除（G4a）：Worker 直读凭据库，控制面不再向 Worker 发送令牌。
- 租约策略：Worker 落盘最近一次租约策略；全新 Worker 在收到第一份策略前不做定时刷新、请求内刷新先申请租约（终审 B1，`TestUnknownLeasePolicyNeverRefreshesWithoutALease`）。
- 内部凭据按实例分发（中期技术债 M2，设计 5.1）：引导需要授权（托管 Worker 用托管器的一次性引导令牌自动引导，外部 Worker 由管理员开一次性限时授权），新密钥加密包裹下发、响应带签名；之后改用实例 HMAC 密钥（v2 签名串覆盖方法与路径），可在线轮换（宽限期内新旧都有效；轮换不处置泄露）与吊销（吊销后需重新授权），已签发实例不再接受共用内部令牌；回执只能写本实例的派发；新实例 ID 在批准或完成引导前不下发策略、不派发、不采信其上报（第二轮复审 P1-1）；托管引导在响应丢失、落盘失败或控制面重启后自愈（P1-2）。证据：`test/unit/gateway-instance-keys.test.mjs`、Go `TestRegistrationBootstrapsWithTheOneTimeTokenRotatesAndReusesTheKey` 等、真实 Worker e2e `instance key issued at registration, used, rotated online and re-bootstrapped after revocation`。
- 剩余边界：控制面与 Worker 共用凭据包密钥；只持有内部令牌的一方仍能以新实例 ID 或未签发的实例注册（`required` 下不能，新实例 ID 只登记为待批准），并能抢先用掉管理员开的引导授权（设计 6.2“信任边界”与退出计划）。mTLS 证书主体绑定（M2）曾在测试服务器验收，2026-11-07 随 G4b 删除（只支持同机 Worker）。

## 4. 可替换性

**标准**：新增一个执行服务只需实现执行契约，入口、计费与界面无需改代码（设置与账号表单由 schema 渲染）。

**结论**：部分满足。

- 已满足：
  - 执行契约 v1（事件发件箱、统一结果、刷新租约、设置描述）有共享夹具与双端测试；
  - Codex 的执行设置与账号 BPS 设置表单由设置描述渲染（P6）；
  - 账号向导按能力描述的授权方式生成（P6.3）。
- 未满足：入口与面板中仍有 Codex 专属代码：
  - Gateway 分发 `handle-codex-gateway.mjs`；
  - 账号管理 `account-management.mjs`；
  - 面板路由。
  再接入一个执行服务，仍要为分发与账号生命周期写适配代码。这一项属于 P7（Claude 物理拆分，默认不做）之后的工作。

## 5. 降级

**标准**：第 13 节每一种故障都有演练记录与结果。

**结论**：满足（中期技术债 M3，2026-11-06；此前为部分满足，最终审计 F9）。下表每一种故障都有演练证据。M3 补的两项演练在 `test/e2e/gateway-worker-outage.e2e.test.mjs`（控制面 + 外部真实 Go Worker，`KIN_EXECUTOR_EVENTS=primary`），演练中发现的缺陷已修复（见下表与本节末）。剩余限制写在对应行的“结果”里，主要是：写锁刚被占住时的第一次写入仍会让主线程等满 `busy_timeout`（5 秒）；待重试的推理收口只在进程内存里；磁盘满与运行中只读挂载没有单独演练（与只读走同一错误码路径）；不能修复的只读打开只在 macOS 上复现。演练所依赖的真实 Worker e2e（`gateway-worker-{real,redis,outage}`，含共享 Redis 下的重跑）由 `.github/workflows/worker-e2e.yml` 在每次 main push 与 PR 上运行，缺 Go、有用例被跳过或超时取消即失败，共享 Redis 一步要求实例报告 Redis 可用（最终审计 U10）。

| 故障 | 演练证据 | 结果 |
| --- | --- | --- |
| 控制面短暂不可用 | 演练 A（`drill A`，M3）：事件已为必需、Worker 确认序号追上 head 后，带 3 个在途流式请求 SIGKILL 控制面；Worker 继续运行，宕机约 13 秒内产生 4 条事件（3 条 `request.finalized`、1 条 `account.quota`），head 6→10、acked 停在 6（等过一个 10 秒维护周期仍不变），回执留在 Worker spool；同一数据目录、同一端口重启后一次心跳内重新连上，收件箱为序号 1..10 逐个一条、无重复、全部 applied，回执 6 张与 `request.finalized` 一一对应，spool 清空，`executor-replay-diff` 为 `differing 0, inbox problems 0`，恢复后照常接单。连跑 3 次结果相同。另有：策略未知时不自行确认（`TestEventLogDoesNotSelfAcknowledgeBeforeThePolicyIsKnown`）；回执重放（`replayReceipts`）；租约不可达时不刷新 | 恢复后补交，不丢、不重复。在途的流不会“继续完成”：调用方连接经过控制面，控制面宕机即断开，Worker 取消上游并把这些分发记为 `ambiguous`（已发往上游、结果不明）。它们有回执、没有使用记录，按现有设计不计费（第 2 条“已知盲区”） |
| 执行实例失联 | `control plane hops to another Worker only when the first reports not_sent`、`TestDrainingExecuteIsMarkedNotSent`；共享并发租约到期 `TestSharedLeaseRenewAndExpiryAfterInstanceLoss` | 未发送的请求换实例，已发送的按回执对账；失联实例持有的共享租约 30 秒后到期 |
| 实例重启（数据目录保留） | 真实 Worker e2e 中 SIGKILL 后由托管进程重启，并继续服务；`TestEventLogRecoversFromBrokenStateAndLostStreamFile` | 账号从库里读回，事件流沿用 |
| 实例数据目录从旧快照恢复 | `a Worker event log restored from an old snapshot is detected and its new events are processed` | 控制面发现流回退，从 Worker 已确认处重新处理；期间心跳兜底 |
| 实例重建（数据目录丢失） | 事实读取与合并（见第 1 条）；事件流换新（`TestEventEndpointsPageAckAndDetectStreamChanges`） | 重新注册、从库里读回账号，控制面从新流开始。外部 Worker 用共用令牌重新注册会被拒（实例密钥已签发，中期技术债 M2），管理员吊销其实例密钥并允许引导后才能重新签发（e2e 覆盖）；同机托管的 Worker 吊销后重启控制面或允许引导 |
| 事件积压 | `TestUnconsumedEventLogSelfAcknowledgesAndNeverBlocks`、`TestBrokenEventLogStopsAcceptingRequests`；控制面积压告警测试 | 必需时超限拒单，不必需时自行确认 |
| Worker 读到的事实缺失或落后 | `heartbeat facts mark bindings synced once the Worker caught up`（`gateway-facts-primary`）；Go `TestFactsReaderLoadsTheContractViewAndFollowsChanges` | Worker 每 0.5 秒检查 `data_version`、有变化即增量读取，每 10 分钟全量对账；读不出的账号保留上一份完好的配置与凭据；绑定按心跳上报的读取进度标记已同步 |
| 刷新租约冲突 | `executor-refresh-lease`；`TestDeniedLeaseWaitsForNewCredentials…` | 非持有者不刷新，等库里的新凭据 |
| Redis 不可用 | `gateway-worker-redis.e2e.test.mjs`：真实 Worker 接共享 Redis，停止 Redis 后退回本地状态并保持健康、控制面显示降级，同地址恢复后自动回到共享（G4b 起只支持单个 Worker，原为两个 Worker）；Go `TestSharedBPSStateIsSharedEncryptedAndDegradesToDisk`、`TestSharedLeasesCapConcurrencyAcrossInstances`（Redis 停止时只按本地计数）、`TestSharedServerServesRequestsWhileRedisIsDown`（经 Server 连续接单）、`TestSharedHoldsRetryAfterErrorsAndRepublishAfterDataLoss`（Redis 出错重试、丢数据后全量重发）；演练记录见 `reviews/P5.md` | 不影响接单；并发与冷却短暂回到各实例各自计数，协议状态写数据目录 |
| 控制面数据库不可用 | 演练 B1（`drill B1`，M3）：另一个进程对 `kin.db` 持有写锁约 12 秒，期间一个已准入的计费请求完成、一个新的计费请求到达。演练 B2（`drill B2`）：运行中把 `kin.db` 改为 0444；改为 0444 后重启；macOS 上用不可变标志（`chflags uchg`）复现改不回来的只读后重启。单测 `write-health`（写锁降级、写回队列暂停与恢复、收口重试、只读连接拒绝启动、只读文件先修权限）与 `database unavailability does not turn an event into a poison event`。独立审查后补充：`db-client`（SQLITE_FULL 让 SQLite 回滚整个事务后拒绝后续语句、提交抛原错误）、`write-behind`（整批回滚后全部重排、反复引发回滚的闭包丢弃前落盘、关库时剩余写入计数）、`commit-retry`（只含数据的补写条目、串行重放遇数据库错误即停、非数据库错误 5 次后落盘、停机落盘与 `scripts/replay-pending-commits.mjs` 幂等补写、已回滚事务里入队的使用记录不写）；macOS 上用 40 MB 的 `hdiutil` 镜像写满磁盘，写探测不再误判恢复，释放空间后连续两次探测成功才恢复。修复前的实测（同样 20 秒写锁）：主线程被冻住整整 20 秒（`/healthz` 20 秒内只应答 2 次），这期间完成的一个计费请求的结算与使用记录永久丢失、只有一行日志，`/healthz` 与面板数据库探测都显示正常；改成只读后重启，控制面以只读连接正常启动，之后所有写入失败、改回权限也要再重启 | 写锁：第一次写入等满 5 秒后进入降级（`busy_timeout` 降到 100 毫秒，写入快速失败），就绪接口 `/readyz` 返回 503 `degraded`（带 `Retry-After: 5`，不含错误细节），`/healthz` 保持 200 存活、只带 `degraded: true`（两者降级期间应答都在 1 秒内）；错误码与开始时间只在已鉴权的面板数据库页（“写入失败”与待重试收口）；新的计费请求在准入时拒绝（503 `database_unavailable`，带 `Retry-After`，不发往上游）；准入后完成的请求照常交付，收口进入后台重试；Worker 的 `request.finalized` 不被确认、回执留在 spool，刷新拿不到租约、不使用刷新令牌。锁释放后由写探测恢复（每秒一次、连续两次真正提交成功，审查修复后 3 次运行为 1.2–1.4 秒），无需重启：收口补写（使用记录按原始完成时刻记账）、回执与事件补交、结算完成，比对无差异，没有使用记录落到 `failed-usage-logs.jsonl`，也没有条目留到 `pending-commits.jsonl`。只读：运行中改权限不影响已打开的连接；属于控制面自己的文件在打开前改回 0600；改不回来的只读拒绝启动并说明原因，期间 Worker 事件留在本地，修复后启动补交。限制：写锁刚被占住时的第一次写入仍冻住主线程最多 5 秒；待重试的收口在内存里串行重放，停机时先试一次、剩余的写入 `data/request-logs/pending-commits.jsonl`（启动时提示，用 `scripts/replay-pending-commits.mjs` 补写），进程被 SIGKILL 时内存里的条目仍会丢；补写不含调试正文（`request_log_debug`）；磁盘满只在单测与本机小镜像上复现，端到端演练未覆盖，运行中只读挂载没有单独演练，按同一错误码进入降级；WAL 复用已有空间时小探测可能先于大写入成功，恢复后若再次写满会重新降级；不能修复的只读打开在 Linux CI 上不演练（需要 root） |

## 6. 上游同步

**标准**：一次上游同步中，冲突只出现在入口与 Claude 执行内部，不扩散到执行契约与 Worker。

**结论**：结构上满足。重构期间（PF.1 定稿时）尚未经过一次官方上游同步，此后已同步上游 1.4.041 与 1.4.048（见发布说明），本条还没有按这两次同步补记冲突范围；经过了一次真实的并行合并：另一任务的 CPR 同步（`fe543b58`，改了 Worker 的 `attempt.go`、`schedule.go`、`route_provenance.go`、`turn_state` 等）与本重构三方合并，只有发布说明冲突（`reviews/PF.md`“终审复核”）。

- 执行契约、事件、租约、凭据库、设置存储与 Worker 全部位于定制文件（`src/lib/executor/`、`src/lib/gateway-worker/`、`worker/`、`src/shared/executor-schema/`）。
- 对上游文件的改动持续收缩：P4 恢复 `codex-route.mjs` 为上游原样，本轮上游文件净减少 239 行（`scripts/upstream-touch-budget.mjs`）。
- 剩余上游触点见计划 2.7 预算表：
  - `server.mjs`：内部路由前缀 1 行，启动与恢复时导入设置 2 行；
  - `handle-codex.mjs`：设置快照（P4 例外，用户已认可）；
  - `request-attempts-repo.mjs`（新增列与 `immediate`）；
  - `usage-logs-view` 与日志组件的通道显示；
  - 迁移清单测试；
  - `worker/go.mod` +5、`go.sum` +18（Redis 依赖，P5 例外，用户 2026-11-05 已认可）。这是 P5 这一次的增量；相对上游基线 `5424589a` 的累计差异是 `worker/go.mod` +19/−3、`go.sum` +42，包含重构之外其他任务引入的依赖（最终审计 F11）。
- 数据库迁移（最终审计 F12，重构之外）：上游迁移 039–048 在本地编号为 045–055 与 116，SQL 语句与上游逐字一致，只改了文件名与部分开头注释；与设计 15.1 第 2 条“不改写上游迁移”的差别和下一次撞号的预案，见设计 15.1 第 2 条的“当前实现”。
- 下一次上游同步时按本条复核并补记结果。

## 未完成与接受的事项

- 第 5 条“降级”已满足（M3 补齐两项演练）；剩余限制：写锁刚被占住时第一次写入仍冻住主线程最多 5 秒，待重试的推理收口只在内存，磁盘满与运行中只读挂载未单独演练，见第 5 条“控制面数据库不可用”一行。
- 第 4 条“可替换性”部分满足：入口与面板仍有 Codex 专属代码，属于 P7（Claude 物理拆分，默认不做）之后的工作。
- P2.4（Claude 进程内适配器）跳过，用户已认可。
- 已知限制（均写入设计与运维文档，带退出条件）：
  - 所有 Worker 共用凭据包密钥；内部令牌已收缩为引导凭据（实例密钥，中期技术债 M2），仍可用于新实例 ID 或未签发实例的注册（设计 6.2 信任边界与退出计划）；
  - 远端归还不唤醒本地等待者，靠 250 毫秒复查（R5-14）；
  - 错误保护冻结的心跳通道与 Redis 通道并存，提前解冻经心跳要等下一轮（设计第 7 节）。
- 用户已认可的例外：P4 上游预算例外、P5 上游预算例外（`worker/go.mod`、`go.sum`），均为 2026-11-05。

## 目标环境验收（测试服务器，中期技术债 M3）

2026-11-06 在测试服务器（6 核 8 GB，与生产同为 Docker 部署、控制面托管 Gateway Worker、Redis 与四个开关全开）上执行，只动 `/opt/tapmodels` 与 `tapmodels-*` 容器；部署前备份在 `/opt/tapmodels-backups/pre-744e17c4-*`、`pre-087d76df-*`。

- **生产形态升级**：从 `main-6157db7b` 升级到 `main-744e17c4`，迁移 114–125 一次启动内全部应用；托管的 gw-01 用托管器下发的一次性引导令牌自动领取实例密钥并确认（`approval_state=approved`），无需人工操作。之后升级到 `main-087d76df`（M6），迁移 126、127 在这份小库上共 13 毫秒，`scripts/audit-money-micros.mjs` 结论“一致”。
- **轮换**：面板轮换 gw-01 实例密钥，10 分钟宽限内新旧并存，Worker 续期后旧密钥退役，期间心跳与接单不中断。
- **跨主机 mTLS 与多 Worker**：另一台主机上的 gw-02 经隧道连接控制面内部 TLS 监听（`KIN_CODEX_GATEWAY_INTERNAL_TLS_LISTEN`）与共享 Redis：管理员“批准并允许引导”后签发密钥并确认，控制面经 https 调 Worker，投影同步、共享状态为 Redis。负向：gw-03 拿 gw-02 的证书注册被拒（`client_certificate_instance_mismatch`）；Worker 配错控制面证书名称时始终不注册——此前 Worker 不打日志，已在 M3 补限频日志（`worker/internal/codexgateway/control_errors.go`）。验收结束后吊销 gw-02 密钥、关闭隧道，`.env` 恢复为验收前版本。跨主机 mTLS 与多 Worker 已于 2026-11-07 随 G4b 删除，这一项只作历史记录。
- **压测**（临时容器、mock 上游，4 轮 × 3000 请求、并发 16）：非流式 125.4 rps，流式 125.1 / 120 rps，p99 254–273 ms，CPU 约 9.0–9.5 ms/请求；另一轮遇到 mock 上游 45 秒停顿，吞吐降到 43.3 rps、出现 1 个 529，没有错误扩散。
- **迁移耗时**（同一台机器、`main-087d76df` 镜像的临时容器，100 万行 `usage_logs` 造数）：126 为 7.5 秒、127 为 7.4 秒，约 **15 秒 / 百万行**（本机约 6 秒）；库 870 MB，迁移后 WAL 844 MB；重建后两张汇总表的整数合计与明细逐项相等。生产 2026-11-06 只读核查：`usage_logs` 23.3 万行、库 1.7 GB、根分区空闲 304 GB，按此估算两次迁移约 4 秒，磁盘充足。
- **未覆盖**：#681（KVM guest 指纹）需要 `/dev/kvm`，测试服务器没有，需要在生产 KVM 主机上验证（需另行授权）；真实上游推理需要重新授权测试账号。

## 生产相关

用户 2026-11-05 授权后已执行，记录见 [PROGRESS.md](PROGRESS.md)：

- P1.10：生产 `KIN_EXECUTOR_EVENTS` 经 `shadow` 比对零差异后切到 `primary`，同时开启 `KIN_REFRESH_LEASE=on`；“观察一个发布周期”从切换时开始计。
- P3.10：生产执行凭据迁移，切换 `KIN_CREDENTIAL_CUSTODY=control`。
- P5：生产部署 Redis 并设置 `KIN_REDIS_URL`。
