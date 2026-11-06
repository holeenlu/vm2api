# SQLite → PostgreSQL 迁移实施方案

状态：阶段 1 大部分已由数据访问分层 R6 完成（2026-11-06，见下方“阶段 1 完成情况”与 `docs/data-access/R6_PROGRESS.md`）；阶段 2 及以后未启动，第 9 节的方向待用户决定。日期：2026-11-03。基线：`main` `059c85f9`（上游 `e3a60858` v1.4.037 + 累计定制提交）。

本文回答“先把 SQLite 迁到 PostgreSQL、暂不引入 Redis 和多实例”时要注意什么、按什么顺序做。和 [目标架构](ARCHITECTURE_TARGET_20261102.md) 的关系：目标架构是 PostgreSQL + Redis + 重新建模（`model_requests`、rollup、outbox）的终态；本文是其中“换存储引擎”这一步的独立方案，先做**语义等价搬迁**，不在同一批里改业务模型。和 [主线程减负计划](performance/process-split-plan.md) 的关系见第 2 节。

本文不授权生产部署、数据迁移、删除 `kin.db` 或发版。

## 0. 结论先行

1. **SQLite 写入不是当前瓶颈。** 生产峰值约每秒 1–2 次业务写，WAL 下远未到单写者上限。迁移的真实收益是：SQL 不再在 Node 主线程执行、允许多进程/多实例并发写、成熟的备份与时间点恢复、更好的运维观测。
2. **最大的工作量是“同步改异步”，不是改 SQL。** 现在全仓库约 440 处 `db.prepare()` 都是 `node:sqlite` `DatabaseSync` 的同步调用，其中 26 个 `admin/`、`vendor/`、`pool/`、`vm/` 模块直接写 SQL。PostgreSQL 驱动只有异步接口，整条调用链都要改成 `await`。
3. **最大的长期成本是上游同步。** `src/lib/db` 是上游维护的数据层，上游近 60 天有 67 个提交改动它；定制迁移的编号已经和上游错开。单方面迁到 PostgreSQL 等于分叉数据层，之后每次同步上游都要把它的 SQLite 迁移和查询翻译成 PostgreSQL 版本，与 AGENTS.md 的“上游优先、最小定制差异”原则直接冲突。**这是启动前必须由用户决定的事项**（见第 9 节）。
4. **最隐蔽的风险是事务语义变化。** 现在同步调用 + 单连接，所有事务天然串行，代码里大量“先查余额、判断、再写”的写法没有并发问题；换成异步连接池后，这些写法会出现超扣、重复入账等竞态。
5. **切换方式推荐停机一次性切换，不做双写。** 生产库约 0.9 GB、约 45 万行，离线拷贝预计是分钟级；双写会带来两边各自计费、对账复杂的风险，收益不抵成本。

## 1. 现状清单（2026-11-03 实测）

### 1.1 代码

| 项 | 现状 | 位置 |
| --- | --- | --- |
| 驱动 | `node:sqlite` `DatabaseSync`，Node 22，零第三方依赖 | `src/lib/db/database.mjs` |
| 连接模型 | 主线程一个读写连接；4 个只读 worker 连接跑面板日志扫描；另一个统计线程 | `sqlite-pool.mjs`、`sqlite-worker.mjs`、`admin/usage-stats-thread.mjs` |
| 热路径写 | 请求日志、attempt 走 write-behind，`setImmediate` 后每批 32 条 `BEGIN IMMEDIATE` 提交 | `write-behind.mjs`、`admin/request-log.mjs:679`、`repos/request-attempts-repo.mjs:103` |
| 热路径事务 | 每个计费请求同步执行 `RelayBilling.authorize` / `settle` | `protocol/handle-protocol.mjs:839`、`:2279`、`:253` |
| 迁移体系 | 69 个 `.sql`（含重复前缀 `057`），SHA-256 校验，逐个事务执行 | `database.mjs` `applyMigrations` |
| Schema | 迁移中出现 58 个表名（含重建用的临时表）、99 个索引、42 个外键、40 个 CHECK、3 个部分索引，无触发器和视图；另有 `thinking_signature_owners` 在代码里建表，不走迁移 | `src/lib/db/migrations/`、`pool/thinking-owner.mjs:51` |
| SQL 调用点 | 约 440 处 `prepare`，约 58 处 `withTransaction`，88 处使用 `.changes` | 全仓库 |
| SQLite 专有能力 | `VACUUM INTO` 备份、`PRAGMA data_version` 变更检测、`PRAGMA` 数据库指标页、`query_only` 只读连接 | `admin/backup-core.mjs:101`、`usage-stats-thread.mjs:14`、`db/database-metrics.mjs:93` |
| 测试 | 451 个测试文件中 101 个直接建 SQLite 库 | `test/` |
| 脚本 | 4 个审计脚本直接打开 `kin.db` | `scripts/audit-*.mjs` |

