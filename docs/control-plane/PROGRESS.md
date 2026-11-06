# 统一控制面与执行服务重构 · 进度台账

本文件是已交付状态的唯一权威，每次交付同步更新。计划与续接流程见 [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md)。

状态：`todo` / `doing` / `done` / `review` / `blocked` / `deferred` / `skipped`。“上游改动”列为 `scripts/upstream-touch-budget.mjs` 的输出摘要。

## 当前

- 阶段：P0–P6 与 PF 全部关闭（P7 不做）；重构代码交付完成
- 下一个任务：无（重构与生产切换均已完成）
- 生产切换：用户 2026-11-05 授权，2026-11-05 20:05–21:28 UTC（北京时间 11-06 04:05–05:28）执行完毕，见下方 P1.10、P3.10 与 P5 部署记录
- 用户决定：2026-11-05 认可 P2.4 skipped 及 P2 目标调整；2026-11-05 认可 P4 上游预算例外；2026-11-05 确认引入 Redis（P5 开工）；2026-11-05 认可 P5 上游预算例外（`worker/go.mod`、`go.sum`）
- 后续工作：Gateway 事实直读（G0–G5，用户 2026-11-06 决定），见下方“Gateway 事实直读”与设计第 19 节

## 阶段

| 阶段 | 状态 | 审查 |
| --- | --- | --- |
| P0 计划、台账与工具 | done | 不设审查门（只含计划与工具） |
| P1 执行契约与事件发件箱 | done | R1：P0×1、P1×5、P2×10，已修复（P2-2 暂缓，P2-10 转 P3.11）；第一轮复审 N1–N5 已修复；第二轮复审通过（P2×2 已修复），见 [reviews/P1.md](reviews/P1.md) |
| P2 统一结果与请求账本 | done | R2：P1×2、P2×8，已修复（P2-1 接受并写入限制）；第一轮复审 N1（P1）、N2–N5 已修复，回放比对零差异已实测；第二轮复审 N6（P1）、N7、N8 已修复；第三轮复核通过（N9 已修复，N10 接受）。审查已通过；用户 2026-11-05 认可 P2.4 skipped，阶段关闭，见 [reviews/P2.md](reviews/P2.md) |
| P3 刷新租约与凭据归属 | done | R3：P1×6、P2×8 已修复（P2-5 接受）；第一轮复审 N1–N8 已修复；第二轮复审通过（M1–M4 P2 已修复），见 [reviews/P3.md](reviews/P3.md)（P3.10 已于 2026-11-05 在生产执行） |
| P4 本地设置与模型目录发布 | done | R4：P0×1、P1×5、P2×11 已修复；复核通过（新问题 6 项 P2 已处理），P2-10 预算例外用户 2026-11-05 已认可，见 [reviews/P4.md](reviews/P4.md) |
| P5 共享运行态（Redis） | done | R5：P1×5、P2×10 已修复（R5-14 后半接受）；复核通过（N1–N3 P2 已处理）；R5-4 预算例外用户 2026-11-05 已认可，见 [reviews/P5.md](reviews/P5.md) |
| P6 界面按设置描述渲染 | done | R6 与 R4 合并审查，复核通过，见 [reviews/P4.md](reviews/P4.md) |
| P7 Claude 物理拆分 | skipped（默认不做） | — |
| PF 整体验收 | done | PF.2 终审 A、B 复核均通过，见 [reviews/PF.md](reviews/PF.md)；验收记录 [ACCEPTANCE.md](ACCEPTANCE.md) |

## 任务

