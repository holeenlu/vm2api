# 数据库访问与后台接口架构：对照 sub2api、CPR 的设计

状态：设计与路线。R1（定制 SQL 收进领域仓储）、R2（声明式路由表）、R3（管理写操作的审计与事务）、R4（大列表 keyset 分页）、R5（统计页读汇总表）已实施（2026-11-05，见 4.2–4.5 的实施结果）；R6（全量异步化）用户 2026-11-05 决定实施，B0–B8 已于 2026-11-06 全部交付：主线程不再同步访问数据库，详见 `docs/data-access/R6_PLAN.md` 与 `R6_PROGRESS.md`。R1、R2、R4、R5 的遗留项与第 3 节的 D 类超时并发、观测写入有界队列已由技术债批次 M5 收尾（2026-11-06，见 4.6）。Q1 金额整数化（含上游表）已由技术债批次 M6 实施（2026-11-06，见 4.7）。日期：2026-11-05。

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
| 计费账本 | 计费事件 → 一个事务内完成去重认领、条件扣余额、写 `usage_logs`；`FOR UPDATE SKIP LOCKED` 恢复中断的记账（`usage_billing_events.go`） | 费用写入 `on conflict(request_id) do nothing` 幂等；预算窗口用 `for update` 行锁 | `RelayBilling.authorize` 只读准入；`settle` 在一个 `DbClient` 事务内先按 `request_id` 抢占 `billing_charges` 再扣款（R6 B7）；回执、尝试记录按 `request_id` 幂等 |
| 统计 | 后台任务每 60s 按水位线汇总到小时、天，需要抢 leader 锁；明细保留 90/180/730 天（`dashboard_aggregation_repo.go`） | 触发器在源事务里把请求 ID 写进待处理表（库内 outbox），Worker 每 5s 增量投影到 15 分钟、1 小时、1 天桶；查询时合并已投影的桶和边界明细 | `usage_cost_hourly`（迁移 093，定制）：触发器同步维护，整小时读汇总、边界小时读明细；只覆盖账号成本类查询。面板使用记录统计仍扫 `usage_logs`（放在只读线程中） |
| 配置一致性 | 认证信息两级缓存（进程内 ristretto + Redis），pub/sub 通知失效 | 业务写入、`config_revision` 加 1、审计在同一事务；请求开始时冻结一份内存快照；pub/sub 加 5s 对账 | 执行设置已有 `config_revisions`（控制面 P4）；其余配置是文件（`routing.json`）加 `fs.watch` |
| Redis | 用途很广：限流、并发槽、调度快照、计费在途、会话、锁、队列 | 只存可丢失、可重建的协调状态（准入、租约、冷却、亲和、会话）；队列和事实都放 PostgreSQL | 只给 Gateway Worker 的共享运行态用（P5），控制面不用 |
| 金额 | 库里是 decimal，Go 代码里是 `float64` | `numeric(20,10)` | M6 起全部整数：每个金额列有 `*_micros` 权威列（`*_nano_usd*` 原本就是整数），`total_cost`、`balance` 等 REAL 列只是镜像；倍率、汇率仍是 REAL 比例（4.7） |
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

实施状态（M5，2026-11-06，详见 4.6）：D 类的并发上限与超时已按路由表类别统一套用（`src/lib/admin/route-budget.mjs`）；A 类的写回队列已加上限，观测写入写不进去时丢弃并计数，计费写入改为直接落库，不丢弃（`src/lib/db/write-behind.mjs`）。D 类“结果按汇总的版本缓存”仍未做。

A 类“计费写不进去时拒绝请求”（中期技术债 M3 降级演练，2026-11-06）：预检是只读的，原来没有写入可以失败，数据库写不进去时请求照常放行、交付后的结算失败只打一行日志。现在按写连接上的错误码判定“写入失败中”（`src/lib/db/write-health.mjs`）：期间新的计费请求在准入时返回 503 `database_unavailable`（带 `Retry-After`）；已准入请求的收口（结算 + 使用记录）失败时只把补写数据交给后台串行重试（`src/lib/db/commit-retry.mjs`），停机时剩余的写入 `pending-commits.jsonl` 由 `scripts/replay-pending-commits.mjs` 补写；写回队列暂停、恢复后排空，整批被 SQLite 回滚时全部重排。演练与限制见 `docs/control-plane/ACCEPTANCE.md` 第 5 条。

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
SQLite（DatabaseSync；主线程经异步 DbClient 访问，见 R6）

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
  - `src/lib/executor/repos/`：event-inbox、refresh-lease、vault、settings、finalized-attempts（R6 B3 起经 `DbClient` 异步访问，语句缓存由 `DbClient` 负责，`statement-cache` 已删除）；
  - `src/lib/usage/repos/`：quota-observations。
- **约定**：
  - SQL 文本、参数顺序与 `.get/.all/.run/.iterate` 和原调用处一致；
  - 数据库对象由调用方传入（第一个参数，或仓储工厂的参数），不改变调用方用的是哪个连接；
  - 事务和保存点的边界留在调用方；原来只预编译一次的语句，搬过去后同样只预编译一次。
- **跨领域去重**：同一条 SQL 只保留一个归属。`vendor_resources`、`vendors` 的通用读写归 vendor 仓储，gateway-worker 改为引用；`operation_audit` 的写入统一用 `admin/repos/relay-repo.mjs` 的 `insertOperationAudit`。
- **上游文件**：`panel-routes.mjs`、`panel-api.mjs`、`panel-users.mjs`、`request-log.mjs`、`proxy-pool.mjs` 中定制加的 35 处 SQL 都移到了定制仓储，原处只留一行调用。这 5 个文件相对上游的差异行数共减少 76 行。
- **同步上游时**：如果上游新代码在仓储以外加了 SQL，守卫单测会失败。按上游优先不搬，在基线登记为 `exempt`，原因写“上游原有”。
- **遗留**（M5 复核，2026-11-06）：
  - ~~`vendor/repos/usage-repo.mjs` 与 `gateway-worker/gateway-repo.mjs` 仍各有一份相同的两条 SQL（查询 Gateway 账号归属、写 `vendor_usage_facts`）~~。**已合并**：R6（B4、B8）把它们改成 async 时已收成一处，`gateway-repo.mjs` 引用 `vendor/repos/usage-repo.mjs` 的 `gatewayAccountResource` 与 `insertUsageFact`；M5 核实 `src` 中这两条 SQL 各只出现一次（`GATEWAY_ACCOUNT_RESOURCE_SQL`、`INSERT_USAGE_FACT_SQL`），无需再改；
  - 仓储写法有两种，**不统一**：按位置透传参数（`fn(db, a, b)`，多数由 R1 原样搬迁的 SQL，参数顺序与 SQL 占位符一致）与按字段名传对象（`fn(db, { a, b })`，参数多或可选的查询）。两种写法都只在仓储内部决定 SQL 参数顺序，调用方不拼 SQL；统一要改全部调用点而没有行为收益。新写的仓储函数：参数不超过 3 个且都必填时按位置，否则按对象；
  - ~~语句缓存目前只在 executor 仓储中使用~~。R6 起由 `DbClient` 按 SQL 文本统一缓存预编译语句（最近使用的 512 条），各仓储不再自建缓存。

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

#### R3 实施结果（2026-11-05）

- **盘点**：路由表中会写库或写配置文件的路由共 231 条。其中 105 条由处理器写审计（`operation_audit` 60 条、`vendor_audit_events` 45 条），其余没有审计；没有发现事务内的网络调用。
- **路由级审计**：
  - 路由表每条增加审计方式：`handler`（处理器写完整审计，99 条）、`route`（由面板按路由写，107 条）、`none`（读、观测类操作与不落盘的路由，225 条）；
  - `route` 的路由在响应成功后，由 `src/lib/admin/route-audit.mjs` 写一条 `operation_audit`：操作者、`route:<方法> <路径模式>`、实际路径，以及请求体的顶层字段名；
  - 不记字段值（请求体里可能有凭据、密码、代理密码），也不记失败的请求；
  - 只部分审计的处理器（例如用户的创建与修改只审计分组变化）也标为 `route`，因此会多一条按路由的记录；
  - 单测要求每条写路由都标了 `handler` 或 `route`。不落盘的 6 条写路由（固定返回错误，或只改进程内状态）列明了原因。
