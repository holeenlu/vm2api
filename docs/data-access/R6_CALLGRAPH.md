# R6 全量异步化：同步数据库调用 → 调用方 调用图（vm2api-cp @ cdde04cd）

> 生成：2026-11-05T14:10:15.379Z；机器可读数据见本机 `~/Backups/vm2api/r6/r6-callgraph.json`（不入库）（entries / tx_sites / tainted / await_sites / groups / races / batches / hot_crossings）。

## 0. 方法与局限

- acorn 解析 `src/**/*.mjs`（466 个文件、9864 个函数单元）。DB 叶子 = 直接执行 `.prepare(...).get/all/run/iterate`、预编译语句变量、`statementCache` 语句、语句工厂方法（如 `ClusterNodesRepo._stmt`）、`db.exec` 的函数；`withTransaction` 本身也是叶子。
- 调用解析：词法作用域 → import/re-export → `this.` 类方法/对象字面量兄弟 → `new X().m` → 变量类型（`x = new X`）→ 工厂返回对象 → 名字匹配（通用名 get/set/list 等需接收者名与类名一致才连边）。染色 = 不动点：同步函数调用了染色函数即染色；已是 `async` 的函数视为 await 落点（边界）；`sqlite-worker.mjs`、`usage-stats-thread.mjs` 是独立线程连接，视为边界。
- 上游判定：`git ls-tree d6ad7a6c`（等价于 `git cat-file -e d6ad7a6c:<path>`）。
- 局限：名字匹配边可能误报；依赖注入（`ctx.xxx()`、`deps.xxx`）可能漏报，`context` 含 `di-or-dynamic` 的函数需人工确认调用方；“每请求调用次数”是对照源码人工核算的估计。

## 1. 规模

| 指标 | 数值 |
| --- | --- |
| 染色单元（需改 async 的同步函数/回调） | 1575 |
| 其中具名函数/方法 | 1381 |
| 其中匿名回调（tx/map/filter/监听器等） | 194 |
| 涉及文件 | 195 |
| 其中上游文件 | 104（53%） |
| 上游文件中的染色具名函数 | 852 |
| 热路径上的染色单元 | 477 |
| 同步上下文（构造函数/getter/数组回调/监听器等，需重构而非加 await） | 120 |
| 已是 async、需补 await 的落点函数 | 257 |
| `withTransaction` 调用点 | 74（事务内读后写 59 处） |
| 数据库入口条目（仓储函数/方法 + 豁免文件 + Worker） | 662 |
| 做完 B1 快照 + B2 延后写入后剩余染色单元 | 1242（149 个文件，上游 66 个） |

### 1.1 按模块分组

| 模块 | 具名函数 | 匿名回调 | 文件 | 上游文件 | 上游占比 | 热路径 | 同步上下文 | 可被快照切断 |
| --- | --: | --: | --: | --: | --: | --: | --: | --: |
| admin | 232 | 52 | 37 | 18 | 49% | 57 | 34 | 60 |
| db/repos | 239 | 25 | 22 | 19 | 86% | 64 | 9 | 9 |
| pool | 145 | 11 | 15 | 14 | 93% | 154 | 12 | 30 |
| vendor/repos | 138 | 0 | 14 | 0 | 0% | 12 | 0 | 0 |
| vm | 108 | 20 | 17 | 17 | 100% | 25 | 18 | 81 |
| protocol | 108 | 19 | 25 | 18 | 72% | 99 | 17 | 95 |
| gateway-worker/repos | 86 | 7 | 7 | 0 | 0% | 11 | 2 | 0 |
| vendor | 67 | 22 | 11 | 0 | 0% | 3 | 8 | 1 |
| gateway-worker | 44 | 16 | 9 | 0 | 0% | 11 | 8 | 8 |
| executor | 45 | 9 | 6 | 0 | 0% | 6 | 3 | 5 |
| executor/repos | 44 | 0 | 5 | 0 | 0% | 3 | 0 | 0 |
| server.mjs | 26 | 4 | 1 | 1 | 100% | 3 | 4 | 12 |
| admin/repos | 29 | 0 | 5 | 0 | 0% | 7 | 0 | 0 |
| oauth | 14 | 5 | 6 | 5 | 83% | 2 | 4 | 11 |
| db(core) | 16 | 2 | 4 | 4 | 100% | 4 | 0 | 0 |
| cluster | 15 | 2 | 2 | 2 | 100% | 3 | 1 | 6 |
| transport | 11 | 0 | 4 | 4 | 100% | 5 | 0 | 11 |
| usage/repos | 6 | 0 | 1 | 0 | 0% | 3 | 0 | 0 |
| identity | 4 | 0 | 1 | 1 | 100% | 3 | 0 | 4 |
| core | 2 | 0 | 1 | 1 | 100% | 1 | 0 | 0 |
| usage | 2 | 0 | 2 | 0 | 0% | 1 | 0 | 0 |

## 2. 数据库入口清单

| 文件 | 类别 | 上游 | 条目 | 直接执行 SQL | 用 tx | 仅 prepare（构造期） |
| --- | --- | --- | --: | --: | --: | --: |
| admin/repos/group-metrics-repo.mjs | custom-repo |  | 1 | 1 | 0 | 0 |
| admin/repos/panel-users-repo.mjs | custom-repo |  | 3 | 3 | 0 | 0 |
| admin/repos/relay-billing-repo.mjs | custom-repo |  | 18 | 17 | 0 | 1 |
| admin/repos/relay-repo.mjs | custom-repo |  | 5 | 5 | 0 | 0 |
| admin/repos/vm-bulk-edit-repo.mjs | custom-repo |  | 3 | 3 | 0 | 0 |
| executor/repos/event-inbox-repo.mjs | custom-repo |  | 23 | 22 | 0 | 1 |
| executor/repos/finalized-attempts-repo.mjs | custom-repo |  | 3 | 3 | 0 | 0 |
| executor/repos/refresh-lease-repo.mjs | custom-repo |  | 8 | 7 | 0 | 1 |
| executor/repos/settings-repo.mjs | custom-repo |  | 4 | 4 | 0 | 0 |
| executor/repos/statement-cache.mjs | custom-repo |  | 1 | 0 | 0 | 0 |
| executor/repos/vault-repo.mjs | custom-repo |  | 9 | 8 | 0 | 1 |
| gateway-worker/gateway-repo.mjs | custom-repo |  | 47 | 38 | 5 | 0 |
| gateway-worker/repos/account-ids-repo.mjs | custom-repo |  | 3 | 3 | 0 | 0 |
| gateway-worker/repos/accounts-repo.mjs | custom-repo |  | 21 | 21 | 0 | 0 |
| gateway-worker/repos/event-health-repo.mjs | custom-repo |  | 2 | 2 | 0 | 0 |
| gateway-worker/repos/execution-policies-repo.mjs | custom-repo |  | 3 | 3 | 0 | 0 |
| gateway-worker/repos/oauth-sessions-repo.mjs | custom-repo |  | 5 | 5 | 0 | 0 |
| gateway-worker/repos/receipts-repo.mjs | custom-repo |  | 8 | 8 | 0 | 0 |
| usage/repos/quota-observations-repo.mjs | custom-repo |  | 6 | 6 | 0 | 0 |
| vendor/repos/account-groups-repo.mjs | custom-repo |  | 3 | 3 | 0 | 0 |
| vendor/repos/account-usage-repo.mjs | custom-repo |  | 10 | 8 | 0 | 0 |
| vendor/repos/admin-settlements-repo.mjs | custom-repo |  | 10 | 10 | 0 | 0 |
| vendor/repos/audit-repo.mjs | custom-repo |  | 2 | 2 | 0 | 0 |
| vendor/repos/gateway-bindings-repo.mjs | custom-repo |  | 6 | 6 | 0 | 0 |
| vendor/repos/members-repo.mjs | custom-repo |  | 15 | 15 | 0 | 0 |
| vendor/repos/portal-repo.mjs | custom-repo |  | 7 | 7 | 0 | 0 |
| vendor/repos/pricing-repo.mjs | custom-repo |  | 7 | 7 | 0 | 0 |
| vendor/repos/resources-repo.mjs | custom-repo |  | 38 | 38 | 0 | 0 |
| vendor/repos/runtime-accounts-repo.mjs | custom-repo |  | 1 | 1 | 0 | 0 |
| vendor/repos/runtime-policy-repo.mjs | custom-repo |  | 4 | 4 | 0 | 0 |
| vendor/repos/settlements-repo.mjs | custom-repo |  | 17 | 16 | 0 | 1 |
| vendor/repos/usage-repo.mjs | custom-repo |  | 5 | 4 | 0 | 0 |
| vendor/repos/vendors-repo.mjs | custom-repo |  | 17 | 17 | 0 | 0 |
| db/database-metrics.mjs | db-layer | 是 | 4 | 3 | 0 | 0 |
| db/database.mjs | db-layer | 是 | 13 | 5 | 1 | 0 |
| db/legacy-import.mjs | db-layer | 是 | 1 | 0 | 1 | 0 |
| db/repos/account-runtime-repo.mjs | db-layer | 是 | 19 | 7 | 0 | 1 |
| db/repos/accounts-repo.mjs | db-layer | 是 | 10 | 8 | 0 | 1 |
| db/repos/api-endpoints-repo.mjs | db-layer | 是 | 13 | 9 | 2 | 1 |
| db/repos/api-keys-repo.mjs | db-layer | 是 | 11 | 9 | 0 | 1 |
| db/repos/backup-repo.mjs | db-layer | 是 | 8 | 4 | 0 | 1 |
| db/repos/cluster-nodes-repo.mjs | db-layer | 是 | 18 | 16 | 0 | 2 |
| db/repos/codex-response-owners-repo.mjs | db-layer |  | 6 | 2 | 0 | 1 |
| db/repos/groups-repo.mjs | db-layer | 是 | 25 | 16 | 8 | 0 |
| db/repos/jev-usage-repo.mjs | db-layer | 是 | 5 | 4 | 1 | 1 |
| db/repos/proxies-repo.mjs | db-layer | 是 | 5 | 1 | 1 | 1 |
| db/repos/refusal-device-blocks-repo.mjs | db-layer | 是 | 8 | 7 | 0 | 1 |
| db/repos/refusal-guards-repo.mjs | db-layer | 是 | 9 | 8 | 0 | 1 |
| db/repos/request-attempts-repo.mjs | db-layer | 是 | 9 | 5 | 0 | 1 |
| db/repos/settings-repo.mjs | db-layer | 是 | 8 | 7 | 0 | 1 |
| db/repos/statistics-repo.mjs | db-layer | 是 | 13 | 4 | 0 | 0 |
| db/repos/sticky-repo.mjs | db-layer | 是 | 9 | 8 | 0 | 1 |
| db/repos/usage-cost-rollup.mjs | db-layer |  | 7 | 1 | 0 | 0 |
| db/repos/usage-log-preds.mjs | db-layer | 是 | 2 | 0 | 0 | 0 |
| db/repos/usage-logs-repo.mjs | db-layer | 是 | 53 | 35 | 2 | 1 |
| db/repos/usage-logs-view.mjs | db-layer | 是 | 25 | 15 | 0 | 0 |
| db/repos/usage-stats-rollup.mjs | db-layer |  | 5 | 3 | 0 | 0 |
| db/repos/users-repo.mjs | db-layer | 是 | 13 | 8 | 1 | 1 |
| db/repos/vms-repo.mjs | db-layer | 是 | 11 | 5 | 1 | 1 |
| db/secure.mjs | db-layer | 是 | 6 | 0 | 0 | 0 |
| db/sqlite-pool.mjs | db-layer | 是 | 5 | 0 | 0 | 0 |
| db/write-behind.mjs | db-layer | 是 | 7 | 1 | 0 | 0 |
| admin/relay-migration.mjs | exempt-direct-prepare |  | 1 | 1 | 1 | 0 |
| admin/usage-stats-worker.mjs | exempt-direct-prepare |  | 7 | 2 | 0 | 0 |
| pool/thinking-owner.mjs | exempt-direct-prepare | 是 | 7 | 1 | 0 | 0 |
| admin/usage-stats-thread.mjs | worker-thread |  | 2 | 2 | 0 | 0 |
| db/sqlite-worker.mjs | worker-thread | 是 | 2 | 2 | 0 | 0 |

豁免文件（`scripts/sql-boundary-baseline.json`）：`admin/relay-migration.mjs`（启动期一次性迁移，可保持同步）、`admin/usage-stats-thread.mjs`（统计线程，边界外）、`admin/usage-stats-worker.mjs`（主线程侧 `PRAGMA data_version`/`total_changes()` 变更检测，构造函数里有查询）、`pool/thinking-owner.mjs`（上游，`statements()` 里建表 + 4 条预编译，热路径每 attempt 调 `ownersOf`）。

### 2.1 `withTransaction` 调用点（74 处）

