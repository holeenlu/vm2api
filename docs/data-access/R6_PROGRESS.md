# R6 全量异步化 · 进度台账

已交付状态的唯一权威。计划见 [R6_PLAN.md](R6_PLAN.md)。

| 批次 | 状态 | 交付提交 | 审查 | 备注 |
| --- | --- | --- | --- | --- |
| B0 | done | 见发布说明“R6 B0” | 待 B1 一并审查 | `DbClient` + SQLite 适配器；单次查询额外开销约 106 ns |
| B1 | done | settings 快照（见发布说明“R6 B1（一）”） | 待 B3 一并审查 | 只做 settings。key-scope、`vendorRuntimeBlock`、`summarizeVm` 分组字段是权限与归属数据，写入方多（上游仓储与定制原生 SQL），`node:sqlite` 没有写入钩子，零查询快照无法保证及时失效，改为在各自批次（B7、B4、B6c）直接改 async；集群节点平台不在推理热路径上，随 B6c |
| B2 | merged | — | — | 并入 B7/B8：写回队列的闭包改 async 后，同步的 `closeDatabase()` / `flushWrites()` 无法等它们完成，须与 B8 把 `closeDatabase` 改 async 同批；在此之前闭包保持同步（本就延后批量执行，不阻塞请求） |
| B3 | done | 见发布说明“R6 B3” | 主会话审查（补 DbClient 排队） | executor 异步化；R15–R17 由事务原子性保证 |
| B4 | todo | — | — | vendor（下一批） |
| B5 | todo | — | — | gateway-worker |
| B6a | todo | — | — | 统计读模型 |
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
