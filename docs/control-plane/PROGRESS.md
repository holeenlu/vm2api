# 统一控制面与执行服务重构 · 进度台账

本文件是已交付状态的唯一权威，每次交付同步更新。计划与续接流程见 [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md)。

状态：`todo` / `doing` / `done` / `review` / `blocked` / `deferred` / `skipped`。“上游改动”列为 `scripts/upstream-touch-budget.mjs` 的输出摘要。

## 当前

- 阶段：P0–P6 与 PF 全部关闭（P7 不做）；重构代码交付完成
- 下一个任务：无（等待用户：生产切换 P1.10、P3.10 与 Redis 部署授权）
- 等待用户：P1.10、P3.10 生产授权
- 用户决定：2026-11-05 认可 P2.4 skipped 及 P2 目标调整；2026-11-05 认可 P4 上游预算例外；2026-11-05 确认引入 Redis（P5 开工）；2026-11-05 认可 P5 上游预算例外（`worker/go.mod`、`go.sum`）

## 阶段

| 阶段 | 状态 | 审查 |
| --- | --- | --- |
| P0 计划、台账与工具 | done | 不设审查门（只含计划与工具） |
| P1 执行契约与事件发件箱 | done | R1：P0×1、P1×5、P2×10，已修复（P2-2 暂缓，P2-10 转 P3.11）；第一轮复审 N1–N5 已修复；第二轮复审通过（P2×2 已修复），见 [reviews/P1.md](reviews/P1.md) |
| P2 统一结果与请求账本 | done | R2：P1×2、P2×8，已修复（P2-1 接受并写入限制）；第一轮复审 N1（P1）、N2–N5 已修复，回放比对零差异已实测；第二轮复审 N6（P1）、N7、N8 已修复；第三轮复核通过（N9 已修复，N10 接受）。审查已通过；用户 2026-11-05 认可 P2.4 skipped，阶段关闭，见 [reviews/P2.md](reviews/P2.md) |
| P3 刷新租约与凭据归属 | done | R3：P1×6、P2×8 已修复（P2-5 接受）；第一轮复审 N1–N8 已修复；第二轮复审通过（M1–M4 P2 已修复），见 [reviews/P3.md](reviews/P3.md)（P3.10 deferred，需授权生产迁移） |
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
| P1.10 | deferred | | | 需生产 `primary` 观察一个发布周期后授权 |
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
| P3.10 | deferred | | | 需授权生产凭据迁移 |
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
| P6.1 | done | 2026-11-05 R3 修复与 P4、P6 交付 | 上游净减 | web schema-form |
| P6.2 | done | 2026-11-05 R3 修复与 P4、P6 交付 | 上游净减 | 设置页与账号 BPS 设置按描述渲染；删除手写组件 |
| P6.3 | done | 2026-11-05 R3 修复与 P4、P6 交付 | 上游净减 | 能力描述 authorizations；向导 BPS 步骤 |
| P7 | skipped | | | |
| PF.1 | done | | | ACCEPTANCE.md 定稿 |
| PF.2 | done | | | 审查 A、B 复核均通过，见 reviews/PF.md |
| PF.3 | done | | | 设计状态行、运维第 8–13 节、审查报告与验收记录已更新 |

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
| 2026-11-05 | 事件收件箱写入时去掉 attribution | `2a55257f` | 见 journal | |
