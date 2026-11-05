# 数据库访问与后台接口架构：对照 sub2api、CPR 的设计

状态：设计与路线。R1（定制 SQL 收进领域仓储）、R2（声明式路由表）已实施（2026-11-05，见 4.2、4.4 的实施结果）；R3–R6 未实施。日期：2026-11-05。

对照快照：

| 系统 | 快照 | 本机路径 |
| --- | --- | --- |
| vm2api | `main` `4b980732`（上游 `6a8f9c7f` + 累计定制提交） | 本仓库 |
| sub2api（定制 NewAPI，Go） | `54f179cde`（2026-11-04） | `~/Git/sub2api`，只读 |
| CPR（codex-proxy-rs，Rust） | `21d84af2`（2026-11-05） | `~/Git/codex-proxy-rs`，只读 |

本文回答三个问题：两套参考系统的数据库是怎么设计的；它们的后台有多少接口读写数据库；vm2api 应该怎样划分接口、分层和组织数据访问。

和已有文档的分工：

- [ARCHITECTURE_TARGET_20261102.md](ARCHITECTURE_TARGET_20261102.md)：PostgreSQL + Redis 终态下的数据归属、请求生命周期、统计投影和配置发布。本文不重复。
- [POSTGRESQL_MIGRATION_PLAN_20261103.md](POSTGRESQL_MIGRATION_PLAN_20261103.md)：换存储引擎的方案，包括类型映射、方言、`rowid` 水位和同步改异步。本文第 6 节的 R6 引用它的阶段 1。
- [ARCHITECTURE_CONTROL_PLANE_EXECUTORS_20261105.md](ARCHITECTURE_CONTROL_PLANE_EXECUTORS_20261105.md)：D8“数据库跟随上游”。本文所有建议都在 D8 之内：不迁上游表，不改上游 SQL；需要越过 D8 的，单独列为待决定事项。

本文不授权代码改造、数据迁移、生产部署或数据处置。

## 0. 结论

1. **三套系统都把“推理热路径”和“管理后台”分开处理。** 热路径同步时只读内存快照（Key、配置、账号），每个请求只写一条事实；用量、日志、统计都异步写。后台写入是一个操作一个事务，事务里同时写审计。
2. **真正给数据库带来压力的只有两类接口：推理热路径，以及统计与用量查询。** 管理 CRUD 数量多，但都是低频、小事务。CPR 给观测查询单独分了连接预算；sub2api 的看板全部查汇总表。
3. **vm2api 的主要问题是数据访问分散，不是表结构。** `src` 中共 646 处 `.prepare(`，`src/lib/db` 里 252 处，其余 394 处分散在 42 个业务文件中。这 394 处里：
   - 354 处在纯定制文件中（vendor、gateway-worker、executor、admin 中的定制模块）；
   - 35 处是定制往上游文件里加的（`panel-routes.mjs` 30 处）；
   - 只有 5 处来自上游原文件。
   因此把 SQL 收进各领域的仓储，基本不碰上游，不增加同步成本。
4. **建议按六类接口分别规定读写规则**（第 3 节），并在定制范围内补三样基础设施：
   - 领域仓储加 lint 守卫；
   - 声明式路由表加覆盖测试；
   - 管理写操作的事务模板（校验 → 写入 → revision → 审计）。
5. **不照搬两套参考系统的规模。** sub2api 约 140 张表、850 个服务文件；CPR 自研了投影状态机。对单进程 SQLite 控制面来说都太重。

## 1. 数据库设计对照

### 1.1 总表

