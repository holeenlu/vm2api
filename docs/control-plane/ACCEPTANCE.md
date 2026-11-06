# 统一控制面重构 · 整体验收记录（PF.1）

依据设计 [第 17 节](../ARCHITECTURE_CONTROL_PLANE_EXECUTORS_20261105.md) 的 6 条验收标准，逐条记录证据或未满足项。证据中的测试均在交付提交上运行通过；生产切换记录见末节“生产相关”。

状态：定稿（2026-11-05），同日按最终审计（`reviews/AUDIT.md`）修正第 1、5 条结论。P1–P6 阶段审查（`reviews/P1.md`–`P5.md`）与 PF.2 两个独立终审（`reviews/PF.md`）均已复核通过；交付提交见 [PROGRESS.md](PROGRESS.md) 的交付记录。所有新能力的开关默认关闭；代码随 `v1.4.038.20` 起的发布版本进入镜像（迁移 100 起、设置迁入数据库等与开关无关的部分随版本生效，清单见运维文档 `docs/CODEX_GATEWAY_WORKER_SETUP.md` 第 12 节）。生产切换已于 2026-11-05 经授权执行，记录见 [PROGRESS.md](PROGRESS.md) 的 P1.10、P3.10 与 P5 部署记录；本文其余证据都来自测试，不是生产观察。

## 1. 单一事实来源

**标准**：任一执行实例的数据目录清空、重建后，无需人工操作即可恢复接单；控制面数据库备份即可恢复全部账号、凭据、设置与账本。

**结论**：control 托管下满足（最终审计 F1 实现凭据库重建投影后）；worker 托管（默认）下凭据仍以 Worker 为准，单 Worker 数据目录丢失需要重新导入或重新授权。

- 数据目录清空后恢复：`test/e2e/gateway-worker-multi.e2e.test.mjs`。清空 `gw_b` 的数据目录后重启，它重新注册并接收投影，账号与凭据代次恢复，全程无人工操作。新托管公钥进入待确认，确认之前投影回退到共享凭据包，接单不受影响。
- 没有在线来源时从凭据库重建（最终审计 F1）：同一 e2e 继续停掉 `gw_a`、再清空 `gw_b`，`gw_b` 从凭据库重建账号并启用；再刷新一次成功且没有重放旧刷新令牌（重建的是凭据库里轮换后的最新令牌），刷新经账号代理发出。去掉实现后该用例失败。单测 `a single Worker that lost its data is re-projected from the vault under control custody` 覆盖：共享凭据包与托管封装两种封装（代理在凭据包里）、BPS 一并重建（令牌代次与封装一致、过期时间取 JWT exp）、worker 托管不重建、凭据库缺失或落后于绑定与刷新租约时不重建（BPS 落后只重建原生）、在线来源导出失败时不重建、不带 `account_not_found` 的 404 与心跳仍回报账号时不覆盖。
- 控制面数据库可恢复的内容：
  - 账号与绑定：`vendor_resources`、`gateway_worker_account_bindings`；
  - 凭据：`executor_credentials`（control 托管），解密需要主密钥文件；
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

**结论**：满足（`KIN_REFRESH_LEASE=on`、`KIN_CREDENTIAL_CUSTODY=control` 时）；默认关闭。

- 并发刷新：双 Worker 真实 e2e 中两个实例同时刷新同一账号，假 OAuth 只换票一次、没有复用，另一个实例经投影拿到新令牌。
- 故障注入：
  - 结果不明（已发出没收到响应）：Go `TestRefreshSentWithoutResponseIsReportedAmbiguous`；Node 租约与路由测试保持 10 分钟。
  - 租约被拒、控制面不可达：`TestDeniedLeaseWaitsForProjectionAndNeverUsesTheRefreshToken`。
  - 轮换报告丢失后凭据库仍能追上：`executor-credential-custody`。
  - 数据目录清空：多 Worker e2e。
- 加密封装：
  - 凭据库为信封加密；
  - 投影为按实例的 `custody_bundle`，或实例间共享密钥的凭据包；
  - Worker 的明文凭据接口已删除；
  - 事件页响应有签名。
