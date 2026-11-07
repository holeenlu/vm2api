# 统一控制面与执行服务重构 · 开发计划

> 2026-11-07：BPS 通道停止运营，相关代码与数据已删除（迁移 133），本文 BPS 相关条目仅作历史记录。

状态：执行中。日期：2026-11-05。

- 设计依据：[../ARCHITECTURE_CONTROL_PLANE_EXECUTORS_20261105.md](../ARCHITECTURE_CONTROL_PLANE_EXECUTORS_20261105.md)（下称“设计”）。
- 进度台账：[PROGRESS.md](PROGRESS.md)（已交付状态的唯一权威）。
- 阶段审查报告：`reviews/P<n>.md`。

最终交付物是**按设计完成、已验证并合入 `main` 的程序代码**。本计划的作用是让工作可以跨会话、跨断线续接，并保证每个任务都有完成标准、验证和审查，不遗漏。

---

## 0. 续接（每次开工、断线恢复都先做）

三处记录，按顺序读：

1. **记忆指针**：`~/.claude/projects/-Users-luhonglin-Git-vm2api/memory/control-plane-refactor.md`，指向下面两处。
2. **本机进度日志**：`~/Backups/vm2api/cp-refactor/journal.md`（不入库）。每个动作立即追加一行；记录尚未交付的进行中步骤、检查点、验证结果、交付 SHA。
3. **进度台账**：`origin/main` 上的 `docs/control-plane/PROGRESS.md`。每个任务交付时同步更新，是已交付状态的唯一权威。

续接步骤：

```text
1. git -C /Users/luhonglin/Git/vm2api fetch origin main
2. 读 origin/main:docs/control-plane/PROGRESS.md → 找到第一个状态不是 done/deferred/skipped 的任务
3. 读 journal.md 末尾 → 确认该任务是否有未交付的进行中工作
4. 检查持久检出：git -C ~/Git/vm2api-cp status / git -C ~/Git/vm2api-cp log --oneline origin/main..cp/wip
   - 检出不存在：git worktree add -B cp/wip ~/Git/vm2api-cp origin/main（若 cp/wip 分支还在，用 git worktree add ~/Git/vm2api-cp cp/wip 恢复检查点）
   - 有检查点提交但远端 main 已前进：git rebase --onto origin/main <journal 记录的 task-base> cp/wip
5. 重跑该任务已完成部分的验证，再从 journal 记录的下一步继续
6. 若 journal 说已交付但台账未显示：用 refs/cp/<任务>/result 与 origin/main 比对，判断是否被其他会话覆盖；被覆盖则三方合并重新交付
```

任务状态：`todo` 未开始 / `doing` 进行中 / `done` 已交付且验证通过 / `review` 阶段审查中 / `blocked` 等待用户决定或授权（写明原因） / `deferred` 依赖生产观察或授权，代码已就绪 / `skipped` 经决定不做。

---

## 1. 硬约束

来自 `AGENTS.md`、`docs/CHANGE_DELIVERY.md` 与设计 15.1，每个任务都必须满足：

1. 交付目标只有 `holeenlu/vm2api` 的 `main`；`main` 始终是“上游基线 + 一个定制提交”。不向 `upstream` 推送。
2. 不覆盖其他任务的修改：不在主检出 `/Users/luhonglin/Git/vm2api` 上开发（那里可能有其他任务未提交的改动）；交付时远端已前进就三方合并。
3. 上游代码不搬家，只加接入点；数据库跟随上游（上游表保持 SQLite）；设置只迁本地键；Claude 物理拆分默认不做。
4. 新能力以**开关默认关闭**进入 main，保证 main 随时可部署；切换生产默认值、生产数据迁移、依赖生产观察的清理都需要用户授权。
5. 新增、替换功能时同次清理被替代的实现、字段、配置、文案与测试；兼容保留必须写明依据与移除条件。
6. 每次交付更新 `docs/CUSTOMIZATION_RELEASE_NOTES.md`（相对上游的完整差异描述）；不写外部 issue 引用（`owner/repo#N`）。
7. 生产部署、生产数据库操作不在授权内。

---

## 2. 工作方式

### 2.1 环境

