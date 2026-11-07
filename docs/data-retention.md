# 数据保留清单

更新：2026-11-07（审计阶段 1 W5）。范围：`kin.db` 里持续追加的表。新增追加型表时在这里登记保留期与清理位置；
清理代码只删除超期行，不改写或删除已应用的历史迁移，生产上的存量数据处置另行授权。

## 清理方式

- **周期**：使用记录、调试明细、请求尝试、Gateway Worker 历史都挂在同一个 10 分钟周期上
  （`src/lib/admin/request-log.mjs` `RequestLogStore.cleanup`，启动时也跑一次）；上一轮没跑完时本轮复用它，不叠加。
- **分批**：`src/lib/db/batch-delete.mjs`，每批最多 500 行，批间 `setImmediate` 让出事件循环。有时间索引的表按
  `WHERE 时间 < ? LIMIT n` 取最旧的行；没有时间索引的表按 rowid 取表头 n 行再按时间过滤（行按写入顺序追加，
  表头就是最旧的行，不做全表扫描）。
- **检查点**：使用记录清理后做 `PRAGMA wal_checkpoint(PASSIVE)`，不等读者、不阻塞写入；不在主线程上 `TRUNCATE`。
- **小时汇总**：保留期清理不扣减 `usage_cost_hourly` / `usage_stats_hourly`（迁移 132 的 `usage_prune_marker`），
  统计页、账号 5h/7d 窗口与成本报表保留超出明细保留期的历史；人工删除、恢复等其他删除仍按原逻辑扣减。
  `scripts/audit-money-micros.mjs` 与每日计费对账（`src/lib/admin/billing-reconcile.mjs`）的“汇总 = 明细合计”与三方核对只比较
  清理边界（`settings.usage_logs_pruned_through`）之后的小时。

## 保留期

| 表 | 保留 | 依据列 | 清理位置 |
| --- | --- | --- | --- |
| `usage_logs` | 路由配置 `logging.retain_days`，默认 7 天（1–90） | `created_at` | `usage-logs-repo.mjs` `_pruneUsage`；小时汇总不随之扣减 |
| `request_log_debug` | `logging.debug_retain_days`，默认 3 天且不超过上一行；另有总大小上限 `logging.max_mb`（默认 2048） | `ts` | `usage-logs-repo.mjs` `cleanup`、`trimDebugToMaxBytes` |
| `request_attempts` | 同 `usage_logs` 的保留天数 | `started_at` | `request-attempts-repo.mjs` `cleanup`（原来只在启动时跑，现随 10 分钟周期） |
| `gateway_worker_receipts` | 30 天 | `created_at` | `gateway-worker/repos/retention-repo.mjs` |
| `gateway_worker_dispatches` | 30 天 | `created_at` | 同上；派发行删除后，迟到 30 天以上的回执不再改写使用记录 |
| `gateway_worker_reconciliation_jobs` | 终态（`settled`、`unmetered`、`dead_letter`）30 天；`pending`、`running` 不删 | `updated_at` | 同上 |
| `gateway_worker_dead_letters` | 30 天（目前没有读取方，只作排障留痕） | `created_at` | 同上 |
| `gateway_worker_oauth_sessions` | 过期 7 天后删除（过期即清空 PKCE 会话数据，见 `clearExpiredOAuthSessions`） | `expires_at` | 同上，走迁移 130 的 `(status, expires_at)` 索引 |
| `executor_event_inbox` | 7 天 | `received_at` | `executor/event-ingest.mjs` |
| `quota_observations` | 9 天 | `observed_at` | `usage/quota-observations.mjs` |
| `jev_usage_events` | 30 天（`jev_usage_totals` 按周期另行收缩） | `created_at` | `jev-usage-repo.mjs` |
| `thinking_signature_owners` | 30 天 | `created_at` | `pool/thinking-owner.mjs` |
| `codex_response_owners` | 到期即删 | `expires_at` | `codex-response-owners-repo.mjs` |
| `vendor_settlement_previews` | 到期且未生成结算单即删 | `expires_at` | `vendor/repos/settlements-repo.mjs` |
| `billing_inflight`（迁移 131，计费工作包） | 收口即删；进程中断留下的孤儿行由计费扫描处理 | — | 计费在途表的收口与扫描（`admin/billing-inflight.mjs`） |

## 本轮不删的账务与审计记录

以下表是账务凭据或审计留痕，删除会让余额、结算、供应商对账或追责失去依据，本轮不设保留期：

| 表 | 内容 | 不删的原因 |
| --- | --- | --- |
| `billing_charges` | 每次请求的计费结果 | 钱包余额 = 流水 − 扣费，结算与退款按它追溯 |
| `wallet_ledger` | 钱包流水 | 余额的来源，删除后无法重算余额 |
| `operation_audit` | 管理操作审计 | 追责与合规留痕 |
| `vendor_audit_events` | 供应商侧审计事件 | 供应商争议与结算复核 |
| `config_revisions` | 配置修订历史 | 回溯某次请求当时生效的配置 |
| `vendor_usage_facts` | 供应商用量事实 | 供应商结算单的计算依据 |

这些表会一直增长。按月看一次体积，任一张表超过数据库的 20% 或单表超过 1 GB 时，再评估归档（导出到库外后按时间删除）
而不是直接删除：

```bash
sqlite3 data/kin.db "SELECT name, ROUND(SUM(pgsize) / 1048576.0, 1) AS mb FROM dbstat GROUP BY name ORDER BY mb DESC LIMIT 20"
```

（`dbstat` 需要 sqlite3 命令行带 `SQLITE_ENABLE_DBSTAT_VTAB`；没有时用 `SELECT COUNT(*)` 估算。）

## 已知限制

- 删除只把页面还给 SQLite 的空闲列表，数据库文件不会变小；需要回收磁盘时停写后手工 `VACUUM`（单独授权，生产库不自动执行）。
- 对账任务表头若长期积压 500 个以上的非终态任务，按表头取批的清理会停在那里，直到这些任务进入终态。