| 位置 | 所在函数 | 上游 | 外层已 async | 事务内读/写 | 读后写 | 批次 |
| --- | --- | --- | --- | --- | --- | --- |
| admin/panel-api-endpoint-routes.mjs:125 | createPanelApiEndpointRoutes>other:ReturnStatement@30 |  | 是 | 5/7 | 是 | B6b |
| admin/panel-api-key-routes.mjs:160 | createPanelApiKeyRoutes>other:ReturnStatement@46 |  | 是 | 7/2 | 是 | B6b |
| admin/panel-routes.mjs:1745 | createPanelHandler>updateVendorAccount | 是 | 是 | 16/17 | 是 | B6b |
| admin/panel-routes.mjs:1878 | createPanelHandler>archiveVendorAccount | 是 | 是 | 1/8 | 是 | B6b |
| admin/panel-routes.mjs:2467 | createPanelHandler>other:ReturnStatement@2373 | 是 | 是 | 21/14 | 是 | B6b |
| admin/panel-routes.mjs:3208 | createPanelHandler>other:ReturnStatement@2373 | 是 | 是 | 6/3 | 是 | B6b |
| admin/panel-routes.mjs:3330 | createPanelHandler>other:ReturnStatement@2373 | 是 | 是 | 1/8 | 是 | B6b |
| admin/panel-user-routes.mjs:157 | createPanelUserRoutes>other:ReturnStatement@38 |  | 是 | 16/8 | 是 | B6b |
| admin/panel-users.mjs:284 | PanelUserStore.create | 是 |  | 6/9 | 是 | B6b |
| admin/panel-users.mjs:334 | PanelUserStore.update | 是 |  | 6/8 | 是 | B6b |
| admin/relay-billing.mjs:79 | RelayBilling.adjust |  |  | 5/4 | 是 | B6b |
| admin/relay-billing.mjs:129 | RelayBilling.transfer |  |  | 5/3 | 是 | B6b |
| admin/relay-billing.mjs:206 | RelayBilling.reverse |  |  | 3/8 | 是 | B6b |
| admin/relay-billing.mjs:275 | RelayBilling.createSubscription |  |  | 2/2 | 是 | B6b |
| admin/relay-billing.mjs:297 | RelayBilling.updateSubscription |  |  | 1/2 | 是 | B6b |
| admin/relay-billing.mjs:358 | RelayBilling.settle |  |  | 3/3 | 是 | B7 |
| admin/relay-migration.mjs:9 | migrateRelayScopes |  |  | 8/9 | 是 | B6b |
| admin/relay-routes.mjs:249 | createRelayHandler>other:ReturnStatement@24 |  | 是 | 3/7 | 是 | B6b |
| admin/relay-routes.mjs:264 | createRelayHandler>other:ReturnStatement@24 |  | 是 | 10/5 | 是 | B6b |
| admin/relay-routes.mjs:314 | createRelayHandler>other:ReturnStatement@24 |  | 是 | 6/7 | 是 | B6b |
| admin/relay-routes.mjs:344 | createRelayHandler>other:ReturnStatement@24 |  | 是 | 13/8 | 是 | B6b |
| admin/vm-bulk-edit.mjs:241 | createVmBulkEditService>save |  |  | 4/9 | 是 | B6b |
| admin/vm-bulk-edit.mjs:271 | createVmBulkEditService>save |  |  | 0/2 |  | B6b |
| db/database.mjs:66 | reconcileHistorical001ProxySchema | 是 |  | 0/1 |  | B0 |
| db/legacy-import.mjs:60 | runLegacyImport | 是 |  | 9/15 | 是 | B0 |
| db/repos/api-endpoints-repo.mjs:158 | ApiEndpointsRepo.removeEndpoint | 是 |  | 0/3 |  | B6b |
| db/repos/api-endpoints-repo.mjs:209 | ApiEndpointsRepo.replaceModels | 是 |  | 0/2 |  | B6b |
| db/repos/groups-repo.mjs:207 | GroupsRepo.create | 是 |  | 1/2 | 是 | B6b |
| db/repos/groups-repo.mjs:228 | GroupsRepo.update | 是 |  | 1/2 | 是 | B6b |
| db/repos/groups-repo.mjs:248 | GroupsRepo.remove | 是 |  | 1/6 | 是 | B6b |
| db/repos/groups-repo.mjs:264 | GroupsRepo.assignResource | 是 |  | 3/5 | 是 | B6b |
| db/repos/groups-repo.mjs:312 | GroupsRepo.setOverride | 是 |  | 2/6 | 是 | B6b |
| db/repos/groups-repo.mjs:345 | GroupsRepo.#setUserOverride | 是 |  | 1/3 | 是 | B6b |
| db/repos/groups-repo.mjs:366 | GroupsRepo.inheritGrants | 是 |  | 2/9 | 是 | B6b |
| db/repos/groups-repo.mjs:385 | GroupsRepo.setGrants | 是 |  | 3/9 | 是 | B6b |
| db/repos/jev-usage-repo.mjs:53 | JevUsageRepo.record | 是 |  | 0/3 |  | B6b |
| db/repos/proxies-repo.mjs:101 | ProxiesRepo.replaceAll | 是 |  | 0/2 |  | B6c |
| db/repos/usage-logs-repo.mjs:402 | UsageLogsRepo.insertSummary | 是 |  | 3/2 | 是 | B4 |
| db/repos/usage-logs-repo.mjs:417 | UsageLogsRepo.insertSummaryIfAbsent | 是 |  | 3/2 | 是 | B4 |
| db/repos/users-repo.mjs:144 | UsersRepo.insert | 是 |  | 1/3 | 是 | B6b |
| db/repos/vms-repo.mjs:105 | VmsRepo.remove | 是 |  | 4/9 | 是 | B6b |
| executor/event-ingest.mjs:403 | createExecutorEventIngest>completeAttempts |  |  | 2/7 | 是 | B3 |
| executor/event-ingest.mjs:461 | createExecutorEventIngest>tick |  | 是 | 0/0 |  | B3 |
| executor/refresh-lease.mjs:80 | createRefreshLeases>acquire |  |  | 2/1 | 是 | B3 |
| executor/refresh-lease.mjs:158 | createRefreshLeases>release |  |  | 1/4 | 是 | B3 |
| executor/settings-store.mjs:132 | write |  |  | 2/2 | 是 | B3 |
| executor/vault.mjs:322 | createCredentialVault>put |  |  | 1/1 | 是 | B3 |
| executor/vault.mjs:370 | createCredentialVault>rewrap |  |  | 1/1 | 是 | B3 |
| gateway-worker/account-management.mjs:739 | GatewayAccountManagement.saveAuthorized |  | 是 | 7/11 | 是 | B5 |
| gateway-worker/account-management.mjs:819 | GatewayAccountManagement.saveBpsGrant |  | 是 | 0/2 |  | B5 |
| gateway-worker/account-management.mjs:1023 | GatewayAccountManagement.bpsRecoveryAction>arg:exclusive:1@1011 |  | 是 | 0/3 |  | B5 |
| gateway-worker/account-management.mjs:1054 | GatewayAccountManagement.revokeBps>arg:exclusive:1@1041 |  | 是 | 0/3 |  | B5 |
| gateway-worker/account-management.mjs:1083 | GatewayAccountManagement.reconcileBpsBlocks |  |  | 4/9 | 是 | B4 |
| gateway-worker/account-management.mjs:1296 | GatewayAccountManagement.update>arg:exclusive:1@1292 |  | 是 | 4/10 | 是 | B5 |
| gateway-worker/gateway-repo.mjs:543 | GatewayWorkerRepo.recordRuntimeLoad |  |  | 0/3 |  | B5 |
| gateway-worker/gateway-repo.mjs:574 | GatewayWorkerRepo.recordBpsProbes |  |  | 1/2 | 是 | B5 |
| gateway-worker/gateway-repo.mjs:614 | GatewayWorkerRepo.recordRuntimeCredentials |  |  | 0/2 |  | B5 |
| gateway-worker/gateway-repo.mjs:679 | GatewayWorkerRepo.recordAccountFreezes |  |  | 0/2 |  | B5 |
| gateway-worker/gateway-repo.mjs:874 | GatewayWorkerRepo.ingestReceipt |  |  | 6/8 | 是 | B4 |
| gateway-worker/gateway-routes.mjs:157 | createGatewayWorkerRoutes>other:ReturnStatement@119 |  | 是 | 0/2 |  | B5 |
| protocol/handle-protocol.mjs:330 | createHandleProtocol>installCommercialLog>req.commitRelayLog.commitRelayLog>other:ConditionalExpression@330 | 是 |  | 0/0 |  | B7 |
| vendor/vendor-admin.mjs:145 | updateAdminVendor |  |  | 7/9 | 是 | B4 |
| vendor/vendor-admin.mjs:238 | createSettlement |  |  | 12/2 | 是 | B4 |
| vendor/vendor-admin.mjs:292 | settlementAction |  |  | 3/5 | 是 | B4 |
| vendor/vendor-platform.mjs:268 | VendorPlatform.createRoot |  |  | 6/6 | 是 | B4 |
| vendor/vendor-platform.mjs:347 | VendorPlatform.createChild |  |  | 8/9 | 是 | B4 |
| vendor/vendor-platform.mjs:409 | VendorPlatform.createChildInTransaction |  |  | 6/6 | 是 | B4 |
| vendor/vendor-platform.mjs:510 | VendorPlatform.updateProxyResource |  |  | 5/2 | 是 | B4 |
| vendor/vendor-platform.mjs:654 | VendorPlatform.createAccount |  |  | 10/6 | 是 | B4 |
| vendor/vendor-platform.mjs:894 | VendorPlatform.updateResource |  |  | 3/3 | 是 | B4 |
| vendor/vendor-pricing.mjs:118 | createGlobalPricing |  |  | 3/2 | 是 | B4 |
| vendor/vendor-settlements.mjs:163 | previewDownstreamSettlements |  |  | 5/2 | 是 | B4 |
| vendor/vendor-settlements.mjs:216 | createDownstreamSettlement |  |  | 11/3 | 是 | B4 |
| vendor/vendor-settlements.mjs:272 | mutateDownstreamSettlement |  |  | 8/9 | 是 | B4 |

## 3. 推理热路径

入口：`protocol/handle-protocol.mjs` 的 `executeProtocol/executeSearch/executeImages/executeLive`（已 async）、`handle-codex*.mjs`、`responses-ws.mjs`、`server.mjs#requireAuth`。下表是热路径上**当前同步、需要改 async 或改读快照**的函数与每请求次数（N = 本轮候选 VM 数）。