| 项目 | 值 |
| --- | --- |
| 持久检出 | `~/Git/vm2api-cp`，本地分支 `cp/wip`（只在本机，不推送） |
| 依赖链接 | 开发时 `ln -sfn /Users/luhonglin/Git/vm2api/node_modules node_modules`，web 同理；交付前删除链接 |
| Go | `export GOTOOLCHAIN=go1.25.14; ~/sdk/go1.27/bin/go …`；gofmt 用 `~/go/pkg/mod/golang.org/toolchain@v0.0.1-go1.25.14*/bin/gofmt`；e2e 用 `PATH=$HOME/sdk/go1.27/bin:$PATH` |
| 交付脚本 | `/Users/luhonglin/Backups/vm2api/deliver-single-commit.sh <检出> <OURBASE>`；返回 `REMOTE_MOVED` 时用 `git diff OURBASE R --binary \| git apply -3 --index` 合并、重测后用新 R 重跑 |
| 已知环境失败 | Node 单测 `egress`、`guest-identity-reader`、`oauth-binary`、`telemetry-status` 在本机基线同样失败 |

### 2.2 单个任务的流程（每个任务都走完）

1. **开始**：`git fetch origin main`；无检查点时 `git -C ~/Git/vm2api-cp checkout -B cp/wip origin/main`。journal 记 `start | task-base=<SHA>`；台账把任务改为 `doing`（随交付生效）。
2. **实施**：每完成一个可验证的小步就提交本地检查点 `git commit -m "cp(<任务>): <小步>"`，journal 记 `checkpoint`。
3. **验证**：按 2.3 跑与改动相应的检查；结果写 journal `verify`。
4. **文档**：更新台账（状态 `done`、交付说明、上游改动预算）、发布说明、受影响的设计或运维文档。
5. **交付**：删除依赖链接 → `git add -A` → 交付脚本。成功后：
   - `git update-ref refs/cp/<任务>/base <R>`、`git update-ref refs/cp/<任务>/result <NEW>`（本机引用，供阶段审查取差异）；
   - `git diff <R> <NEW> > ~/Backups/vm2api/cp-refactor/patches/<任务>.patch`；
   - journal 记 `deliver | R=… NEW=…`；
   - `git -C ~/Git/vm2api-cp checkout -B cp/wip <NEW>`。
6. **一次交付可以包含同一阶段的多个任务**，台账逐项记录。

### 2.3 验证矩阵

| 改动 | 必须通过 |
| --- | --- |
| Worker Go | gofmt；`go vet ./...`；`go test -race ./internal/...`；linux/amd64、linux/arm64、darwin/arm64 交叉编译 |
| 控制面 Node | 受影响的单测文件；阶段收尾或改动面大时跑全量 `node scripts/run-isolated-tests.mjs test/unit .test.mjs`（只允许已知环境失败）；`npx biome format` |
| 迁移 | `test/unit/database.test.mjs`（迁移清单断言同步更新） |
| Worker ↔ 控制面交互 | `test/e2e/gateway-*.e2e.test.mjs`（含真实 Worker） |
| Web | `npx tsc -b --noEmit`；修改文件 eslint、prettier；vitest 全量；`vite build` |
| 计费相关 | 回放比对零差异（P1 起提供工具） |
| 每次交付 | `node scripts/upstream-touch-budget.mjs <R>` 输出记入台账 |

### 2.4 阶段审查门

每个阶段的全部任务交付后，进入 `review`：

1. 收集本阶段任务的 `refs/cp/<任务>/{base,result}` 与补丁文件列表，并为审查者建立固定在阶段交付提交上的干净检出：`git -C ~/Git/vm2api-cp worktree add --detach /private/tmp/cp-review-P<n> refs/cp/P<n>/result`（持久检出会继续开发下一阶段，不能作为审查对象）。审查关闭后删除该检出。
2. 启动一个**独立的审查子智能体**（Agent，general-purpose，新上下文，不用 fork）。简报只给范围与材料，不给我的结论：
   - 设计中相关章节与本计划中本阶段的任务、完成标准；
   - 本阶段补丁文件路径与涉及的源码路径；
   - 审查清单（2.5）。
   要求它只读审查、给出带文件与行号的发现、标注严重级别（P0 阻断 / P1 必须修 / P2 建议），不修改代码。