| 维度 | sub2api | CPR | vm2api |
| --- | --- | --- | --- |
| 语言与访问层 | Go；Ent（44 个 schema）加大量手写 SQL（`lib/pq`） | Rust；sqlx 运行时查询，约 337 处 `query`、78 处 `QueryBuilder`；Core 声明“数据库中立”的端口，实现只有 PostgreSQL | Node；`node:sqlite` `DatabaseSync` 同步调用 |
| 数据库 | 只用 PostgreSQL | 只用 PostgreSQL | SQLite（WAL），与控制面同进程；另有 4 个只读 worker 连接和 1 个统计线程 |
| 表数量 | 约 140 张（Ent 只描述了其中一部分） | 36 张表加 1 个视图 | 81 张 |
| 迁移 | 379 个 SQL（其中 17 个 `_notx` 用于 `CONCURRENTLY`），带 checksum，advisory lock 保证单实例执行（`internal/repository/migrations_runner.go`） | 38 个，启动时 `sqlx::migrate!`；已合入的按字节冻结，用 `.frozen-sha256` 校验 | 112 个，带 SHA-256 校验，逐个事务执行 |
| 连接与超时 | 连接池 | 默认 20 连接；每个连接 `statement_timeout` 30s、`lock_timeout` 5s；观测查询另有连接预算 | 单写连接；面板日志扫描走只读 worker |
| 请求事实 | `usage_logs` 带快照列、约 20 个索引，批量异步写 | `model_requests` 一请求一行，大字段放受校验的 JSON，再用视图投影出类型化字段；运行中租约单独放一张窄表 | `usage_logs` + `request_attempts`（write-behind，每批 32 条）；Gateway 另有 `gateway_worker_receipts` |
| 计费账本 | 计费事件 → 一个事务内完成去重认领、条件扣余额、写 `usage_logs`；`FOR UPDATE SKIP LOCKED` 恢复中断的记账（`usage_billing_events.go`） | 费用写入 `on conflict(request_id) do nothing` 幂等；预算窗口用 `for update` 行锁 | `RelayBilling.authorize` / `settle` 同步事务；回执、尝试记录按 `request_id` 幂等 |
| 统计 | 后台任务每 60s 按水位线汇总到小时、天，需要抢 leader 锁；明细保留 90/180/730 天（`dashboard_aggregation_repo.go`） | 触发器在源事务里把请求 ID 写进待处理表（库内 outbox），Worker 每 5s 增量投影到 15 分钟、1 小时、1 天桶；查询时合并已投影的桶和边界明细 | `usage_cost_hourly`（迁移 093，定制）：触发器同步维护，整小时读汇总、边界小时读明细；只覆盖账号成本类查询。面板使用记录统计仍扫 `usage_logs`（放在只读线程中） |
| 配置一致性 | 认证信息两级缓存（进程内 ristretto + Redis），pub/sub 通知失效 | 业务写入、`config_revision` 加 1、审计在同一事务；请求开始时冻结一份内存快照；pub/sub 加 5s 对账 | 执行设置已有 `config_revisions`（控制面 P4）；其余配置是文件（`routing.json`）加 `fs.watch` |
| Redis | 用途很广：限流、并发槽、调度快照、计费在途、会话、锁、队列 | 只存可丢失、可重建的协调状态（准入、租约、冷却、亲和、会话）；队列和事实都放 PostgreSQL | 只给 Gateway Worker 的共享运行态用（P5），控制面不用 |
| 金额 | 库里是 decimal，Go 代码里是 `float64` | `numeric(20,10)` | 混用：`*_micros`、`*_nano_usd*` 是整数；`total_cost`、`balance`、`multiplier` 等是 `REAL` |
| 凭据与 Key | 明文保存 | 明文保存 Client Key，常量时间比较 | Key 存哈希；执行凭据信封加密（控制面 P3） |

### 1.2 可以借鉴的做法

- **一请求一行事实，尝试和费用以 `request_id` 幂等**（三套都有，vm2api 已具备）。
- **观测写入和计费写入分开处理**：观测写入用有界队列，写不进去时放行请求（CPR 满了就丢弃并计数）；计费写入写不进去时拒绝请求。
- **统计只查汇总表**：sub2api 用水位线定时汇总，CPR 用库内 outbox 增量投影。vm2api 的 `usage_cost_hourly` 用触发器同步维护，在 SQLite 单写者下最简单，应作为扩展的基础。
- **配置写入与审计、revision 同事务**，请求开始时冻结快照（CPR）。
- **迁移冻结并校验**（CPR 按字节冻结；vm2api 已有 SHA-256 校验）。
- **权限路由表加覆盖测试**：sub2api 的 `internal/authz/routes.go` 把每个路由登记为只读或修改，`policy_test.go` 保证没有遗漏。
- **分页不对大表全量 `COUNT`**：sub2api 用游标（`usage_log_cursor.go`）；CPR 的用量深页先按 15 分钟计数定位。

### 1.3 不照搬的做法

