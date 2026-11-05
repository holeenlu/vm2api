# Gateway 账号统一编号：`account_<uuid>` → `gw-NN`

早期 Gateway Worker 账号的资源 ID 是 `account_<uuid>`，新账号已经按 `gw-01`、`gw-02`…… 分配（`src/lib/gateway-worker/account-ids.mjs`）。本手册把早期账号离线改到同一序列：资源 ID 与运行账号 ID（`gwacct_<资源 ID>`）一起改。

## 改什么、不改什么

| 位置 | 处理 |
|---|---|
| 控制面数据库各表的文本列（账号行、绑定、分组关系、OAuth 会话、响应归属、用量明细、请求尝试、回执、派发、事件收件箱、调试记录等） | 旧 ID 是带 UUID 的唯一字符串，派生形式（`gwacct_<ID>`、`gateway:<ID>`、`binding_<ID>_<实例>`、JSON 字段）都原样包含它，统一做子串替换 |
| `executor_credentials`（凭据库） | 附加认证数据含账号 ID：用旧 ID 解开、按新 ID 重新封装，代次与令牌不变 |
| `usage_cost_hourly`、`usage_stats_hourly` | 不直接改，由 `usage_logs` 的更新触发器搬桶（直接改会重复计数） |
| `operation_audit`、`vendor_audit_events`、`vendor_settlements`、`vendor_settlement_previews` | 审计与结算证据保持原样；另写一条 `gateway.account_ids_renamed` 审计，记录完整映射 |
| 未完成的 OAuth 授权会话 | 密文里带旧 ID，立即过期；需要时重新生成授权链接 |
| `settings.gateway_account_id_seq` | 抬到改名区间的最大编号，新账号接着往后编 |
| Worker `accounts.json` | 只改 `id`；`installation_id`、额度、冷却、Cookie 等运行态保留，上游看到的仍是同一个安装 |
| Worker `route_provenance.json` | 签发账号改为新 ID，已有对话继续由原账号续接 |
| Worker `receipts/`、`events/` 未确认部分 | 替换旧 ID 后重新签名（回执 `payload_hash`、事件 `payload_sha256`），重启后控制面按新 ID 入账；已确认的事件是历史，不改 |
| Worker `bps_state/` | 清空（文件名由含账号 ID 的作用域派生）；BPS 对话缓存失效一次 |
| Redis `kin:gw:*` | 清空（租约、冷却、来源、BPS 状态，均带过期时间，可重建） |

编号规则：按账号创建时间（同时刻按旧 ID）从当前高水位之后依次分配，已归档账号也改。

外部影响：供应商门户与 API 会返回账号 ID，执行前确认没有供应商名下的老账号（`vendor_resources.vendor_id` 为空）。CPR 对等方看到的账号摘要由账号 ID 派生，改名后表现为账号下线又上线。

## 工具

- `scripts/rename-gateway-account-ids.mjs`
  - `--plan <out.json>`：只读，生成改名计划。
  - `--apply <plan.json>`：一个事务改控制面；任何一步失败整体回滚；重复执行已完成的计划不做改动。
  - `--worker <plan.json>`：按控制面托管 Worker 的同一套环境（`runtime-secrets.json` 里的 bundle 密钥、数据目录、实例、Redis）调用 `kin-codex-gateway -rename-accounts <plan.json>`。
  - `--verify <plan.json>`：只读，做全库残留扫描、凭据按新 ID 解密、绑定与高水位核对；失败时退出码为 1。
- 脚本不执行数据库迁移。库结构落后于代码时报 `schema_outdated`，先部署并启动一次新版本。

## 生产执行步骤

前提：已部署包含本工具的版本并正常运行。容器启动时会把镜像里的新 `kin-codex-gateway` 复制到 `bin/`。在低峰时段（19:00–22:00 UTC）执行，控制面与所有 Worker 必须停止。

```bash
cd /opt/tapmodels
TS=$(date -u +%Y%m%dT%H%M%SZ); BK=/root/gwid-backup-$TS
RUN="docker compose run --rm --no-deps --entrypoint node tapmodels scripts/rename-gateway-account-ids.mjs --data-dir /opt/tapmodels/data"
```

1. 停止：`docker compose stop tapmodels`，确认 `docker ps` 里已经没有 `tapmodels`。
2. 备份（停机状态，文件一致）：
   ```bash
   mkdir -m 700 "$BK"
   cp -a data/kin.db data/kin.db-wal data/kin.db-shm data/credential-master-keys.json data/runtime-secrets.json "$BK"/ 2>/dev/null
   cp -a data/codex-gateway "$BK"/codex-gateway
   cp -a .env "$BK"/env
   ```
3. 计划：`$RUN --plan /opt/tapmodels/data/gwid-plan.json`，核对条数与编号。
4. 控制面：`$RUN --apply /opt/tapmodels/data/gwid-plan.json`。
5. Worker：`$RUN --worker /opt/tapmodels/data/gwid-plan.json`。报告里 `renamed` 应为全部账号，`missing` 只能是从未投影过的账号。
6. 校验：`$RUN --verify /opt/tapmodels/data/gwid-plan.json`，要求 `ok: true`。
7. 启动：`docker compose up -d --no-build tapmodels`，然后检查：
   - `/healthz` 返回 200；
   - Gateway Worker 页的账号为 `gw-NN`，投影状态正常；
   - 真实请求成功，`usage_logs` 新行的 `account_resource_id` 是 `gw-NN`；
   - 控制面日志里没有 `receipt_integrity_failed`、`credential_tampered`、`unknown runtime account`。

## 回滚

改名前状态完整保存在 `$BK`：停止容器，用备份覆盖 `data/kin.db*`、`data/credential-master-keys.json`、`data/codex-gateway/`，再启动。Redis 共享态会自动重建。回滚后，执行期间新产生的使用记录随备份一起丢失。只要在同一个维护窗口内决定回滚，就不会有新记录。

## 移除条件

生产执行并通过验证后，本工具与手册不再有用途。届时在下一次交付中同时删除：

- 脚本、Worker 的 `-rename-accounts` 及其测试；
- `vault.mjs` 的 `resealCredentialForAccount`；
- 前端 `vmSlotId` 对 `account_` 前缀的截短分支。