- 审计：
  - 账号导出 `gateway.account.exported`；
  - BPS 授权与撤销 `gateway.account.bps_*`；
  - 凭据迁移 `gateway.credentials.migrated`；
  - 托管公钥替换 `gateway.instance.custody_key_accepted`；
  - 设置修改 `executor.settings.updated`。
- 托管公钥：新实例的首个公钥也要管理员确认（终审 B2），只有控制面自己拉起的同机 Worker 自动确认；未确认前投影走共享凭据包。
- 租约策略：Worker 落盘最近一次租约策略；全新 Worker 在收到第一份策略前不做定时刷新、请求内刷新先申请租约（终审 B1，`TestUnknownLeasePolicyNeverRefreshesWithoutALease`）。
- 内部凭据按实例分发（中期技术债 M2，设计 5.1）：引导需要授权（托管 Worker 用托管器的一次性引导令牌自动引导，外部 Worker 由管理员开一次性限时授权），新密钥加密包裹下发、响应带签名；之后改用实例 HMAC 密钥（v2 签名串覆盖方法与路径），可在线轮换（宽限期内新旧都有效；轮换不处置泄露）与吊销（吊销后需重新授权），已签发实例不再接受共用内部令牌；回执只能写本实例的派发；新实例 ID 在批准或完成引导前不投影、不派发、不采信其上报（第二轮复审 P1-1）；托管引导在响应丢失、落盘失败或控制面重启后自愈（P1-2）；mTLS 开启时证书主体（SAN URI `urn:kin:gateway:<实例 ID>`）与请求声明的实例绑定，Worker 校验控制面证书名称。证据：`test/unit/gateway-instance-keys.test.mjs`、`test/unit/gateway-mtls.test.mjs`（用 `scripts/gateway-mtls-certs.sh` 生成的证书链）、Go `TestRegistrationInstallsRotatesAndReusesTheInstanceKey` 等、真实 Worker e2e `instance key issued at registration, used, rotated online and re-bootstrapped after revocation`。
- 剩余边界：所有 Worker 共用凭据包密钥；只持有内部令牌的一方仍能以新实例 ID 或未签发的实例注册（`required` 下不能），并能抢先用掉管理员开的引导授权（设计 6.2“信任边界”与退出计划）。目标环境的真实 mTLS 证书链未验收。没有在线来源时由凭据库重建投影（最终审计 F1），来源实例才有的运行状态不随重建恢复。

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

**结论**：部分满足（最终审计 F9 修正）。下表除“控制面数据库不可用”外都有演练证据；“控制面短暂不可用”只演练了策略未知时的行为，事件已为必需后控制面宕机、恢复后补交的整段流程没有端到端演练。演练所依赖的真实 Worker e2e（`gateway-worker-{real,multi,redis}`，含共享 Redis 下的重跑）由 `.github/workflows/worker-e2e.yml` 在每次 main push 与 PR 上运行，缺 Go、有用例被跳过或超时取消即失败，共享 Redis 一步要求两个实例都报告 Redis 可用（最终审计 U10）。