| 函数 | 位置 | 上游 | 每请求调用次数 / 查询数 | 同步上下文 | 建议批次 |
| --- | --- | --- | --- | --- | --- |
| requireAuth | src/server.mjs:789 | 是 | 1 次/请求；≈14 条查询（authenticate 2 + canAccept ≈12） |  | B7 |
| ApiKeyStore._ownerActive | admin/api-keys.mjs:160 | 是 | 1 次/请求；1 条 |  | B7 |
| ApiKeyStore.authenticate | admin/api-keys.mjs:194 | 是 | 1 次/请求；2 条（getByHash + _ownerActive）；遗留明文 Key 时全表 list |  | B7 |
| ApiKeyStore._rpmPolicies | admin/api-keys.mjs:385 | 是 | ≈4 次/请求（每次 canAccept 1 + acquire 1）；每次 2–3 条 |  | B7 |
| ApiKeyStore._userConcurrencyCap | admin/api-keys.mjs:403 | 是 | 3 次/请求；每次 1 条 |  | B7 |
| ApiKeyStore.canAccept | admin/api-keys.mjs:439 | 是 | 3 次/受管 Key 请求（requireAuth、executeProtocol:734、acquire 内）；每次 ≈11–12 条 |  | B7 |
| ApiKeyStore.acquire | admin/api-keys.mjs:542 | 是 | 1 次/请求（Codex:976 / API:1348 / Claude:1476 三选一，另 search/images/live 各 1）；≈12 条后同步改内存 inflight/rpm |  | B7 |
| ApiKeyStore.recordUsage | admin/api-keys.mjs:577 | 是 | 1 次/计费请求（settle 回调，在结算事务内）；2–3 条 |  | B7 |
| keyScopeFromRecord | admin/key-scope.mjs:11 | 是 | 随 keyScopeFromRequest/refreshKeyScope/canAccept 每次 1；≈6 条 |  | B1 |
| refreshAuthenticatedKey | admin/key-scope.mjs:74 | 是 | 随 canAccept/keyScopeFromRequest 每次 1；2 条 |  | B1 |
| keyScopeFromRequest | admin/key-scope.mjs:89 | 是 | ≥1 次/请求（executeProtocol:891；Codex 另有 codexVmFallbackReady 1、pickCodexCandidates 每轮 1、hop:1174 1；无 relayBilling 结算 1）；每次 ≈8 条 |  | B1 |
| refreshKeyScope | admin/key-scope.mjs:111 | 是 | Claude 调度每轮 (N+2) 次：eligibleCandidates 循环前 1 + 循环内每候选 1（pool-scheduler:1061）+ reserve 1；failover 每次尝试再 1；每次 ≈8 条 → 每轮 ≈8N+16 条（N=本轮候选 VM 数） |  | B1 |
| RelayBilling.wallet | admin/relay-billing.mjs:43 |  | 1–2 次/计费请求；1 条 |  | B7 |
| RelayBilling.walletAmount | admin/relay-billing.mjs:50 |  | 1–3 次/计费请求；1 条 |  | B7 |
| RelayBilling.changeWallet | admin/relay-billing.mjs:55 |  | settle 内 1 次（读 1 + 条件外的增量 UPDATE 1 + 读 1） |  | B7 |
| RelayBilling.subscriptionWindows | admin/relay-billing.mjs:307 |  | authorize 内 1 次；Array.map 回调里 3 个窗口各 1 条 |  | B7 |
| RelayBilling.authorize | admin/relay-billing.mjs:321 |  | 1 次/计费请求（executeProtocol:908、executeSearch:2225、executeImages:2556、executeLive:2679 之一）；≈7–11 条；只读准入，不预占余额 |  | B7 |
| RelayBilling.settle | admin/relay-billing.mjs:356 |  | 1 次/计费请求（res.on(finish) 同步监听器 → commitRelayLog 事务内）；≈5–7 条 + recordUsage 2–3 条 |  | B7 |
| GroupsRepo.rateMultiplier | db/repos/groups-repo.mjs:147 | 是 | commitRelayLog 内 1 次；1 条 |  | B6b |
| GroupsRepo.access | db/repos/groups-repo.mjs:420 | 是 | 每次 keyScopeFromRecord/authorize 1 次；4 条 → 每请求 ≥5 次 |  | B6b |
| createHandleProtocol>finalizeCommercial | protocol/handle-protocol.mjs:249 | 是 | 1 次/请求（commitRelayLog 事务内）；settle / recordUsage / enqueueReconciliation 三选一 |  | B7 |
| createHandleProtocol>installCommercialLog>req.commitRelayLog.commitRelayLog | protocol/handle-protocol.mjs:327 | 是 | 1 次/请求（res finish 监听器或 2264/2277/2611/2752 显式调用，relayLogCommitted 去重）；一个同步事务包 settle + rateMultiplier + requestLog.finish |  | B7 |
| createHandleProtocol>installCommercialLog>listener:on:finish@346 | protocol/handle-protocol.mjs:346 | 是 | 1 次/请求（同步事件分发） | 事件监听器 on:finish | B7 |
| createHandleProtocol>claudeScopePending | protocol/handle-protocol.mjs:432 | 是 | 每 attempt 1；1 条 settings（无缓存） |  | B1 |
| createHandleProtocol>refusalEnabled | protocol/handle-protocol.mjs:505 | 是 | 每请求 1–2；1 条 settings（无缓存） |  | B1 |
| createHandleProtocol>banRefusalDevice | protocol/handle-protocol.mjs:523 | 是 | 命中设备封禁时 1；insert + get |  | B7 |
| createHandleProtocol>refusalPolicy | protocol/handle-protocol.mjs:532 | 是 | 每次 intercept 1 + rememberRefusal 0–1；4 条 settings（无缓存） |  | B1 |
| createHandleProtocol>rememberRefusal | protocol/handle-protocol.mjs:541 | 是 | 每请求结束 1（命中拒答时写 guards/device blocks） |  | B7 |
| commitProtocolBlock | protocol/intercept-gate.mjs:65 | 是 | 拦截命中时 1；guards/device hit 写 |  | B7 |
| PoolScheduler.claimSeat | pool/pool-scheduler.mjs:851 | 是 | 每次选座/唤醒 1；调用 reserve |  | B7 |
| PoolScheduler.reconcileSticky | pool/pool-scheduler.mjs:986 | 是 | 每轮选择 1；sticky resolve 每键 1 条 |  | B7 |
| PoolScheduler.pick | pool/pool-scheduler.mjs:1547 | 是 | selectDirect 每轮 1–2 |  | B7 |
| PoolScheduler.admissionSnapshot | pool/pool-scheduler.mjs:1674 | 是 | reserve 内 1 次；schedulingSnapshot 1–2 条 + evaluateSlotGate 1 条 |  | B7 |
| PoolScheduler.reserve | pool/pool-scheduler.mjs:1756 | 是 | 每次占座尝试 1（选座、排队唤醒 tryGrant、openNewSeat）；≈12–14 条后同步改内存 inflight |  | B7 |
| PoolScheduler.reserve>release | pool/pool-scheduler.mjs:1797 | 是 | 每个占座结束 1 次（同步闭包，经 planner.pump → grant → reserve 读库） |  | B7 |
| PoolScheduler.markSuccess | pool/pool-scheduler.mjs:1824 | 是 | 成功 hop 1；runtime 写 1–2 条 |  | B7 |
| PoolScheduler.markCooldown | pool/pool-scheduler.mjs:1848 | 是 | 失败 hop 1；runtime get + upsert |  | B7 |
| PoolScheduler.resolveWaitPlan | pool/pool-scheduler.mjs:1943 | 是 | 需排队时每轮 1；sticky resolve 1 条 |  | B7 |
| PoolScheduler.notifyCapacity | pool/pool-scheduler.mjs:2013 | 是 | 每次释放座位 1 → 唤醒排队者 → claimSeat → reserve |  | B7 |
| evaluateSlotGate | pool/schedule-eligibility.mjs:104 | 是 | Claude 每轮 (N+1) 次（checkEligibility 每候选 + admissionSnapshot）；每次 1 条（configuredIpv6Enabled 无缓存） |  | B1 |
| configuredIpv6Enabled | vm/proxy-policy.mjs:5 | 是 | 同 proxyBlockedReason，每次 1 条，无缓存 |  | B1 |
| proxyBlockedReason | vm/proxy-policy.mjs:9 | 是 | 默认参数 configuredIpv6Enabled() 每调用读 1 条 settings；Claude ≈N+1 次/轮；Codex 每 VM 2–3 次（含 Array.filter/some/find 回调） |  | B1 |
| listVms | vm/vm-registry.mjs:61 | 是 | Claude 每轮 eligibleCandidates 1；Codex 每轮准入 1（+codexVmFallbackReady 1）；每次 N×(2 + 供应商 VM 5–7) 条（N=本轮候选 VM 数） |  | B1 |
| summarizeVm | vm/vm-registry.mjs:82 | 是 | 每 VM 每次 listVms 1（Array.map 回调内）；2 条 groups + vendorRuntimeBlock |  | B1 |
| persistCodexUsage | vm/vm-registry.mjs:247 | 是 | 每 Codex hop 1；3 条 |  | B7 |
| vendorRuntimeBlock | vendor/vendor-runtime-policy.mjs:17 |  | 每个供应商 VM：每次 listVms 1 + Codex isCodexSlotReady/codexAccountStatus 各 1；每次 5–7 条 |  | B1 |
| AccountQuota.ensure | pool/account-quota.mjs:146 | 是 | 上面每次 1；get 1 条，缺失时 insert（先查后插） |  | B7 |
| AccountQuota.ingestHeaders | pool/account-quota.mjs:191 | 是 | 每次成功 hop 1（executeProtocol:2059）；≈3–4 条 |  | B7 |
| AccountQuota.canAccept | pool/account-quota.mjs:606 | 是 | Claude 每候选 1（checkEligibility:1321）+ tryAcquire 内 1；每次 ensure 1 条 |  | B7 |
| AccountQuota.tryAcquire | pool/account-quota.mjs:766 | 是 | reserve 内 1；ensure 1–2 条，之后同步改内存 inflight |  | B7 |
| AccountQuota.gateZoneOf | pool/account-quota.mjs:857 | 是 | Claude 每候选 1 + tryAcquire 1；ensure 1 条 |  | B7 |
| AccountQuota.snapshot | pool/account-quota.mjs:1061 | 是 | 热路径仅经 findAccount（claudeScopePending 为真时每 attempt 1）；list 1 + 每账号 recentAllocations（Array.map 回调） |  | B7 |
| UnitCircuit.admit | pool/unit-circuit.mjs:56 | 是 | reserve 内 1；closed 时 0 条，half_open 时 get+upsert |  | B7 |
| UnitCircuit.recordFailure | pool/unit-circuit.mjs:76 | 是 | 失败 hop 1；get+upsert（读改写 model_states） |  | B7 |
| UnitCircuit.recordSuccess | pool/unit-circuit.mjs:98 | 是 | 成功 hop 1；状态变化时 get+upsert |  | B7 |
| RateLimitService.handle429 | pool/rate-limit-service.mjs:126 | 是 | 429/529 时 1；updateWindow → upsert |  | B7 |
| RateLimitService.updateSessionWindow | pool/rate-limit-service.mjs:160 | 是 | 每次成功响应 1（executeProtocol:2073）；get + upsert |  | B7 |
| SeatPlanner.release | pool/seat-planner.mjs:240 | 是 | 每个会话座位释放 1 → pump |  | B7 |
| SeatPlanner.pump | pool/seat-planner.mjs:420 | 是 | 每次座位释放/超时 1；对排队票 grant → claimSeat → reserve |  | B7 |
| SeatPlanner.grant | pool/seat-planner.mjs:457 | 是 | 每张被授予的票 1 |  | B7 |
| StickyRouter.extractPoolKey | pool/sticky-router.mjs:348 | 是 | 1–2 次/请求；Array.find 回调内每候选键 1 条 |  | B7 |
| StickyRouter.sessionPoolKeys | pool/sticky-router.mjs:389 | 是 | 1 次/请求；Array.filter 回调内每键 1 条 |  | B7 |
| StickyRouter.familyPoolKey | pool/sticky-router.mjs:415 | 是 | 有父会话时 1 次/请求；resolve 2 + bind 0–1 |  | B7 |
| StickyRouter.resolve | pool/sticky-router.mjs:430 | 是 | Claude：executeProtocol:1257/1259 各 1 + 调度每轮 1–3；Codex 每轮准入 1；extractPoolKey/sessionPoolKeys 的 find/filter 回调里每个候选键 1；每次 1 条 |  | B7 |
| StickyRouter.bind | pool/sticky-router.mjs:447 | 是 | 成功选座后 1 次；1 upsert |  | B7 |
| StickyRouter.unbind | pool/sticky-router.mjs:594 | 是 | 粘性目标失效时每键 1 次 |  | B7 |
| codexVmFallbackReady | protocol/handle-codex.mjs:293 | 是 | Codex 网关回退判定 1 次/请求；keyScope 8 + listVms |  | B1 |
| pickCodexCandidates | protocol/handle-codex.mjs:308 | 是 | Codex 每轮准入 1（admitCodexCandidate for(;;) 循环，排队唤醒后重跑）；keyScope 8 + owner 1 + sticky 1 + listVms + 每 VM status/protection |  | B7 |
| ingestCodexHop | protocol/handle-codex.mjs:406 | 是 | 每 Codex hop 1；persistCodexUsage → 配额观测 3 条 |  | B7 |
| handleCodexProtocol>rememberOwner | protocol/handle-codex.mjs:968 | 是 | 每次成功响应 1；response owner upsert |  | B7 |
| handleCodexProtocol>bindSticky | protocol/handle-codex.mjs:1073 | 是 | 成功后 1；sticky upsert |  | B7 |
| CodexAccountProtection.capture | pool/codex-account-protection.mjs:20 |  | 每 hop 1；读 1 + CAS 写 1 |  | B7 |
| isCodexSlotReady | pool/codex-slot-pool.mjs:32 | 是 | 每 VM 1 次（hasServiceableCodexSlot 的 some 回调、pickCodexSlots 循环） |  | B1 |
| CodexAccountProtection.until | pool/codex-account-protection.mjs:41 |  | Codex 每候选 1（orderCodexSessionSlots 的 protectionUntil 回调）+ 每 hop 1；1 条 |  | B7 |
| CodexAccountProtection.observe | pool/codex-account-protection.mjs:51 |  | 每 hop 结束 1（recordDiagnostic 回调内）；读 + CAS 写 |  | B7 |
| hasServiceableCodexSlot | pool/codex-slot-pool.mjs:100 | 是 | codexVmFallbackReady 内 1；Array.some 回调 |  | B1 |
| pickCodexSlots | pool/codex-slot-pool.mjs:114 | 是 | 每次调用 1；Array.sort 比较器里 parkUntil → codexSettings（TTL 缓存，过期时读库） |  | B1 |
| codexAccountStatus | pool/codex-slot-pool.mjs:187 | 是 | 每 VM 1–2 次/轮；供应商 VM 5–7 条 + proxyBlockedReason 1 条 |  | B1 |
| orderCodexSessionSlots | pool/codex-slot-pool.mjs:244 | 是 | pickCodexCandidates 内 1；map/filter 回调对每 VM 调 codexAccountStatus/codexAccountCandidate |  | B1 |
| CodexResponseOwnersRepo.remember | db/repos/codex-response-owners-repo.mjs:45 |  | 每次成功响应 1；1 upsert |  | B7 |
| CodexResponseOwnersRepo.resolve | db/repos/codex-response-owners-repo.mjs:81 |  | 续写请求（previous_response_id）1 次；1 条 |  | B7 |
| ThinkingOwnerStore.ownersOf | pool/thinking-owner.mjs:77 | 是 | 每 attempt 1–2（applyAttempt:1613/1696）；批量 1 条 |  | B7 |
| filterThinkingForAccount | pool/thinking-owner.mjs:121 | 是 | 每 attempt 1–2 |  | B7 |
| RequestLogStore.finish | admin/request-log.mjs:541 | 是 | 1 次/请求；write-behind 已启用时同步段 0 条（只入队） |  | B2 |
| RequestLogStore.finish>persist | admin/request-log.mjs:674 | 是 | 1 次/请求，延后在 write-behind 批事务内；3–6 条 |  | B7 |
| flushWrites | db/write-behind.mjs:30 | 是 | 仅关闭数据库时 1 次 |  | B0 |
| drain | db/write-behind.mjs:43 | 是 | setImmediate 回调；每批 1 次 |  | B0 |
| drainBatch | db/write-behind.mjs:49 | 是 | 每 32 条写入 1 次 BEGIN IMMEDIATE/COMMIT；批内逐条同步执行回调 |  | B0 |
| RequestAttemptsRepo.begin | db/repos/request-attempts-repo.mjs:72 | 是 | 每 hop 1 次（写入入队 write-behind；另同步 list 1 条） |  | B2 |
| RequestAttemptsRepo.record | db/repos/request-attempts-repo.mjs:122 | 是 | Codex 网关每次尝试 1 次（Array.forEach 回调内） |  | B2 |
| RequestAttemptsRepo.complete | db/repos/request-attempts-repo.mjs:174 | 是 | 每 hop 1 次（入队 write-behind） |  | B2 |
| GatewayWorkerClient.instance | gateway-worker/gateway-client.mjs:244 |  | Codex 网关每次派发 1；1 条 |  | B5 |
| GatewayWorkerService.shouldUse | gateway-worker/gateway-execution.mjs:295 |  | Codex 每请求 1；1 条 |  | B5 |
| recordQuotaObservations | usage/quota-observations.mjs:39 |  | 每 Codex hop 1；latest + insert + prune 3 条 |  | B7 |
| ApiEndpointStore.listRaw | admin/api-endpoints.mjs:152 | 是 | API 后端每次 runApiInference 1；listHydrated 1 + 每端点 hydrate（Array.map 回调） |  | B7 |
| findAccount | admin/panel-api.mjs:2188 | 是 | claudeScopePending 为真时每 attempt 1；AccountQuota.snapshot |  | B7 |
| readCodexSettings | executor/settings-store.mjs:74 |  | 每请求多次，TTL 缓存命中 0 条，过期 1–2 条 |  | B1 |
| loadModelPolicy | protocol/model-policy.mjs:564 | 是 | 首个请求后 memo（loaded 标志），之后 0 条；静态上却让 17 个调用方染色 |  | B1 |
| loadGptModelPolicy | protocol/gpt-model-policy.mjs:183 | 是 | 首个请求后 memo，之后 0 条（未命中时还会写 settings） |  | B1 |
| applyCooldown | pool/failover-runner.mjs:418 | 是 | 失败 hop 1；markCooldown → runtime upsert |  | B7 |