3. 报告存为 `docs/control-plane/reviews/P<n>.md`（发现、证据、处置：已修复 / 不修复及理由 / 转入后续任务）。
4. P0、P1 发现全部修复并交付后，用同一审查智能体（SendMessage）或新智能体复核修复；复核通过后阶段才标记 `done`。
5. 用户想自己查看时，可以把审查改为单独会话；报告格式不变。

### 2.5 审查清单

1. 是否实现了本阶段每个任务的完成标准；台账与实际代码是否一致。
2. 正确性：并发、幂等、顺序、重放、崩溃恢复、错误分支、资源释放。
3. 契约一致性：字段、事件类型、错误分类与设计第 5 节一致；新旧通道并行期间结果一致。
4. 安全：凭据只以加密形式离开控制面；签名与权限校验；日志与事件脱敏；审计记录。
5. 计费：用量与费用不重复、不遗漏；未知用量不按 0 结算。
6. 上游同步：改动的上游文件与行数在预算内；没有复制或改写上游逻辑。
7. 清理：被替代的实现、字段、配置、文案、测试是否同次删除；兼容保留是否写明依据与移除条件。
8. 开关：默认关闭时行为与改动前一致；打开后的行为有测试。
9. 测试：新增行为有测试；失败路径有测试；没有为通过而弱化的断言。
10. 文档：发布说明、设计、运维文档同步。

### 2.6 插入的其他工作

- 用户中途要求同步上游或其他任务：当前任务提交检查点并记 journal，先完成插入的工作；之后把 `cp/wip` 变基到新的 `origin/main` 再继续。
- 其他会话推进了 `main`：交付时三方合并，不覆盖对方改动。

### 2.7 上游改动预算

`scripts/upstream-touch-budget.mjs <base>`：统计 `<base>` 到工作树的改动中，在上游基线（`main^`）里已存在的文件及其增删行数。阶段预算：

| 阶段 | 允许改动的上游文件 | 上限 |
| --- | --- | --- |
| P1 | 无（只改 Worker 与本地控制面模块；`server.mjs` 只允许注册路由）；迁移清单断言 `test/unit/database.test.mjs` 每个新迁移 +1 行为固定例外 | `server.mjs` ≤ 10 行 |
| P2 | `request-attempts-repo.mjs`、`usage-logs-view.mjs` 及其测试 `usage-logs-view.test.mjs`、日志尝试链组件与类型、`log-display.ts` 及其测试 `log-display.test.ts`（含 P3 交付中 R2 第二轮 N7 的选号文案）、迁移清单测试 | 每文件 ≤ 30 行 |
| P3 | `src/server.mjs` 内部路由前缀判断；`request-attempts-repo.mjs` 的 `record` 增加 `immediate`（R2 复审 N3）；迁移清单测试 | `server.mjs` ≤ 2 行，`request-attempts-repo.mjs` ≤ 3 行 |
| P4 | `routing.json` 只删本地键 | 只减不增（整体）；例外（R4 审查 P2-10）：`server.mjs` 启动导入 +3 行；`request-attempts-repo.mjs` 设置版本列 +2 行；`handle-codex.mjs` 设置快照 +5 行；同轮删除上游文件中的本地代码 239 行；用户 2026-11-05 认可 |
| P5 | 无 | 0；例外：`worker/go.mod` +5、`go.sum` +18（新增 go-redis 与 miniredis 依赖，引入 Redis 所必需；用户 2026-11-05 认可）；迁移清单测试 +2 |
| P6 | 共享 UI 组件只加导出 | ≤ 20 行 |

超出时停止并在台账记 `blocked`，请用户决定。

---

## 3. 阶段与任务

每个任务的“完成标准”同时是审查依据。迁移编号写为“下一个可用编号”，开工时按 `src/lib/db/migrations` 实际最大编号顺延。

### P0 计划、台账与工具

| 编号 | 任务 | 完成标准 |
| --- | --- | --- |
| P0.1 | 设计文档补 15.1 同步约束；D8 改为“数据库跟随上游”；16 节指向本计划 | 设计中不再把 PostgreSQL 作为本方案前提 |
| P0.2 | 本计划、进度台账、本机 journal、记忆指针、持久检出 | 按第 0 节能从任意断点恢复 |
| P0.3 | `scripts/upstream-touch-budget.mjs` 与单测 | 输出上游文件清单与增删行数；有单测 |