- **事务与一致性修复**：
  - `PUT /api/panel/onboarding` 选用量方案、`POST /api/panel/dataplane` 全局切换时，恢复上游的 `await`。原来路由写入失败会被吞掉并先回成功，参数错误也不回 400；
  - BPS 撤销的凭据与租约删除，并入配置写入与审计的事务（BPS 通道已于 2026-11-07 停止运营，撤销路径随 BPS 代码与数据一并删除，迁移 133）；
  - 托管公钥替换与审计并入同一事务。
- **静态守卫**：单测禁止把 async 函数传给 `withTransaction`，因为回调同步执行，`await` 之后的写入不在事务里。
- **按 revision 推进**：只在有读取方的地方推进。执行设置已经这样做；分组、价格、账号目前没有按 revision 失效的快照，加 revision 只会多出无人读取的字段，因此本轮不加。
- **未处理，有依据**：
  - 路由配置写文件后再按 CAS 推进 revision，冲突时只恢复内存（`routing-runtime.mjs`，上游代码）。检查与推进之间没有 `await`，单进程部署下不会冲突，按上游优先不改；
  - 历史成本重算每 2000 行提交一次（`usage-logs-repo.mjs`，上游代码）；
  - 代理池保存分两步提交（`proxy-pool.mjs`，上游代码）；
  - 设置类接口把审计包在 `try/catch` 里，审计失败只是没有记录，不影响设置本身；
  - 供应商账号归档先改文件、等待停机，再进事务：涉及 VM 进程，无法与数据库同一事务；
  - 路由表中有几条类别与实际行为不完全一致（例如 `DELETE /api/panel/vms/:id` 记为 action，实际也写库）。审计方式按实际行为判定，类别留到需要按类别取默认值时再调整。

### 4.4 声明式路由表

现状：`src/lib/admin/capability-policy.mjs` 用集合和正则维护“角色 × 方法 × 路径”的授权矩阵，有单测，但没有登记接口的读写类别，也不能保证每个已注册的路由都被覆盖。

建议：

- 每个路由登记方法、路径、允许的角色、类别（第 3 节的 A–F）和是否写审计；
- 授权、限流、超时按类别取默认值；
- 加覆盖测试：遍历全部已注册路由，没有登记的直接失败（参照 sub2api `internal/authz/policy_test.go`）。

`capability-policy.mjs` 是定制文件，这项改动不碰上游。

#### R2 实施结果（2026-11-05）

- **路由表**：`src/lib/admin/route-table.mjs`，实施时 431 条；之后新增的路由按同样规则登记，条数以导出的 `ROUTES` 为准（2026-11-06 为 441 条）。
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
  - M5（2026-11-06）：`stats` 类别已按类别统一挂上并发上限与超时（见 4.6）；其他类别仍没有按类别的限流与超时。

### 4.5 读模型

- **快照**：A 类需要的数据（Key、分组、价格、账号、路由配置）在进程内维护快照，按 revision 或变更事件更新，并定时对账。
- **汇总**：沿用 `usage_cost_hourly` 的触发器同步维护方式。新的统计需求先判断能否用已有维度回答；不能时再增加维度或新的汇总表，不回到扫明细。
- **分页**：大表用 keyset 或游标（按 `(created_at, id)` 之类的稳定排序）；需要总数时返回汇总表给出的估计值，或者只返回“是否还有下一页”。

#### R4 实施结果（2026-11-05）

- **现状**：控制台的使用记录页（`/api/panel/usage-logs`）和钱包流水已经是 keyset 游标分页，不做全量 `COUNT`。
- **问题**：游标条件写成 `created_at < ? OR (created_at = ? AND id < ?)`，SQLite 无法据此确定索引扫描的起点。带筛选条件（例如按模型）翻页时，每页都要从最新一条重新扫起，越往后越慢。本机 108 万行实测：第 100 页 19 毫秒，第 1000 页 194 毫秒。
- **改法**：改成等价的 `created_at <= ? AND (created_at < ? OR id < ?)`，先给出范围上界，查询计划从全表扫描变为范围查找。修改了两处：
  - `usage-logs-view.mjs`：使用记录页；
  - `relay-billing.mjs`：钱包流水。
- **效果**：同样按模型筛选，第 1000 页降到 1.1 毫秒，与第 1 页相同。
- **守卫**：单测检查游标查询的执行计划必须是 `SEARCH … (created_at<?)`；改回旧写法时测试失败。
- **未改，有依据**：
  - ~~`/request-logs` 普通模式的 OFFSET 分页加全量 `COUNT`~~：M5 已改为 keyset 游标，不再整表 `COUNT`（见 4.6）；
  - 导出时的一次 `COUNT`：用于告诉用户被截断了多少，只在导出时执行，且在只读线程池里运行。

#### R5 实施结果（2026-11-05）

- **范围**：统计页（`/api/panel/statistics` 的时间序列、合计与环比，`/api/panel/statistics/leaderboard` 排行）。这两个接口在主线程同步执行，是长时间窗聚合阻塞网关的来源。
- **汇总表**：迁移 115 `usage_stats_hourly`。
  - 按小时汇总，维度是统计页可分组的列（用户、Key、模型、槽位、计费分组、入口），加上谓词读取的列（`status`、`error_code`）；
  - 平均耗时、首字耗时存和与个数，便于跨段合并；
  - 由 `usage_logs` 的插入、更新、删除触发器同步维护（与 093 `usage_cost_hourly` 相同的方式），迁移时按现有数据回填；
  - NULL 存为 `''` 或 `-1`，读取时 NULLIF 还原。
- **读取**（`src/lib/db/repos/usage-stats-rollup.mjs`）：
  - 时间窗拆成起点、终点所在的不完整小时（读 `usage_logs`）与中间的整小时（读汇总表），投影成同一形状后合并；
  - 归属谓词（`ownerPred`）与成败谓词（`SUCCESS_PRED` / `ERROR_PRED`）原样套在合并结果上，因为它们只读 `user_id`、`api_key_id`、`status`、`error_code`；
  - 时间序列按 15 分钟槽分桶，桶边界不在整点时（非整小时时区）整段改用原查询。系统时区固定为 `Asia/Shanghai`，实际都走汇总表。
- **上游文件**：`statistics-repo.mjs`（上游）只把三段取数拆成可覆盖的方法（`_seriesRows`、`_totalsRow`、`_leaderboardRows`），SQL 不变；汇总实现是定制子类 `RollupStatisticsRepo`，`panel-routes.mjs` 改用它。上游以后改统计页的展示逻辑，仍能直接合并。
- **一致性**：单测按 4 种时间范围 × 6 种归属 × 6 个维度，比较时间序列与排行，在插入后以及更新、改时间、删除后都与直接扫明细逐项相同。费用是浮点和，求和顺序不同可能有 1e-9 量级的差异；两个系列费用恰好相等时，这种差异可能让排名先后互换。
- **耗时**（本机，按生产的相关性构造 30 天、108 万行，汇总表 33 万行）：
  - 统计页 30 天：2.1 秒降到 0.26–0.32 秒；排行：1.2 秒降到 0.24 秒；
  - 管理员范围 30 天：1.18 秒降到 0.08 秒；单个用户：0.15 秒降到 0.06 秒；
  - 写入开销每行约 7 微秒（维度完全打散时约 20 微秒）。
  - 生产最近 6 小时实测压缩约 18 倍（3.3 万次请求对应 1820 个汇总行），比本机样本更集中，预期更快。