- sub2api 的金额用浮点运算、明文保存 Key 与凭据、把 Redis 当队列和锁的主力，以及整体规模。
- CPR 每次选号都同步读数据库（Node 单线程下应读内存快照）；依赖 PostgreSQL 特性的 plpgsql 触发器、RR 快照、GIN 索引；约 4 万行 Store 代码的投影状态机。
- 两套系统都用 Go/Rust 的强类型 DTO 三层分离（wire / model / row）。vm2api 是 JS，三层 DTO 收益有限，只保留“路由层负责入参校验与出参裁剪、仓储返回普通对象”这一条边界。

## 2. 后台接口规模与读写

统计口径：

- sub2api 按 `internal/authz/routes.go` 的登记统计；
- CPR 统计 `crates/gateway-api/src` 中的 `.route(` 注册，按 HTTP 方法拆开计数；
- vm2api 用 `src` 中的路径字面量去重统计，方法分支数是 `method === 'X'` 的出现次数（包括少量非路由判断，作为近似值）。

| 系统 | 接口总数 | 管理后台 | 后台读 / 写 | 其他 |
| --- | --- | --- | --- | --- |
| sub2api | 约 783 | 约 464 | 只读 199 / 修改 267 | 对外约 126、用户侧约 193 |
| CPR | 164 | 123 | 读约 45 / 写约 52 / 不访问数据库约 26 | 对外推理 28；健康、登录、Key 用量 11 |
| vm2api | 方法分支约 342（GET 129、POST 154、PUT 23、PATCH 15、DELETE 21） | `/api/panel/` 108 个路径、`/api/admin/` 11 个、`/api/vendor` 8 个 | GET 129 / 修改类 213（含推理 POST） | `/internal/v1/` 34 个（执行器契约）、`/v1/` 25 个 |

CPR 管理后台各组的分布：

- 账号 29（读约 9 / 写 12 / 调上游 8）；
- 插件 29；
- 设置 14（其中 5 个是预览和探测）；
- 观测 12，全部是重查询；
- Client Key 8、代理 8、备份 8、系统 8（全部不访问数据库）、账号分组 7。

这个分布说明：

- 管理后台的写接口多，但都是低频小事务，不是瓶颈；
- 有相当一部分接口根本不访问数据库（调上游、探测、读进程状态），不应占用数据库连接或事务；
- 观测和统计接口数量不多，但每个都是重查询，必须单独限制。

## 3. 接口分类与读写规则

vm2api 的每个接口都应归入下面六类之一，并在路由表中登记（见 4.4）。

| 类别 | 范围 | 读 | 写 | 失败策略 |
| --- | --- | --- | --- | --- |
| A. 推理热路径 | `/v1/*`、`/v1/messages` 等客户端入口 | 只读内存快照：Key、分组、价格、账号、路由配置。请求中不查列表，不做全表扫描 | 预检与结算（`authorize` / `settle`）是一次短事务；`usage_logs`、`request_attempts` 走 write-behind 批量写；回执与事件按 `request_id` 幂等 | 计费写不进去时拒绝请求；观测写不进去时放行，只计数和告警 |
| B. 管理写操作 | 面板中的创建、修改、删除、批量操作 | 校验所需的当前值 | 一个操作一个事务：校验 → 业务写入 → revision 加 1（会影响路由或计费的配置）→ 审计。提交后发布快照或让缓存失效 | 整体回滚；事务中不调上游、不做网络请求 |
| C. 管理读列表与详情 | 账号、Key、用户、供应商资源、使用记录列表 | 走仓储的列表方法：固定排序、keyset 或游标分页；大表（`usage_logs`、`request_attempts`、`billing_charges`）不做全量 `COUNT` | 无 | 超时返回部分结果或提示缩小范围 |
| D. 统计与看板 | 使用记录统计、排行、成本、预测 | 只查汇总表（`usage_cost_hourly` 及后续扩展），边界上的少量明细从索引补齐；在只读线程或连接上执行 | 无（汇总由触发器或后台任务维护） | 单独的超时与并发上限；结果按汇总的版本缓存 |
| E. 内部执行器契约 | `/internal/v1/*` | 投影、租约、设置描述 | 事件收件箱、回执、尝试补齐，以（实例, 序号）或 `request_id` 幂等 | 已在控制面重构中实现（执行契约 v1），保持现状 |
| F. 不访问数据库的操作 | 连接测试、上游探测、VM 命令、读进程状态 | 不读库，或只在开始时读一次配置 | 只在结束时写一条结果或审计 | 不持有事务，不占用写连接 |