### 1.2 生产数据（只读查询）

| 项 | 数值 |
| --- | --- |
| `kin.db` | 888 MB + WAL 224 MB，61 张表（含 `sqlite_stat1`、`schema_migrations`） |
| 最大的表 | `billing_charges` 15.4 万、`request_attempts` 10.7 万、`usage_logs` 7.5 万、`thinking_signature_owners` 4.1 万、`jev_usage_events` 3.6 万 |
| 写入速率 | `usage_logs` 近 24 小时约 4.4 万行；现有保留期清理在运行（最早行为 2026-11-01） |
| 时间格式 | `created_at` 为 `TEXT`，形如 `2026-11-03T09:44:48.117Z` |
| 备份目录 | `data/backups` 约 11 GB（每日 tar.gz，含 `db/kin.db` 与 `vms/*.json`） |

### 1.3 不在本方案范围

- `vms/*.json`、`routing.json` 等文件存储和 `fs.watch` 同步：继续是文件，后续按目标架构 Phase 4 处理。
- Redis、多 Gateway 实例、rollup/outbox 重新建模：按目标架构后续阶段处理。
- 历史 `kin.db` 的删除或归档：属于数据处置，单独授权。

## 2. 与其他计划的先后关系

- **主线程减负第二阶段（进程拆分）可以先做，也可以不做。** 进程拆分在 SQLite WAL 上就能成立；PostgreSQL 迁移不依赖它。如果停顿复测（见进程拆分计划第 0 节）已经不达门槛，PostgreSQL 迁移也就失去“性能”这个理由，只剩多实例和运维理由。
- **本方案第 3 阶段的异步数据访问边界是两条路线的公共前置。** 不管最后是否迁 PostgreSQL，把仓储改成异步接口后，SQLite 也可以整体放进 worker 线程执行，主线程同样不再被 SQL 阻塞。这一点决定了第 3 阶段可以独立交付、独立回滚。
- **与目标架构第 1.3 节的约束一致**：本方案迁移后，面板统计仍是原查询，但运行在独立只读连接池并带 `statement_timeout`，作为过渡；rollup 投影仍按目标架构 Phase 2 实施，本方案不把“原表 + 全表统计”当终态。

## 3. 需要注意的问题

### 3.1 同步改异步

- **调用链整体变色。** 仓储方法改成 `async` 后，调用它的路由、调度、协议处理都要 `await`。仓储构造函数里提前 `prepare` 的写法要改成按需执行（PostgreSQL 的预编译语句绑定在连接上，不能跨连接复用）。
- **原来的“原子代码块”会被打断。** 以前一段同步代码中间不会插入别的请求；改成 `await` 后，两次查询之间可能插入别的请求修改了内存或数据库状态。凡是“读内存状态 → 查库 → 改内存状态”的逻辑（调度准入、配额计数、冷却）都要逐一审查。
- **热路径必须减少数据库往返。** 进程内 SQLite 单次查询是微秒级；PostgreSQL 即使走 unix socket，每次往返也在 0.1–0.5 ms。API Key、分组、价格这类每请求都读的数据要用内存快照 + 失效通知，不能每个请求查多次库。
- **否决的捷径：同步桥接。** 用 worker + `Atomics.wait` 把 PostgreSQL 包装成同步调用，可以不改调用方，但每次查询都会阻塞主线程整个网络往返，比现在更差，不采用。