### P1 执行契约与事件发件箱

目标：Worker 把回执、心跳中的状态与探测统一成持久化、可重放的事件；控制面按游标拉取、幂等落库；先影子并行，再切换为主来源。开关：控制面 `KIN_EXECUTOR_EVENTS=off|shadow|primary`（默认 `off`）；Worker 始终写事件日志（只增加本地文件；只有控制面消费事件时，事件日志故障或积压超限才拒绝新请求，见设计 5.6）。事件类型 v1 为 `request.finalized`、`account.state`、`account.quota`、`probe.recorded`；订阅由控制面同步查询写入，冻结与在途仍随心跳，不做成事件。

| 编号 | 任务 | 主要文件 | 完成标准 |
| --- | --- | --- | --- |
| P1.1 | 契约类型：事件信封与事件类型（`request.finalized`、`account.state`、`account.quota`、`probe.recorded`），Go 与 JS 各一份并有一致性测试 | `worker/internal/codexgateway/events_types.go`、`src/lib/executor/contract.mjs` | 字段与设计 5.6 一致；JS 校验器拒绝缺字段与类型错误 |
| P1.2 | Worker 事件日志：按段追加、每条带 seq 与 sha256、fsync 后才算产生；启动时扫描恢复、截断损坏尾部；确认后清理、已确认保留 24 小时；磁盘写失败时停止接新请求 | `worker/internal/codexgateway/events.go` | 崩溃恢复、损坏尾部、清理、并发追加测试通过 |
| P1.3 | Worker 接口 `GET /internal/v1/events?after=&limit=&stream_id=`、`POST /internal/v1/events/ack`；心跳与健康接口增加 `events` 水位；心跳策略下发 `executor_events.required`，不消费时 Worker 自行确认、不因事件积压拒单 | `server.go`、`events_http.go`、`background.go` | 签名校验、分页、确认幂等、流变化、自行确认与“必需”切换的测试 |
| P1.4 | Worker 产生事件：回执写入点产生 `request.finalized`（内容与回执一致）；每 10 秒采集并在有变化时产生 `account.state`、`account.quota`；探测记录产生 `probe.recorded` | `attempt.go`、`store.go`、`server.go`、`bps_auth.go` | 每类事件有产生测试；回执与事件逐字段一致 |
| P1.5 | 控制面迁移：`executor_event_cursors`（实例、事件流、已处理 seq）、`executor_event_inbox`（事件 ID 去重、类型、处理结果）；迁移 101 增加 `gateway_worker_instances.executor_events_json`、收件箱 `attempts_state` | 迁移 100、101 | `database.test.mjs` 通过 |
| P1.6 | 控制面事件接收器：游标从 max(本地游标, Worker 已确认序号) 开始；校验信封与 sha256（与 Go 同口径，含 U+2028/U+2029）；按事件 ID 去重、按类型分发、确认；事件流切换；无效事件跳过并告警；积压与故障告警（日志 + 面板水位） | `src/lib/executor/event-ingest.mjs`，挂在现有 reconciler 循环 | 去重、无效跳过、确认起点、流切换、失败重试、告警测试 |
| P1.7 | 影子模式：`shadow` 下事件只比对不生效——`request.finalized` 与回执 `payload_hash`、`probe.recorded` 与探测记录比较，晚到的回执复查、超时记为 `missing`；`account.*` 快照与心跳到达时间不同步，只记录（正确性由 primary 测试覆盖） | `event-ingest.mjs` | e2e：真实 Worker 跑一组请求后差异为 0 |
| P1.8 | 主来源模式：`primary` 下由事件写回执与对账、绑定终态（只应用不早于已应用的快照）、额度、探测；心跳同类字段只在事件链路健康时停写（`eventsChannelHealthy`），回执重放保留为幂等兜底 | `event-ingest.mjs`、`gateway-routes.mjs` | 三种开关值下 e2e 结果一致；`off` 时 Worker 不积压、不拒单 |
| P1.9 | 回放比对工具：只读比较收件箱 `request.finalized` 与回执表的计费相关字段（Worker 响应头不落库，由 e2e 覆盖） | `scripts/executor-replay-diff.mjs` | 工具有单测；作为 P2 的验收工具 |
| P1.10 | 清理旧通道：删除回执接口、心跳中重复字段、`gateway_worker_receipts` 写入路径（表只读保留） | Worker 与控制面 | **deferred**：需要用户部署并以 `primary` 观察一个发布周期后授权 |