补充规则：

- **跨类别的接口要拆开。** 例如“测试连接并保存结果”应先做 F 类操作（事务外），再做 B 类写入（短事务），不能在事务里等上游响应。
- **重查询不放进 B 类的同一个请求。** 写操作的响应只返回被写的对象，列表刷新交给 C 类接口。
- **A 类只读快照。** 快照因 B 类写入失效时，可以按 revision 重建，也可以靠定时对账收敛，但请求路径上不回退到实时查询。

## 4. 分层架构

### 4.1 分层与职责

```text
路由（route table）
  解析参数、入参校验、权限（按路由表）、出参裁剪
    ↓
用例 / 服务（use case）
  业务规则、事务边界、审计、revision、提交后发布快照
    ↓
仓储（repository）
  唯一写 SQL 的地方；按领域分文件；返回普通对象
    ↓
SQLite（DatabaseSync；以后可换异步 DbClient，见 R6）

后台任务：汇总维护、保留期清理、对账、快照发布
```

约束：

- 路由层不写 SQL，也不开事务。
- 服务层通过仓储访问数据，事务用现有的 `withTransaction` 包住一个用例。
- 仓储不调网络，不读快照，不感知 HTTP。
- 后台任务和接口共用同一套仓储，不另写一份 SQL。

### 4.2 SQL 归属

| 代码归属 | 仓储位置 | 说明 |
| --- | --- | --- |
| 上游文件（`src/lib/db/repos/*` 等） | 保持原样 | 按 D8 与“上游优先”，不搬家，不改写 |
| 定制往上游文件中加的 SQL（35 处，主要是 `panel-routes.mjs` 30 处） | 移到对应定制领域的仓储，上游文件只保留一行调用 | 同时减少对上游文件的改动行数（计入 `scripts/upstream-touch-budget.mjs`） |
| 纯定制模块（354 处） | 各领域自己的仓储文件，例如 `src/lib/vendor/repos/`、`src/lib/gateway-worker/gateway-repo.mjs`（已是仓储形态，61 处）、`src/lib/executor/` 下的存储文件 | 按领域放，不塞进上游的 `src/lib/db/repos/` |

当前分散最多的定制文件：

| 文件 | `.prepare(` 数 |
| --- | ---: |
| `src/lib/vendor/vendor-platform.mjs` | 46 |
| `src/lib/gateway-worker/account-management.mjs` | 31 |
| `src/lib/admin/panel-routes.mjs`（定制部分） | 30 |
| `src/lib/vendor/vendor-admin.mjs` | 28 |
| `src/lib/admin/relay-billing.mjs` | 26 |
| `src/lib/executor/event-ingest.mjs` | 19 |
| `src/lib/vendor/vendor-settlements.mjs` | 18 |

守卫：加一条检查脚本（或 lint 规则），禁止在仓储目录以外新增 `.prepare(`。现存调用记为基线清单，只允许减少。每完成一批迁移就收缩基线。上游原有的调用点列为豁免。

#### R1 实施结果（2026-11-05）

- **守卫**：`scripts/sql-boundary.mjs` 统计仓储以外的 SQL 调用点，与 `scripts/sql-boundary-baseline.json` 逐文件比较，单测 `test/unit/sql-boundary.test.mjs` 随单测运行。
  - 仓储位置：`src/lib/db/` 下、任何 `repos/` 目录中，或文件名以 `-repo.mjs` 结尾的文件。
  - 调用点的口径：`.prepare(` 后跟字符串或变量，以及数据库对象上的 `.exec(`。`handle-protocol.mjs` 中的 `toolPruneCache.prepare({…})` 不是 SQL，不计入（设计初稿把它算进了“上游原有 5 处”）。
  - 新增调用点直接失败；减少后必须同步改小基线；基线只允许有原因的豁免。
- **结果**：仓储以外从 342 处降到 25 处，剩下的都是豁免：

  | 文件 | 处数 | 豁免原因 |
  | --- | ---: | --- |
  | `src/lib/pool/thinking-owner.mjs` | 6 | 上游原有代码，按上游优先不改 |
  | `src/lib/admin/usage-stats-thread.mjs` | 5 | 统计线程的连接设置（PRAGMA）与只读事务边界，业务查询走 `UsageLogsRepo` |
  | `src/lib/admin/usage-stats-worker.mjs` | 3 | 统计线程的变更检测（`PRAGMA data_version`、`total_changes()`） |
  | `src/lib/admin/relay-migration.mjs` | 11 | 启动时执行一次的数据转换，属于迁移代码 |