### 3.2 事务语义和并发

- **余额、预占、幂等的“先查后写”会出竞态。** 例如钱包调整和转账先 `SELECT` 余额判断是否足够，再 `UPDATE`（`admin/relay-billing.mjs:78`、`:115`）；幂等先查 `idempotency_key` 再插入。PostgreSQL 默认 `READ COMMITTED` 下，两个并发事务都能通过检查。改法：
  - 扣款用条件更新：`UPDATE ... SET balance_micros = balance_micros - $1 WHERE id = $2 AND balance_micros >= $1 RETURNING ...`，按影响行数判断成败；
  - 需要先读后算的，用 `SELECT ... FOR UPDATE` 锁行；多行加锁按固定顺序（如按 ID 排序），避免转账互相死锁；
  - 幂等一律依赖唯一约束 + `INSERT ... ON CONFLICT DO NOTHING RETURNING`，不依赖先查；
  - 结算这类跨多表的复杂事务，用 `SERIALIZABLE` 并对 `40001` 序列化失败做有限次重试。
- **嵌套事务。** 现在 `withTransaction` 嵌套时直接在外层事务里执行（`reverse` 内部调用 `adjust`）。异步后用 `AsyncLocalStorage` 传递当前事务连接，内层需要部分回滚时用 `SAVEPOINT`。
- **事务里禁止等待外部 I/O。** 事务持有连接期间不能等 VM、上游接口或 SSH，否则连接池耗尽、行锁长期不放。配合 `idle_in_transaction_session_timeout` 兜底。
- **write-behind 的批量提交要保留。** 改为每批一个事务、多值 `INSERT`，失败的单条要能隔离重试，不能整批丢弃。

### 3.3 类型与数据

| SQLite 现状 | PostgreSQL 映射 | 注意 |
| --- | --- | --- |
| `TEXT` ISO 时间（105 列） | `timestamptz` | 驱动默认返回 `Date`；设置类型解析器，统一输出与 `toISOString()` 相同格式，保持 API 契约。迁移前要统计格式不规范的行 |
| `INTEGER` 毫秒/秒时间（16 列） | `bigint` | 保持数值，不顺手改成 `timestamptz` |
| `INTEGER` 金额：`*_micros`、`*_nano_usd*` | `bigint` | 驱动默认把 `int8` 返回成字符串；注册解析器转成 `Number`，并检查是否在安全整数范围内 |
| `REAL` 金额与倍率：`total_cost`、`actual_cost`、`balance`、`multiplier` 等 | `double precision` | 第一阶段保持浮点，与现有计算逐位一致；改 `numeric` 会让驱动返回字符串、改变运算结果，放到后续单独做 |
| `INTEGER` 0/1 布尔（`INTEGER DEFAULT 0/1` 约 79 列，多数是布尔） | 先用 `smallint` 保持 0/1 | 代码里大量 `=== 1` 判断，第一阶段不改成 `boolean` |
| `TEXT` JSON（`config_json`、`record_json` 等） | `jsonb` | 非法 JSON 会导致导入失败，先审计。高频 join 字段（`runtime_vm_id`、`vm_resource_id`、`platform`）建议提成生成列并建索引 |
| `COLLATE NOCASE`（用户名、邮箱） | `lower()` 唯一索引或 `citext` | 先查现有数据在大小写不敏感下是否已有重复 |
| `AUTOINCREMENT` / `rowid` | `bigint generated always as identity` | 迁移后要 `setval` 重置序列 |
| 动态类型 | 严格类型 | SQLite 允许 `INTEGER` 列里存文本、`''` 和 `NULL` 混用；逐列 `typeof()` 审计后再定转换规则 |
| `SUM`/`COUNT` 返回数字 | `COUNT` 返回 `bigint`、`SUM(bigint)` 返回 `numeric` | 两者都会以字符串返回，统计接口要统一转换 |