**单个 Claude 计费请求的同步查询量（估算）**：requireAuth ≈14 + executeProtocol 的 canAccept ≈12 + keyScopeFromRequest ≈8 + authorize ≈9 + acquire ≈12 + 调度每轮 ≈(8N+16)（refreshKeyScope）+ N×(1 settings + 1 quota + 2 groups + 供应商 VM 5–7)（listVms/evaluateSlotGate/canAccept）+ reserve ≈13 + 每 attempt（thinking 1、claudeScopePending 1、refusal 5）+ 结束 settle ≈8 + ingestHeaders ≈4 + sticky/runtime 写 ≈4。N=20 时约 **300–450 条同步查询/请求**，其中 ≥70% 是配置/身份/分组只读，正是 B1 快照要消掉的部分；直接改 await 会把每条都变成一次事件循环让出（PostgreSQL 下每条 0.1–0.5 ms 往返）。

**Codex 请求**：每轮准入 pickCodexCandidates（keyScope 8 + listVms N×(2+供应商 5–7) + 每 VM codexAccountStatus/protection 1–2）在 `admitCodexCandidate` 的 `for(;;)` 循环里，排队唤醒后整轮重跑；每 hop 另有 protection capture/observe 各 2、attempt begin/complete、quota observations 3、response owner 1。

## 4. 同步上下文（需要重构，不能只加 await）