- **新仓储**：
  - `src/lib/vendor/repos/`：resources、vendors、members、audit、account-groups、gateway-bindings、admin-settlements、runtime-accounts、settlements、pricing、usage、account-usage、portal、runtime-policy；
  - `src/lib/admin/repos/`：panel-users、relay-billing、relay、vm-bulk-edit、group-metrics；
  - `src/lib/gateway-worker/repos/`：accounts、oauth-sessions、receipts、execution-policies、event-health、account-ids；
  - `src/lib/executor/repos/`：event-inbox、refresh-lease、vault、settings、finalized-attempts，以及按 SQL 文本缓存预编译语句的 `statement-cache`；
  - `src/lib/usage/repos/`：quota-observations。
- **约定**：
  - SQL 文本、参数顺序与 `.get/.all/.run/.iterate` 和原调用处一致；
  - 数据库对象由调用方传入（第一个参数，或仓储工厂的参数），不改变调用方用的是哪个连接；
  - 事务和保存点的边界留在调用方；原来只预编译一次的语句，搬过去后同样只预编译一次。
- **跨领域去重**：同一条 SQL 只保留一个归属。`vendor_resources`、`vendors` 的通用读写归 vendor 仓储，gateway-worker 改为引用；`operation_audit` 的写入统一用 `admin/repos/relay-repo.mjs` 的 `insertOperationAudit`。
- **上游文件**：`panel-routes.mjs`、`panel-api.mjs`、`panel-users.mjs`、`request-log.mjs`、`proxy-pool.mjs` 中定制加的 35 处 SQL 都移到了定制仓储，原处只留一行调用。这 5 个文件相对上游的差异行数共减少 76 行。
- **同步上游时**：如果上游新代码在仓储以外加了 SQL，守卫单测会失败。按上游优先不搬，在基线登记为 `exempt`，原因写“上游原有”。
- **遗留**：
  - `vendor/repos/usage-repo.mjs` 与 `gateway-worker/gateway-repo.mjs` 仍各有一份相同的两条 SQL（查询 Gateway 账号归属、写 `vendor_usage_facts`），R1 之前就分在两个模块里；
  - 仓储写法有两种：按位置透传参数，或按字段名传对象；
  - 语句缓存目前只在 executor 仓储中使用。
  这些留到 R3 改写管理写操作时一并统一。

### 4.3 管理写操作模板

```text
withTransaction(() => {
  当前值 = repo.get(id)               // 校验 revision 或存在性
  校验(输入, 当前值)
  repo.update(id, 变更)
  if (影响路由或计费) revisions.bump(域)
  audit.write(操作者, 动作, 目标, 变更字段)
})
提交后：发布快照 / 让缓存失效
```

- 执行设置（`executor_settings` + `config_revisions`）已经按这个顺序实现，可作为样板。
- 审计只记变更字段名和必要的前后值，不记凭据和密钥。
- 批量操作在一个事务内完成，或按条目逐个事务处理并返回每条的结果；不能部分成功却不报告。

### 4.4 声明式路由表

现状：`src/lib/admin/capability-policy.mjs` 用集合和正则维护“角色 × 方法 × 路径”的授权矩阵，有单测，但没有登记接口的读写类别，也不能保证每个已注册的路由都被覆盖。

建议：

- 每个路由登记方法、路径、允许的角色、类别（第 3 节的 A–F）和是否写审计；
- 授权、限流、超时按类别取默认值；
- 加覆盖测试：遍历全部已注册路由，没有登记的直接失败（参照 sub2api `internal/authz/policy_test.go`）。

`capability-policy.mjs` 是定制文件，这项改动不碰上游。

#### R2 实施结果（2026-11-05）

- **路由表**：`src/lib/admin/route-table.mjs`，431 条。
  - 覆盖 `panel-routes.mjs` 处理的 `/api/panel/*`、`/api/vendor/*`、`/api/admin/vendors/*`、`/admin/*`，以及它转交的子处理器（VM、用户、Key、端点、分组与计费、集群、备份、Gateway Worker 面板路由）；
  - 每条登记方法、路径模式、鉴权方式（`panel`、`panel_pre_gate`、`public`、`vendor`、`vendor_admin`、`super_admin`）、类别（`read`、`write`、`stats`、`action`、`auth`），以及非超管可进入角色门的角色；
  - 不含 `/v1`（推理入口）、`/internal/v1`（执行器契约，内部令牌鉴权）、站点图标与 WebSocket 升级。