数据库必须用 `LC_COLLATE=C`（或列级 `COLLATE "C"`）创建。PostgreSQL 默认的语言区域排序与 SQLite 的二进制比较不同，会改变 ID 和文本游标的排序与范围比较。

### 3.4 SQL 方言

| SQLite 写法 | 出现次数 | PostgreSQL 写法与差异 |
| --- | --- | --- |
| `?` 占位符 | 全部 | `$1..$n`；建议在适配层自动转换，SQL 文本里不出现两种写法 |
| `INSERT OR IGNORE` | 源码 12、迁移 4 | `ON CONFLICT DO NOTHING`。注意 SQLite 的 `OR IGNORE` 还会吞掉 `NOT NULL`、`CHECK` 违例，PostgreSQL 不会，原来被静默跳过的脏数据会变成报错 |
| `INSERT OR REPLACE` | 1 | `ON CONFLICT DO UPDATE`。`REPLACE` 是先删后插，会重置未赋值列、触发级联删除，语义不同，需逐处确认 |
| `ON CONFLICT ... DO UPDATE` | 16 | 语法基本兼容；检查冲突目标是否有对应唯一索引，`excluded.` 引用写法一致 |
| `json_extract(col,'$.k')` | 22 | `col->>'k'`；返回值类型从“按 JSON 类型”变成文本，数字比较要显式转换 |
| `json_each(?)` 传数组 | 3 | `= ANY($1::text[])` |
| `strftime('%Y-%m-%d', created_at, '+8 hours')` | 23 | `to_char(created_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD')`；UTC+8 业务日规则必须逐处对照 |
| `unixepoch` | 7 | `extract(epoch FROM ...)` |
| `rowid` 作为水位 / 游标 | 9 | 见 3.5，**不能直接换成自增 ID** |
| `.changes` / `lastInsertRowid` | 88 / 1 | `rowCount` / `RETURNING id` |
| `LIKE` | 13 | SQLite 对 ASCII 不区分大小写，PostgreSQL 区分；按原意改 `ILIKE` |
| 标量 `MAX(a,b)`、`IFNULL`、`printf` | 7 / 10 / 2 | `GREATEST`、`COALESCE`、`format` |
| `CAST(x AS INTEGER)` | 7 | SQLite 会把 `'12abc'` 截成 12，PostgreSQL 直接报错 |
| `ORDER BY` 遇到 `NULL` | 普遍 | 升序时 SQLite 把 `NULL` 排最前，PostgreSQL 排最后；分页和展示要显式写 `NULLS FIRST/LAST` |
| `GROUP BY` 中选非聚合列 | 需审计 | SQLite 允许，PostgreSQL 报错 |
| 比较表达式的结果 | 普遍 | SQLite 返回 0/1，PostgreSQL 返回布尔，JS 侧变成 `true/false` |

列名中的 `key`、`value`、`type`、`role`、`action`、`name` 在 PostgreSQL 都不是保留字，未发现必须改名的标识符。

### 3.5 以 `rowid` 为水位的增量消费（计费正确性）

供应商计费、账号用量和结算用 `rowid` 当增量水位（`vendor/vendor-pricing.mjs:9`、`vendor/vendor-account-usage.mjs:10`、`vendor/vendor-settlements.mjs:181`），`usage_logs` 导出也用 `rowid` 做游标（`repos/usage-logs-repo.mjs:750`）。SQLite 单写者下，`rowid` 的提交顺序和数值顺序一致。PostgreSQL 的序列在取号时分配，并发事务可能“后取号先提交”：消费者读到 101 并推进水位后，100 才提交，100 就被永久跳过，表现为**漏计费**。

改法（选一种，计费路径推荐第一种）：