阶段完成标准：P1.1–P1.9 交付；开关三种值行为有测试；审查 R1 关闭。

### P2 统一结果与请求账本

目标：请求尝试与结算有单一、完整的事实来源。调研结论（2026-11-05）：
- Codex 的尝试由控制面在交付结束时按响应头实时写入（带控制面视角的终态：是否提交下游、调用方是否中途断开），结算由回执完成；
- Claude 在控制面进程内执行，尝试与使用记录本来就由同一组上游写入函数（`RequestAttemptsRepo`、请求日志）写入，Codex 也调用这组函数。

因此 P2 不改写 Claude 路径（避免改动上游高频文件），改为：Worker 侧字段进入尝试记录；`request.finalized` 作为最终来源补齐实时记录缺失的尝试。开关：沿用 `KIN_EXECUTOR_EVENTS=primary`。

| 编号 | 任务 | 主要文件 | 完成标准 |
| --- | --- | --- | --- |
| P2.1 | 统一结果写入器：把 `request.finalized` 映射为请求尝试；实时记录已存在时只补 Worker 侧字段（通道、阶段、凭据代次、上游请求 ID），缺失时按事件写入 | `src/lib/executor/result-writer.mjs` | 不覆盖控制面视角的终态与交付事实；重复事件不重复写 |
| P2.2 | `request_attempts` 补列（通道、阶段、凭据代次），实时写入从响应头取值；去掉此前把阶段拼进 `action` 的写法 | 迁移、`request-attempts-repo.mjs`、`gateway-execution.mjs`、`usage-logs-view.mjs` | 迁移与读写测试 |
| P2.3 | primary 模式接入：`request.finalized` 入库 60 秒后（实时写入已完成）由接收器调用写入器补齐，进度记在收件箱 `attempts_state` | `event-ingest.mjs` | 控制面在交付中途重启后，事件补齐的尝试与 Worker 一致；正常请求不产生重复行 |
| P2.4 | Claude 进程内适配器 | — | **skipped**：Claude 已经与 Codex 共用上游写入函数，单独适配器只在 P7 物理拆分时才有意义 |
| P2.5 | 控制台尝试详情显示 BPS 通道与阶段（四语文案） | `web/src/features/logs/*` | vitest、tsc 通过 |

阶段完成标准：P2.1–P2.3、P2.5 交付；回放比对零差异；审查 R2 关闭。

### P3 刷新租约与凭据归属控制面

目标：同一刷新令牌只被一个实例使用；令牌以控制面为准，加密保存、按实例封装投影；授权会话在控制面。开关：`KIN_REFRESH_LEASE=off|on`（默认 `off`）、`KIN_CREDENTIAL_CUSTODY=worker|control`（默认 `worker`）。