| 故障 | 演练证据 | 结果 |
| --- | --- | --- |
| 控制面短暂不可用 | 策略未知时事件不自行确认（`TestEventLogDoesNotSelfAcknowledgeBeforeThePolicyIsKnown`，覆盖的是重启后策略未知的情形）；回执重放（对账循环 `replayReceipts`）；租约不可达时不刷新 | 恢复后补交，不丢事件；“事件已为必需时控制面宕机再恢复”未端到端演练 |
| 执行实例失联 | `control plane hops to another Worker only when the first reports not_sent`、`TestDrainingExecuteIsMarkedNotSent`；共享并发租约到期 `TestSharedLeaseRenewAndExpiryAfterInstanceLoss` | 未发送的请求换实例，已发送的按回执对账；失联实例持有的共享租约 30 秒后到期 |
| 实例重启（数据目录保留） | 真实 Worker e2e 中 SIGKILL 后由托管进程重启，并继续服务；`TestEventLogRecoversFromBrokenStateAndLostStreamFile` | 投影与事件流沿用 |
| 实例数据目录从旧快照恢复 | `a Worker event log restored from an old snapshot is detected and its new events are processed` | 控制面发现流回退，从 Worker 已确认处重新处理；期间心跳兜底 |
| 实例重建（数据目录丢失） | 多 Worker e2e 清空数据目录；事件流换新（`TestEventEndpointsPageAckAndDetectStreamChanges`） | 重新注册并接收投影，控制面从新流开始。外部 Worker 用共用令牌重新注册会被拒（实例密钥已签发，中期技术债 M2），管理员吊销其实例密钥并允许引导后才能重新签发（e2e 覆盖）；同机托管的 Worker 吊销后重启控制面或允许引导 |
| 事件积压 | `TestUnconsumedEventLogSelfAcknowledgesAndNeverBlocks`、`TestBrokenEventLogStopsAcceptingRequests`；控制面积压告警测试 | 必需时超限拒单，不必需时自行确认 |
| 投影缺失或过期 | `stale Worker admission recovers on heartbeat and projection revisions are monotonic`；托管投影回退（`executor-credential-custody`） | 心跳补发投影 |
| 刷新租约冲突 | 多 Worker e2e；`TestDeniedLeaseWaitsForProjection…` | 非持有者不刷新，等投影 |
| Redis 不可用 | `gateway-worker-redis.e2e.test.mjs`：两个真实 Worker 共享 Redis，停止 Redis 后都退回本地状态并保持健康、控制面显示降级，同地址恢复后自动回到共享；Go `TestSharedBPSStateIsSharedEncryptedAndDegradesToDisk`、`TestSharedLeasesCapConcurrencyAcrossInstances`（Redis 停止时只按本地计数）、`TestSharedServerServesRequestsWhileRedisIsDown`（经 Server 连续接单）、`TestSharedHoldsRetryAfterErrorsAndRepublishAfterDataLoss`（Redis 出错重试、丢数据后全量重发）；演练记录见 `reviews/P5.md` | 不影响接单；并发与冷却短暂回到各实例各自计数，协议状态写数据目录 |
| 控制面数据库不可用 | SQLite 与控制面同进程，数据库不可用即控制面不可用 | 与“控制面不可用”一行相同，未单独演练 |

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

- 第 5 条“降级”部分满足：控制面数据库不可用未演练；控制面宕机期间事件必需的整段流程未端到端演练。
- 第 4 条“可替换性”部分满足：入口与面板仍有 Codex 专属代码，属于 P7（Claude 物理拆分，默认不做）之后的工作。
- P2.4（Claude 进程内适配器）跳过，用户已认可。
- 已知限制（均写入设计与运维文档，带退出条件）：
  - 所有 Worker 共用凭据包密钥；内部令牌已收缩为引导凭据（实例密钥，中期技术债 M2），仍可用于新实例 ID 或未签发实例的注册（设计 6.2 信任边界与退出计划）；
  - 远端归还不唤醒本地等待者，靠 250 毫秒复查（R5-14）；
  - 错误保护冻结的心跳通道与 Redis 通道并存，提前解冻经心跳要等下一轮（设计第 7 节）。
- 用户已认可的例外：P4 上游预算例外、P5 上游预算例外（`worker/go.mod`、`go.sum`），均为 2026-11-05。

## 生产相关

用户 2026-11-05 授权后已执行，记录见 [PROGRESS.md](PROGRESS.md)：

- P1.10：生产 `KIN_EXECUTOR_EVENTS` 经 `shadow` 比对零差异后切到 `primary`，同时开启 `KIN_REFRESH_LEASE=on`；“观察一个发布周期”从切换时开始计。
- P3.10：生产执行凭据迁移，切换 `KIN_CREDENTIAL_CUSTODY=control`。
- P5：生产部署 Redis 并设置 `KIN_REDIS_URL`。