1. 写入事实时在同一事务写一条待处理记录（pending projection / outbox），消费者用 `FOR UPDATE SKIP LOCKED` 领取，处理完删除或标记；
2. 继续用序列水位，但只推进到“安全水位”：低于当前所有未提交写事务的最小序号（实现复杂，不推荐）。

纯分页导出的游标可以继续用 identity 列，因为它只要求顺序稳定，不要求不漏未提交的行。

### 3.6 迁移体系与上游同步

- 69 个 SQLite 迁移不能在 PostgreSQL 上原样执行。PostgreSQL 侧从一个 `pg/0001_baseline.sql` 开始，内容等于当前最终 schema；导入时同时写入 `schema_migrations` 映射，记录它等价于哪些 SQLite 迁移版本。
- 之后每次 schema 变更都要成对提交 SQLite 和 PostgreSQL 两份迁移（如果保留 SQLite 后端），或只写 PostgreSQL 版本（如果完全分叉）。
- 上游新增的 SQLite 迁移和查询，每次同步时都要人工翻译成 PostgreSQL 版本并做方言审查。这需要写进 `docs/CHANGE_DELIVERY.md` 第 4 节的同步流程，并在 `docs/CUSTOMIZATION_RELEASE_NOTES.md` 中作为永久定制差异记录依据和退出条件。

### 3.7 备份、恢复和运维

- 现有每日备份是 `VACUUM INTO` 快照加 `vms/*.json` 打包，面板还能一键恢复。PostgreSQL 改为 `pg_dump -Fc`（一致性快照）加可选的 WAL 归档实现时间点恢复。面板恢复流程要重做：先停写、恢复到临时库、校验后切换。数据库快照和 `vms/*.json` 要保持同一时间点。
- 数据库指标页（`database-metrics.mjs`）的 `PRAGMA` 指标换成 `pg_stat_database`、`pg_stat_statements`、连接池指标。
- 统计线程用 `PRAGMA data_version` 判断数据是否变化，换成版本表或 `LISTEN/NOTIFY`。
- 只读 worker 的 `query_only` 换成只读角色，或设置 `default_transaction_read_only = on`。
- 超时分角色设置：网关 `statement_timeout` 约 2 s，面板约 10 s；统一设置 `lock_timeout`、`idle_in_transaction_session_timeout`，开启慢查询日志。

### 3.8 部署

- PostgreSQL 与网关同机部署（Docker 容器，只监听 unix socket 或 `127.0.0.1`），固定一个当前受官方支持的大版本，部署时按官方支持矩阵选定。不对公网开放。
- 宿主机内存与槽位 VM 共享，`shared_buffers`、`work_mem` 要按实际余量设置，并写进 `docs/DEPLOY.md`。
- 连接数：网关池约 10、面板只读池约 4、后台任务约 2，总数远低于 `max_connections`；暂不需要 PgBouncer。
- 凭据用 `scram-sha-256`，通过环境变量或密钥文件注入，不进镜像、不进仓库。
- 新增 npm 依赖 `pg`（node-postgres）。这打破了当前数据层“零第三方依赖”的设计，需要记录在定制说明中。

### 3.9 故障行为

| 故障 | 要求 |
| --- | --- |
| PostgreSQL 不可用 | 拒绝新的需要鉴权或计费的请求（返回明确的 503），不能放行未计费请求 |
| 已开始的流在结束时写不进去 | 结算和用量记录进入本地持久化重试队列（如追加写文件），恢复后按请求 ID 幂等补写 |
| 连接池耗尽 | 获取连接设超时，超时按不可用处理；监控等待队列长度 |
| 查询超时 | 面板查询返回明确错误，不影响网关连接池 |

## 4. 实施阶段

每个阶段都能独立验收、独立回滚。阶段 3 之前生产仍跑 SQLite。

### 阶段 0：决策与基线（不改代码）