- **未做，有依据**（M5 已处理，见 4.6）：
  - ~~使用记录页的汇总（`summary`）~~：汇总表能回答的筛选改读 `usage_stats_hourly`，其余回落逐行扫描；
  - ~~使用记录排行（`ranking`）~~：改为当前筛选下的精确合计（不再按最新 5000 行抽样），只有按行判定错误类别时仍抽样；
  - ~~概览（`overview`）~~：今日与昨日同期读汇总表；会话数只取最近 5 分钟，仍读明细（窗口小，走时间索引）。

### 4.6 M5：数据访问遗留项（2026-11-06）

技术债批次 M5 收尾 R1、R2、R4、R5 的遗留项，并落实第 3 节的 D 类超时与并发、A 类观测写入有界队列。

#### `/request-logs` 普通模式改 keyset 分页

- **改法**：`UsageLogsRepo.query`（`src/lib/db/repos/usage-logs-repo.mjs`）去掉整表 `COUNT`，按 `(created_at DESC, id DESC)` 取 `limit + 1` 行。游标谓词与使用记录页相同：`created_at <= ? AND (created_at < ? OR id < ?)`。
- **响应**：保留 `items`、`limit`、`offset`、`config`；新增 `next_cursor`（`{ created_at, id }`，没有下一页时为 null）与 `has_more`；不再返回 `total`。请求参数新增 `cursor_created_at`、`cursor_id`。
- **按行判定错误类别**：指定 `error_class`，或屏蔽 `auth` 以外的类别时，分块（每块 500 行）扫描并在扫描中过滤，页面尽量填满。一次调用最多读 5000 行；读满仍不够一页时，游标指向最后读到的行，`has_more` 为 true。原来是先分页再在 JS 中删掉屏蔽行，一页常常不满。
- **兼容**：`offset` 是上游 `GET /api/panel/request-logs` 的公开参数（上游基线 `5424589a` 的 `panel-routes.mjs` 第 2092 行，上游注释说明错误收集与导出仍按 offset 调用），控制台以外的 API 调用方（运维脚本、外部集成）可能依赖它，按“上游优先”保留：没有游标时生效，最多跳过 10000 行。移除条件：上游删除该参数，或上游的调用方全部改用游标。
- **调用方核实**：控制台不调用这个列表，只用 `/request-logs/:id`、`/:id/attempts`、`/stats`、`/export`；`web/src/types/panel-logs.ts` 的 `RequestLogsResponse` 已同步改为游标字段，前端没有分页交互和文案需要改。依赖 `total` 的只有测试：单测 `request-log.test.mjs` 与 e2e `persistence.e2e.test.mjs` 已改为断言条数与游标。已删除只剩测试使用的 `RequestLogStore.exportRows`；面板导出走 `UsageLogsView.exportRows`，不受影响。
- **执行计划**：首页为 `SCAN usage_logs USING INDEX idx_reqlog_cost_ts`，读到 `LIMIT` 为止；游标页为 `SEARCH usage_logs USING INDEX idx_reqlog_cost_ts (created_at<?)`。两者都不整表 `COUNT`。单测 `request-log.test.mjs` 检查游标页的执行计划。

#### 使用记录页 summary / ranking / overview 读汇总表

- **迁移 123** `usage_stats_hourly_log_summary`：给 115 的汇总表加 `cache_creation_5m_tokens`、`cache_creation_1h_tokens`（summary 的缓存写入分档）与 `cost_n`（`actual_cost` 非空的行数，排行中没有计价行时金额仍为 null）。迁移时重建三个触发器，并在同一事务内按全部列重新回填。本机 50 万行回填耗时 2.8 秒；新旧触发器的单行写入开销没有可测差异。
- **数据源**：`src/lib/db/repos/usage-log-rollup.mjs` 的 `rollupSource` 由统计页与使用记录页共用：
  - 整小时读汇总表，起止所在的不完整小时读明细；
  - 某一端不限时，那一端全读汇总表（汇总表由触发器维护，含当前小时）；
  - 筛选谓词套在合并结果外层，SQLite 会把它下推到明细部分，命中 `user_id`、`created_at` 等索引。
  `usage-stats-rollup.mjs`（统计页）改为引用它。
- **汇总表能回答的筛选**：归属（`ownerPred`）、用户、Key、槽位、状态码、排除 2xx、只看错误、开始与结束时间、只屏蔽 `auth` 类（SQL 可表达，默认设置就是这样）。由 `buildFilter` 逐条标记，全部满足才走汇总表。
- **回落到逐行扫描的筛选**（写在 `buildFilter` 注释中）：
  - 分组：要读 `group_id` 回退列，汇总表只有 `billing_group_id`；
  - 会话；
  - 账号；
  - 模型：同时匹配 `requested_model`；
  - 平台；
  - 模型不一致；
  - 最少尝试次数；
  - 全文搜索；
  - 指定错误类别；
  - 屏蔽 `auth` 以外的错误类别。
  
  其中前八种是 SQL 可表达的筛选，summary 与 ranking 走 `usage_logs` 上的一条聚合 SQL，结果是精确值。后两种要按行在 JS 中判定，仍按最新 5000 行抽样，`ranking` 的 `capped` 会说明。
- **语义变化**：
  - 排行由“最新 5000 行抽样”改为当前筛选下的精确合计，`capped` 为 false，`sampled` 为合计请求数；
  - Key 名称取 `api_keys` 当前名称，不再取日志行里记录的名称；
  - Key 的所属用户取该组最大的 `user_id`，原来取最新一行的用户；
  - 排序为金额降序（按 1e-9 取整比较）、请求数降序、ID 升序。浮点求和顺序不同不会让排名互换。
- **一致性测试**：`test/unit/usage-logs-rollup.test.mjs`。同一份数据，`useRollup: false` 的同一个视图（逐行扫描）作对照：
  - 6 种归属 × 7 种时间窗（不限、两端不在整点、两端在整点、只有开始、只有结束、同一小时内、起点晚于终点）× 10 组汇总表筛选 + 6 组回落筛选；
  - summary 与两种排行逐项相同（数值按 1e-6 比较，排行顺序完全相同），插入后，以及改金额、改时间、改归属、删除之后都检查；
  - overview 在 4 个时刻（含今日第一个小时内）× 6 种归属下相同；
  - 只改汇总表时，走汇总表的筛选结果随之变化，回落筛选不变，证明两条路径确实分开；
  - 构造金额相等、浮点和相差 1 ulp 的两个 Key，两条路径都按请求数、ID 排序。
- **修正**：汇总读取的平均耗时改为 `SUM(…) * 1.0 / SUM(n)`。窗口全落在不完整小时内时，两列都是整数和，原写法会被 SQLite 截断（统计页在今日第一个小时内也受影响），有单测覆盖。

#### D 类（stats）接口的超时与并发上限

- **位置**：`src/lib/admin/route-budget.mjs`。`panel-routes.mjs` 的分发入口按 `matchRoute` 查路由表，类别为 `stats` 的请求统一套用，没有逐个修改路由。路由表中 `stats` 类共 24 条（2026-11-06），包括使用记录 summary / ranking / overview / active-sessions、请求日志 stats / export、统计页、看板、分组、供应商用量与结算预览等。
- **并发**：每条 stats 路由（方法 + 路径模式）同时最多 4 个，全部 stats 路由合计最多 16 个。超出时直接返回 503 `stats_busy`，带 `Retry-After: 2`，不排队。“每类 N 个”这里按每条路由各 N 个，再加一个类别合计上限：页面一次加载就会并发 summary、ranking、overview、stats 四个统计接口，如果整个类别只给 4 个名额，两个用户同时打开页面就会互相拒绝。
- **超时**：15 秒内处理器还没有开始写响应时，返回 503 `stats_timeout`，提示“缩小时间范围或减少筛选条件”。
  - 底层查询无法取消，会继续跑完：只读线程池中的查询在线程里跑完；主连接上的语句同步执行，计时器只能在两条语句之间触发。名额在处理器真正结束时才释放，所以上限约束的是实际在跑的查询数；
  - 超时后处理器再写响应会被丢弃；
  - 已经开始写响应的处理器（导出）不打断。
