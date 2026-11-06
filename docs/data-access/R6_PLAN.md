# R6 全量异步化 · 开发计划

状态：完成（B0–B8 已于 2026-11-06 全部交付，见 R6_PROGRESS.md）。日期：2026-11-05。用户 2026-11-05 选择“全量异步化”（上游数据层、推理热路径一并改 async），已知与“上游优先、最小定制差异”冲突：每次同步上游时，上游新增或改动的同步数据访问都要按本计划的约定改写。

- 设计依据：[../DATA_ACCESS_AND_API_ARCHITECTURE_20261105.md](../DATA_ACCESS_AND_API_ARCHITECTURE_20261105.md) 第 6 节 R6、[../POSTGRESQL_MIGRATION_PLAN_20261103.md](../POSTGRESQL_MIGRATION_PLAN_20261103.md) 3.1、3.2 与阶段 1。
- 调用图：[R6_CALLGRAPH.md](R6_CALLGRAPH.md)（1575 个染色单元、195 个文件，其中上游 104 个；22 个竞态点；批次建议）。机器可读版本在本机 `~/Backups/vm2api/r6/r6-callgraph.json`。
- 进度台账：[R6_PROGRESS.md](R6_PROGRESS.md)（已交付状态的唯一权威）。

## 0. 续接

1. 记忆指针 `~/.claude/projects/-Users-luhonglin-Git-vm2api/memory/r6-async-db.md`。
2. 本机进度日志 `~/Backups/vm2api/r6/journal.md`：每个动作追加一行（批次、步骤、检查点、验证、交付 SHA）。
3. `origin/main:docs/data-access/R6_PROGRESS.md`：找第一个不是 done 的批次；对照 journal 末尾确认是否有未交付的进行中工作。
4. 持久检出 `~/Git/vm2api-cp`（分支 `cp/wip`）；交付用 `~/Backups/vm2api/deliver-single-commit.sh`，基线传“本树所基于的远端 SHA”，远端前进时先 `git apply -3` 合入对方改动。

## 1. 约定

### 1.1 `DbClient`（B0 引入，`src/lib/db/db-client.mjs`）

```js
const db = dbClient()            // 绑定 getDb()；测试可 createDbClient(database)
await db.one(sql, ...params)     // 首行或 undefined
await db.many(sql, ...params)    // 全部行
await db.run(sql, ...params)     // { changes, lastInsertRowid }
await db.exec(sql)               // 多语句 DDL
await db.tx(async (tx) => { … }) // 事务；tx 与 db 同接口，嵌套为 SAVEPOINT
```

- 底层仍是单连接 `DatabaseSync`，语句同步执行，返回已完成的 Promise。`await` 只让出给微任务，不让出给其他请求的 I/O 回调。
- **事务不跨事件循环**：`tx` 开始时登记一个 `setImmediate` 守卫；事务结束前守卫被触发，说明事务内等待了真实 I/O（网络、定时器、文件 Promise），此时回滚并抛 `db_tx_yielded`。事务内只能做数据库操作与纯计算，外部调用放在事务前后（与 4.3 节“事务内不做网络调用”一致）。
- 事务上下文用 `AsyncLocalStorage` 传递：事务内经 `dbClient()` 发出的语句自动落在该事务里；嵌套 `tx` 用 `SAVEPOINT`。
- 同步旧接口（`getDb()`、`withTransaction`）在迁移期间保留，供未改造的调用方使用；在 async 事务内调用同步 `withTransaction` 会按嵌套处理（与现状一致）。在同步事务内发起 async `tx` 直接抛错（不允许混用）。B8 起主线程不再有同步出口：`withTransaction` 只留作 `database.mjs` 内部迁移使用，`DbClient` 删除同步方法，`getDb()` 只用于取当前连接交给 `dbClient()` / 仓储构造（守卫测试 `test/unit/sync-data-access.test.mjs`）。
- 语句按 SQL 文本缓存（沿用 `statementCache` 思路）。

### 1.2 改造规则