1. 用户就第 9 节的问题作出决定，尤其是上游策略。
2. 写只读审计脚本，对生产备份副本（不是生产库本身）跑一遍：
   - 逐列 `typeof()` 分布、格式不规范的时间、非法 JSON、`NOCASE` 下的重复值、`CHECK`/`NOT NULL` 下会失败的行；
   - `GROUP BY` 非聚合列、`ORDER BY` 中依赖 `NULL` 顺序的查询清单（静态扫描）。
3. 固定一份“黄金对照快照”：各表行数，全部钱包余额之和，`billing_charges`/`wallet_ledger` 金额合计，按 UTC+8 每日的 usage token 与费用汇总，供应商结算单与已分配范围。后续每个阶段都和它对比。

验收：审计报告列出所有需要清洗或特殊转换的数据，每项都有处理规则。

### 阶段 1：异步数据访问边界（仍是 SQLite，可单独上线）

1. 新增统一接口 `DbClient`：`query`、`one`、`many`、`run`（返回 `rowCount`）、`tx(fn)`，内部用 `AsyncLocalStorage` 传递事务连接。先实现 SQLite 适配器。
2. 把 26 个模块里直接写的 SQL 收进 `repos/`，仓储方法全部改成 `async`，调用方逐层改 `await`。
3. 按 3.2 节改写所有“先查后写”：钱包、预占、幂等、配额。这些改写在 SQLite 上同样正确，可以先上线验证。
4. 热路径（`authorize`、`settle`、API Key 查询）加内存快照，统计每个请求的数据库往返次数并写进指标。
5. 可选：SQLite 适配器整体移到 worker 线程执行，主线程不再执行任何 SQL（这是不迁 PostgreSQL 也能拿到的收益）。

验收：现有测试全过；钱包与预占的并发测试（同一用户并发扣款、并发转账、重复幂等键）通过；生产灰度后 `/healthz` p99 不回退，账单与黄金快照的增量对得上。
回滚：回退代码，数据不变。

**阶段 1 完成情况（2026-11-06，数据访问分层 R6 B0–B8）：**

| 条目 | 状态 |
| --- | --- |
| 1. 统一接口 `DbClient` | 已完成。接口为 `one` / `many` / `run` / `exec` / `tx`，没有单独的 `query`；`run` 返回 `{ changes, lastInsertRowid }`；事务不跨事件循环（守卫回滚），事务外语句排队 |
| 2. SQL 收进仓储并改 async | 已完成（R1 + R6）。主线程不再同步访问数据库，守卫测试 `sync-data-access.test.mjs` 与 `scripts/sql-boundary.mjs` 锁住；豁免只剩连接与迁移、Worker 线程、运维脚本等 |
| 3. 改写“先查后写” | 已完成（竞态 R1–R22）。余额、转账、配额等仍靠 SQLite 单连接串行，迁 PostgreSQL 时要加行锁（按用户 ID 顺序加锁），见 R6 发布说明“限制” |
| 4. 热路径内存快照与每请求往返指标 | 部分完成：settings 快照已做；Key、分组、供应商闸门等改为直接 async 读库；每请求数据库往返次数指标未做 |
| 5. SQLite 移到 worker 线程 | 未做：`DbClient` 底层仍在主线程同步执行 |
| 验收 | 全量测试与本机压测（推理热路径、收尾两批与改造前持平）已过；并发测试只在单连接上做；生产灰度未做（B7、B8 尚未部署） |

### 阶段 2：PostgreSQL 后端与方言

1. 编写 `pg/0001_baseline.sql`：按 3.3 节类型映射，保留全部约束和索引，补齐 `json` 生成列索引；数据库用 `C` 排序规则。代码里自建的表（`thinking_signature_owners`）一并收进迁移。
2. 实现 PostgreSQL 适配器：连接池、`?`→`$n` 转换、类型解析器（`int8`、`numeric`、`timestamptz`）、分角色超时、错误码映射（唯一冲突、序列化失败、死锁）。
3. 方言集中在一个模块里，按需提供 `dayBucket(col)`、`jsonText(col, key)`、`inList(arr)` 等函数，仓储里不散落条件分支。
4. 改写 3.4 节列出的全部方言点，按 3.5 节重做计费水位。
5. 实现 PostgreSQL 版的备份、指标、变更检测。
6. 测试：仓储契约测试在两个后端上都跑；CI 增加 PostgreSQL 服务，每个测试文件用独立 database（模板库复制）。不使用 `pg-mem` 这类模拟库，因为它的语义和真实 PostgreSQL 不同。