- **参数**：routing 配置 `panel_stats.{route_concurrency, concurrency, timeout_ms}` 优先，其次是环境变量 `KIN_STATS_ROUTE_CONCURRENCY` / `KIN_STATS_CONCURRENCY` / `KIN_STATS_TIMEOUT_MS`，最后是默认值；0 表示不限。每次请求读取，改 routing 配置后立即生效。
- **可见性**：`GET /api/panel/database/metrics` 的 `route_budget` 返回放行、繁忙拒绝、超时次数，当前在跑的查询数（总数与按路由），以及生效参数。控制台数据库页新增“数据访问保护”面板，四种语言的文案已补。
- **测试**：`test/unit/route-budget.test.mjs`，覆盖单路由上限、类别合计上限、超时提示与迟到响应丢弃、名额到查询结束才释放、已开始写响应时不打断、参数优先级，以及 `createPanelHandler` 按路由表类别挂载（read 类不受影响）。

#### 观测写入有界队列

- **现状核实**：`write-behind.mjs` 原来没有上限。队列承载两类闭包：
  - `RequestLogStore.finish` 的使用记录落库：`usage_logs`、调试原文，以及经 `insertSummaryIfAbsent` 写的供应商用量事实；
  - `RequestAttemptsRepo` 的请求尝试台账：`request_attempts` 的开始与完成。
- **分类依据**：
  - 使用记录是计费与对账的事实来源：成本重算、供应商结算、汇总表都从它来，归为 **billing**；
  - 请求尝试只用于诊断与决策链展示，丢一条只影响该请求的尝试明细，归为 **observation**；
  - 未标类别的写入按 billing 处理。
- **行为**：队列最多 10000 个闭包（环境变量 `KIN_WRITE_BEHIND_MAX_QUEUE`）。满了以后：
  - observation 丢弃并计数，每分钟最多告警一次，请求照常完成；
  - billing 不入队，`enqueueWrite` 返回 false，`finish` 改为直接 await 落库（与写回队列未启用时相同）。这一条请求承担背压，数据不丢。
- **可见性**：`/api/panel/database/metrics` 的 `write_behind` 返回队列深度、上限、峰值、入队数、`dropped_observation`、`billing_direct`，数据库页的“数据访问保护”面板显示。
- **测试**：`test/unit/write-behind.test.mjs`。队列满时，观测写入（含 `RequestAttemptsRepo.begin`）丢弃且计数，计费写入在 `finish` 返回时已落库，有空位后观测写入恢复入队。

#### 合并重复 SQL

见 4.2 R1 的遗留：已在 R6 合并，M5 只做核实并更新本文；两种参数写法按约定保留。

#### 本机耗时（50 万行，10 天，Key 与模型、槽位相关；汇总表 18 万行，压缩约 2.8 倍，生产实测约 18 倍）

| 查询 | 改前 | 改后 |
| --- | ---: | ---: |
| `/request-logs` 首页（无筛选 / 按模型 / 按 Key） | 84 / 59 / 11 ms | 1.1 / 1.2 / 1.0 ms |
| `/request-logs` 第 5000 行处（改前 OFFSET，改后游标） | 82 ms | 1.1 ms |
| summary 全部 / 7 天 / 24 小时 | 150 / 532 / 90 ms | 60 / 54 / 10 ms |
| summary 7 天、单个用户 | 14 ms | 19 ms |
| summary 7 天、按模型（回落） | 475 ms | 453 ms |
| ranking（Key）全部 / 7 天 / 24 小时 | 198 / 610 / 183 ms（抽样 5000 行） | 123 / 120 / 19 ms（精确） |
| overview | 91 ms | 8 ms |

单个用户的 7 天 summary 略慢：明细按 `(user_id, created_at)` 索引只读该用户的行，汇总表则按小时范围读出全部汇总行后再过滤。试加 `usage_stats_hourly(user_id, hour)` 索引没有改善，所以没有加。

#### 仍未做

- D 类“结果按汇总的版本缓存”；
- C 类“超时返回部分结果”：列表接口没有挂超时；
- 统计页、使用记录页之外的 stats 接口（看板、供应商用量等）仍读明细或各自的汇总，只受上面的并发与超时约束。

### 4.7 M6：金额整数化（2026-11-06）

技术债批次 M6 落实 Q1：**全部金额列整数化，包括上游表**。用户已知这与“上游优先、最小定制差异”冲突：以后同步上游时，上游新增或改动的金额读写都要按本节的约定改写（见“同步上游时的改写规则”），由守卫测试与一致性脚本兜底。

#### 盘点

金额单位：1 美元（1 USDT）= 1,000,000 微单位（micros）。登记表在 `src/lib/core/money-columns.mjs`，守卫测试要求新库里每个 `REAL` 列都在登记表里归了类。

有 REAL 镜像的金额列（M6 新增整数列，迁移 126 / 127）：

| 表 | REAL 列（镜像） | 整数列（权威） | 归属 | 写入方 | 读取 / 计算方 |
| --- | --- | --- | --- | --- | --- |
| `usage_logs` | `input_cost`、`output_cost`、`cache_read_cost`、`cache_creation_cost`、`web_search_cost`、`image_cost`、`total_cost`、`actual_cost` | 同名 `*_micros` | 上游 | `RequestLogStore.finish` → `UsageLogsRepo.insertSummary(IfAbsent)`（`toRow`）；重新定价 `_repriceRows`（`backfillMissingCosts`、`repriceRange`）；Gateway 回执补算 `GatewayWorkerRepo` 与对账 `settleUsageLog` | `UsageLogsRepo`（aggregate、totals、costBetween、costByModel、Key / 槽位统计、billingStats、ownerBilling、windowStats）、`UsageLogsView`、`StatisticsRepo`、`usage-log-rollup`、分组指标、供应商用量与结算来源、额度预测；两张小时汇总表的触发器 |
| `api_keys` | `quota`、`quota_used`、`rate_limit_5h/1d/7d`、`usage_5h/1d/7d` | 同名 `*_micros` | 上游 | `ApiKeysRepo.insert/update/recordUsage`（`ApiKeyStore`、旧数据导入经它） | `ApiKeyStore.acquire`（额度与窗口准入）、`recordUsage` 的额度翻转、`cpr-peer-link` 预算展示 |
| `users` | `balance` | `balance_micros`（039 起已有） | 上游 | 钱包 SQL（`relay-billing-repo`，两列同写）、`UsersRepo` 插入 | `RelayBilling`（只读整数） |
| `redeem_codes` | `value` | `value_micros` | 上游 | 无（遗留表，src 内没有读写方） | 无 |
| `groups` | `image_price_1k/2k/4k`、`web_search_price_per_call` | 同名 `*_micros` | 定制（082） | `GroupsRepo.create/update` | `groupMediaPolicy` → `mediaCharge`（按张、按次计费） |
| `vendor_usage_facts` | `cost_usd` | `cost_usd_micros` | 定制（056） | `insertUsageFact`（`recordVendorUsage`、Gateway 回执） | 供应商用量、结算来源 |
| `vendor_settlements` | `amount_usdt` | `amount_usdt_micros` | 定制（070） | `insertSettlement` | 结算单状态、付款比较 |
| `vendor_payments` | `amount_usdt` | `amount_usdt_micros` | 定制 | `insertPayment` | 已付合计、超付判断 |
| `usage_cost_hourly` | 五个成本列 | 同名 `*_micros` | 定制（093 / 119） | 触发器（127） | `usage-cost-rollup`（账号成本、Gateway 账号用量） |
| `usage_stats_hourly` | `cost` | `cost_micros` | 定制（115 / 123） | 触发器（127） | 统计页、使用记录页 summary / ranking / overview |