| 编号 | 任务 | 主要文件 | 完成标准 |
| --- | --- | --- | --- |
| P3.1 | 刷新租约表（账号、授权类别、持有实例、代次、令牌、到期）与接口 `lease`、`release`（R3 审查后：“结果不明”由 Worker 报告 `ambiguous`，租约保持 10 分钟不发放，替代原 `pending` 查询）；SQLite 单写事务实现 | 下一个迁移编号、`src/lib/executor/refresh-lease.mjs`、内部路由 | 并发申请只有一个成功；到期、冲突、结果不明三种路径测试 |
| P3.2 | Worker 刷新器与请求内 401 刷新（原生与 BPS）在 `on` 时先申请租约，刷新后同步报告结果（`release`）；拿不到租约时等待投影（最多 20 秒），不计入过期判定；BPS 用刷新令牌指纹识别过时令牌（迁移 105） | `refresh_lease.go`、`refresher.go`、`bps_auth.go`、`background.go`、`refresh-lease.mjs` | 多实例并发刷新测试：刷新令牌只使用一次 |
| P3.3 | 控制面预刷新协调：按账号选一个健康实例发放租约，替代各实例各自预刷新 | `refresh-lease.mjs` | 只有被选中的实例刷新 |
| P3.4 | 凭据库：信封加密（数据密钥 + 主密钥文件，支持轮换）、`executor_credentials` 表、轮换脚本 | `src/lib/executor/vault.mjs`、迁移、`scripts/rotate-credential-master-key.mjs` | 加解密、轮换、篡改检测测试；明文不落库 |
| P3.5 | 实例密钥对：Worker 生成并在注册时提交公钥（首次登记后固定，更换需管理员确认）；控制面按实例封装凭据写入投影；Worker 在内存解封后写入本地加密账号库（投影缓存）；保留现有凭据包作为过渡 | `register`、投影、Worker `credential_custody.go` | 错误实例无法解封；实例重建后重新封装可恢复 |
| P3.6 | `credential.issued` / `credential.rotated` 事件与同步接口：带 `expected_revision` 的 CAS 写入；成功后投影到其他实例 | `event-ingest.mjs`、`refresh-lease.mjs` | 旧代次写入被拒；投影收敛测试 |
| P3.7 | 授权会话（PKCE、state、草稿）迁回控制面；Worker 只做换码；删除 Worker `oauth-sessions.json` 的持久化 | `account-management.mjs`、`oauth.go` | OAuth、BPS 授权、导入流程 e2e 通过 |
| P3.8 | 迁移工具：从各 Worker 读取现有令牌写入凭据库并比对代次（经审计）；`control` 模式下 Worker 本地令牌改为投影缓存 | `scripts/migrate-worker-credentials.mjs` | 本地多实例演练：清空 Worker 数据目录后重新注册恢复全部账号 |
| P3.9 | 账号导出改读凭据库；删除 Worker 明文 `credentials` 接口 | `account-management.mjs`、`server.go` | 导出、导入回归；接口删除后无残留调用 |
| P3.10 | 生产启用：生产执行 P3.8 迁移并切 `control`、开 `on` | — | **deferred**：需要用户授权生产数据操作 |
| P3.11 | 事件页响应签名：Worker 对 `/internal/v1/events` 响应体加 HMAC 签名，控制面验签后才处理（R1 审查 P2-10：目前依赖请求签名与跨主机 mTLS） | `events_http.go`、`gateway-client.mjs`、`event-ingest.mjs` | 篡改或缺签名的响应被拒 |

阶段完成标准：P3.1–P3.9 交付；故障注入（清空数据目录、并发刷新、租约过期）通过；审查 R3（安全为重点）关闭。

### P4 本地设置与模型目录发布

目标：本地设置键迁入控制面数据库，带 `config_revision` 发布到 Worker；设置与账号专属字段由 Worker 的设置描述 schema 定义，控制面按 schema 校验。

| 编号 | 任务 | 主要文件 | 完成标准 |
| --- | --- | --- | --- |
| P4.1 | 盘点 `routing.codex` 键：上游键（见设计 15.1）与本地键清单，写入本计划附录 | — | 清单与代码读取点一致 |
| P4.2 | `executor_settings` 表 + `config_revisions`；启动时从 `routing.json` 的本地键一次性导入；读取统一走新存储；`routing.json` 删除已迁移的本地键 | 迁移、`src/lib/executor/settings-store.mjs`、`codex-route.mjs` | 设置页读写回归；上游键行为不变 |
| P4.3 | 设置发布：心跳响应携带 `settings_revision`（R4 审查后改名，避免与上游 `config_revision` 混淆），Worker 记录已应用版本；请求信封与请求尝试记录同一快照的版本 | `gateway-routes.mjs`、Worker | 修改后一个心跳周期内所有实例收敛的测试 |
| P4.4 | Worker 设置描述接口 `GET /internal/v1/schema/settings`、`/schema/account`；控制面按 schema 校验保存 | Worker `schema.go`、`settings-store.mjs` | 非法值被拒；schema 版本变化测试 |
| P4.5 | 模型目录：上游目录与 BPS 目录由控制面定时缓存，`/v1/models` 不再在请求路径访问 Worker | `codex-catalog.mjs`、`gateway-execution.mjs` | 目录回归测试 |

阶段完成标准：本地设置全部来自控制面存储并带版本；审查 R4 关闭。

### P5 共享运行态与协议状态（Redis）