验收：两个后端的契约测试全过；同一份数据快照下，两个后端的面板 API 响应逐字段一致（允许的差异逐项登记）。

### 阶段 3：数据迁移工具与演练

1. `scripts/migrate-sqlite-to-pg.mjs`：
   - 输入是 `VACUUM INTO` 得到的一致快照，不直接读运行中的库；
   - 按外键依赖顺序用 `COPY` 批量导入，按审计规则清洗转换，拒绝的行写进报告而不是静默丢弃；
   - 重置全部 identity 序列，执行 `ANALYZE`；
   - 只允许导入空目标库，可重复执行。
2. `scripts/verify-pg-migration.mjs`：逐表行数、逐表规范化行哈希、黄金快照全部指标。
3. 反向导出工具（PostgreSQL → SQLite），用于切换后的回滚（见阶段 5）。
4. 用生产备份副本在本机或预发完整演练至少两次，记录耗时，确定停机窗口。

验收：两次演练校验全部一致，耗时稳定。

### 阶段 4：预发验证

1. 预发环境用最新生产备份副本导入 PostgreSQL，跑完整功能回归。
2. 压测：峰值 2–3 倍并发（约 120 条并发流），观察连接池等待、p99 延迟、每请求往返次数。
3. 故障注入：重启 PostgreSQL、耗尽连接池、制造长事务和锁等待，确认 3.9 节的行为。
4. 并发计费专项：同一用户、同一 Key 高并发请求，核对预占、结算、钱包流水与 usage 完全一致。

验收：无漏计费、无重复计费；故障时不放行未计费请求；恢复后补写完整。

### 阶段 5：生产切换（需单独授权）

1. 提前公告窗口；切换前做一次仓库外完整备份（`kin.db` 快照 + `vms/*.json`）。
2. 停止接受新请求，等在途流结束（设上限），停网关进程，确认 write-behind 队列已清空。
3. 执行迁移和校验脚本；校验不通过直接回滚到 SQLite，不带病启动。
4. 以 `KIN_DB_DRIVER=pg` 启动，冒烟测试：登录、发 Key、Claude/Codex 各一个计费请求、面板日志和统计、供应商页面。
5. 观察期（建议 72 小时）：错误率、延迟、计费对账每天和黄金快照的增量对比一次。

回滚：
- **启动前**：直接用原 `kin.db` 启动，无数据损失。
- **观察期内**：停机，用反向导出工具把 PostgreSQL 数据导回 SQLite，再用 SQLite 启动。因此反向导出工具必须在阶段 3 就完成并演练。
- **观察期后**：不再保证回滚到 SQLite。

### 阶段 6：收尾

按 AGENTS.md“需求变更与旧代码清理”规则，在同一次交付里处理被替代的实现：
- 若决定完全分叉：删除 SQLite 适配器、只读 worker 池、`PRAGMA` 指标、`VACUUM INTO` 备份、`data_version` 检测以及对应测试和文档。
- 若决定保留 SQLite 后端（用于上游同步或单机部署）：在 `docs/CUSTOMIZATION_RELEASE_NOTES.md` 记录保留依据、范围和退出条件，两个后端的契约测试长期都跑。
- 旧 `kin.db` 和历史备份的处置单独授权。
- 随后进入目标架构的 rollup、outbox、Redis 阶段。

## 5. 工作量估算（粗估，单人）

