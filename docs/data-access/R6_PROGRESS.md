# R6 全量异步化 · 进度台账

已交付状态的唯一权威。计划见 [R6_PLAN.md](R6_PLAN.md)。

| 批次 | 状态 | 交付提交 | 审查 | 备注 |
| --- | --- | --- | --- | --- |
| B0 | done | 见发布说明“R6 B0” | 待 B1 一并审查 | `DbClient` + SQLite 适配器；单次查询额外开销约 106 ns |
| B1 | done | settings 快照（见发布说明“R6 B1（一）”） | 待 B3 一并审查 | 只做 settings。key-scope、`vendorRuntimeBlock`、`summarizeVm` 分组字段是权限与归属数据，写入方多（上游仓储与定制原生 SQL），`node:sqlite` 没有写入钩子，零查询快照无法保证及时失效，改为在各自批次（B7、B4、B6c）直接改 async；集群节点平台不在推理热路径上，随 B6c |
| B2 | merged | — | — | 并入 B7/B8：写回队列的闭包改 async 后，同步的 `closeDatabase()` / `flushWrites()` 无法等它们完成，须与 B8 把 `closeDatabase` 改 async 同批；在此之前闭包保持同步（本就延后批量执行，不阻塞请求） |
| B3 | done | 见发布说明“R6 B3” | 主会话审查（补 DbClient 排队） | executor 异步化；R15–R17 由事务原子性保证 |
| B4 | done | 见发布说明“R6 B4” | 主会话审查（补 DbClient 语句缓存上限） | vendor 异步化：仓储经 DbClient、服务层与调用方逐层 await，`withTransaction` 改 `db.tx`；竞态 R20 改 `INSERT … ON CONFLICT DO NOTHING` 后读回（全局价格、下游账单、付款；超管按周期开单仍靠同一事务串行，表上没有周期唯一索引，迁 PostgreSQL 时需加约束或锁）；供应商终端授权（slot-shell `authorize`）改为可 await；读池 Worker 等待 async 报表；结算明细由 `iterate` 改一次取回。临时同步出口见下表 |
| B5 | todo | — | — | gateway-worker（下一批） |
| B6a | done | 见发布说明“R6 B6a” | 主会话审查 | 统计读模型异步化：统计页（`StatisticsRepo` 与汇总表子类 `RollupStatisticsRepo` 的钩子 `_totalsRow` / `_seriesRows` / `_leaderboardRows`）、使用记录视图 `UsageLogsView` 与 `lookupNames`、`windowSums` / `costByAccount` / `billingStats`、分组用量 `groupUsage` 经 DbClient 读取，调用方逐层 await（统计线程、读池 Worker、panel 与 relay 路由）；分组视图里的用量改为请求内共用一次查询的 Promise，`PUT /groups/:id/resources` 的分组视图移到同步事务提交后生成。不新增同步出口。`UsageStatsWorker` 的 `PRAGMA data_version` / `total_changes()` 属统计线程连接基础设施（sql-boundary 基线 exempt），用于同步判定快照能否合并，保持同步；`billingStats` 调用的 `maintainBillingCosts`、`logCoverageStart`、`_rollupHoursByAccount`、`_costEventsForAccount`、`vmWindowForecast` 属 B7，暂保持同步 |
| B6b | todo | — | — | 管理面 |
| B6c | todo | — | — | VM、代理池、集群 |
| B7 | todo | — | — | 推理热路径（同批上线） |
| B8 | todo | — | — | 收尾 |

## 临时同步出口

