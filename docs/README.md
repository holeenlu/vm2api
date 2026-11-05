# 文档

- [CHANGE_DELIVERY.md](CHANGE_DELIVERY.md) — 需求交付、上游同步、冲突决策、验证与发布边界；本机技能 `$vm2api-sync-upstream` 的制度依据
- [CUSTOMIZATION_IMPLEMENTATION_RECORD.md](CUSTOMIZATION_IMPLEMENTATION_RECORD.md) — 全部定制的需求、规划、实现、迁移、清理与验证总记录
- [CUSTOMIZATION_RELEASE_NOTES.md](CUSTOMIZATION_RELEASE_NOTES.md) — 定制版本交付、升级、限制与验证说明
- [CUSTOMIZATION_FILE_INDEX.md](CUSTOMIZATION_FILE_INDEX.md) — 相对上游基线的逐文件差异索引
- [UPSTREAM_SYNC_2026-10-21.md](UPSTREAM_SYNC_2026-10-21.md) — 本轮上游固定来源、冲突处理、功能入口及验证限制
- [BUILD.md](BUILD.md) — 构建、验证与人工发版入口
- [BRANDING_AND_RELEASE.md](BRANDING_AND_RELEASE.md) — 品牌、语言、linux/amd64 应用发布与更新来源
- [DEPLOY.md](DEPLOY.md) — 安装与升级（含 `deploy/install.sh` 一键安装 / 更新）
- [CODEX_GATEWAY_WORKER_SETUP.md](CODEX_GATEWAY_WORKER_SETUP.md) — Codex Gateway Worker 启动配置、注册验证与账号添加路径（`codex-gateway` 分支，灰度）
- [nginx-shell.md](nginx-shell.md) — 集群 / 槽运维终端 WebSocket 连不上时查 nginx Upgrade
- [FORMAT.md](FORMAT.md) — 本地与 CI 同一套格式（Biome / gofmt / Prettier，LF）
- [API.md](API.md) — `/v1`
- [RISK.md](RISK.md) — 封控拦截（蒸馏 → 硬正则 → 拒答缓存 → 决策模型 → 放行出站）
- [supplier-platform/README.md](supplier-platform/README.md) — SA/AD/U 职责、菜单规划与后续供应商平台设计
- [PANEL_API.md](PANEL_API.md) — 管理台 API
- [redaction/README.md](redaction/README.md) — Node 清洗阶段可启停脱敏插件与 Web 控制面板设计（尚未实施）
- [ISSUE_BACKLOG.md](ISSUE_BACKLOG.md) — open issue 复核后暂不修复的清单（2026-10-28）
- [RELAY_OPERATIONS.md](RELAY_OPERATIONS.md) — 中转站运营体系整合规划（分组、VM 账号、用户计费、Key 与使用记录）
- [RELAY_OPERATIONS_DELIVERY.md](RELAY_OPERATIONS_DELIVERY.md) — 中转站实施、权限、数据迁移、清理清单与本机验收
- [RELAY_OPERATIONS_FEEDBACK.md](RELAY_OPERATIONS_FEEDBACK.md) — 控制台反馈修正、代理（当时含多协议，现已仅 SOCKS5）与本机复验
- [cpr/README.md](cpr/README.md) — CPR 研究、能力矩阵、目标架构、开发路线与证据索引
- [ARCHITECTURE_TARGET_20261102.md](ARCHITECTURE_TARGET_20261102.md) — 对照定制 NewAPI 与 codex-proxy-rs 后形成的 PostgreSQL + Redis 目标业务、数据和迁移架构
- [POSTGRESQL_MIGRATION_PLAN_20261103.md](POSTGRESQL_MIGRATION_PLAN_20261103.md) — SQLite → PostgreSQL 迁移实施方案（计划，未实施；启动前需用户决策）
- [performance/process-split-plan.md](performance/process-split-plan.md) — 网关主线程减负第二、三阶段（进程拆分）计划与启动门槛（计划，未实施）
- [ARCHITECTURE_CONTROL_PLANE_EXECUTORS_20261105.md](ARCHITECTURE_CONTROL_PLANE_EXECUTORS_20261105.md) — 统一控制面（入口、账号、凭据、设置、调度策略、请求账本）与 Claude / Codex 执行服务分离的目标架构、执行契约 v1 与分阶段实施路线
- [control-plane/DEVELOPMENT_PLAN.md](control-plane/DEVELOPMENT_PLAN.md) — 上述重构的开发计划（任务、续接流程、审查门、授权节点）；进度见 [control-plane/PROGRESS.md](control-plane/PROGRESS.md)
- [DATA_ACCESS_AND_API_ARCHITECTURE_20261105.md](DATA_ACCESS_AND_API_ARCHITECTURE_20261105.md) — 对照 sub2api、CPR 的数据库设计与后台接口规模，vm2api 的接口分类、数据访问分层与落地路线（设计，未实施）
- 抄本：[deploy/env.example](deploy/env.example) · [deploy/tapmodels.service](deploy/tapmodels.service)

总览：[README](../README.md)。版本：[CHANGELOG.md](../CHANGELOG.md)

原上游入门站：[vm2api.fkcodex.com/zh](https://vm2api.fkcodex.com/zh/)（对照 1.3.133）。

原作者 Telegram：[t.me/VM2API](https://t.me/VM2API)