| 任务 | 状态 | 交付 | 上游改动 | 说明 |
| --- | --- | --- | --- | --- |
| P0.1 | done | 见发布说明 2026-11-05 | 0 | 设计 15.1、D8、16 节 |
| P0.2 | done | 同上 | 0 | 计划、台账、journal、记忆、持久检出 `~/Git/vm2api-cp` |
| P0.3 | done | 同上 | 0 | `scripts/upstream-touch-budget.mjs` |
| P1.1 | done | 2026-11-05 P1 交付 | database.test.mjs +2 | 契约类型 Go/JS + 共享夹具 |
| P1.2 | done | 2026-11-05 P1 交付 | database.test.mjs +2 | Worker 分段事件日志 |
| P1.3 | done | 2026-11-05 P1 交付 | database.test.mjs +2 | events / events/ack 接口、心跳与健康水位 |
| P1.4 | done | 2026-11-05 P1 交付 | database.test.mjs +2 | request.finalized、account.state、account.quota、probe.recorded |
| P1.5 | done | 2026-11-05 P1 交付 | database.test.mjs +2 | 迁移 100 |
| P1.6 | done | 2026-11-05 P1 交付 | database.test.mjs +2 | event-ingest.mjs |
| P1.7 | done | 2026-11-05 P1 交付 | database.test.mjs +2 | shadow 比对 |
| P1.8 | done | 2026-11-05 P1 交付 | database.test.mjs +2 | primary 生效，心跳同类字段停写 |
| P1.9 | done | 2026-11-05 P1 交付 | database.test.mjs +2 | scripts/executor-replay-diff.mjs；e2e 三模式 |
| P1.10 | done | 生产 | 0 | 2026-11-05 20:05 UTC `KIN_EXECUTOR_EVENTS=shadow`（与 P5 Redis 同一次重建）；shadow 45 分钟后比对：shadow 期间 115 个事件全部匹配、`differing 0`、`inbox problems 0`（1 小时窗口另有 6 条回执 `event_missing`，均为 shadow 开启前 20:04:34–20:05:02 结束、重启后补收的请求，属切换边界）；20:53 切 `primary` 并开 `KIN_REFRESH_LEASE=on`，10 分钟后复查 114/114 匹配、0 差异 |
| P2.1 | done | 2026-11-05 R1 修复交付 | request-attempts-repo.mjs、usage-logs-view.mjs | result-writer.mjs |
| P2.2 | done | 2026-11-05 R1 修复交付 | request-attempts-repo.mjs、usage-logs-view.mjs | 迁移 101；repo、日志视图、实时写入取 route/stage/凭据代次 |
| P2.3 | done | 2026-11-05 R1 修复交付 | request-attempts-repo.mjs、usage-logs-view.mjs | primary 下 request.finalized 入库 60 秒后补齐尝试 |
| P2.4 | skipped | | | Claude 已与 Codex 共用上游写入函数，见计划 P2；用户 2026-11-05 认可 |
| P2.5 | done | 2026-11-05 R1 修复交付 | provider-chain-popover.tsx、panel-usage-logs.ts | 尝试链显示 BPS 通道与阶段 |
| P3.1 | done | 2026-11-05 R1 第二轮修复同批交付 | server.mjs 1 行 | 迁移 102、refresh-lease.mjs、内部接口、策略开关（默认关） |
| P3.2 | done | 2026-11-05 P3.2 交付 | request-attempts-repo.mjs 2 行（R2 复审修复） | refresh_lease.go；迁移 104（R2 复审 N1）、105；e2e 手动刷新经租约 |
| P3.3 | done | 2026-11-05 P3.3 交付 | log-display.ts +9、log-display.test.ts +7（R2 第二轮 N7） | 心跳策略 `refresh_lease.designated`；Worker 定时刷新只处理指派账号 |
| P3.4 | done | 2026-11-05 P3.4–P3.11 交付 | 0 | vault.mjs、迁移 106、主密钥轮换脚本 |
| P3.5 | done | 2026-11-05 P3.4–P3.11 交付 | 0 | Worker custody.go、迁移 107、JS custody.mjs、共享夹具 |
| P3.6 | done | 2026-11-05 P3.4–P3.11 交付 | 0 | release 附凭据包，CAS 写入凭据库；投影从凭据库封装 |
| P3.7 | done | 2026-11-05 P3.4–P3.11 交付 | 0 | 控制面生成授权会话（迁移 108），Worker 不落盘 |
| P3.8 | done | 2026-11-05 P3.4–P3.11 交付 | 0 | scripts/migrate-worker-credentials.mjs |
| P3.9 | done | 2026-11-05 P3.4–P3.11 交付 | 0 | 导出读凭据库或凭据包；删除明文凭据接口 |
| P3.10 | done | 生产 | 0 | 2026-11-05 21:07 UTC 数据库快照；演练两次零错误；21:27 `migrate-worker-credentials --apply` 收录原生 22、BPS 21（跳过 1）；主密钥另存（与数据库分开，已核对一致）；21:28 `KIN_CREDENTIAL_CUSTODY=control`：账号投影 22 synced / 1 archived、无 drifted，无 `vault copy cannot be read`，真实 Codex 请求 200；10 分钟后比对 52/52 匹配、0 差异 |
| P3.11 | done | 2026-11-05 P3.4–P3.11 交付 | 0 | 事件页响应签名（R1 P2-10） |
| P4.1 | done | 2026-11-05 R3 修复与 P4、P6 交付 | 上游净减 | 附录 A |
| P4.2 | done | 2026-11-05 R3 修复与 P4、P6 交付 | 上游净减 | settings-store.mjs、codex-settings.mjs、迁移 109；codex-route 恢复上游 |
| P4.3 | done | 2026-11-05 R3 修复与 P4、P6 交付 | 上游净减 | 心跳与信封 settings_revision；迁移 111、112（R4 P1-2 改名） |
| P4.4 | done | 2026-11-05 R3 修复与 P4、P6 交付 | 上游净减 | settings-schema.mjs、src/shared/executor-schema、Worker schema.go |
| P4.5 | done | 2026-11-05 R3 修复与 P4、P6 交付 | 上游净减 | /v1/models 只读缓存；BPS 目录 30 分钟检查 |
| P5.1 | done | 见 journal | 0 | shared_state.go；KIN_REDIS_URL / KIN_REDIS_PREFIX；探活与降级；加密 |
| P5.2 | done | 见 journal | 0 | shared_concurrency.go；续期丢失补登记、不取消（计划修订） |
| P5.3 | done | 见 journal | 0 | shared_holds.go；迁移 113 与「Gateway Worker」页展示 |
| P5.4 | done | 见 journal | 0 | shared_bps_state.go；route_provenance.go |
| P5.5 | done | 见 journal | 0 | gateway-worker-redis.e2e（Redis 停止与恢复演练）；测试辅助 miniredis-server |
| P5.6 | done | 生产 | 0 | 2026-11-05 20:05 UTC 生产部署 Redis（`redis:7-alpine`，仅监听 127.0.0.1，密码只在 `.env`，不持久化）；Worker 共享运行态 `backend=redis`、`healthy`、`encrypted`，租约续期无丢失 |
| P6.1 | done | 2026-11-05 R3 修复与 P4、P6 交付 | 上游净减 | web schema-form |
| P6.2 | done | 2026-11-05 R3 修复与 P4、P6 交付 | 上游净减 | 设置页与账号 BPS 设置按描述渲染；删除手写组件 |
| P6.3 | done | 2026-11-05 R3 修复与 P4、P6 交付 | 上游净减 | 能力描述 authorizations；向导 BPS 步骤 |
| P7 | skipped | | | |
| PF.1 | done | | | ACCEPTANCE.md 定稿 |
| PF.2 | done | | | 审查 A、B 复核均通过，见 reviews/PF.md |
| PF.3 | done | | | 设计状态行、运维第 8–13 节、审查报告与验收记录已更新 |