| 位置 | 形态 | 函数 | 热路径 | 上游 | 处理建议 |
| --- | --- | --- | --- | --- | --- |
| admin/api-keys.mjs:139 | constructor | ApiKeyStore.constructor | 是 | 是 | 构造函数只保存依赖，读库移到 `static async create()`/`init()`；调用方改 `await X.create()` |
| admin/api-keys.mjs:183 | Array.prototype.map 回调 | ApiKeyStore.list>array:map@183 | 是 | 是 | 改 `await Promise.all(xs.map(async …))`（读）或 for…of 顺序 await（写/事务内） |
| admin/relay-billing.mjs:261 | Array.prototype.map 回调 | RelayBilling.subscriptions>array:map@261 | 是 |  | 改 `await Promise.all(xs.map(async …))`（读）或 for…of 顺序 await（写/事务内） |
| admin/relay-billing.mjs:314 | Array.prototype.map 回调 | RelayBilling.subscriptionWindows>array:map@314 | 是 |  | 改 `await Promise.all(xs.map(async …))`（读）或 for…of 顺序 await（写/事务内） |
| db/repos/api-endpoints-repo.mjs:109 | Array.prototype.map 回调 | ApiEndpointsRepo.listHydrated>array:map@109 | 是 | 是 | 改 `await Promise.all(xs.map(async …))`（读）或 for…of 顺序 await（写/事务内） |
| gateway-worker/gateway-execution.mjs:192 | Array.prototype.forEach 回调 | recordGatewayAttempts>array:forEach@192 | 是 |  | 改 `await Promise.all(xs.map(async …))`（读）或 for…of 顺序 await（写/事务内） |
| gateway-worker/gateway-repo.mjs:242 | Array.prototype.map 回调 | GatewayWorkerRepo.pickInstance>array:map@242 | 是 |  | 改 `await Promise.all(xs.map(async …))`（读）或 for…of 顺序 await（写/事务内） |
| pool/account-quota.mjs:63 | constructor | AccountQuota.constructor | 是 | 是 | 构造函数只保存依赖，读库移到 `static async create()`/`init()`；调用方改 `await X.create()` |
| pool/account-quota.mjs:1067 | Array.prototype.map 回调 | AccountQuota.snapshot>array:map@1067 | 是 | 是 | 改 `await Promise.all(xs.map(async …))`（读）或 for…of 顺序 await（写/事务内） |
| pool/codex-slot-pool.mjs:102 | Array.prototype.some 回调 | hasServiceableCodexSlot>array:some@102 | 是 | 是 | 先 `await Promise.all(items.map(check))` 得布尔数组，再同步过滤；或改 for…of + await |
| pool/codex-slot-pool.mjs:144 | Array.prototype.sort 回调 | pickCodexSlots>array:sort@144 | 是 | 是 | 比较器不能 async：先 `await` 预取排序键（Promise.all），再同步 sort |
| pool/codex-slot-pool.mjs:283 | Array.prototype.map 回调 | orderCodexSessionSlots>array:map@283 | 是 | 是 | 改 `await Promise.all(xs.map(async …))`（读）或 for…of 顺序 await（写/事务内） |
| pool/codex-slot-pool.mjs:314 | Array.prototype.map 回调 | orderCodexSessionSlots>array:map@314 | 是 | 是 | 改 `await Promise.all(xs.map(async …))`（读）或 for…of 顺序 await（写/事务内） |
| pool/codex-slot-pool.mjs:329 | Array.prototype.map 回调 | orderCodexSessionSlots>array:map@329 | 是 | 是 | 改 `await Promise.all(xs.map(async …))`（读）或 for…of 顺序 await（写/事务内） |
| pool/pool-scheduler.mjs:260 | constructor | PoolScheduler.constructor | 是 | 是 | 构造函数只保存依赖，读库移到 `static async create()`/`init()`；调用方改 `await X.create()` |
| pool/sticky-router.mjs:205 | constructor | StickyRouter.constructor | 是 | 是 | 构造函数只保存依赖，读库移到 `static async create()`/`init()`；调用方改 `await X.create()` |
| pool/sticky-router.mjs:350 | Array.prototype.find 回调 | StickyRouter.extractPoolKey>array:find@350 | 是 | 是 | 先 `await Promise.all(items.map(check))` 得布尔数组，再同步过滤；或改 for…of + await |
| pool/sticky-router.mjs:353 | Array.prototype.find 回调 | StickyRouter.extractPoolKey>array:find@353 | 是 | 是 | 先 `await Promise.all(items.map(check))` 得布尔数组，再同步过滤；或改 for…of + await |
| pool/sticky-router.mjs:403 | Array.prototype.filter 回调 | StickyRouter.sessionPoolKeys>array:filter@403 | 是 | 是 | 先 `await Promise.all(items.map(check))` 得布尔数组，再同步过滤；或改 for…of + await |
| protocol/handle-codex.mjs:853 | 同步回调参数 measure() | handleCodexProtocol>arg:measure:2@853 | 是 | 是 | measure() 计时包装需支持 async（await fn() 再记时） |
| protocol/handle-codex.mjs:968 | 同步回调参数 recordDiagnostic() | handleCodexProtocol>rememberOwner>arg:recordDiagnostic:0@968 | 是 | 是 | 回调式 API 同步调用回调：改为先 await 取数据再传值，或让该 API 接受 async 回调 |
| protocol/handle-codex.mjs:1153 | 同步回调参数 measure() | handleCodexProtocol>arg:measure:2@1153 | 是 | 是 | measure() 计时包装需支持 async（await fn() 再记时） |
| protocol/handle-codex.mjs:1238 | 同步回调参数 recordDiagnostic() | handleCodexProtocol>runHop>hop>arg:recordDiagnostic:0@1238 | 是 | 是 | 回调式 API 同步调用回调：改为先 await 取数据再传值，或让该 API 接受 async 回调 |
| protocol/handle-codex.mjs:1277 | 同步回调参数 recordDiagnostic() | handleCodexProtocol>runHop>hop>arg:recordDiagnostic:0@1277 | 是 | 是 | 回调式 API 同步调用回调：改为先 await 取数据再传值，或让该 API 接受 async 回调 |
| protocol/handle-codex.mjs:1294 | 同步回调参数 recordDiagnostic() | handleCodexProtocol>runHop>hop>arg:recordDiagnostic:0@1294 | 是 | 是 | 回调式 API 同步调用回调：改为先 await 取数据再传值，或让该 API 接受 async 回调 |
| protocol/handle-protocol.mjs:293 | 同步回调参数 settle() | createHandleProtocol>finalizeCommercial>arg:settle:3@293 | 是 | 是 | 回调式 API 同步调用回调：改为先 await 取数据再传值，或让该 API 接受 async 回调 |
| protocol/handle-protocol.mjs:331 | 同步回调参数 commit() | createHandleProtocol>installCommercialLog>req.commitRelayLog.commitRelayLog>arg:commit:0@331 | 是 | 是 | 回调式 API 同步调用回调：改为先 await 取数据再传值，或让该 API 接受 async 回调 |
| protocol/handle-protocol.mjs:346 | 事件监听器 on:finish | createHandleProtocol>installCommercialLog>listener:on:finish@346 | 是 | 是 | 监听器不能等待：`emitter.on(e, () => { void task().catch(log) })`，并处理重入/顺序（见竞态 R5） |
| protocol/handle-protocol.mjs:436 | 同步回调参数 readJevConfig() | createHandleProtocol>claudeScopePending>arg:readJevConfig:0@436 | 是 | 是 | 回调式 API 同步调用回调：改为先 await 取数据再传值，或让该 API 接受 async 回调 |
| protocol/handle-protocol.mjs:451 | 同步回调参数 readJevConfig() | createHandleProtocol>applyProtocolIntercept>arg:readJevConfig:0@451 | 是 | 是 | 回调式 API 同步调用回调：改为先 await 取数据再传值，或让该 API 接受 async 回调 |
| protocol/handle-protocol.mjs:508 | 同步回调参数 isRefusalGuardEnabled() | createHandleProtocol>refusalEnabled>arg:isRefusalGuardEnabled:0@508 | 是 | 是 | 回调式 API 同步调用回调：改为先 await 取数据再传值，或让该 API 接受 async 回调 |
| protocol/handle-protocol.mjs:535 | 同步回调参数 refusalGuardPolicy() | createHandleProtocol>refusalPolicy>arg:refusalGuardPolicy:0@535 | 是 | 是 | 回调式 API 同步调用回调：改为先 await 取数据再传值，或让该 API 接受 async 回调 |
| protocol/handle-protocol.mjs:1089 | 同步回调参数 measure() | createHandleProtocol>executeProtocol>arg:measure:2@1089 | 是 | 是 | measure() 计时包装需支持 async（await fn() 再记时） |
| vm/vm-registry.mjs:66 | Array.prototype.map 回调 | listVms>array:map@66 | 是 | 是 | 改 `await Promise.all(xs.map(async …))`（读）或 for…of 顺序 await（写/事务内） |
| admin/api-endpoints.mjs:138 | constructor | ApiEndpointStore.constructor |  | 是 | 构造函数只保存依赖，读库移到 `static async create()`/`init()`；调用方改 `await X.create()` |
| admin/catalog-monitor.mjs:51 | Array.prototype.filter 回调 | claudeCatalogTargets>array:filter@51 |  | 是 | 先 `await Promise.all(items.map(check))` 得布尔数组，再同步过滤；或改 for…of + await |
| admin/panel-api-endpoint-routes.mjs:34 | Array.prototype.map 回调 | createPanelApiEndpointRoutes>other:ReturnStatement@30>array:map@34 |  |  | 改 `await Promise.all(xs.map(async …))`（读）或 for…of 顺序 await（写/事务内） |
| admin/panel-api.mjs:649 | Array.prototype.map 回调 | buildDashboard>array:map@649 |  | 是 | 改 `await Promise.all(xs.map(async …))`（读）或 for…of 顺序 await（写/事务内） |
| admin/panel-api.mjs:791 | Array.prototype.map 回调 | buildVmList>array:map@791 |  | 是 | 改 `await Promise.all(xs.map(async …))`（读）或 for…of 顺序 await（写/事务内） |
| admin/panel-api.mjs:1522 | Array.prototype.map 回调 | snapshotAccountPool>array:map@1522 |  | 是 | 改 `await Promise.all(xs.map(async …))`（读）或 for…of 顺序 await（写/事务内） |
| admin/panel-routes.mjs:415 | Array.prototype.filter 回调 | collectOnboardingFacts>array:filter@415 |  | 是 | 先 `await Promise.all(items.map(check))` 得布尔数组，再同步过滤；或改 for…of + await |
| admin/panel-routes.mjs:641 | Array.prototype.filter 回调 | runKernelSync>array:filter@641 |  | 是 | 先 `await Promise.all(items.map(check))` 得布尔数组，再同步过滤；或改 for…of + await |
| admin/panel-routes.mjs:642 | Array.prototype.filter 回调 | runKernelSync>array:filter@642 |  | 是 | 先 `await Promise.all(items.map(check))` 得布尔数组，再同步过滤；或改 for…of + await |
| admin/panel-routes.mjs:2111 | Array.prototype.map 回调 | createPanelHandler>jevScopeInventory>array:map@2111 |  | 是 | 改 `await Promise.all(xs.map(async …))`（读）或 for…of 顺序 await（写/事务内） |
| admin/panel-routes.mjs:2125 | 同步回调参数 readJevConfig() | createPanelHandler>jevInterceptSnapshot>arg:readJevConfig:0@2125 |  | 是 | 回调式 API 同步调用回调：改为先 await 取数据再传值，或让该 API 接受 async 回调 |
| admin/panel-routes.mjs:4631 | Array.prototype.map 回调 | createPanelHandler>other:ReturnStatement@2373>array:map@4631 |  | 是 | 改 `await Promise.all(xs.map(async …))`（读）或 for…of 顺序 await（写/事务内） |
| admin/panel-routes.mjs:5739 | 同步回调参数 readJevConfig() | createPanelHandler>other:ReturnStatement@2373>arg:readJevConfig:0@5739 |  | 是 | 回调式 API 同步调用回调：改为先 await 取数据再传值，或让该 API 接受 async 回调 |
| admin/panel-routes.mjs:5781 | 同步回调参数 readJevConfig() | createPanelHandler>other:ReturnStatement@2373>arg:readJevConfig:0@5781 |  | 是 | 回调式 API 同步调用回调：改为先 await 取数据再传值，或让该 API 接受 async 回调 |
| admin/panel-users.mjs:160 | constructor | PanelUserStore.constructor |  | 是 | 构造函数只保存依赖，读库移到 `static async create()`/`init()`；调用方改 `await X.create()` |
| admin/panel-users.mjs:182 | Array.prototype.map 回调 | PanelUserStore.list>array:map@182 |  | 是 | 改 `await Promise.all(xs.map(async …))`（读）或 for…of 顺序 await（写/事务内） |
| admin/relay-routes.mjs:53 | Array.prototype.flatMap 回调 | createRelayHandler>other:ReturnStatement@24>array:flatMap@53 |  |  | 改 `await Promise.all(xs.map(async …))`（读）或 for…of 顺序 await（写/事务内） |
| admin/relay-routes.mjs:187 | Array.prototype.flatMap 回调 | createRelayHandler>other:ReturnStatement@24>array:flatMap@187 |  |  | 改 `await Promise.all(xs.map(async …))`（读）或 for…of 顺序 await（写/事务内） |
| admin/relay-routes.mjs:201 | Array.prototype.map 回调 | createRelayHandler>other:ReturnStatement@24>array:map@201 |  |  | 改 `await Promise.all(xs.map(async …))`（读）或 for…of 顺序 await（写/事务内） |
| admin/relay-routes.mjs:315 | Array.prototype.map 回调 | createRelayHandler>other:ReturnStatement@24>tx@314>array:map@315 |  |  | 改 `await Promise.all(xs.map(async …))`（读）或 for…of 顺序 await（写/事务内） |
| admin/relay-routes.mjs:399 | Array.prototype.map 回调 | createRelayHandler>other:ReturnStatement@24>array:map@399 |  |  | 改 `await Promise.all(xs.map(async …))`（读）或 for…of 顺序 await（写/事务内） |
| admin/request-log.mjs:398 | constructor | RequestLogStore.constructor |  | 是 | 构造函数只保存依赖，读库移到 `static async create()`/`init()`；调用方改 `await X.create()` |
| admin/route-audit.mjs:43 | 事件监听器 once:finish | watchRouteAudit>listener:once:finish@43 |  |  | 监听器不能等待：`emitter.on(e, () => { void task().catch(log) })`，并处理重入/顺序（见竞态 R5） |
| admin/usage-stats-worker.mjs:9 | constructor | UsageStatsWorker.constructor |  |  | 构造函数只保存依赖，读库移到 `static async create()`/`init()`；调用方改 `await X.create()` |
| admin/usage-stats-worker.mjs:80 | 事件监听器 on:message | UsageStatsWorker._start>listener:on:message@80 |  |  | 监听器不能等待：`emitter.on(e, () => { void task().catch(log) })`，并处理重入/顺序（见竞态 R5） |
| admin/vm-bulk-edit.mjs:113 | Array.prototype.map 回调 | createVmBulkEditService>snapshot>array:map@113 |  |  | 改 `await Promise.all(xs.map(async …))`（读）或 for…of 顺序 await（写/事务内） |
| admin/vm-bulk-edit.mjs:174 | Array.prototype.map 回调 | createVmBulkEditService>save>array:map@174 |  |  | 改 `await Promise.all(xs.map(async …))`（读）或 for…of 顺序 await（写/事务内） |
| admin/vm-bulk-edit.mjs:179 | Array.prototype.map 回调 | createVmBulkEditService>save>array:map@179 |  |  | 改 `await Promise.all(xs.map(async …))`（读）或 for…of 顺序 await（写/事务内） |
| admin/vm-test-schedule.mjs:342 | constructor | VmTestScheduleRunner.constructor |  | 是 | 构造函数只保存依赖，读库移到 `static async create()`/`init()`；调用方改 `await X.create()` |
| admin/vm-test-schedule.mjs:346 | 默认参数表达式 | VmTestScheduleRunner.constructor>other:AssignmentPattern@346 |  | 是 | 默认参数不能 await：改为调用方显式传入或在函数体内 await |
| cluster/cluster-manager.mjs:301 | Array.prototype.map 回调 | ClusterManager.list>array:map@301 |  | 是 | 改 `await Promise.all(xs.map(async …))`（读）或 for…of 顺序 await（写/事务内） |
| db/repos/api-endpoints-repo.mjs:211 | Array.prototype.forEach 回调 | ApiEndpointsRepo.replaceModels>tx@209>array:forEach@211 |  | 是 | 改 `await Promise.all(xs.map(async …))`（读）或 for…of 顺序 await（写/事务内） |
| db/repos/jev-usage-repo.mjs:86 | Array.prototype.map 回调 | JevUsageRepo.configuredKeys>array:map@86 |  | 是 | 改 `await Promise.all(xs.map(async …))`（读）或 for…of 顺序 await（写/事务内） |
| db/repos/usage-logs-repo.mjs:1173 | Array.prototype.map 回调 | UsageLogsRepo._computeBillingStats>array:map@1173 |  | 是 | 改 `await Promise.all(xs.map(async …))`（读）或 for…of 顺序 await（写/事务内） |
| db/repos/usage-logs-view.mjs:794 | Array.prototype.map 回调 | UsageLogsView._hydrate>array:map@794 |  | 是 | 改 `await Promise.all(xs.map(async …))`（读）或 for…of 顺序 await（写/事务内） |
| db/repos/usage-logs-view.mjs:796 | Array.prototype.map 回调 | UsageLogsView._hydrate>array:map@794>array:map@796 |  | 是 | 改 `await Promise.all(xs.map(async …))`（读）或 for…of 顺序 await（写/事务内） |
| db/repos/usage-logs-view.mjs:998 | Array.prototype.map 回调 | UsageLogsView.filterOptions>array:map@998 |  | 是 | 改 `await Promise.all(xs.map(async …))`（读）或 for…of 顺序 await（写/事务内） |
| db/repos/usage-logs-view.mjs:1033 | Array.prototype.map 回调 | UsageLogsView.filterOptions>array:map@1033 |  | 是 | 改 `await Promise.all(xs.map(async …))`（读）或 for…of 顺序 await（写/事务内） |
| db/repos/usage-logs-view.mjs:1100 | Array.prototype.map 回调 | UsageLogsView.activeSessions>array:map@1100 |  | 是 | 改 `await Promise.all(xs.map(async …))`（读）或 for…of 顺序 await（写/事务内） |
| executor/event-ingest.mjs:398 | Array.prototype.map 回调 | createExecutorEventIngest>completeAttempts>array:map@398 |  |  | 改 `await Promise.all(xs.map(async …))`（读）或 for…of 顺序 await（写/事务内） |
| executor/event-ingest.mjs:472 | Array.prototype.map 回调 | createExecutorEventIngest>stats>array:map@472 |  |  | 改 `await Promise.all(xs.map(async …))`（读）或 for…of 顺序 await（写/事务内） |
| executor/result-writer.mjs:88 | Array.prototype.forEach 回调 | applyFinalizedAttempts>array:forEach@88 |  |  | 改 `await Promise.all(xs.map(async …))`（读）或 for…of 顺序 await（写/事务内） |
| gateway-worker/account-management.mjs:224 | Array.prototype.filter 回调 | GatewayAccountManagement.availableGroups>array:filter@224 |  |  | 先 `await Promise.all(items.map(check))` 得布尔数组，再同步过滤；或改 for…of + await |
| gateway-worker/account-management.mjs:467 | Array.prototype.map 回调 | GatewayAccountManagement.createDraft>array:map@467 |  |  | 改 `await Promise.all(xs.map(async …))`（读）或 for…of 顺序 await（写/事务内） |
| gateway-worker/account-management.mjs:1229 | Array.prototype.map 回调 | GatewayAccountManagement.bulkUpdate>array:map@1229 |  |  | 改 `await Promise.all(xs.map(async …))`（读）或 for…of 顺序 await（写/事务内） |
| gateway-worker/gateway-execution.mjs:705 | Array.prototype.find 回调 | GatewayWorkerService.accountInsight>array:find@705 |  |  | 先 `await Promise.all(items.map(check))` 得布尔数组，再同步过滤；或改 for…of + await |
| gateway-worker/gateway-execution.mjs:780 | Array.prototype.find 回调 | GatewayWorkerService.accountAction>array:find@780 |  |  | 先 `await Promise.all(items.map(check))` 得布尔数组，再同步过滤；或改 for…of + await |
| gateway-worker/gateway-repo.mjs:661 | Array.prototype.map 回调 | GatewayWorkerRepo.recordAccountFreezes>array:map@661 |  |  | 改 `await Promise.all(xs.map(async …))`（读）或 for…of 顺序 await（写/事务内） |
| gateway-worker/quota-forecast.mjs:143 | 同步回调参数 pooledVendorRead() | pooledQuotaForecast>arg:pooledVendorRead:3@143 |  |  | 同步回调 API：改接口签名或预取 |
| gateway-worker/receipt-reconciler.mjs:209 | 同步回调参数 settle() | createGatewayWorkerReconciler>tick>arg:settle:3@209 |  |  | 回调式 API 同步调用回调：改为先 await 取数据再传值，或让该 API 接受 async 回调 |
| oauth/account-profile.mjs:17 | 同步回调参数 withVmLock() | persistAccountProfile>arg:withVmLock:1@17 |  |  | withVmLock 已支持返回 Promise，回调改 async 即可 |
| oauth/credential-refresh-monitor.mjs:105 | Array.prototype.filter 回调 | createCredentialRefreshMonitor>listDue>array:filter@105 |  | 是 | 先 `await Promise.all(items.map(check))` 得布尔数组，再同步过滤；或改 for…of + await |
| oauth/import-commit.mjs:214 | 同步回调参数 withVmLock() | createImportCommit>commitImportedOauthGrant>arg:withVmLock:1@214 |  | 是 | withVmLock 已支持返回 Promise，回调改 async 即可 |
| oauth/usage-probe-monitor.mjs:209 | Array.prototype.filter 回调 | createUsageProbeMonitor>listTargets>array:filter@209 |  | 是 | 先 `await Promise.all(items.map(check))` 得布尔数组，再同步过滤；或改 for…of + await |
| protocol/key-models.mjs:17 | Array.prototype.filter 回调 | keyModelCatalog>array:filter@17 |  |  | 先 `await Promise.all(items.map(check))` 得布尔数组，再同步过滤；或改 for…of + await |
| protocol/key-models.mjs:24 | Array.prototype.some 回调 | keyModelCatalog>array:filter@17>array:some@24 |  |  | 先 `await Promise.all(items.map(check))` 得布尔数组，再同步过滤；或改 for…of + await |
| protocol/models.mjs:272 | Array.prototype.map 回调 | listOfficialModels>array:map@272 |  | 是 | 改 `await Promise.all(xs.map(async …))`（读）或 for…of 顺序 await（写/事务内） |
| vendor/queries/usage-query-service.mjs:12 | 同步回调参数 pooledVendorRead() | createUsageQueryService>admin>arg:pooledVendorRead:3@12 |  |  | 同步回调 API：改接口签名或预取 |
| vendor/vendor-account-usage.mjs:222 | 同步回调参数 pooledVendorRead() | readVendorUsagePooled>arg:pooledVendorRead:3@222 |  |  | 同步回调 API：改接口签名或预取 |
| vendor/vendor-admin.mjs:69 | Array.prototype.map 回调 | adminVendors>array:map@69 |  |  | 改 `await Promise.all(xs.map(async …))`（读）或 for…of 顺序 await（写/事务内） |
| vendor/vendor-admin.mjs:125 | Array.prototype.map 回调 | updateAdminVendor>array:map@125 |  |  | 改 `await Promise.all(xs.map(async …))`（读）或 for…of 顺序 await（写/事务内） |
| vendor/vendor-admin.mjs:203 | Array.prototype.map 回调 | listSettlements>array:map@203 |  |  | 改 `await Promise.all(xs.map(async …))`（读）或 for…of 顺序 await（写/事务内） |
| vendor/vendor-platform.mjs:464 | Array.prototype.map 回调 | VendorPlatform.listVendors>array:map@464 |  |  | 改 `await Promise.all(xs.map(async …))`（读）或 for…of 顺序 await（写/事务内） |
| vendor/vendor-portal-view.mjs:177 | Array.prototype.map 回调 | accountPortalRows>array:map@177 |  |  | 改 `await Promise.all(xs.map(async …))`（读）或 for…of 顺序 await（写/事务内） |
| vendor/vendor-settlements.mjs:169 | Array.prototype.map 回调 | previewDownstreamSettlements>tx@163>array:map@169 |  |  | 改 `await Promise.all(xs.map(async …))`（读）或 for…of 顺序 await（写/事务内） |
| vm/proxy-pool.mjs:373 | constructor | ProxyPool.constructor |  | 是 | 构造函数只保存依赖，读库移到 `static async create()`/`init()`；调用方改 `await X.create()` |
| vm/proxy-pool.mjs:483 | Array.prototype.filter 回调 | ProxyPool.snapshot>array:filter@483 |  | 是 | 先 `await Promise.all(items.map(check))` 得布尔数组，再同步过滤；或改 for…of + await |
| vm/proxy-pool.mjs:505 | Array.prototype.map 回调 | ProxyPool.snapshot>array:map@505 |  | 是 | 改 `await Promise.all(xs.map(async …))`（读）或 for…of 顺序 await（写/事务内） |
| vm/proxy-pool.mjs:533 | Array.prototype.map 回调 | ProxyPool.panelSnapshot>array:map@533 |  | 是 | 改 `await Promise.all(xs.map(async …))`（读）或 for…of 顺序 await（写/事务内） |
| vm/proxy-pool.mjs:897 | Array.prototype.some 回调 | ProxyPool.ensureBoundToVm>array:some@897 |  | 是 | 先 `await Promise.all(items.map(check))` 得布尔数组，再同步过滤；或改 for…of + await |
| vm/proxy-pool.mjs:917 | Array.prototype.some 回调 | ProxyPool.allocateForVm>array:some@917 |  | 是 | 先 `await Promise.all(items.map(check))` 得布尔数组，再同步过滤；或改 for…of + await |
| vm/proxy-pool.mjs:921 | Array.prototype.find 回调 | ProxyPool.allocateForVm>array:find@921 |  | 是 | 先 `await Promise.all(items.map(check))` 得布尔数组，再同步过滤；或改 for…of + await |
| vm/proxy-pool.mjs:935 | Array.prototype.filter 回调 | ProxyPool.allocateForVm>array:filter@935 |  | 是 | 先 `await Promise.all(items.map(check))` 得布尔数组，再同步过滤；或改 for…of + await |
| vm/proxy-pool.mjs:1513 | 事件监听器 on:data | ProxyPool._socksProbe>promise-executor@1467>listener:on:data@1513 |  | 是 | 监听器不能等待：`emitter.on(e, () => { void task().catch(log) })`，并处理重入/顺序（见竞态 R5） |
| vm/proxy-pool.mjs:1563 | 事件监听器 on:timeout | ProxyPool._socksProbe>promise-executor@1467>listener:on:timeout@1563 |  | 是 | 监听器不能等待：`emitter.on(e, () => { void task().catch(log) })`，并处理重入/顺序（见竞态 R5） |
| vm/proxy-pool.mjs:1566 | 事件监听器 on:error | ProxyPool._socksProbe>promise-executor@1467>listener:on:error@1566 |  | 是 | 监听器不能等待：`emitter.on(e, () => { void task().catch(log) })`，并处理重入/顺序（见竞态 R5） |
| vm/proxy-pool.mjs:1567 | 事件监听器 on:close | ProxyPool._socksProbe>promise-executor@1467>listener:on:close@1567 |  | 是 | 监听器不能等待：`emitter.on(e, () => { void task().catch(log) })`，并处理重入/顺序（见竞态 R5） |
| vm/proxy-pool.mjs:1607 | Array.prototype.filter 回调 | ProxyPool.probeAll>array:filter@1607 |  | 是 | 先 `await Promise.all(items.map(check))` 得布尔数组，再同步过滤；或改 for…of + await |
| vm/proxy-pool.mjs:1902 | Array.prototype.find 回调 | ProxyPool.getProxyForVm>array:find@1902 |  | 是 | 先 `await Promise.all(items.map(check))` 得布尔数组，再同步过滤；或改 for…of + await |
| vm/slot-runtime.mjs:364 | Array.prototype.filter 回调 | switchInheritedInferenceEngines>array:filter@364 |  | 是 | 先 `await Promise.all(items.map(check))` 得布尔数组，再同步过滤；或改 for…of + await |
| vm/slot-shell.mjs:543 | 事件监听器 on:message | createSlotShell>attach>listener:on:message@543 |  | 是 | 监听器不能等待：`emitter.on(e, () => { void task().catch(log) })`，并处理重入/顺序（见竞态 R5） |
| vm/vm-db-sync.mjs:152 | 同步回调参数 setVmWriteHook() | initVmDbSync>arg:setVmWriteHook:0@152 |  | 是 | 同步回调 API：改接口签名或预取 |
| src/server.mjs:183 | 同步回调参数 installJevUsageRecorder() | arg:installJevUsageRecorder:0@183 |  | 是 | 同步回调 API：改接口签名或预取 |
| src/server.mjs:548 | Array.prototype.map 回调 | listTargets>array:map@548 |  | 是 | 改 `await Promise.all(xs.map(async …))`（读）或 for…of 顺序 await（写/事务内） |
| src/server.mjs:633 | 同步回调参数 onRestored() | arg:onRestored:0@633 |  | 是 | 同步回调 API：改接口签名或预取 |
| src/server.mjs:1566 | 同步回调参数 listen() | arg:listen:2@1566 |  | 是 | 同步回调 API：改接口签名或预取 |