本来就是整数、不变：`admin_domains.balance_micros`、`billing_charges.actual_micros`、`billing_reservations.reserved_micros/actual_micros`、`wallet_ledger.amount_micros/balance_after_micros`、`groups.*_limit_micros`、`jev_usage_*` 的 `*_nano_usd*`。

比例列（保留 REAL，见“倍率”）：`accounts`、`groups`、`user_group_overrides`、`usage_logs`、`billing_charges`、`billing_reservations` 的 `rate_multiplier`，`groups.image_rate_multiplier`，`vendors.default_multiplier/default_price_cny_per_usd/fx_cny_per_usdt`，`vendor_contracts.multiplier/price_cny_per_usd/fx_cny_per_usdt`。与金额无关的 REAL：`account_allocations.util_5h/7d`、`quota_observations.used_percent`、`usage_stats_hourly.duration_sum/ttft_sum`。

金额类 JSON 字段：

| 字段 | 内容 | 约定 |
| --- | --- | --- |
| 价格表（`price-catalog`，内置与 settings 覆盖） | $/MTok、$/次的十进制单价 | 保持十进制（配置输入）；计价时在 `priceMicros` 一处换成“每百万 token 的微单位”整数，≤6 位小数时精确 |
| `billing_*.quote_json` | 请求准入时冻结的解析后价格 | 同价格表；只做计价输入 |
| 请求内的 `media_json`（随请求冻结；Gateway 回执对账任务的 `context_json` 里也有一份） | 分组媒体计费策略 | 新旧两种键都写：整数键 `image_price_*_micros`、`web_search_price_per_call_micros` 为准，美元键由它派生；读取时只有美元键（上一版本入队的对账任务）按美元键换算 |
| `vendors/vendor_contracts.group_prices_json` | 结算单价（CNY/USD 系数） | 比例，保持十进制；结算按 1e-10 精度的 BigInt 计算（原有实现） |
| `vendor_settlements.usage_snapshot_json`、`vendor_settlement_previews.snapshot_json`、`vendor_settlement_allocations.snapshot_json` | 冻结的结算快照与逐行证据 | 金额是由整数算出的十进制字符串；逐行快照新带 `total_cost_micros`；历史快照不改写 |
| `billing_charges.usage_json`、`wallet_ledger.metadata_json` | token 用量、关联 ID | 不含金额 |
| 审计（`operation_audit`）的前后余额 | 展示值 | 由整数换算的美元数，只读 |

#### 约定

1. **权威值是整数列**。计算一律用整数：结算、钱包、套餐窗口、Key 额度与窗口、汇总、价格乘法、分摊、供应商结算。REAL 列保留为展示镜像，值为 `micros / 1e6`，每次写入与整数列同时写，未改造的上游读取方读到的仍是正确值；回滚后上一版本读到的值见“迁移 / 回滚”。
2. **读取口径**：SQL 一律经 `src/lib/db/repos/money-sql.mjs`：`moneySql(col)` = `COALESCE(col_micros, CAST(ROUND(col * 1e6) AS INTEGER))`，`microsSumSql` / `usdSumSql` 在整数上求和，出口再除以 1e6。整数列为 NULL 只会出现在“只写 REAL 的写入方”留下的行（上一版本在回滚期间写入），此时按 REAL 派生；JS 侧同口径的是 `rowMicros(row, col)`。对外 API 返回原字段（美元数），数值由整数换算，响应结构不变；有些中间对象（成本桶、使用记录行）多带了 `*_micros` 字段，面向普通用户的投影（`public-usage-projection`）把它们与 REAL 字段同等隐藏或替换。
3. **写入**：仓储边界统一处理——`UsageLogsRepo.toRow`、`ApiKeysRepo.toValue`、`UsersRepo` 插入、`GroupsRepo`、供应商事实写入：有 `*_micros` 用它，只给美元值的写入方在这里换算一次（`toMicros`），REAL 一律由整数派生。直接写 SQL 的地方（回执对账、重新定价、Key 用量、结算单、付款）同时写两列。
4. **倍率**：倍率、汇率、结算单价是比例，不是金额，**保留 REAL**。理由：它们由管理员输入、从不求和；唯一的运算是与一个整数金额相乘后舍入一次；最多 6 位小数的十进制值存成 double 后 `round(x × 1e6)` 总能还原成原值，计算时用 `ratePpm` 换成百万分之一整数（`applyRate(micros, rate) = round(micros × ppm / 1e6)`），与 ppm 列等价；另加 9 个 ppm 列要再改 8 张表（6 张上游表）和全部倍率读写方，没有精度收益。倍率精度因此是 1e-6，超过 6 位小数的倍率在计算时舍入（误差 ≤ 0.5e-6 × 金额）。
5. **迁移不改 REAL 的历史值**：126 只回填整数列；历史行的 REAL 保留原来的 8 位小数，与整数列的关系是 `x_micros = ROUND(x × 1e6)`，一致性脚本按这个关系逐行比对。新写入的行 REAL = micros / 1e6，同样满足。
6. **整数列没有默认值**（汇总表除外）：只写 REAL 的旧写入方留下 NULL，读取与触发器能识别并按 REAL 派生，一致性脚本能找出这些行。
7. **有效范围**：金额 |x| < 2^51 微单位（约 22.5 亿美元，`MAX_MONEY_MICROS`）。在这个范围内 REAL 镜像乘回 1e6 一定得到原值，node:sqlite 也能读出整数（超过 2^53 的整数会让整条语句抛错）。超出范围的输入按无效处理；Key 的额度与窗口上限超出时按“不限”存 0（与表单输入同一规则）；`ApiKeysRepo` 读取时把越界的整数列按 NULL 读（再按 REAL 回退，仍越界按 0），认证不会因为一行坏数据整体失败。

#### 舍入规则

- **价格 × token**：`picos = tokens × priceMicros(单价)`，单位是皮美元（1e-12 美元），在安全整数范围内用 Number、超出时用 BigInt，都是精确计算。一行的计价部分是输入、输出、缓存读、缓存写 5m、缓存写 1h、网页搜索（次数 × 单价）、生图（文本与图片 token 分档后的精确和）；生图部分与其余部分一起分摊，已定价时各部分之和恰为总额。**总额从各部分的精确和四舍五入一次**到微单位；各部分先向下取整，再按余数从大到小（同余数按顺序）补 1，使各部分之和恰为总额（最大余数法，`allocateMicros`）。`cache_creation_cost = 5m + 1h`。
- **按张、按次**（分组媒体计费）：单价本来就是整数微单位，总额 = 单价 × 数量，精确。
- **实际扣费** `actual = round(total_micros × rate_ppm / 1e6)`：按存储的整数官方价计算，库内两列可以复算（一致性脚本据此核对）。
- **四舍五入、远离零，并与 SQLite `ROUND` 逐位一致**：JS 的 `sqlRound(x)` 在 |x| < 2^52 时为 `(int)(x ± 0.5)`，否则为 x 本身，与 SQLite `ROUND(x)` 的实现相同；`toMicros(v) = sqlRound(v × 1e6)` 与 SQL 回退 `CAST(ROUND(v * 1000000) AS INTEGER)` 对任何输入结果相同（审查脚本 `roundtrip.mjs`：420 万个往返值与 400 万个 0.5 微单位边界的历史值，0 处不同）。管理面输入（充值、扣款、转账、额度）的 `moneyMicros` 改为校验后调用 `toMicros`，不再有自己的 `Math.round`（两者原来在负数的 .5 处不同）。这是二进制乘积上的舍入：历史值 1.0000025 × 1e6 = 1000002.4999999999，计 1000002 而不是十进制意义上的 1000003；只影响第 7 位以后正好是 5 的历史值，与 SQL 回填一致是更重要的约束。
- **与改造前 REAL 计算的差异上界**：
  - 官方价：每行与精确值相差 ≤ 0.5 微单位；改造前按 1e-8 舍入，两者相差 ≤ 0.505 微单位。组成部分与精确值相差 < 1 微单位。
  - 实际扣费：与“精确官方价 × 倍率”相差 ≤ 0.5 × 倍率 + 0.5 微单位；改造前也是整数微单位（`moneyMicros(total_cost × rate)`），两者相差 ≤ 0.5 × 倍率 + 1 微单位（倍率 1 时 ≤ 1.5 微单位）。
  - 单行低于 0.5 微单位（$5e-7）的金额舍为 0：例如 1 个缓存读取 token（$0.2/MTok）计 0，5 个计 1 微单位。按行舍入是无偏的，n 行合计的最大偏差是 0.5n 微单位。
  - 汇总：小时汇总、统计、排行、Key 窗口、供应商用量都是整数之和，与逐行扫描逐项相等（改造前是浮点和，有 1e-9 量级的顺序差异）。
  - 供应商结算：用量金额改读整数列；历史行与改造前相差 ≤ 0.5 微单位 × 行数 × 系数，改造后写入的行没有差异。冻结的历史快照不重算。