| 方法 | 所在文件 | 保留原因（热路径调用方） | 移除批次 |
| --- | --- | --- | --- |
| `credentialCustody.forgetSync`（及其依赖 `vault.removeSync`、`vaultRepo.removeSync`） | `src/lib/executor/credential-custody.mjs`、`vault.mjs`、`repos/vault-repo.mjs` | `account-management.mjs` 的 `revokeBps` 在同步 `withTransaction` 里删除 BPS 凭据（该事务属 B5） | B5 |
| `readColdSync`（经 `latestConfigRevisionSync` / `loadSettingsRowSync`） | `src/lib/executor/settings-store.mjs`、`repos/settings-repo.mjs` | Codex 设置快照冷启动且尚未预热时（单测、不走服务启动流程的工具进程）同步读一次；服务进程启动时已 `await warmCodexSettings` | B8 |
| `hasCredentialRecords`（`vaultHasRecords`） | `src/lib/executor/repos/vault-repo.mjs` | 启动期判断：凭据库已有记录时主密钥文件不能自动生成（`createCredentialVault` / 托管 `getVault` 同步构造时调用）；`vaultRevision` / `forget` / `forgetSync` 在 worker 托管下也先用它判断凭据库是否为空 | B8 |
| `vendorRuntimeBlockSync`（与 `vendorRuntimeBlock` 共用 `runtimeBlockSteps` 判定；依赖 `accountResourceSync`、`vmGroupMembershipsSync`、`activeGroupNamesSync`、`proxyStatusSync`、`getVendorRowSync`、`getVendorVmResourceSync`） | `src/lib/vendor/vendor-runtime-policy.mjs`、`vendor/repos/runtime-policy-repo.mjs`、`vendor/repos/vendors-repo.mjs`、`vendor/repos/resources-repo.mjs` | 推理热路径：`vm-registry.mjs` 的 `summarizeVm` / `isVmScheduleReady`，`codex-slot-pool.mjs` 的 `isCodexSlotReady` / `codexAccountStatus`；另有 VM 批量编辑 `vm-bulk-edit.mjs` 的 `vmOf` 与可调度校验（B6c 改 await） | B7 |
| `recordVendorUsageSync`（与 `recordVendorUsage` 共用判定；依赖 `gatewayAccountResourceSync`、`vmAccountResourceSync`、`insertUsageFactSync`） | `src/lib/vendor/vendor-usage.mjs`、`vendor/repos/usage-repo.mjs` | `usage-logs-repo.mjs` 的 `insertSummary` / `insertSummaryIfAbsent` 在同步事务里写使用记录后写供应商用量事实（请求日志落库 `RequestLogStore.finish>persist`） | B7 |
| `gatewayAccountResourceSync`、`insertUsageFactSync` | `src/lib/vendor/repos/usage-repo.mjs` | `gateway-repo.mjs` 的 `applyReceiptToUsage`（回执入账同步事务，B5 改造）与上一行 `recordVendorUsageSync`（B7） | B7 |
| `resolveVendorAccountNameSync`（依赖 `findAuthorizationNamedAccountSync`、`setResourceNameConfigStampedSync`） | `src/lib/vendor/vendor-account-name.mjs`、`vendor/repos/resources-repo.mjs` | `oauth-credentials.mjs` 的 `persistOauthToVm`（凭据刷新与导入链路，同步写 VM 文件后命名账号） | B7 |
| `findSupplierRuntimeVmSync` | `src/lib/vendor/repos/resources-repo.mjs` | `request-log.mjs` 的 `RequestLogStore.finish`（日志关闭时仍保留供应商 VM 的最小用量） | B7 |
| `findRuntimeVmVendorSync` | `src/lib/vendor/repos/resources-repo.mjs` | `proxy-pool.mjs` 的 `ProxyPool.vendorIdForVm`（`allocateForVm` / `bind` / `getProxyForVm` 等同步方法，panel-routes 清冷却也经此判断） | B6c |
| `getResourceSecretJsonSync`、`updateResourceConfigStampedSync` | `src/lib/vendor/repos/resources-repo.mjs` | `gateway-worker/account-management.mjs` 的同步方法与同步事务（`normalize`、`desiredGatewayAccountConfig`、BPS 授权 / 撤销 / 恢复、目录刷新等）；`saveAuthorized` 的事务已改 `db.tx`（供应商建号 `owner.createResource` 已 async） | B5 |