前提：**用户确认引入 Redis**（部署与运维）。用户 2026-11-05 确认引入。开关：`KIN_REDIS_URL`（未设置即关闭，维持会话亲和）。

实施设计（2026-11-05 细化）：

- **客户端与降级（P5.1）**：Worker 用 go-redis v9；`KIN_REDIS_URL`（`redis://` / `rediss://`），键前缀 `KIN_REDIS_PREFIX`（默认 `kin:gw:`）。连接与读写超时 1 秒以内；每 5 秒探活。Redis 不可用时每项能力退回本地行为（本地并发、本地冷却、磁盘协议状态），恢复后自动回到共享；健康接口与心跳报告 `shared_state`（后端、是否健康、最近错误），「Gateway Worker」页显示。协议内容（BPS 回放、目录、续接快照、图片检查点）以凭据包密钥派生的 AES-256-GCM 密钥加密，附加认证数据为 Redis 键；历史来源只存（调用方范围 + 标识）的 SHA-256 与通道名，并发与冷却只存账号 ID、时刻与原因。
- **跨实例并发（P5.2）**：每个账号、每个池（普通 / Guardian）一个有序集合信号量，成员为持有者令牌，分数为到期时刻；Lua 脚本原子执行“清理过期 → 未满则加入”。本地准入成功后再取共享租约（不在调度锁内做网络调用）；被拒时归还本地租约，并把该账号短暂（250 毫秒）记为“远端满载”，按原有排队等待。租约 30 秒到期，每 10 秒续期，请求结束释放。续期发现租约已丢失（Redis 重启等）时补登记，不取消在途请求：中途取消会伤害调用方并浪费上游用量（对原计划“续期失败取消”的修订）。并发上限在准入时控制；Redis 短暂不可用期间准入的请求记为无令牌租约，恢复后补登记，故障恢复的短时间内合计可能超限（R5 审查后修订）。
- **冷却共享（P5.3）**：原生冷却 `CooldownUntil`、按模型冷却、错误保护冻结、BPS 冷却、BPS usage-policy 退避（2026-11-06 起按账号），以（账号, 类别, 实例）为字段写入共享哈希，值为截止时刻与原因类别；每个实例只写、只删自己的字段，读取时按（账号, 类别）取最晚截止。本地状态变化后去抖发布，写入成功才记为已发布，每 30 秒全量重发；各实例每秒拉取一次，忽略自己的字段，合并为调度时的“共享限制”；Redis 不可用时清空共享限制。控制面只展示（心跳里的共享状态）。错误保护冻结原有的心跳通道保留（服务没有 Redis 的部署），见设计第 7 节（R5 审查后修订）。
- **协议状态（P5.4）**：BPS 回放、会话目录、续接快照、图片检查点实现 `basispoints.StateStore` 的 Redis 版本（版本号 CAS 用 Lua，空闲 2 小时过期，单条上限沿用 `MaxStateEntryBytes`）；历史来源写 Redis（24 小时），查询先本地后 Redis。Redis 出错时读写退回数据目录。
- **测试（P5.5）**：Go 单测用 miniredis；多实例 e2e 用 miniredis 起的真实 TCP 服务（测试辅助程序），覆盖跨实例续接与签发账号共享（2026-11-05 起历史来源不再锁定通道）、冷却与冻结传播、Redis 停止后降级与恢复。

| 编号 | 任务 | 完成标准 |
| --- | --- | --- |
| P5.1 | Worker Redis 客户端、键设计、加密与 TTL；不可用时降级 | 降级测试 |
| P5.2 | 跨实例账号并发租约（持有者 token、续期；续期丢失补登记、不取消在途请求，见实施设计） | 两实例并发上限测试 |
| P5.3 | 冷却、错误保护冻结、usage-policy 退避共享；控制面只展示与审计 | 一实例冷却，另一实例立即生效 |
| P5.4 | BPS 回放、会话目录、续接快照、历史来源、图片检查点迁入 Redis | 跨实例续接与签发账号共享测试 |
| P5.5 | 多实例 e2e 与故障演练（Redis 停止、实例失联） | 演练记录写入审查报告 |

### P6 界面按设置描述渲染