| 阶段 | 估算 | 主要不确定性 |
| --- | --- | --- |
| 0 决策与基线 | 2–3 天 | 审计发现的脏数据量 |
| 1 异步边界 | 2–4 周 | 调用链深度、调度与配额的并发审查 |
| 2 PostgreSQL 后端 | 2–3 周 | 方言点数量、水位重做、测试基础设施 |
| 3 迁移工具 | 1 周 | 数据清洗规则 |
| 4 预发验证 | 1–2 周 | 压测与故障注入发现的问题 |
| 5 切换 | 窗口 < 1 小时（以演练实测为准）+ 72 小时观察 | — |

另外，每次同步上游都会多出方言翻译和审查的固定成本，按上游数据层的改动频率，可能每次增加 0.5–2 天。

## 6. 风险登记

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| 异步化引入竞态 | 超扣、重复入账、调度超发 | 阶段 1 先在 SQLite 上改写并上线；并发专项测试 |
| `rowid` 水位漏读 | 供应商漏计费 | 3.5 节改为 pending 记录 + `SKIP LOCKED` |
| 类型解析遗漏 | 金额变字符串拼接、比较出错 | 统一类型解析器；契约测试覆盖金额与计数字段 |
| 排序与 `NULL` 顺序变化 | 分页错乱、展示变化 | `C` 排序规则；显式 `NULLS FIRST/LAST`；双后端响应比对 |
| 热路径往返增加 | 首字节延迟上升 | 内存快照；每请求往返计数指标；压测门槛 |
| 上游同步成本 | 每次同步变慢、冲突增多 | 第 9 节决策；方言集中在单一模块；同步流程写进交付规范 |
| 回滚困难 | 切换后出问题无法回退 | 反向导出工具；72 小时观察期 |
| 宿主机内存紧张 | 与槽位 VM 争抢内存 | 保守设置 `shared_buffers`；部署前核对余量 |

## 7. 总验收标准

- 黄金快照的全部指标在迁移后完全一致；切换后每日增量对账无差异。
- 两个后端（如保留）契约测试全过，面板 API 响应比对的差异均已登记并确认。
- 并发计费测试无超扣、无重复、无遗漏。
- `/healthz` p99 不高于切换前；网关不再在主线程执行任何 SQL。
- PostgreSQL 不可用时不放行未计费请求，恢复后补写完整。
- 备份、恢复和反向导出都完成过实际演练。

## 8. 交付物清单

- `src/lib/db/client.mjs`（统一接口）、`sqlite-adapter.mjs`、`pg-adapter.mjs`、`dialect.mjs`
- `src/lib/db/pg/0001_baseline.sql` 及后续 PostgreSQL 迁移
- `scripts/audit-sqlite-for-pg.mjs`、`scripts/migrate-sqlite-to-pg.mjs`、`scripts/verify-pg-migration.mjs`、`scripts/export-pg-to-sqlite.mjs`
- 更新 `docs/DEPLOY.md`（PostgreSQL 部署、备份、恢复）、`docs/CHANGE_DELIVERY.md`（上游同步时的方言翻译）、`docs/CUSTOMIZATION_RELEASE_NOTES.md`

## 9. 启动前需要用户决定的事项

1. **上游策略。** 三选一：
   - A. 先向上游提议“异步仓储接口 + 可插拔后端”，PostgreSQL 适配器作为定制。冲突最少，但取决于上游是否接受、何时接受。
   - B. 本地独立分叉数据层。最快，但每次同步上游都要翻译数据层改动，长期成本最高。
   - C. 暂不迁移。先做阶段 1（异步边界 + SQLite 进 worker 线程）和进程拆分，等确实需要多实例时再迁。
   推荐 **C 起步，再视需要走 A**：阶段 1 本身就能解决主线程阻塞，而且是 A、B 的共同前置，不浪费；当前规模下多实例还不是刚需。
2. **是否长期保留 SQLite 后端**（影响阶段 6 的清理范围和测试成本）。
3. **PostgreSQL 部署位置**：同机容器（推荐，延迟最低）还是托管服务。
4. **停机窗口**：阶段 3 演练出实测耗时后再定具体时间。
5. **是否在同一批引入 Redis**：建议不引入，先只换存储引擎，隔离风险。