- **单测里的舍入差异**（断言改为整数结果，逐条说明）：`pricing.test.mjs` 两处 GPT-5.6-sol 的缓存写入 62.5 → 63 微单位、总额 572.5 → 573；`request-log.test.mjs` Sonnet 5 总额 92.6 → 93 微单位。其余计费、钱包、结算、供应商、统计、汇总单测的断言值不变。

#### 迁移

- **126 `money_micros`**：
  - 先检查越界：除 Key 额度与窗口上限外，任何 |REAL| ≥ 2^51 微单位的金额让迁移以 `CHECK constraint failed: m6_money_out_of_range__fix_rows_first` 整体失败，提示运维先处理这些行；Key 的 `quota`、`rate_limit_*` 越界时两列都存 0（“不限”）。生产 2026-11-06 只读核查：最大 Key 额度 $1000，最大单条使用记录 $14.95，离上限很远。
  - 给上表的 REAL 金额列加 `*_micros INTEGER`（无默认值），按 `CAST(ROUND(x * 1000000) AS INTEGER)` 回填，NULL 保持 NULL，REAL 不动。
  - 小表（`api_keys`、`groups`、`redeem_codes`、`vendor_usage_facts`、`vendor_settlements`、`vendor_payments`）建“旧写入方”触发器：AFTER UPDATE 时某列 `NEW.x IS NOT OLD.x` 而 `NEW.x_micros IS OLD.x_micros`（只改了 REAL），当场把整数列改为 `ROUND(REAL × 1e6)`；AFTER INSERT 时整数列为 NULL 而 REAL 非空，同样处理；越界值按上面的规则（限额存 0，其余存 NULL）。新代码总是两列同写、REAL = micros / 1e6，对它触发器要么不触发，要么写回同一个值。
  - `usage_logs` 不建这种触发器：它与两张汇总表的触发器在同一事件上触发，执行顺序不保证，会让汇总与明细不一致（审查脚本 `legacy-sync-trigger.mjs`）。改为部分索引 `idx_usage_logs_money_drift`，条件就是“某个整数列与 `ROUND(REAL × 1e6)` 不一致”，正常情况下为空。
- **127 `money_micros_rollups`**：以 119（`usage_cost_hourly`，上游账号口径）与 123（`usage_stats_hourly`，全部列）的触发器为准重建六个触发器：两张汇总表加 `*_micros INTEGER NOT NULL DEFAULT 0`，触发器加减整数列，REAL 汇总列在每次变化时由整数重新派生（不再累加浮点）；`AFTER UPDATE OF` 的列表加上整数列。两张汇总表在同一事务里按 `usage_logs` 全量重建。触发器读 `COALESCE(x_micros, ROUND(x × 1e6))`。审查脚本 `trigger-diff.mjs`：六个触发器的非金额部分与 119 / 123 逐项相同。
- **启动补齐**：`UsageLogsRepo.syncLegacyMoneyRows` 在服务启动、监听端口之前执行：经部分索引找出漂移行，2000 行一批、每批一个事务，把整数列改回 `ROUND(REAL × 1e6)`；改写整数列经汇总触发器同步更新两张小时汇总表。理由：使用记录不参与准入，但统计、账号成本、供应商结算都读整数列，回滚期间上一版本写入或改写的行如果等人工跑脚本，升级回来后的这段时间里报表和结算预览会少算；部分索引让这一步在正常情况下只读一次空索引，所以做成自动的。漂移行多时会推迟监听：实测约 2.8 万行/秒（20 万行 7.1 秒；回滚期间若大范围重新定价 300 万行，约 107 秒），每 5 万行打印一次进度；每批独立提交，中途被杀掉下次启动接着补。
- **回滚**（上一版本只认识 REAL 列）：
  - 上一版本的迁移器不认识 126 / 127 的记录，跳过它们；新增的列、索引和触发器它不感知。
  - 它对小表的写入经旧写入方触发器当场同步整数列：Key 用量、额度、窗口上限、分组单价、供应商事实、结算单、付款，在升级回来时已经是对的，不会被下一次记账覆盖（审查脚本 `rollback-apikey.mjs`、`group-media-rollback.mjs` 复现的问题已修复）。`users` 两个版本都同写 `balance_micros`，不需要触发器。
  - 它插入的使用记录：整数列为 NULL，两张小时汇总表的触发器按 REAL 派生计入，所以它读到的汇总 REAL 列包含这些行。
  - 它改写已有使用记录的金额（重新定价、回执对账写 `actual_cost`）：这些行的整数列仍是旧值，汇总触发器经 COALESCE 取到的也是旧值，所以**上一版本读到的小时汇总不反映它自己做的这类改写**，直到升级回来、启动补齐把这些行连同汇总一起修正。上一版本直接对 `usage_logs` 明细做的查询不受影响。
  - 升级回来后：启动补齐自动处理 `usage_logs`，它在监听端口之前执行；失败只告警，此时先停流量跑 `--backfill`（必要时 `--sync-from-real`）再接流量。随后跑一次一致性脚本确认一致；写模式只作兜底。
- **耗时与磁盘**（本机）：
  - 50 万行 `usage_logs`（按 M5 的造数脚本以基线代码建库，汇总表 18 万 / 13 万行）：126 耗时 1.4 秒、127 耗时 1.9 秒；审查脚本 `migrate-timing.mjs` 造 100 万行：126 为 2.8 秒、127 为 3.1 秒，约 **6 秒 / 百万行**。
  - 每个迁移在一个写事务里执行，写锁时长等于耗时。迁移在服务启动时、监听端口之前执行，这段时间服务不可用（启动被阻塞）；WAL 下其他进程的只读连接（如一致性脚本、备份）不受影响。
  - 磁盘：两个迁移改写 `usage_logs` 每一行、重建两张汇总表，WAL 在检查点之前会涨到接近库文件大小（100 万行、870 MB 的库，迁移后 WAL 844 MB；50 万行、495 MB 的库，关掉自动检查点时 WAL 峰值 208 MB）。部署前预留不少于库文件大小的空闲磁盘；库文件本身增加约 4.5%（494.9 → 517.2 MB）。
  - 启动补齐在这份库上（漂移索引为空）耗时 0.08 毫秒；部分索引让写入多算一次索引条件，2 万行插入各三轮（旧 134.5 / 146.7 / 124.2 μs，新 145.9 / 128.0 / 132.3 μs）看不出差异。
  - 一致性脚本在 50 万行的库上只读耗时 2.0 秒。
- **热路径**：计价函数（`costColumnsFromUsage` + `calculateCost` 各一次）从 3.9 μs 增到 5.8 μs（皮美元在安全整数内用 Number，超出才用 BigInt）。本机压测（3000 请求、并发 16，与基线交替各两轮，主 Key 路径，含请求日志计价与触发器，不含商业结算）：非流式均值 255.5 → 241.0 rps、CPU 3.73 → 3.94 ms/请求，流式 230.4 → 238.0 rps、CPU 4.07 → 4.02 ms/请求，差异在单轮波动（约 ±8%）之内。