| 编号 | 任务 | 完成标准 |
| --- | --- | --- |
| P6.1 | 通用 schema 表单渲染组件（分组、条件显示、校验、四语文案 key） | 组件单测 |
| P6.2 | Codex 设置区、BPS 账号设置改用 schema 渲染，与手写组件对照一致后删除手写组件与重复文案 | 交互回归；手写组件无残留 |
| P6.3 | 账号向导按能力描述的授权方式生成 | OAuth、BPS 流程浏览器验收 |

### P7 Claude 执行物理拆分

默认 `skipped`。只有 `docs/performance/process-split-plan.md` 的决策门触发且用户确认接受上游移植成本时才展开任务。

### PF 整体验收

| 编号 | 任务 | 完成标准 |
| --- | --- | --- |
| PF.1 | 按设计第 17 节逐条验收并记录证据 | 6 条全部有证据或明确的未满足项 |
| PF.2 | 两个独立审查智能体分别审查全部改动（一个侧重正确性与计费，一个侧重安全与上游同步） | 报告 `reviews/PF.md`，P0/P1 全部关闭 |
| PF.3 | 文档收尾：设计状态改为“已实施”，运维文档（开关、迁移、回滚） | 文档评审通过 |

---

## 附录 A：Codex 本地设置键（P4.1 盘点，2026-11-05）

上游 `routing.codex` 键保持上游原样（`enabled`、`catalog_client_version`、`user_agent`、`upstream_transport`、`websocket`、`client_features`、`analytics`、`protocols`、`convert`、`clients`、`quota`、`model_mappings`）。本地新增的 8 个键迁入控制面设置存储（`executor_settings`，定义见 `src/lib/executor/codex-settings.mjs`，描述见 `src/shared/executor-schema/codex-settings.json`）：

| 键 | 读取方（迁移后） | 下发 Worker |
| --- | --- | --- |
| `gateway_worker.preference` | `gateway-execution.mjs` `shouldUse`、`handle-codex-gateway.mjs` 回退判断 | 否 |
| `scheduling` | `handle-codex.mjs`（VM 槽位排序、选号原因、`codexGatewayScheduling` 信封） | 请求信封 |
| `warmup` | `gateway-routes.mjs` 心跳策略（只给指定实例） | 心跳 |
| `reset_credit` | 心跳策略 | 心跳 |
| `credit_overage` | `codex-usage.mjs` `codexCreditOverageAllowed`、心跳策略 | 心跳 |
| `bps_enabled` | `handle-codex.mjs` 信封、`gateway-execution.mjs` `bpsModels` | 请求信封 |
| `bps_images` | `handle-codex.mjs` 信封 | 请求信封 |
| `bps_defaults` | `account-management.mjs` `bpsDefaults`（首次 BPS 授权） | 否 |

---

## 4. 顺序与依赖

```text
P0 → P1 → P2
      ├──→ P3
      └──→ P4 → P6
P5（Redis 决策门） 可在 P1 之后任何时候开始
P7 默认不做
P1–P6 完成 → PF
```

单线程执行顺序：P0 → P1 → P2 → P3 → P4 → P6 → P5（若已获准）→ PF。

## 5. 需要用户决定或授权的节点

| 节点 | 内容 | 未获答复时 |
| --- | --- | --- |
| P1.10 | 生产以 `primary` 观察一个发布周期后删除旧通道 | 保持 `deferred`，继续后续阶段 |
| P3.10 | 生产凭据迁移并切换 | 保持 `deferred`，继续后续阶段 |
| P5 | 是否引入 Redis | 用户 2026-11-05 确认引入 |
| P7 | 是否物理拆分 Claude | `skipped` |
| 预算超限 | 任一任务超出 2.7 预算 | 该任务 `blocked`，跳到不依赖它的任务 |

## 6. 风险

| 风险 | 应对 |
| --- | --- |
| 事件与回执并行期间重复结算 | 写入器按 `request_id` 幂等；影子模式不生效 |
| 刷新租约实现错误导致令牌被重复使用 | 默认关闭；多实例并发测试；租约结果不明时不自动重发 |
| 凭据集中后控制面泄露面变大 | 信封加密、按实例封装、审计、导出确认 |
| 上游同步冲突上升 | 2.7 预算与每次交付统计 |
| 其他会话并行改 main | 交付脚本检测远端前进，三方合并 |
| 长时间工作中断 | 第 0 节续接流程；每个小步提交检查点 |