另：`withTransaction(db, () => {...})` 的 74 个回调全部要改 `await db.tx(async () => {...})`，回调内所有仓储调用加 await；事务内禁止 await 外部 I/O（VM、上游、SSH）。

## 5. 先查后写的竞态风险点

| # | 领域 | 位置 | 函数 | 现状模式 | 异步后的风险 | 改法 | 上游 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| R1 | 钱包 | admin/relay-billing.mjs:71 | RelayBilling.adjust | 事务内 ledgerByIdempotencyKey 先查 → balance 读余额判断是否足够 → changeWallet 增量 UPDATE → insertWalletLedger | 异步后两个并发扣款都通过 available>=value 检查，余额可透支；幂等键靠 wallet_ledger.idempotency_key UNIQUE 兜底但会以异常而非 duplicate 返回 | 扣款改条件更新 UPDATE … SET balance_micros=balance_micros-? WHERE id=? AND balance_micros>=? 判 rowCount；幂等改 INSERT … ON CONFLICT(idempotency_key) DO NOTHING RETURNING，冲突时再查旧行比对 |  |
| R2 | 钱包 | admin/relay-billing.mjs:119 | RelayBilling.transfer | 查 debit/credit 两条幂等记录 → 读转出方余额判断 → 两次 changeWallet + 两条流水 | 同上，且双向并发转账在 PostgreSQL 下会互相等待行锁 | 条件扣减 + 按用户 ID 排序加锁（SELECT … FOR UPDATE） |  |
| R3 | 钱包 | admin/relay-billing.mjs:204 | RelayBilling.reverse | 读原流水 → 校验钱包归属 → 内部调用 adjust（嵌套 withTransaction） | 嵌套事务在 ALS 下需要复用外层连接；并发重复冲正依赖 reversal:<id> 幂等键 | tx 内复用 ALS 连接；幂等同 R1 |  |
| R4 | 结算幂等 | admin/relay-billing.mjs:356 | RelayBilling.settle | chargeByRequestId 先查 → changeWallet 扣款 → recordKeyUsage 回调 → insertBillingCharge（request_id PRIMARY KEY） | 同一 request_id 被 res finish 监听器与显式 commitRelayLog、或 receipt-reconciler 定时器并发结算时，两边都查不到旧记录，钱包扣两次后第二次 insert 才因主键失败（若在同一事务则整体回滚，若不同连接则扣款已提交） | 先 INSERT billing_charges … ON CONFLICT(request_id) DO NOTHING RETURNING，成功插入才扣款与记 Key 用量；或在 tx 开头抢占行 |  |
| R5 | 结算幂等 | protocol/handle-protocol.mjs:327 | installCommercialLog > req.commitRelayLog | if (req.relayLogCommitted) return → withTransaction(settle + requestLog.finish) → relayLogCommitted = true（标志在事务后才置位） | 改 async 后 res.on(finish) 与 2264/2277/2611/2752 的显式调用可在 await 期间重入，两次进入结算 | 进入时先同步置 req.relayLogCommitted（或存 Promise 复用），失败再回滚标志；监听器改为 void commit().catch() | 是 |
| R6 | 余额准入 | admin/relay-billing.mjs:321 | RelayBilling.authorize | 只读准入：walletAmount<=0 才拒绝，不预占 | 现状已允许并发超支（设计如此，“Read-only admission”）；异步后窗口更大。套餐窗口 used>=limit 判断同理 | 如需严格：引入预占（reserve_micros）或结算时允许负余额并告警；至少在测试里固定现有语义 |  |
| R7 | Key 并发/RPM | admin/api-keys.mjs:542 | ApiKeyStore.acquire | canAccept（≈12 条查询 + 检查 inflight/rpm/userInflight）→ 返回后自增 inflight、userInflight、rpm 桶 | 读库变 await 后，同 Key 并发请求都在自增前通过 max_concurrency/rpm/用户并发检查，突破上限 | 先 await 拿齐 DB 数据（记录、分组、用户、override），再在一个同步段内完成“检查内存计数 + 自增” | 是 |
| R8 | Key 额度 | admin/api-keys.mjs:576 | ApiKeyStore.recordUsage | repo.getById → repo.recordUsage（累加）→ 读到 quota_used>=quota 后 update 为 quota_exhausted | 累加本身是 SQL 增量则安全；status 翻转基于读到的快照，可能被并发 update 覆盖其他字段（update 写整行） | 改为 UPDATE … SET status=? WHERE id=? AND quota_used>=quota AND status='active' | 是 |
| R9 | 账号并发预占 | pool/pool-scheduler.mjs:1756 | PoolScheduler.reserve | refreshKeyScope + admissionSnapshot（读库）→ 读 requestInflight 判断 < maxConcurrency → tryAcquire（ensure 读库）→ unitCircuit.admit（读写库）→ inflight.set(+1) | 检查与自增之间隔着 tryAcquire/admit 的 await，同账号并发 reserve 都通过 maxConcurrency；注释“Use the live count”只覆盖自增不覆盖判断 | DB 读取全部前置；“检查 inflight + tryAcquire 内存部分 + admit 内存部分 + 自增”放进同一同步段，持久化（circuit _save、quota save）改为之后 fire-and-forget 或入 write-behind | 是 |
| R10 | 配额预占 | pool/account-quota.mjs:766 | AccountQuota.tryAcquire / ensure | ensure：get → 不存在则 insert；tryAcquire：ensure → canAccept → inflight 检查 → 自增 | 并发首次请求双 insert（主键冲突异常）；inflight 检查与自增被 await 隔开 | ensure 用 INSERT … ON CONFLICT DO NOTHING 再读；账号行放内存缓存，tryAcquire 保持纯同步 | 是 |
| R11 | 熔断 | pool/unit-circuit.mjs:56 | UnitCircuit.admit / _save | 内存 unit.probeHeld 判断并置位 → _save：repo.get → 合并 model_states → upsert | 内存判断安全；_save 是读改写整行 model_states，与 markCooldown/RateLimitService 的 upsert 并发时互相覆盖 JSON 字段 | model_states 按键 json_set 更新，或 runtime 行按账号串行写 | 是 |
| R12 | 运行态读改写 | db/repos/account-runtime-repo.mjs:197 | AccountRuntimeRepo.upsert / markCooldown / updateWindow | this.get(account_id) → 合并 input → 整行写回 | 异步后两个 hop 的 cooldown/window/circuit 更新交错，后写覆盖先写（丢 cooldown 或 model_states） | 字段级 UPDATE 或 CAS（protection 已有 compareAndSwapProtectionState 可参照） | 是 |
| R13 | 粘性 | pool/sticky-router.mjs:447 | StickyRouter.resolve → bind / Codex pickCodexCandidates → admitCodexCandidate | resolve 读绑定 → 选座 → bind upsert；Codex 注释写明“Admission = fresh candidates + one synchronous seat claim” | 同会话并发请求读到同一旧绑定后各自绑到不同 VM；pickCodexCandidates 改 async 后候选在 await 期间过期，但 tryAcquireOpenAISlot 仍同步占座，可接受 | 保持“读取（await）→ 同步占座”结构；bind 用 upsert 且以最后成功为准，必要时按 sessionKey 加进程内锁 | 是 |
| R14 | 幂等日志 | db/repos/usage-logs-repo.mjs:416 | UsageLogsRepo.insertSummaryIfAbsent | INSERT OR IGNORE（_insertIfAbsent）→ changes>0 才 recordVendorUsage（读 3 写 1） | 本身靠唯一键，安全；但 recordVendorUsage 在同一 tx 里读 vendor_resources，异步后 tx 持连接时间变长 | 保持 ON CONFLICT 语义；tx 内不做外部 I/O | 是 |
| R15 | 租约 | executor/refresh-lease.mjs:80 | createRefreshLeases.acquire / release | 事务内 latestRevision、leases.get 读当前持有者 → 判断 stale/ambiguous/过期 → upsert 租约 | 两个 Worker 实例并发申请同一账号刷新租约，都读到空闲后都拿到租约，导致刷新令牌被双重轮换 | 条件写：UPDATE … WHERE account_resource_id=? AND (expires_at<? OR holder=?)，或 INSERT … ON CONFLICT DO UPDATE … WHERE 过期，按 rowCount 判定 |  |
| R16 | 凭据代次 | executor/vault.mjs:322 | createCredentialVault.put / rewrap | select 现有 revision → 计算下一代 → upsert | 并发写入同一凭据可能代次回退或互相覆盖 | WHERE revision=? 的 CAS 写 |  |
| R17 | 设置版本 | executor/settings-store.mjs:132 | write（executor settings） | MAX(revision) 读 → +1 写 config_revisions/executor_settings | 并发保存得到相同 revision | 复用 SettingsRepo.advanceConfigRevision 式 CAS 或自增主键 |  |
| R18 | 分组版本 | db/repos/groups-repo.mjs:264 | GroupsRepo.assignResource / setGrants / inheritGrants / setOverride | 读 resource_group_versions → 改关系 → version+1 | 管理面并发编辑同一资源时版本号与关系集不一致（快照失效依赖版本号时尤其重要） | version=version+1 增量写并 RETURNING；或整个操作 SERIALIZABLE/BEGIN IMMEDIATE | 是 |
| R19 | Receipt 结算 | gateway-worker/gateway-repo.mjs:874 | GatewayWorkerRepo.ingestReceipt + receipt-reconciler.tick → RelayBilling.settle | 读 receipt/dispatch/usage_logs → 写 receipt、更新日志、结算 | 推理路径 finalizeCommercial 与 reconciler 定时器对同一 request 并发结算（见 R4）；Receipt 重放并发写 | 以 receipt 唯一键 + billing_charges 主键做抢占 |  |
| R20 | 供应商结算幂等 | vendor/vendor-settlements.mjs:216 | createDownstreamSettlement / mutateDownstreamSettlement / vendor-admin.createSettlement / createGlobalPricing | 先按 (created_by, idempotency_key) 查 → 不存在则计算并插入 | 并发重复提交都查不到，第二个撞唯一索引抛错而非返回 duplicate | INSERT … ON CONFLICT DO NOTHING RETURNING，冲突再查旧行 |  |
| R21 | 模型策略初始化 | protocol/model-policy.mjs:638 | loadModelPolicy / loadGptModelPolicy | if (loaded) return；读 settings → 无则 seed 并写回 → loaded=true | 异步后首批并发请求都执行 seed 写；loaded 标志在 await 后才置位 | 启动期 await 预热（B1），运行期只读内存 | 是 |
| R22 | 事务连接独占 | db/database.mjs:336 | withTransaction → DbClient.tx | 当前 db.isTransaction 判断嵌套；同步执行期间不可能有别的请求插入 | 单连接 SQLite 上 tx(fn) 跨 await 时，其他请求的普通查询会落进这个未提交事务（读到未提交数据、被一起回滚） | SQLite 适配器：tx 期间独占连接，其他 query 排队（或写走单独连接 + BEGIN IMMEDIATE）；ALS 只用于嵌套识别 | 是 |

此外 59 个 `withTransaction` 事务内存在读后写（见 2.1 表“读后写”列）；在 SQLite 单连接上只要 `tx` 独占连接（R22）即与现在等价，迁 PostgreSQL 时需逐个按 3.2 节加条件更新/行锁。

## 6. 建议批次（叶子 → 根，每批可独立交付）