- **类别与第 3 节的对应**：`read` 对应 C，`write` 对应 B，`stats` 对应 D，`action` 对应 F，`auth` 是登录与会话。各条的类别按处理代码的实际内容判定，混合型路由取主要部分。
- **来源**：两路逐文件阅读路由代码列出全部路由（`panel-routes.mjs` 252 条，子处理器 207 条）。去掉 `/internal/v1`、站点图标与 WebSocket 升级后得到 431 条。另外临时记录全量单测与 e2e 实际请求过的 316 个管理路由，逐个核对都已登记（未登记的 12 个都是测试故意请求的已删除路由、不支持的方法或越权请求）。
- **角色门改为查表**：`authorizePanelRoute` 只查表，原来的集合与正则全部删除。每条的角色按原函数对该条样例路径的判定生成。新旧函数在全部样例路径、实测路径与五种角色上逐一比对，只有一处不同：`GET /api/panel/api-keys/:id`。这条路由没有处理器，原来管理员靠前缀放行后得到 404，现在角色门直接返回 403。对应的跨租户 e2e 断言改为“403 或 404，且不泄露对方 Key”。
- **覆盖**：
  - 单测 `test/unit/route-table.test.mjs` 检查：每条格式正确且不重复；字面段优先于参数段；角色门与表一致；路由源码中出现的完整路径字面量都已登记（只做前缀、字符串替换或交回外层路由的 4 个字面量列明了原因）；
  - `panel-routes.mjs` 在鉴权与角色门之后调用 `routeTableGuard`：e2e 测试服务器设置 `KIN_ROUTE_TABLE_STRICT=1`，未登记的路由按原来的 404 格式返回；生产只按“方法 + 路径”每 10 分钟告警一次，不改变行为。
- **未做**：按类别给授权、限流、超时取默认值。当前没有按路由的限流与超时机制，加上会改变行为，留到需要时再做。各类别的写入审计仍由处理器负责，表里不登记。

### 4.5 读模型

- **快照**：A 类需要的数据（Key、分组、价格、账号、路由配置）在进程内维护快照，按 revision 或变更事件更新，并定时对账。
- **汇总**：沿用 `usage_cost_hourly` 的触发器同步维护方式。新的统计需求先判断能否用已有维度回答；不能时再增加维度或新的汇总表，不回到扫明细。
- **分页**：大表用 keyset 或游标（按 `(created_at, id)` 之类的稳定排序）；需要总数时返回汇总表给出的估计值，或者只返回“是否还有下一页”。

## 5. 数据设计约定

| 项 | 约定 | 现状与说明 |
| --- | --- | --- |
| 主键 | 带前缀的文本 ID（如 `gw-01`、`req_…`）或自增整数，表内统一 | 已有多种格式；新表按此约定，旧表不改 |
| 时间 | 新表统一一种格式：ISO 文本（与 `usage_logs` 一致）或毫秒整数，同表不混用 | 现有 105 列 ISO 文本、16 列整数（见迁移方案 3.3） |
| 金额 | 新表一律用整数（`*_micros` 或 `*_nano_usd`），不用 `REAL` | 上游表中的 `REAL` 金额列不改（D8）；整数化见待决定事项 |
| JSON 列 | 只存诊断和扩展字段；需要过滤、排序或关联的字段提成普通列并建索引 | 例：`usage_json` 已裁掉上游 attribution |
| 幂等 | 外部可能重放的写入都要有唯一键（`request_id`、（实例, 序号）、幂等键） | 回执、事件、尝试已具备 |
| 保留期 | 每张明细表都写明保留天数和清理任务；清理与汇总表一起维护 | `request_attempts` 7 天、事件收件箱 7 天已有；`gateway_worker_receipts` 没有清理（发布说明已记录约 1.5 GB 待处置） |
| 迁移 | 编号顺延，已合入的不改；破坏性变更分两步（先兼容写，再删旧） | 已有 SHA-256 校验 |

## 6. 落地路线

每一项都能独立交付、独立回滚，都不改上游表结构。