## Gateway 事实直读（G0–G5）

用户 2026-11-06 决定：Gateway Worker 去掉控制面的逐实例账号投影，改为同机只读直读控制面 SQLite（`kin.db`），只支持同机部署，放弃跨主机多 Worker；写回（刷新租约 CAS、事件、回执）仍走控制面接口；分组由 Worker 读 `group_resources`。设计见 [设计第 19 节](../ARCHITECTURE_CONTROL_PLANE_EXECUTORS_20261105.md#19-gateway-事实直读2026-11-06-决定)。完成后回到分组与资源管理重整（统一关系服务、分组页三页签、遗留清理）。

| 任务 | 状态 | 交付 | 上游改动 | 说明 |
| --- | --- | --- | --- | --- |
| G0 设计与台账 | done | 与 G1 同次交付 | 0 | 设计第 19 节、本节 |
| G1 凭据写回收敛 | done | 见交付记录 | 0 | 凭据固定由控制面托管（删除 `KIN_CREDENTIAL_CUSTODY` 与 worker 模式）；刷新租约恒开（删除 `KIN_REFRESH_LEASE`）；rotated 在释放租约的同一事务里按代次 CAS 写凭据库，被重新授权取代时回复 409 `credential_superseded`，写不进去时租约不释放、回复 503。原计划放在 G1 的契约迁移与 preflight 移到 G2（有读者时再加） |
| G2 契约迁移 + Go 只读读取器（影子） | done | 见交付记录 | `worker/go.mod` +10、`go.sum` +47（`modernc.org/sqlite` v1.40.1，纯 Go，计划阶段已说明并经用户批准计划）、`database.test.mjs` +2 | 迁移 124（契约版本、事实序列与按账号版本、触发器、`runtime_account_id` 回填、实例 `facts_json`、视图 `gateway_account_facts_v1`/`gateway_account_groups_v1`）；`scripts/gateway-facts-preflight.mjs`；Worker 导出带安装身份、控制面收录为 `config.installation_id`；Go `facts_crypto.go`、`facts_db.go`、`facts_shadow.go` 只读读取与影子比对，健康与心跳上报，Gateway Worker 页展示；跨语言夹具 `test/fixtures/executor-contract/facts.json`。生产影子运行与 preflight `--apply` 待授权 |
| G3 以库为准 | done（代码） | 见交付记录 | 0 | `KIN_CODEX_GATEWAY_FACTS=primary`：Worker 把直读的事实合并进账号表（`facts_apply.go`：配置与分组以库为准、凭据只前进不后退、运行态保留、库里没有的停止接单、墓碑删除）；能力描述报告 `facts`；控制面对 primary 实例不再推送投影、只收录凭据（`facts-mode.mjs`），绑定同步状态按心跳读取进度标记（`markFactsSynced`）。原计划的 Store 拆分、凭据待确认日志与无状态 OAuth 不做：`accounts.json` 已是同步落盘的本地缓存，承担待确认作用；授权与导入仍经 Worker 再收录进凭据库。生产切换待影子观察期满（2026-11-08 12:51 UTC 起）并另行授权 |
| G4a 删除投影与托管封装 | done | 见交付记录 | `panel-routes.mjs` +2 −5、`usage-logs-view.mjs` +1 −1（已有定制段落内） | Worker：删除 `accounts/project`、PATCH/DELETE、导入、投影状态接口，`custody.go`（X25519 托管密钥与封装）、`facts_shadow.go`；`KIN_CODEX_GATEWAY_FACTS` 只接受 primary/off，默认 primary。控制面：删除 `projectAccountToAll`/`projectFromVault`/`projectAllAccountsTo` 等投影推送、心跳对账与 `exclude_accounts`、`account-removal.mjs`（逐实例删除与 pending_delete）、`facts-mode.mjs`、托管公钥登记与确认路由、`custody.mjs` 的按实例封装、`credential-custody.mjs` 的 `projectionFields`/`vaultImport`；授权、导入与刷新后改为 `captureFromWorker` 只收录凭据；配置修改不再调用 Worker。前端：删除托管公钥确认卡片与影子比对展示，“事实直读”改为已加载/读取出错；删除恒为 false 的 `projection_pending` 提示。测试：删除多 Worker e2e（G4b 删除该路径），假 Worker 改为签名心跳上报读取进度 |
| G4b 删除多 Worker 与跨主机路径 | done | 见交付记录 | 见交付记录 | Worker：删除 `tls.go`（mTLS 服务端与回连 TLS）、`RequireMTLS`/`TLS_*` 配置、实例间冻结 `PeerFreeze`、预刷新指派、`ExcludeAccounts`、`ProjectionRevision`/`ConfigFingerprint`/心跳 `account_revisions`、账号 pause/resume 动作；只接受环回（或 `ALLOW_INSECURE`）明文。控制面：删除 `gateway-mtls.mjs`、客户端 HTTPS/mTLS、内部 TLS 监听、`KIN_CODEX_GATEWAY_MULTI_WORKER`（单 Worker 冲突恒开）、心跳策略里的 `account_freezes` 与 `designated`、`peerAccountFreezes`/`listAllAccountBindings`/`designatedRefreshAccounts`、绑定与回执的投影版本写入（`recordProjection` 改为 `recordAccountBinding`）；供应商暂停/恢复改走账号更新；`MULTI_WORKER`/`REQUIRE_MTLS` 仍配置时启动告警。保留：实例密钥与待批准、单 Worker 冲突与 45 秒接替、Redis 共享运行态、冻结上报（供应商门户显示）、执行时的实例改派循环（接替窗口用）。`scripts/gateway-mtls-certs.sh`、`gateway-mtls.test.mjs`、`peer_freeze_test.go` 删除，Redis e2e 改为单 Worker |
| G5 收缩（破坏性，单独发版） | todo | | | 删死表、绑定表改为每账号运行态 |

## 交付记录

| 时间 | 任务 | 远端前 R | 交付 NEW | 说明 |
| --- | --- | --- | --- | --- |
| 2026-11-05 01:32 | P0 | `efa16635` | `adb06dbf` | 计划、台账、预算工具 |
| 2026-11-05 01:54 | P1.1–P1.9 | `adb06dbf` | `58808174` | 事件发件箱 |
| 2026-11-05 02:22 | R1 修复、P2.1–P2.3、P2.5 | `58808174` | `c6656b5a` | |
| 2026-11-05 | R1 第二轮修复、R2 修复、P3.1 | `c6656b5a` | `8743b356` | |
| 2026-11-05 | P1 关闭修复、R2 复审修复、P3.2 | `8743b356` | `3c71a521` | |
| 2026-11-05 | P3.3、R2 第二轮复审修复 | `3c71a521` | `73fa71e7` | |
| 2026-11-05 | P3.4–P3.9、P3.11、R2 第三轮 N9 | `73fa71e7` | `42d47488` | |
| 2026-11-05 | R3 修复、P4、P6 | `42d47488` | `f7cfd7a9` | |
| 2026-11-05 | R4/R6 修复、R3 复审修复、PF.1 草稿 | `f7cfd7a9` | `6ebf52fa` | |
| 2026-11-05 | 复审 P2（R3 M1–M4、R4 复核新问题 1–6），P3/P4/P6 关闭，PF.3 文档 | `6ebf52fa` | `f48712fd` | |
| 2026-11-05 | （其他任务）CPR 同步 `1daa0623` | `f48712fd` | `fe543b58` | 非本重构；本重构下一次交付以它为基线三方合并 |
| 2026-11-05 | P2 关闭（用户认可 P2.4）、P4 预算例外认可、PF.2 终审修复、P5 设计 | `fe543b58` | `efd3c996` | |
| 2026-11-05 | P5 共享运行态（Redis）、终审复核遗留修复 | `efd3c996` | `c8b6a8e7` | 上游触点：`worker/go.mod` +5、`go.sum` +18（Redis 依赖，P5 例外）、`database.test.mjs` +2 |
| 2026-11-05 | R5 修复、终审复核 A-N2 | `c8b6a8e7` | `934b14dd` | |
| 2026-11-05 | R5 复核遗留（N1–N3）、PF.1 验收定稿、P5/PF 关闭 | `934b14dd` | `94aaa16c` | |
| 2026-11-05 | 记录用户认可 P5 上游预算例外（仅文档） | `94aaa16c` | `6157db7b` | |
| 2026-11-05 | （其他任务）attribution 源头去除、bps_state 按条目写入等 | `6157db7b` | `2a55257f` | 非本重构 |
| 2026-11-05 | 事件收件箱写入时去掉 attribution | `2a55257f` | `fc7888b5` | 之后由其他任务的上游 1.4.041 同步带入 `f8af8a37` |
| 2026-11-05 | 最终审计第一批修复（C1、C2、C3、F2、U2、U3、U5、U9 与验收、回滚文档；修复审查 V1–V5、W1–W2） | `d54ae998` | 见 journal | 在 `6dc7019c` 上开发，与 R6 异步化三方合并；审计记录见 `reviews/AUDIT.md` |
| 2026-11-06 | 最终审计第二批 F1：没有在线来源时由凭据库重建投影 | `2b2859c5` | 见 journal | |
| 2026-11-06 | 最终审计 U1：回滚期间的设置在再次升级时三方合并 | `1d990acc` | 见 journal | |
| 2026-11-06 | 最终审计 U8：控制面运行状态可见 | `5744d873` | 见 journal | |
| 2026-11-06 | 最终审计 U10：真实 Worker e2e 进 CI | `f85dd480` | 见 journal | |
| 2026-11-06 | 最终审计 U10a：真实 Worker e2e 封闭环境 | `f901dfcd` | 见 journal | |
| 2026-11-06 | 最终审计 I1/I2：心跳时间按控制面时钟、探测失败不刷新 | `6dbb58c8` | 见 journal | |
| 2026-11-06 | 最终审计 N1：回滚合并按备份标记识别起点 | `43621362` | 见 journal | |
| 2026-11-06 | 最终审计文档类余项：F3–F7、F10（文档）、F11、F12、U6（文档）、U13 | `99b3592c` | 见 journal | 上游触点：`.env.example` +14、`docs/DEPLOY.md` +8、`docker-compose.yml` +3（均为已有定制段落内追加） |
| 2026-11-06 | 最终审计第三批（中期技术债 M1）：N1b、N4、F10（代码）、U6（代码）、U7、U8 余项、U11 | `a4f860c8` | | 审计记录见 `reviews/AUDIT.md` 第三批；新增迁移 121、`scripts/credential-master-key-doctor.mjs`；上游触点：`web/src/features/settings/backup-pane.tsx` +1 |
| 2026-11-06 | Gateway 事实直读 G0–G1：租约恒开、凭据固定由控制面托管、轮换写回事务内 CAS | `a257bf56` | `f58eafa1` | 上游触点 0 |
| 2026-11-06 | Gateway 事实直读 G2：读取契约迁移 124、preflight、Worker 只读读取器与影子比对 | `f58eafa1` | `0e7398b5` | 上游触点：`worker/go.mod` +10、`go.sum` +47、`database.test.mjs` +2 |
| 2026-11-06 | G2 生产部署 `v1.4.048.4`（用户授权）；影子比对取数修复（对外视图清空了凭据） | `0e7398b5` | `cd35b29b` | 部署前快照 `data/backups/auto/kin-20261106T120659Z.sqlite`、`.env.bak-g2-20261106T120659Z` |
| 2026-11-06 | 中期技术债 M2：执行器信任边界（按实例签发 HMAC 密钥、引导授权与待批准实例、在线轮换与吊销，mTLS 证书主体绑定实例 ID；含三轮独立安全审查修复） | `0e7398b5` | | 新增迁移 125（实例密钥、引导授权两张表与实例 `approval_state` 列）、`scripts/gateway-mtls-certs.sh`；开关 `KIN_CODEX_GATEWAY_INSTANCE_KEYS`（默认 on） |
| 2026-11-06 | 生产 `v1.4.048.6`（影子比对修复，用户确认）、preflight `--apply`（用户授权，补齐 22 个安装身份）；影子 22/0 | — | — | 观察期 2026-11-06 12:51 UTC 起 |
| 2026-11-06 | Gateway 事实直读 G3：以库为准（`KIN_CODEX_GATEWAY_FACTS=primary`） | `a9a3671f` | 本条所在提交 | 上游触点 0 |
| 2026-11-06 | 生产 `v1.4.048.8`（用户授权“升级并切 primary”）：15:03 UTC 部署、15:07 UTC `KIN_CODEX_GATEWAY_FACTS=primary` | — | — | 迁移 125–127 已应用；切换后 23 个绑定 synced、请求 200；备份 `.env.bak-primary-20261106T150707Z`、`kin-20261106T142207Z.sqlite` |
| 2026-11-07 | Gateway 事实直读 G4a：删除投影推送、托管封装与影子比对 | `8fe72fea` | `3dea2607` | 上游触点：`panel-routes.mjs` +2 −5、`usage-logs-view.mjs` +1 −1（已有定制段落内） |
| 2026-11-07 | Gateway 事实直读 G4b：删除多 Worker、mTLS 与跨主机路径 | `ec3847a5` | 本条所在提交 | 见发布说明 |
| 2026-11-06 | 中期技术债 M3：降级演练（控制面宕机后事件补交；控制面数据库写锁被占与只读）及修复：数据库写入健康与降级（就绪接口 `/readyz` 503、`/healthz` 保持 200 存活、计费准入拒绝带 `Retry-After`、写入快速失败、写回队列暂停、收口重试、事件不计毒）、只读连接拒绝启动、面板显示；Worker 注册网络与 TLS 错误限频日志。独立审查修复：SQLite 自动回滚整个事务后 DbClient 标为已中止并拒绝后续语句、写回整批重排；写探测改为真正提交并连续两次成功才恢复；收口重试只留补写数据、串行重放，停机落盘 `pending-commits.jsonl` + `scripts/replay-pending-commits.mjs`；错误分类收窄、日志限频、停机丢弃计数 | `3dea2607` | | ACCEPTANCE 第 5 条改为满足；新增 `test/e2e/gateway-worker-outage.e2e.test.mjs` 并进 `worker-e2e.yml`；上游触点：`server.mjs`（`/healthz`、`/readyz`、启动提示）、`handle-protocol.mjs`（准入与收口重试）、`database.mjs`、`write-behind.mjs`、`request-log.mjs`、`panel-routes.mjs`（`db-client.mjs`、`relay-billing.mjs` 是定制文件） |