#### 守卫与校验

- **守卫测试** `test/unit/money-micros-guard.test.mjs`，参照 `sync-data-access` 的逐文件计数豁免：
  - 扫描 src 下全部 `.mjs`（注释不计）：
    - SQL：对 REAL 金额列 SUM / TOTAL / AVG / MIN / MAX（包括 `SUM(${… 'total_cost' …})` 这类插值，`moneySql` 等口径函数除外）、在 CASE 中取 REAL 金额参与聚合（含 `THEN IFNULL(total_cost,0)`）、按 REAL 金额排序（`ORDER BY total_cost`）、加减乘除、大小比较（`>= <= > <`，例：`quota_used>=quota`、`total_cost > 0`）；
    - SQL 写入：`UPDATE … SET` / `INSERT INTO` 写 REAL 金额列而同一语句没写对应 `_micros`；动态列表（`UPDATE t SET ${…}`、`INSERT INTO t (${…})`、`'INSERT INTO t (' + FIELDS.join(…)`）每处计一次，由豁免写明列表来源；
    - JS：对金额字段（`total_cost`、`actual_cost`、`quota_used`、`cost_usd`、`amount_usdt`…）加减乘除、`+=`、大小比较（含 `quota`），带兜底读取后参与运算（`(x.total_cost || 0) * k`、`sum + (r.actual_cost ?? 0)`），以及把 REAL 金额读进局部变量（`const c = Number(row.total_cost)`，之后的运算无法再按字段名识别）。
  - 豁免清单逐文件逐类计数完全一致，每条写原因：四个仓储的动态列表写入（列表都含全部 `*_micros`）、两处按整数换算别名 `cost_usd` 排序、通知文案与供应商用量投影各一处展示用的读取、`relay-migration.mjs` 的迁移预检（专门报告 REAL 余额与整数余额的舍入差）、计费对账（`billing-reconcile*.mjs`，审计 W9）的旧口径对照与余额镜像漂移计数（只报告，判定只用整数列）。
  - 这是基于文本的检查，按列名与字段名识别：先 SELECT 出 REAL 列、再在别处按别名求和，或在不带金额名的局部变量上运算，识别不了，由下面两项补位。
  - 新库每个 REAL 列都必须在 `money-columns.mjs` 归类，金额镜像都有 INTEGER 的 `*_micros`；127 之后的新迁移出现 REAL 金额列（列名含 cost / price / balance / amount / quota / usd…）直接失败；126 / 127 只新增整数列。
  - `test/unit/money-micros.test.mjs` 覆盖舍入规则（含 JS 与 SQLite `ROUND` 逐位一致、镜像往返、`moneyMicros` 同口径）、最大余数分摊（含生图部分）、价格 × token 与改造前浮点结果的差异上界（400 组随机用量）、BigInt 大额与 1e-7 美元级小额、回填一致性（含 NULL、8 位小数、大额）、127 重建与逐行触发器结果相同、触发器只认整数列与 NULL 回退、各写入方写入后逐行一致、回滚兼容（上一版本对 Key 用量与限额、分组单价的写法，`usage_logs` 启动补齐后明细与汇总一致）、媒体策略新旧键、超大历史值（限额存 0、金额让迁移失败、越界整数不拖垮认证），以及一致性脚本的只读、检出、分批写模式、`users` 只反向修镜像、汇总表不改。
- **一致性脚本** `scripts/audit-money-micros.mjs`（默认只读，`new DatabaseSync(path, { readOnly: true })`）：
  - 逐表逐行比对 `x_micros` 与 `ROUND(x × 1e6)`：整数缺失、整数多出、两者不等的行数，最大差值与样例 rowid；
  - 汇总口径在新旧两种口径下：小时汇总 = 明细合计（整数应逐项相等，另按小时统计不等的桶；REAL 报告差值）、结算 = 使用记录实际价、钱包余额 = Σ流水 − Σ结算扣费（判错；另报告负余额钱包）、供应商结算单已付 ≤ 应付；
  - 审计阶段 2 W9 起检查部分移到 `src/lib/admin/billing-reconcile.mjs`（SQL 在 `admin/repos/billing-reconcile-repo.mjs`），与每日对账共用，另有结算扣费 ↔ 使用记录 ↔ 供应商用量事实三方核对、近 24 小时 unmetered 金额占比、settlement_pending 超过 1 小时；脚本只保留参数、写模式与输出；
  - `--json` 输出完整报告（含 `findings`）；有 error 级发现项时退出码为 1。
- **每日对账**（审计阶段 2 W9，`src/lib/admin/billing-reconcile-schedule.mjs`）：`relay_billing.reconcile_at`（UTC+8，默认 03:30，空串关闭）到点后在 Worker 线程的只读连接、一个读事务里跑上述检查，结果写 `operation_audit`（`billing.reconcile`），异常推送 `billing_reconcile` 通知；钱包差额以上一次对账记下的差额为基线，出现或变化才判错。
  - 写模式 `--backfill`、`--sync-from-real`：分批执行（每批 5000 行一个短事务，`busy_timeout` 5 秒）；两张汇总表不改（由触发器维护）；`users.balance` 的权威值从 039 起就是 `balance_micros`，写模式从不按 REAL 改余额，`--sync-from-real` 只反向把 REAL 改成 `balance_micros / 1e6`；|REAL| 越界的行不改、只报告。写模式可以在线执行，但每批持有写锁、与线上写入交错，建议停服或低峰执行。

#### 同步上游时的改写规则

上游（sub2api 形状）的金额仍是浮点，同步时按以下规则改写；冲突时以守卫测试和一致性脚本为验收：

1. **写入**：上游新增或改动对 `usage_logs`、`api_keys`、`users`、`redeem_codes` 金额列的写入，经仓储边界（`toRow`、`toValue`、`UsersRepo` 插入）的不用改；直写 SQL 的必须同时写 `<col>_micros`（权威）与 REAL（`micros / 1e6`）。
2. **读取**：展示可以直接读 REAL 镜像；凡是求和、比较、相减、乘倍率、排序比较，SQL 改用 `moneySql` / `microsSumSql` / `usdSumSql`，JS 改用 `rowMicros` 后在整数上计算，出口 `fromMicros`。
3. **计价**：上游改 `pricing.mjs` 时保留“各部分皮美元精确值 → `allocateMicros` 一次舍入”的骨架，把上游新增的计价部分作为新的 part；倍率一律 `applyRate`。
4. **新列与新表**：上游新增金额列时，在本地新增迁移（编号顺延）加 `*_micros INTEGER` 并回填，登记 `money-columns.mjs`；上游新增的 REAL 列不归类时守卫测试失败。上游迁移文件本身不改（按字节冻结、带校验和）。
5. **汇总**：两张小时汇总表与触发器是定制的；上游改 `usage_logs` 金额列时，同步检查 127 的触发器列表、126 的漂移索引与 `syncLegacyMoneyRows` 的列清单。
6. **上游新增金额字段的面向用户投影**：同时登记整数列的隐藏规则（`public-usage-projection`）。
7. **回滚兼容**：上游新增有金额列的小表时，照 126 的写法建旧写入方触发器；上游新增 `usage_logs` 金额列时，加入漂移索引与启动补齐。

#### 测试服务器演练（建议）