批次归属规则：B1/B2 = 被快照/延后写入切断后不再需要 async 的函数；其余按“最先转换的仓储集合”向上归属，**热路径核心（HOTCORE）只归 B7**，其他批次遇到热路径调用方时记为“跨批热调用边”，该批需给被调仓储方法保留临时同步出口（仅供 HOTCORE 使用，B7 交付时删除）。估算行数 = 签名变更 + 1.2×调用点 + 15×同步上下文 + 6×事务点，±30%；不含新测试。

| 批次 | 内容 | 具名函数 | 匿名回调 | 文件 | 上游文件 | 同步上下文 | tx 点 | 入边（调用点） | 预估改动行 | 相关测试文件数 |
| --- | --- | --: | --: | --: | --: | --: | --: | --: | --- | --: |
| B0 | 基础设施：DbClient + SQLite 适配器 + tx/ALS + write-behind 异步批 | 16 | 2 | 4 | 4 | 0 | 2 | 110 | 约 400–600（新增适配器与测试 300+，write-behind 50，database.mjs 50） | 124 |
| B1 | 热路径只读快照（切断染色，非 async 化） | 279 | 43 | 77 | 62 | 42 | 0 | 1064 | 约 600–900（快照模块 + 失效钩子 + 测试；被切断函数本身基本不改签名） | 27 |
| B2 | 延后写入通道（请求日志/attempt 入队 async） | 7 | 4 | 6 | 3 | 4 | 0 | 25 | 约 81–131 | 8 |
| B3 | executor 凭据库/租约/事件收件箱 | 84 | 9 | 12 | 1 | 3 | 7 | 102 | 约 242–393 | 19 |
| B4 | vendor 供应商平台 | 247 | 42 | 42 | 9 | 12 | 17 | 573 | 约 1007–1637 | 31 |
| B5 | gateway-worker 仓储与 receipt/投影 | 115 | 14 | 20 | 2 | 7 | 10 | 288 | 约 512–832 | 17 |
| B6a | 统计读模型（usage-logs-view/statistics/rollup） | 45 | 8 | 9 | 3 | 8 | 0 | 76 | 约 211–343 | 17 |
| B6b | 管理面：用户/分组/设置写/Key 与端点管理/备份/中继运营 | 179 | 45 | 41 | 26 | 19 | 35 | 562 | 约 1114–1811 | 48 |
| B6c | VM/代理池/集群节点 | 44 | 3 | 9 | 7 | 2 | 1 | 107 | 约 169–274 | 10 |
| B7 | 推理热路径：账号/运行态/粘性/Key/计费/attempt/usage 写 | 365 | 24 | 47 | 36 | 23 | 2 | 1012 | 约 1568–2548 | 29 |

### B0 基础设施：DbClient + SQLite 适配器 + tx/ALS + write-behind 异步批

- 说明：保留 DatabaseSync 同步 API 作为过渡（getDb() 不删），applyMigrations/reconcileHistorical001 属启动期，可继续同步执行；withTransaction 74 处调用点在各自批次改为 await db.tx()。
- 风险：中：事务语义从“同步不可打断”变为“持有连接期间串行”；单连接 SQLite 下 tx 必须独占连接（互斥队列），否则其他请求的语句会落进别人的事务。write-behind 批事务要改成 await 逐条执行并隔离失败。
- 测试：新增 DbClient 适配器单测（query/one/many/run/rowCount、嵌套 tx → SAVEPOINT、ALS 传递、并发 tx 串行、异常回滚）；test/unit/database.test.mjs；test/unit/transaction-callbacks.test.mjs；test/unit/write-behind.test.mjs；test/unit/sqlite-pool.test.mjs；test/unit/sql-boundary.test.mjs
- 文件（4，上游 4）：`db/database-metrics.mjs`、`db/database.mjs`、`db/legacy-import.mjs`、`db/write-behind.mjs`

### B1 热路径只读快照（切断染色，非 async 化）

- 说明：这一批不改 async，而是让热路径的同步读取改读内存快照：SettingsRepo.get（含 jev/refusal/ipv6/model-policy/gpt-policy/codex settings）、key-scope 四个函数（apiKey+user+group+grant+subscription+resources）、vendorRuntimeBlock、summarizeVm 的分组字段、ClusterNodesRepo.platform、ownerScopeFromRequest。快照在启动时 await 预热、在写路径（管理面）同步更新。与迁移方案 3.1“热路径必须减少往返”和阶段 1 第 4 条一致。
- 风险：中：引入缓存后要保证失效及时（管理写入后立即刷新）；Key 停用/分组变更的生效时延从 0 变为“写后同步失效”，多进程部署需失效通知。
- 测试：test/unit/key-scope*；test/unit/api-keys.test.mjs；test/unit/model-policy*；test/unit/proxy-ipv6.test.mjs；test/unit/codex-slot-pool.test.mjs；test/unit/schedule-eligibility.test.mjs；test/unit/settings-revision.test.mjs；test/unit/vendor-platform.test.mjs；新增：快照失效（写后读到新值、停用 Key 立即拒绝）
- 文件（77，上游 62）：`admin/backup-service.mjs`、`admin/catalog-monitor.mjs`、`admin/key-connection.mjs`、`admin/key-scope.mjs`、`admin/onboarding.mjs`、`admin/panel-api.mjs`、`admin/panel-routes.mjs`、`admin/pool-seat-stream.mjs`、`admin/pricing-view.mjs`、`admin/resource-scope.mjs`、`admin/routing-runtime.mjs`、`admin/site-branding.mjs`、`admin/vm-bulk-edit.mjs`、`admin/vm-test-chat.mjs`、`admin/vm-test-schedule.mjs`、`cluster/cluster-manager.mjs`、`cluster/placement.mjs`、`db/repos/cluster-nodes-repo.mjs`、`db/repos/proxies-repo.mjs`、`db/repos/settings-repo.mjs`、`db/repos/vms-repo.mjs`、`executor/settings-store.mjs`、`gateway-worker/account-management.mjs`、`gateway-worker/codex-client-profile.mjs`、`gateway-worker/gateway-execution.mjs`、`gateway-worker/request-location.mjs`、`identity/crs-headers.mjs`、`oauth/credential-refresh-monitor.mjs`、`oauth/official-cc-bootstrap.mjs`、`oauth/usage-probe-monitor.mjs`、`pool/api-protocol.mjs`、`pool/codex-account-protection.mjs`、`pool/codex-slot-pool.mjs`、`pool/openai-quota-policy.mjs`、`pool/schedule-eligibility.mjs`、`pool/slot-model-gate.mjs`、`pool/upstream-error-policy.mjs`、`protocol/anthropic-policy.mjs`、`protocol/codex-catalog.mjs`、`protocol/codex-context-budget.mjs`、`protocol/codex-convert.mjs`、`protocol/codex-model-mapping.mjs`、`protocol/codex-route.mjs`、`protocol/codex-usage.mjs`、`protocol/convert.mjs`、`protocol/gpt-model-policy.mjs`、`protocol/handle-codex.mjs`、`protocol/handle-protocol.mjs`、`protocol/key-models.mjs`、`protocol/model-policy.mjs`、`protocol/models.mjs`、`protocol/outbound-attempt.mjs`、`protocol/request-purpose.mjs`、`protocol/sanitize.mjs`、`protocol/thinking.mjs`、`protocol/user-usage.mjs`、`transport/codex-kernel-supervisor.mjs`、`transport/go-worker-client.mjs`、`transport/kernel-router.mjs`、`transport/rust-kernel-supervisor.mjs`、`vendor/vendor-runtime-policy.mjs`、`vm/codex-slot.mjs`、`vm/docker-slot-memory.mjs`、`vm/egress.mjs`、`vm/execution-context.mjs`、`vm/fleet-update.mjs`、`vm/proxy-policy.mjs`、`vm/proxy-pool.mjs`、`vm/proxy-resolve.mjs`、`vm/slot-host.mjs`、`vm/slot-runtime.mjs`、`vm/slot-shell.mjs`、`vm/vm-package.mjs`、`vm/vm-recreate.mjs`、`vm/vm-registry.mjs`、`vm/vm-runtime.mjs`、`src/server.mjs`

### B2 延后写入通道（请求日志/attempt 入队 async）

- 说明：RequestLogStore.finish 与 RequestAttemptsRepo.begin/record/complete 保持同步签名（只入队），persist 闭包改 async；begin 内的同步 list 读取要移出或改成内存。
- 风险：低：这些写入已经在 write-behind 队列里延后执行，只需把入队回调改成 async 并由 B0 的批执行器 await。
- 测试：test/unit/request-log.test.mjs；test/unit/write-behind.test.mjs；test/unit/attempt-facts.test.mjs；test/e2e/request-log.e2e.test.mjs
- 文件（6，上游 3）：`admin/request-log.mjs`、`db/repos/request-attempts-repo.mjs`、`executor/result-writer.mjs`、`gateway-worker/gateway-execution.mjs`、`protocol/handle-codex-gateway.mjs`、`protocol/handle-codex.mjs`

### B3 executor 凭据库/租约/事件收件箱

- 风险：中：刷新租约 acquire/release、vault put/rewrap 是先查后写，异步后需条件更新或 BEGIN IMMEDIATE 串行。executor 为定制代码，无上游冲突。
- 测试：test/unit/executor-*；test/unit/credential-*；test/unit/settings-revision.test.mjs
- 文件（12，上游 1）：`executor/credential-custody.mjs`、`executor/event-ingest.mjs`、`executor/refresh-lease.mjs`、`executor/repos/event-inbox-repo.mjs`、`executor/repos/finalized-attempts-repo.mjs`、`executor/repos/refresh-lease-repo.mjs`、`executor/repos/settings-repo.mjs`、`executor/repos/vault-repo.mjs`、`executor/result-writer.mjs`、`executor/settings-store.mjs`、`executor/vault.mjs`、`src/server.mjs`
- 跨批热调用边（需临时同步出口或并入 B7）：`pool/unit-circuit#UnitCircuit._save` → `executor/repos/vault-repo#vaultRepo>upsert`

### B4 vendor 供应商平台

- 风险：中：结算/价格/成员均为定制代码；createDownstreamSettlement、settlementAction、createGlobalPricing 依赖唯一索引做幂等，异步后改 INSERT … ON CONFLICT 返回已有行。VendorPlatform 方法多为同步且被 panel 路由大量调用。
- 测试：test/unit/vendor-*；test/e2e/vendor-*.e2e.test.mjs
- 文件（42，上游 9）：`admin/panel-api.mjs`、`admin/panel-routes.mjs`、`admin/panel-user-routes.mjs`、`admin/panel-vm-runtime-routes.mjs`、`admin/relay-routes.mjs`、`cluster/cluster-manager.mjs`、`db/repos/usage-logs-repo.mjs`、`gateway-worker/account-management.mjs`、`gateway-worker/gateway-execution.mjs`、`gateway-worker/gateway-repo.mjs`、`gateway-worker/gateway-routes.mjs`、`gateway-worker/receipt-reconciler.mjs`、`oauth/account-profile.mjs`、`oauth/import-commit.mjs`、`vendor/queries/usage-query-service.mjs`、`vendor/repos/account-groups-repo.mjs`、`vendor/repos/account-usage-repo.mjs`、`vendor/repos/admin-settlements-repo.mjs`、`vendor/repos/audit-repo.mjs`、`vendor/repos/gateway-bindings-repo.mjs`、`vendor/repos/members-repo.mjs`、`vendor/repos/portal-repo.mjs`、`vendor/repos/pricing-repo.mjs`、`vendor/repos/resources-repo.mjs`、`vendor/repos/runtime-accounts-repo.mjs`、`vendor/repos/runtime-policy-repo.mjs`、`vendor/repos/settlements-repo.mjs`、`vendor/repos/usage-repo.mjs`、`vendor/repos/vendors-repo.mjs`、`vendor/vendor-account-name.mjs`、`vendor/vendor-account-usage.mjs`、`vendor/vendor-admin.mjs`、`vendor/vendor-platform.mjs`、`vendor/vendor-portal-view.mjs`、`vendor/vendor-pricing.mjs`、`vendor/vendor-settlements.mjs`、`vendor/vendor-usage.mjs`、`vendor/vendor-vm-provisioner.mjs`、`vm/proxy-pool.mjs`、`vm/proxy-resolve.mjs`、`vm/slot-shell.mjs`、`src/server.mjs`
- 跨批热调用边（需临时同步出口或并入 B7）：`oauth/oauth-credentials#persistOauthToVm` → `vendor/vendor-account-name#resolveVendorAccountName`；`admin/request-log#RequestLogStore.finish>persist` → `db/repos/usage-logs-repo#UsageLogsRepo.insertSummaryIfAbsent`

### B5 gateway-worker 仓储与 receipt/投影

- 风险：中高：ingestReceipt、reconciler.settle、recordAccountFreezes 是多表读后写；receipt-reconciler 定时器调用 settle（钱包扣减）。Codex 网关派发 createDispatch/markDispatch 在推理路径上。
- 测试：test/unit/gateway-*；test/e2e/gateway-*.e2e.test.mjs；test/e2e/panel-billing-worker.e2e.test.mjs
- 文件（20，上游 2）：`admin/panel-routes.mjs`、`executor/refresh-lease.mjs`、`gateway-worker/account-ids.mjs`、`gateway-worker/account-management.mjs`、`gateway-worker/gateway-client.mjs`、`gateway-worker/gateway-execution.mjs`、`gateway-worker/gateway-repo.mjs`、`gateway-worker/gateway-routes.mjs`、`gateway-worker/quota-forecast.mjs`、`gateway-worker/receipt-reconciler.mjs`、`gateway-worker/repos/account-ids-repo.mjs`、`gateway-worker/repos/accounts-repo.mjs`、`gateway-worker/repos/event-health-repo.mjs`、`gateway-worker/repos/execution-policies-repo.mjs`、`gateway-worker/repos/oauth-sessions-repo.mjs`、`gateway-worker/repos/receipts-repo.mjs`、`gateway-worker/request-location.mjs`、`protocol/codex-live.mjs`、`protocol/cpr-peer-link.mjs`、`src/server.mjs`
- 跨批热调用边（需临时同步出口或并入 B7）：`protocol/handle-protocol#createHandleProtocol>finalizeCommercial` → `gateway-worker/gateway-repo#GatewayWorkerRepo.enqueueReconciliation`