- 仓储方法改为 `async`，签名与返回值不变；调用方逐层 `await`。同步上下文（构造函数、数组回调、事件监听器、默认参数、同步回调参数，调用图第 4 节 120 处）要重构：构造函数改为显式 `init()`；数组回调先 `await` 取数再处理；监听器改为调用 async 函数并处理拒绝。
- **先查后写**（调用图第 5 节 R1–R22）在所属批次改成条件更新或放进同一 `tx`：余额 `UPDATE … SET balance = balance - ? WHERE balance >= ?` 并检查 `changes`；幂等键 `INSERT … ON CONFLICT DO NOTHING` 后读回；计数 `UPDATE … WHERE inflight < max`。这样在 SQLite 上正确，迁 PostgreSQL 后也正确。
- **临时同步出口**：后批次（B7 热路径）尚未改造前，前批次改成 async 的仓储方法若仍被热路径同步调用，保留一个只供热路径使用的同步方法（命名 `…Sync`，注释写“R6 临时出口，B7 删除”）。台账记录每个出口；B7 交付时全部删除，测试检查不再存在。
- 上游文件改动按批次在发布说明里逐项说明；同步上游时按 2.3 处理。

### 1.3 验证

每批：相关单测 + 全量单测（基线：4 个已知环境失败）+ 全量 e2e（基线：129 通过、39 失败，失败用例逐条相同）+ Gateway Worker 真实 e2e；涉及热路径的批次另跑本机压测对比（请求耗时与主线程占用不回退）。每批交付后由独立子智能体只读审查（重点：遗漏的 await、同步上下文、竞态、事务跨事件循环）。

## 2. 批次

| 批次 | 内容 | 完成标准 |
| --- | --- | --- |
| B0 | `DbClient` + SQLite 适配器：事务守卫、ALS、SAVEPOINT、语句缓存；sql-boundary 承认 `db-client` 为仓储层 | 单测覆盖：读写、嵌套回滚、抛错回滚、跨事件循环被拒、同步事务内调用被拒；不改任何调用方 |
| B1 | 热路径只读快照：settings、key scope、`vendorRuntimeBlock`、`summarizeVm` 分组字段、IPv6 开关、模型策略、集群节点平台（调用图 6 节 B1） | 快照按变更失效；热路径对这些数据不再查库；行为不变 |
| B2 | 延后写入：write-behind 改 async 批；请求日志与尝试入队回调 async | 单测 + 日志 e2e |
| B3 | executor：凭据库、刷新租约、事件收件箱、设置；修 R15–R17 | executor 单测、Gateway 真实 e2e |
| B4 | vendor：平台、管理、结算、价格、用量；修 R20 | vendor 单测与 e2e |
| B5 | gateway-worker：账号管理、回执、对账、路由；修 R19 | Gateway 单测与 e2e |
| B6a | 统计读模型（统计页、使用记录视图） | 统计单测（含 R5 一致性测试） |
| B6b | 管理面：用户、分组、设置写、Key 与端点管理、备份、中继运营；修 R1–R3、R18 | 管理面单测与 e2e |
| B6c | VM、代理池、集群 | 相关单测与 e2e |
| B7 | 推理热路径：B7a 准入与计费、B7b Claude 调度、B7c Codex（同批上线）；修 R4–R13、R21；删除全部临时同步出口 | 全量测试 + 压测不回退 |
| B8 | 收尾：`server.mjs` 接线；删除 `getDb()` / `withTransaction` 的同步出口（仅保留 Worker 线程与迁移使用）；收紧 sql-boundary 与守卫测试 | 全仓库无同步数据访问（守卫测试） |

## 3. 风险

- 改动面大、上游占比高：每批独立交付、独立回滚；批内先改叶子再改调用方。
- 遗漏 `await` 会把 Promise 当值使用：每批加静态检查（对已改 async 的仓储方法，调用点必须有 `await`/`return`），并沿用“未声明变量”类守卫思路。
- 热路径性能：每次查询多一次 Promise 分配；B1 快照先削减 70% 的只读查询，再做 B7。
- 同步上游：上游改动的数据访问需按约定改写，按批次记录在发布说明。