1. 停服务或用 `VACUUM INTO` 备份 `kin.db`；在备份上用当前版本跑一次 `node scripts/audit-money-micros.mjs <备份> --json`（整数列尚不存在，报告 `missing_column`；记下旧口径的汇总值）。
2. 部署 M6 版本，启动时执行 126 / 127，记录启动日志里的迁移耗时（迁移期间服务不可用，见上面的锁时长）；部署前确认磁盘余量够 WAL 峰值。
3. `node scripts/audit-money-micros.mjs /opt/tapmodels/data/kin.db --json`（Docker；主机安装为 `/opt/kin-gateway/data/kin.db`）：应为一致；与第 1 步对比汇总值（差异应在约定上界内）。
4. 对照面板：统计页、使用记录 summary / ranking / overview、首页账号成本、供应商用量与结算预览在同一时间窗的数值，差异只应在 1e-6 量级。
5. 发起计费请求：核对 `billing_charges.actual_micros` = `usage_logs.actual_cost_micros`，Key 的 `quota_used_micros` 与窗口整数列随之增加，REAL 镜像同步。
6. 回滚演练：换回上一版本，发一些请求（含 Key 用量），改一个 Key 的额度、一个分组的按张单价，在面板上做一次重新定价；再换回 M6，看启动日志里的 `usage_logs money: re-derived N rows`；不跑写模式，直接跑一致性脚本应为一致；核对那个 Key 的已用额度包含回滚期间的用量、分组单价是改后的值。
7. 演练完成后按需要用第 1 步的备份恢复。

#### 改动范围

- 新增：`src/lib/core/money.mjs`（整数工具）、`src/lib/core/money-columns.mjs`（登记表）、`src/lib/db/repos/money-sql.mjs`（SQL 口径）、迁移 126 / 127、`scripts/audit-money-micros.mjs`、两个测试文件。
- 改动的上游文件（13 个，计入上游差异）：`server.mjs`（启动补齐与进度日志，11 行）、`admin/api-keys.mjs`、`admin/panel-api.mjs`、`admin/pricing.mjs`、`admin/request-log.mjs`、`admin/window-estimate.mjs`、`db/repos/api-keys-repo.mjs`、`groups-repo.mjs`、`statistics-repo.mjs`、`usage-logs-repo.mjs`、`usage-logs-view.mjs`、`users-repo.mjs`、`protocol/handle-protocol.mjs`；其余是定制文件。
- 响应：字段与类型不变；部分管理端响应里原样展开的行与成本桶（`/request-logs` 行、分组、账号成本的 today / window 桶）多出 `*_micros` 字段（只增不改）；面向普通用户的投影隐藏或替换它们。
- 前端不改：响应字段与类型不变。

## 5. 数据设计约定

| 项 | 约定 | 现状与说明 |
| --- | --- | --- |
| 主键 | 带前缀的文本 ID（如 `gw-01`、`req_…`）或自增整数，表内统一 | 已有多种格式；新表按此约定，旧表不改 |
| 时间 | 新表统一一种格式：ISO 文本（与 `usage_logs` 一致）或毫秒整数，同表不混用 | 现有 105 列 ISO 文本、16 列整数（见迁移方案 3.3） |
| 金额 | 一律用整数（`*_micros` 或 `*_nano_usd`）计算与存权威值；新列不用 `REAL` | M6 已整数化全部金额列（含上游表，Q1）；REAL 列只保留为镜像，读写规则与同步上游时的改写规则见 4.7 |
| JSON 列 | 只存诊断和扩展字段；需要过滤、排序或关联的字段提成普通列并建索引 | 例：`usage_json` 已裁掉上游 attribution |
| 幂等 | 外部可能重放的写入都要有唯一键（`request_id`、（实例, 序号）、幂等键） | 回执、事件、尝试已具备 |
| 保留期 | 每张明细表都写明保留天数和清理任务；清理与汇总表一起维护 | `request_attempts` 7 天、事件收件箱 7 天已有；`gateway_worker_receipts` 没有清理（发布说明已记录约 1.5 GB 待处置） |
| 迁移 | 编号顺延，已合入的不改；破坏性变更分两步（先兼容写，再删旧） | 已有 SHA-256 校验 |

## 6. 落地路线

每一项都能独立交付、独立回滚，都不改上游表结构（M6 金额整数化经用户决定改了上游表，见 4.7）。

| 编号 | 内容 | 范围 | 验收 |
| --- | --- | --- | --- |
| R1（已完成） | 定制模块的 SQL 收进领域仓储，加守卫脚本与基线清单 | vendor、gateway-worker、executor、admin 中的定制模块；`panel-routes.mjs` 中的 30 处 | 守卫脚本通过且基线减到 0（上游豁免除外）；相关单测和 e2e 通过；`upstream-touch-budget` 显示上游文件改动行数减少 |
| R2（已完成） | 声明式路由表与覆盖测试 | `capability-policy.mjs` 及路由注册处 | 每个已注册路由都有登记；新增路由不登记时测试失败；授权行为与现有测试一致 |
| R3（已完成） | 管理写操作套用 4.3 模板 | 影响路由或计费的配置写入（供应商、分组、价格、账号） | 每次写入都有审计记录；需要的地方推进 revision；事务内无网络调用（用测试或静态检查确认） |
| R4（已完成；`/request-logs` 由 M5 收尾） | 大表列表改 keyset 分页，去掉全量 `COUNT` | 使用记录、尝试记录、计费明细、回执 | 深页查询耗时与页号无关；前端分页交互不变或同步调整 |
| R5（已完成：统计页；使用记录页由 M5 收尾） | 统计只查汇总表 | 面板使用记录统计、排行、概览 | 与直接扫明细的结果逐项一致（参照 `usage-cost-rollup` 的对照测试）；在生产规模数据上耗时有界 |
| R6 | 异步数据访问接口（`DbClient`） | 即迁移方案阶段 1 | 已完成（2026-11-06，B0–B8；守卫测试 `sync-data-access.test.mjs`） |

建议顺序：R1 → R2 → R3，三项都只动定制代码，收益最大；R4、R5 按页面性能的实际问题启动；R6 不主动启动。

## 7. 待决定事项

| 编号 | 事项 | 说明 |
| --- | --- | --- |
| Q1 | 上游表中的 `REAL` 金额是否整数化 | **已实施（M6，2026-11-06）**：用户选择全量迁移（含上游表），接受同步上游时按约定改写金额读写的成本。盘点、约定、舍入规则、迁移 126 / 127、守卫与一致性脚本、同步上游时的改写规则见 4.7 |
| Q2 | `gateway_worker_receipts` 的保留期与历史数据清理 | 属于数据处置，需要单独授权；清理后需低峰执行 `VACUUM` |
| Q3 | R6 范围 | R1–R5 已完成。用户 2026-11-05 选择 R6 全量异步化（含上游数据层与推理热路径），按 `docs/data-access/R6_PLAN.md` 分阶段推进 |

## 8. 证据索引

vm2api：

- SQL 分布：在 `4b980732` 上统计 `src` 中 `.prepare(` 的出现位置，并与 `6a8f9c7f` 的同名文件对比，区分上游原有和定制新增。
- 汇总表：`src/lib/db/migrations/093_usage_cost_rollup.sql`、`src/lib/db/repos/usage-cost-rollup.mjs`。
- 授权矩阵：`src/lib/admin/capability-policy.mjs`、`test/unit/capability-policy.test.mjs`。
- 写入缓冲：`src/lib/db/write-behind.mjs`（M5 起有界，观测写入满时丢弃并计数）。
- 汇总表与使用记录页汇总：`src/lib/db/migrations/115_usage_stats_hourly.sql`、`123_usage_stats_hourly_log_summary.sql`、`src/lib/db/repos/usage-log-rollup.mjs`、`test/unit/usage-logs-rollup.test.mjs`。
- stats 接口并发与超时：`src/lib/admin/route-budget.mjs`、`test/unit/route-budget.test.mjs`。
- 金额整数化：`src/lib/core/money.mjs`、`src/lib/core/money-columns.mjs`、`src/lib/db/repos/money-sql.mjs`、`src/lib/db/migrations/126_money_micros.sql`、`127_money_micros_rollups.sql`、`scripts/audit-money-micros.mjs`、`test/unit/money-micros.test.mjs`、`test/unit/money-micros-guard.test.mjs`。
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
