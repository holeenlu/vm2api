# 统一控制面重构 · 整体验收记录（PF.1）

依据设计 [第 17 节](../ARCHITECTURE_CONTROL_PLANE_EXECUTORS_20261105.md) 的 6 条验收标准，逐条记录证据或未满足项。证据中的测试均在交付提交上运行通过；未部署到生产，生产相关项单独列出。

状态：草稿，阶段审查（R3 复审、R4/R6）关闭后补全最终提交与 PF.2 审查结论。

## 1. 单一事实来源

**标准**：任一执行实例的数据目录清空、重建后，无需人工操作即可恢复接单；控制面数据库备份即可恢复全部账号、凭据、设置与账本。

**结论**：满足（control 托管）；worker 托管（默认）下凭据仍以 Worker 为准。

- 数据目录清空后恢复：`test/e2e/gateway-worker-multi.e2e.test.mjs`。清空 `gw_b` 的数据目录后重启，它重新注册并接收投影，账号与凭据代次恢复，全程无人工操作。新托管公钥进入待确认，确认之前投影回退到共享凭据包，接单不受影响。
- 控制面数据库可恢复的内容：
  - 账号与绑定：`vendor_resources`、`gateway_worker_account_bindings`；
  - 凭据：`executor_credentials`（control 托管），解密需要主密钥文件；
  - 设置：`executor_settings` 与 `config_revisions`（P4）；
  - 账本：`usage_logs`、`request_attempts`、`gateway_worker_receipts`。
- 备份要求：主密钥文件必须与数据库分开备份，否则凭据库无法解密（运维文档第 10 节）。
- 现有备份 e2e：`test/e2e/backup.e2e.test.mjs` 通过。

## 2. 单一账本

**标准**：Claude 与 Codex 的每个客户端请求在 `model_requests` 中只有一条记录；尝试、用量、费用以 `request_id` 幂等；回放样本计费零差异。

**结论**：部分满足，需用户认可目标调整。

- 按 D8（数据库跟随上游），不新建 `model_requests`。Claude 与 Codex 共用上游的 `usage_logs` 与 `request_attempts`：Claude 由 `failover-runner` 写入，Codex 由 `recordGatewayAttempts` 写入，事件补齐 Codex 缺失的尝试（P2）。
- P2.4（Claude 进程内适配器）标为 skipped，待用户认可（`reviews/P2.md`）。
- 幂等：
  - 回执按（实例, dispatch）幂等；
  - 尝试按（`request_id`, `attempt_no`）唯一；
  - 补齐写入以保存点逐行原子执行。
  - 测试：`executor-result-writer`、`executor-events`。
- 回放计费零差异：真实 Worker e2e 在 shadow 与 primary 下断言 `diffDatabase` 零差异（`gateway-worker-real.e2e.test.mjs`）。

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
- 剩余边界：所有 Worker 共用内部令牌与凭据包密钥（设计 6.2“信任边界”与退出计划）。

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

| 故障 | 演练证据 | 结果 |
| --- | --- | --- |
| 控制面短暂不可用 | 事件留在 Worker 本地日志（`TestEventLogDoesNotSelfAcknowledgeBeforeThePolicyIsKnown`）；回执重放（对账循环 `replayReceipts`）；租约不可达时不刷新 | 恢复后补交，不丢事件 |
| 执行实例失联 | `control plane hops to another Worker only when the first reports not_sent`、`TestDrainingExecuteIsMarkedNotSent` | 未发送的请求换实例，已发送的按回执对账 |
| 实例重启（数据目录保留） | 真实 Worker e2e 中 SIGKILL 后由托管进程重启，并继续服务；`TestEventLogRecoversFromBrokenStateAndLostStreamFile` | 投影与事件流沿用 |
| 实例重建（数据目录丢失） | 多 Worker e2e 清空数据目录；事件流换新（`TestEventEndpointsPageAckAndDetectStreamChanges`） | 重新注册并接收投影，控制面从新流开始 |
| 事件积压 | `TestUnconsumedEventLogSelfAcknowledgesAndNeverBlocks`、`TestBrokenEventLogStopsAcceptingRequests`；控制面积压告警测试 | 必需时超限拒单，不必需时自行确认 |
| 投影缺失或过期 | `stale Worker admission recovers on heartbeat and projection revisions are monotonic`；托管投影回退（`executor-credential-custody`） | 心跳补发投影 |
| 刷新租约冲突 | 多 Worker e2e；`TestDeniedLeaseWaitsForProjection…` | 非持有者不刷新，等投影 |
| Redis 不可用 | 未引入 Redis（P5 待用户决定） | 不适用 |
| 控制面数据库不可用 | SQLite 与控制面同进程，数据库不可用即控制面不可用 | 与“控制面不可用”一行相同，未单独演练 |

## 6. 上游同步

**标准**：一次上游同步中，冲突只出现在入口与 Claude 执行内部，不扩散到执行契约与 Worker。

**结论**：结构上满足，尚未经过一次真实上游同步。

- 执行契约、事件、租约、凭据库、设置存储与 Worker 全部位于定制文件（`src/lib/executor/`、`src/lib/gateway-worker/`、`worker/`、`src/shared/executor-schema/`）。
- 对上游文件的改动持续收缩：P4 恢复 `codex-route.mjs` 为上游原样，本轮上游文件净减少 239 行（`scripts/upstream-touch-budget.mjs`）。
- 剩余上游触点见计划 2.7 预算表：
  - `server.mjs` 内部路由前缀 1 行；
  - `request-attempts-repo.mjs`（新增列与 `immediate`）；
  - `usage-logs-view` 与日志组件的通道显示；
  - 迁移清单测试。
- 下一次上游同步时按本条复核并补记结果。

## 生产相关（未授权，未执行）

- P1.10：生产 `primary` 观察一个发布周期。
- P3.10：生产执行凭据迁移并切换 `control`、开启 `on`。
- P5：是否引入 Redis。