| 编号 | 内容 | 范围 | 验收 |
| --- | --- | --- | --- |
| R1（已完成） | 定制模块的 SQL 收进领域仓储，加守卫脚本与基线清单 | vendor、gateway-worker、executor、admin 中的定制模块；`panel-routes.mjs` 中的 30 处 | 守卫脚本通过且基线减到 0（上游豁免除外）；相关单测和 e2e 通过；`upstream-touch-budget` 显示上游文件改动行数减少 |
| R2（已完成） | 声明式路由表与覆盖测试 | `capability-policy.mjs` 及路由注册处 | 每个已注册路由都有登记；新增路由不登记时测试失败；授权行为与现有测试一致 |
| R3 | 管理写操作套用 4.3 模板 | 影响路由或计费的配置写入（供应商、分组、价格、账号） | 每次写入都有审计记录；需要的地方推进 revision；事务内无网络调用（用测试或静态检查确认） |
| R4 | 大表列表改 keyset 分页，去掉全量 `COUNT` | 使用记录、尝试记录、计费明细、回执 | 深页查询耗时与页号无关；前端分页交互不变或同步调整 |
| R5 | 统计只查汇总表 | 面板使用记录统计、排行、概览 | 与直接扫明细的结果逐项一致（参照 `usage-cost-rollup` 的对照测试）；在生产规模数据上耗时有界 |
| R6 | 异步数据访问接口（`DbClient`） | 即迁移方案阶段 1 | 按迁移方案的验收标准；只在决定迁 PostgreSQL 或把 SQLite 移出主线程时启动 |

建议顺序：R1 → R2 → R3，三项都只动定制代码，收益最大；R4、R5 按页面性能的实际问题启动；R6 不主动启动。

## 7. 待决定事项

| 编号 | 事项 | 说明 |
| --- | --- | --- |
| Q1 | 上游表中的 `REAL` 金额是否整数化 | 涉及上游表与上游计费代码，违反 D8；建议在上游自行调整或用户明确接受分叉成本后再做 |
| Q2 | `gateway_worker_receipts` 的保留期与历史数据清理 | 属于数据处置，需要单独授权；清理后需低峰执行 `VACUUM` |
| Q3 | 是否启动 R3 | R1、R2 已完成；R3 待用户决定，启动后按交付规范归入单一定制提交 |

## 8. 证据索引

vm2api：

- SQL 分布：在 `4b980732` 上统计 `src` 中 `.prepare(` 的出现位置，并与 `6a8f9c7f` 的同名文件对比，区分上游原有和定制新增。
- 汇总表：`src/lib/db/migrations/093_usage_cost_rollup.sql`、`src/lib/db/repos/usage-cost-rollup.mjs`。
- 授权矩阵：`src/lib/admin/capability-policy.mjs`、`test/unit/capability-policy.test.mjs`。
- 写入缓冲：`src/lib/db/write-behind.mjs`。
- 设置与 revision：`src/lib/executor/settings-store.mjs`。

sub2api（`~/Git/sub2api/backend`）：

- 迁移：`migrations/`（379 个）、`internal/repository/migrations_runner.go`。
- 计费事件：`internal/repository/usage_billing_events.go`。
- 汇总：`internal/repository/dashboard_aggregation_repo.go`。
- 游标分页：`internal/repository/usage_log_cursor.go`。
- 权限路由表：`internal/authz/routes.go`、`internal/authz/policy_test.go`。
- 分层规模：`internal/service`（851 个非测试文件）、`internal/repository`（183 个）。

CPR（`~/Git/codex-proxy-rs`，以下路径除 `docs/` 外都在 `backend/` 下）：

- 迁移：`migrations/`（38 个，`.frozen-sha256`）。
- 连接与超时：`crates/gateway-store/src/config.rs`、`crates/gateway-store/src/postgres/connection.rs`。
- 观测写入缓冲：`crates/gateway-store/src/postgres/execution_buffer.rs`。
- 投影：`migrations/0032_usage_and_scheduling.sql`、`crates/gateway-store/src/postgres/observability/analytics/worker.rs`、`query.rs`。
- 费用幂等：`crates/gateway-store/src/postgres/client_budgets.rs`。
- 配置快照：`gateway-core/src/runtime/publisher.rs`。
- 分层说明：仓库根目录 `docs/architecture.md`。