### B6a 统计读模型（usage-logs-view/statistics/rollup）

- 风险：低：读模型，调用方已是 async 路由；部分已走读池 worker。
- 测试：test/unit/usage-logs-view.test.mjs；test/unit/statistics-repo.test.mjs；test/unit/usage-stats-*.test.mjs；test/unit/usage-cost-rollup.test.mjs；test/e2e/usage-log-*.e2e.test.mjs
- 文件（9，上游 3）：`admin/group-metrics.mjs`、`admin/relay-routes.mjs`、`admin/repos/group-metrics-repo.mjs`、`admin/usage-stats-worker.mjs`、`db/repos/statistics-repo.mjs`、`db/repos/usage-cost-rollup.mjs`、`db/repos/usage-logs-repo.mjs`、`db/repos/usage-logs-view.mjs`、`db/repos/usage-stats-rollup.mjs`

### B6b 管理面：用户/分组/设置写/Key 与端点管理/备份/中继运营

- 风险：中：上游 groups/users/settings 仓储调用面最广（panel-routes、relay-routes、panel-users）；PanelUserStore/ApiKeyStore 构造函数里同步读库需改为工厂 async init。
- 测试：test/unit/panel-*；test/unit/relay-*；test/unit/users-scope.test.mjs；test/unit/api-endpoints.test.mjs；test/unit/backup-service.test.mjs；test/e2e/panel-*.e2e.test.mjs；test/e2e/relay-*.e2e.test.mjs
- 文件（41，上游 26）：`admin/api-endpoints.mjs`、`admin/api-keys.mjs`、`admin/backup-core.mjs`、`admin/backup-service.mjs`、`admin/catalog-monitor.mjs`、`admin/onboarding.mjs`、`admin/ops/backup-command.mjs`、`admin/ops/backup-query.mjs`、`admin/panel-api-endpoint-routes.mjs`、`admin/panel-api-key-routes.mjs`、`admin/panel-profile.mjs`、`admin/panel-routes.mjs`、`admin/panel-tenant.mjs`、`admin/panel-users.mjs`、`admin/relay-billing.mjs`、`admin/relay-common.mjs`、`admin/relay-migration.mjs`、`admin/relay-routes.mjs`、`admin/repos/panel-users-repo.mjs`、`admin/repos/relay-repo.mjs`、`admin/route-audit.mjs`、`admin/routing-runtime.mjs`、`admin/site-branding.mjs`、`admin/vm-bulk-edit.mjs`、`admin/vm-group-validation.mjs`、`admin/vm-test-schedule.mjs`、`core/refusal-guard.mjs`、`db/repos/api-endpoints-repo.mjs`、`db/repos/backup-repo.mjs`、`db/repos/groups-repo.mjs`、`db/repos/jev-usage-repo.mjs`、`db/repos/proxies-repo.mjs`、`db/repos/refusal-device-blocks-repo.mjs`、`db/repos/refusal-guards-repo.mjs`、`db/repos/settings-repo.mjs`、`db/repos/users-repo.mjs`、`db/repos/vms-repo.mjs`、`protocol/jev-intercept.mjs`、`protocol/model-policy.mjs`、`vm/vm-db-sync.mjs`、`src/server.mjs`
- 跨批热调用边（需临时同步出口或并入 B7）：`admin/api-endpoints#ApiEndpointStore.listRaw` → `db/repos/api-endpoints-repo#ApiEndpointsRepo.listHydrated`；`admin/api-endpoints#ApiEndpointStore.setKeyCooldown` → `db/repos/api-endpoints-repo#ApiEndpointsRepo.setKeyCooldown`；`admin/api-keys#ApiKeyStore._rpmPolicies` → `db/repos/groups-repo#GroupsRepo.getById`；`admin/api-keys#ApiKeyStore._rpmPolicies` → `db/repos/groups-repo#GroupsRepo.override`；`admin/relay-billing#RelayBilling.authorize` → `db/repos/groups-repo#GroupsRepo.access`；`protocol/handle-protocol#createHandleProtocol>banRefusalDevice` → `db/repos/refusal-device-blocks-repo#RefusalDeviceBlocksRepo.block`；`protocol/intercept-gate#commitProtocolBlock` → `db/repos/refusal-device-blocks-repo#RefusalDeviceBlocksRepo.block`；`protocol/intercept-gate#commitProtocolBlock` → `db/repos/refusal-device-blocks-repo#RefusalDeviceBlocksRepo.hit`；`protocol/handle-protocol#createHandleProtocol>rememberRefusal` → `db/repos/refusal-guards-repo#RefusalGuardsRepo.remember`；`protocol/intercept-gate#commitProtocolBlock` → `db/repos/refusal-guards-repo#RefusalGuardsRepo.remember`；`protocol/intercept-gate#commitProtocolBlock` → `db/repos/refusal-guards-repo#RefusalGuardsRepo.hit`；`core/refusal-guard#matchStoredRefusal` → `db/repos/refusal-guards-repo#RefusalGuardsRepo.nearest`；`protocol/gpt-model-policy#persist` → `db/repos/settings-repo#SettingsRepo.set`；`protocol/model-policy#persistOpus55Model` → `db/repos/settings-repo#SettingsRepo.set`；`protocol/model-policy#persistHaiku55Model` → `db/repos/settings-repo#SettingsRepo.set`；`admin/api-keys#ApiKeyStore._ownerActive` → `db/repos/users-repo#UsersRepo.getById`；`admin/api-keys#ApiKeyStore._rpmPolicies` → `db/repos/users-repo#UsersRepo.getById`；`admin/api-keys#ApiKeyStore._userConcurrencyCap` → `db/repos/users-repo#UsersRepo.getById`；`admin/relay-billing#RelayBilling.wallet` → `db/repos/users-repo#UsersRepo.getById`；`admin/relay-billing#RelayBilling.authorize` → `db/repos/users-repo#UsersRepo.getById`；`protocol/handle-protocol#createHandleProtocol>installCommercialLog>req.commitRelayLog.commitRelayLog>arg:commit:0@331` → `db/repos/groups-repo#GroupsRepo.rateMultiplier`；`vm/proxy-pool#ProxyPool.save` → `db/repos/proxies-repo#ProxiesRepo.setConfig`；`src/server#requireAuth` → `admin/panel-users#PanelUserStore.getByUsername`

### B6c VM/代理池/集群节点

- 风险：中：ProxyPool 构造函数同步加载、_socksProbe 的 socket 监听器里同步 save；vm-db-sync 的 setVmWriteHook 同步钩子；集群节点 _stmt 工厂。上游文件占比高。
- 测试：test/unit/proxy-*；test/unit/cluster-*；test/unit/vm-db-sync.test.mjs；test/unit/vm-bulk-edit.test.mjs
- 文件（9，上游 7）：`admin/panel-routes.mjs`、`admin/repos/vm-bulk-edit-repo.mjs`、`admin/vm-bulk-edit.mjs`、`cluster/cluster-manager.mjs`、`db/repos/cluster-nodes-repo.mjs`、`db/repos/proxies-repo.mjs`、`db/repos/vms-repo.mjs`、`vm/native-telemetry.mjs`、`vm/proxy-pool.mjs`
- 跨批热调用边（需临时同步出口或并入 B7）：`vm/proxy-pool#ProxyPool.save` → `db/repos/proxies-repo#ProxiesRepo.replaceAll`

### B7 推理热路径：账号/运行态/粘性/Key/计费/attempt/usage 写

- 风险：高：推理热路径与计费。PoolScheduler.reserve/ApiKeyStore.acquire/AccountQuota.tryAcquire 依赖“检查 inflight → 自增”在同一同步段；res.on(finish) 同步监听器里跑结算事务；Array.sort/filter/map 回调里有读库。必须先完成 B1 快照，再按竞态清单改写。
- 测试：test/unit/pool-scheduler.test.mjs；test/unit/pool-reservation-release-race.test.mjs；test/unit/seat-planner.test.mjs；test/unit/sticky-router.test.mjs；test/unit/account-quota.test.mjs；test/unit/unit-circuit.test.mjs；test/unit/rate-limit-service.test.mjs；test/unit/relay-operations.test.mjs；test/unit/tenant-billing.test.mjs；test/unit/admin-wallets.test.mjs；test/e2e/concurrency.e2e.test.mjs；test/e2e/review-billing.e2e.test.mjs；test/e2e/account-pool-failover.e2e.test.mjs；新增：同 Key 并发准入不超并发上限、同账号并发 reserve 不超 maxConcurrency、同一 request_id 并发 settle 只扣一次、并发 adjust/transfer 余额不为负
- 文件（47，上游 36）：`admin/anthropic-console.mjs`、`admin/api-endpoints.mjs`、`admin/api-keys.mjs`、`admin/panel-api.mjs`、`admin/panel-routes.mjs`、`admin/pricing-view.mjs`、`admin/relay-billing.mjs`、`admin/repos/relay-billing-repo.mjs`、`admin/request-log.mjs`、`admin/routing-runtime.mjs`、`admin/vm-bulk-edit.mjs`、`core/refusal-guard.mjs`、`db/repos/account-runtime-repo.mjs`、`db/repos/accounts-repo.mjs`、`db/repos/api-keys-repo.mjs`、`db/repos/codex-response-owners-repo.mjs`、`db/repos/request-attempts-repo.mjs`、`db/repos/sticky-repo.mjs`、`db/repos/usage-logs-repo.mjs`、`gateway-worker/gateway-execution.mjs`、`gateway-worker/receipt-reconciler.mjs`、`oauth/import-commit.mjs`、`oauth/oauth-credentials.mjs`、`pool/account-quota.mjs`、`pool/codex-account-protection.mjs`、`pool/failover-runner.mjs`、`pool/pool-scheduler.mjs`、`pool/rate-limit-service.mjs`、`pool/seat-planner.mjs`、`pool/sticky-router.mjs`、`pool/thinking-owner.mjs`、`pool/unit-circuit.mjs`、`protocol/gpt-model-policy.mjs`、`protocol/handle-codex-gateway.mjs`、`protocol/handle-codex.mjs`、`protocol/handle-protocol.mjs`、`protocol/intercept-gate.mjs`、`protocol/model-policy.mjs`、`protocol/responses-ws.mjs`、`usage/quota-observations.mjs`、`usage/repos/quota-observations-repo.mjs`、`usage/vm-quota-forecast.mjs`、`vm/codex-slot.mjs`、`vm/proxy-pool.mjs`、`vm/vm-package.mjs`、`vm/vm-registry.mjs`、`src/server.mjs`

B7 内部可再分三步但需同批上线（共享 sticky/runtime 仓储）：B7a 准入与计费（api-keys、relay-billing、handle-protocol 商业日志、requireAuth、responses-ws）；B7b Claude 调度（pool-scheduler、seat-planner、sticky-router、account-quota、unit-circuit、rate-limit-service、failover-runner、thinking-owner 及 accounts/account-runtime/sticky/request-attempts/usage-logs 仓储）；B7c Codex（handle-codex*、codex-account-protection、codex-response-owners、quota-observations、vm-registry.persistCodexUsage）。

## 7. 已是 async 的落点（需补 await）

| 文件 | 上游 | async 函数数 | 调用染色函数次数 |
| --- | --- | --: | --: |
| admin/panel-routes.mjs | 是 | 15 | 405 |
| src/server.mjs | 是 | 5 | 64 |
| protocol/handle-protocol.mjs | 是 | 11 | 63 |
| gateway-worker/account-management.mjs |  | 16 | 57 |
| admin/relay-routes.mjs |  | 1 | 53 |
| admin/panel-api.mjs | 是 | 8 | 51 |
| pool/failover-runner.mjs | 是 | 1 | 49 |
| gateway-worker/gateway-routes.mjs |  | 3 | 48 |
| pool/pool-scheduler.mjs | 是 | 8 | 46 |
| gateway-worker/gateway-execution.mjs |  | 15 | 42 |
| admin/panel-api-key-routes.mjs |  | 1 | 39 |
| cluster/cluster-manager.mjs | 是 | 13 | 35 |
| protocol/handle-codex.mjs | 是 | 7 | 35 |
| gateway-worker/gateway-client.mjs |  | 23 | 31 |
| admin/panel-api-endpoint-routes.mjs |  | 1 | 29 |
| gateway-worker/receipt-reconciler.mjs |  | 3 | 27 |
| vm/proxy-pool.mjs | 是 | 8 | 27 |
| admin/panel-vm-provision-routes.mjs |  | 1 | 17 |
| admin/panel-user-routes.mjs |  | 1 | 15 |
| vm/slot-shell.mjs | 是 | 4 | 15 |
| admin/vm-test-chat.mjs | 是 | 4 | 14 |
| executor/event-ingest.mjs |  | 2 | 14 |
| admin/routing-runtime.mjs | 是 | 2 | 13 |
| protocol/user-usage.mjs |  | 3 | 13 |
| vm/vm-package.mjs | 是 | 2 | 13 |
| protocol/handle-codex-gateway.mjs |  | 1 | 12 |
| admin/backup-service.mjs | 是 | 3 | 11 |
| admin/panel-vm-maintenance-routes.mjs |  | 1 | 11 |
| admin/panel-vm-reset-routes.mjs |  | 1 | 11 |
| vm/fleet-update.mjs | 是 | 3 | 11 |
| cluster/cluster-routes.mjs | 是 | 1 | 10 |
| admin/panel-vm-oauth-mutation-routes.mjs |  | 1 | 9 |
| vm/slot-runtime.mjs | 是 | 7 | 9 |
| admin/catalog-monitor.mjs | 是 | 2 | 8 |
| cluster/remote-slot.mjs | 是 | 5 | 8 |
| vm/slot-recovery.mjs | 是 | 5 | 8 |
| admin/panel-vm-package-routes.mjs |  | 1 | 7 |
| admin/panel-vm-read-routes.mjs |  | 1 | 7 |
| oauth/import-commit.mjs | 是 | 1 | 7 |
| vm/proxy-policy-runtime.mjs | 是 | 1 | 7 |

（完整列表见 JSON `await_sites`，含未 await 的行号。）

