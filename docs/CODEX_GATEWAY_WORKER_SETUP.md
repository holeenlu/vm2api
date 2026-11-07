# Codex Gateway Worker 启动配置

适用于 `main`（2026-11-03 起包含 `worker/cmd/kin-codex-gateway` 与"Codex 账号 / Gateway Worker"页面）。

状态：已用于生产（统一控制面的生产切换 2026-11-05 完成，记录见 [control-plane/PROGRESS.md](control-plane/PROGRESS.md)）。2026-11-07 起（Gateway 事实直读 G4b）只支持与控制面同机的单个 Worker，多 Worker、mTLS 与跨主机部署已删除（此前在测试服务器的验收记录见 [ACCEPTANCE“目标环境验收”](control-plane/ACCEPTANCE.md)，生产从未启用）。

## 1. 角色与边界

| 对象 | 是什么 | 谁启动 |
| --- | --- | --- |
| 控制面（Node） | 对外入口与鉴权、分组与模型范围、协议转换、计费与 Receipt 对账、续接归属、账号管理（Worker 同机直读账号事实，第 14 节）、策略下发 | `docker compose up -d` / `npm start` |
| Gateway Worker（Go `kin-codex-gateway`） | 一个进程承载全部 Codex 账号：持有凭据，选号、重试与换号，额度与错误保护，上游 HTTP/WS 连接与指纹，出站改写 | 默认由控制面托管启动，见第 3 节 |

控制面入口（`scripts/docker-entrypoint.sh`）把镜像内的 `kin-codex-gateway` 复制到 `bin/`，控制面启动时随之托管启动 Worker，不需要额外开关。"Gateway Worker"页面显示"暂无已注册 Gateway Worker"时，先看页面上的托管状态：`missing_binary` 表示 `bin/` 下没有二进制，`backoff` 表示 Worker 反复退出（原因见控制面日志里的 `[codex-gateway]` 行），`external` 表示托管已关闭、需要外部启动。

实例不在页面上新建：Worker 启动后按 `KIN_CODEX_GATEWAY_CONTROL_PLANE_URL` 自己 POST 注册，之后每 15 秒心跳一次。

**默认拓扑：一个控制面 + 一个同机 Worker，由控制面托管（第 3 节 A）。** 账号的并发、RPM、冷却与错误保护计数都在 Worker 进程内，单实例时只有一份。控制面默认处于单 Worker 模式：已有在线接单的实例时，另一个实例的注册与心跳返回 409 `gateway_single_worker`，Worker 日志会打印一次原因并继续重试。替换实例时先 Drain 或停止旧实例，旧实例 drain 或 45 秒无心跳后新实例即可接单。Worker 直读控制面数据库（第 14 节），只支持同机部署；出口分布由账号代理决定，与 Worker 进程数无关。

## 2. 密钥

控制面托管（默认）时不需要手工准备：两个密钥未配置时由控制面生成并保存在 `data/runtime-secrets.json`。只有外部管理的同机 Worker（见第 3 节 B）才需要在 `.env` 里显式写出，两侧使用同一个值。两个密钥都用高熵随机值，互不复用：

```bash
openssl rand -hex 32
```

写进仓库根目录的 `.env`（没有就 `cp .env.example .env && chmod 600 .env`）：

- `KIN_CODEX_GATEWAY_INTERNAL_TOKEN` — 共用内部 HMAC 令牌：外部自启的 Worker（`KIN_CODEX_GATEWAY_SUPERVISE=0`）与控制面双向签名用它，只读诊断脚本（`npm run health:codex-gateway`）也用它。控制面托管的 Worker 不用它（见下文“会话密钥”）。
- `KIN_CODEX_GATEWAY_CREDENTIAL_BUNDLE_KEY` — Worker 落盘加密的派生密钥：数据目录的 `accounts.json`（OAuth token、代理地址与 Cookie）以 AES-256-GCM 加密保存，旧的明文账号库在首次启动时自动改写为密文。配了 `CONTROL_PLANE_URL` 而没配它，进程会拒绝启动。**更换或丢失这个值后 Worker 会拒绝启动**（不会以空账号库覆盖原有凭据），换回原值，或停掉 Worker、删除数据目录的 `accounts.json` 后重启（账号与凭据从控制面数据库重新读入，第 14 节）。回滚到不支持落盘加密的 Worker 前，先停止 Worker，再用新版本执行 `kin-codex-gateway -unseal-accounts`（读取同样的环境变量）把账号库改回明文。

会话密钥（2026-11-07 S4，取代实例密钥、引导令牌与“待批准”）：

- 托管器每次拉起 Worker 时生成一把 32 字节随机会话密钥，作为子进程的 `KIN_CODEX_GATEWAY_INTERNAL_TOKEN` 传入；控制面只在内存里保存，不落盘。注册、心跳、事件拉取、凭据与设置接口的请求签名与响应签名都用它；子进程退出即作废，重启拿到新密钥。不需要任何操作。
- 托管的实例 ID（默认 `gw-01`）只接受会话密钥：持有共用令牌的一方不能以它的名义注册或上报（`session_key_required`），会话密钥也不能用于别的实例 ID（`instance_mismatch`）。
- 外部自启的 Worker 用共用令牌，注册后直接接单（不再有“待批准”）；单 Worker 冲突检查不变：已有在线实例时，新实例 ID 一律 409，旧实例离线约 45 秒后才能接替。
- Worker 只采纳带有效响应签名的心跳策略；签名用请求时出示的同一把密钥。
- 共用令牌或主机疑似泄露：更换 `.env` 或 `runtime-secrets.json` 里的 `KIN_CODEX_GATEWAY_INTERNAL_TOKEN` 并重启控制面（外部 Worker 同步更换并重启）；托管 Worker 随控制面重启拿到新会话密钥。
- 升级后数据目录里旧版本留下的 `instance-key.json` 不再读取，可以删除；`.env` 里残留的 `KIN_CODEX_GATEWAY_INSTANCE_KEYS`、`KIN_CODEX_GATEWAY_BOOTSTRAP_WINDOW_SECONDS` 启动时告警并忽略。

`.env.example` 已给出其余键的默认值（实例 ID、监听、回连地址、容量）。控制面读取 `SUPERVISE / INTERNAL_TOKEN / CREDENTIAL_BUNDLE_KEY / ALLOW_INSECURE`；其余键由 Worker 进程读取；托管时控制面只按白名单把这些键传给 Worker（见第 3 节 A 的环境白名单，中期技术债 M2），不会原样传出整个环境。

`KIN_CODEX_GATEWAY_ALLOW_INSECURE` 保持留空：Node 与 Go 两侧的默认都是"只接受环回明文 + HMAC"。只有同机的私有主机网络地址（不是环回）才需要设成 `1`。`KIN_CODEX_GATEWAY_MULTI_WORKER`、`KIN_CODEX_GATEWAY_REQUIRE_MTLS` 与 `TLS_*` / `INTERNAL_TLS_*` / `MTLS_*` 已删除（2026-11-07），仍写在 `.env` 里时控制面启动告警一次，可以删掉。

`KIN_CODEX_GATEWAY_RELEASE_CHECK` 默认开启：Worker 每天从 OpenAI 官方 appcast、npm 与安装包核验最新客户端版本，用于上游客户端画像。设成 `off`（或 `0`、`false`、`no`）关闭这项检查，其他值保持开启（没有外网或要求封闭的环境，例如真实 Worker e2e）；关闭后画像使用内置或已保存的版本。

## 3. 启动方式

### A. 控制面托管（默认，推荐）

不需要单独启动 Worker。`bin/kin-codex-gateway` 存在时，控制面以子进程拉起同机的一个 Worker：

- 监听 `127.0.0.1:8790`，实例 ID `gw-01`，数据目录 `data/codex-gateway`（0700），回连地址按控制面自己的 `PORT` 补齐为环回明文 + HMAC；`.env` 里显式写了的同名键优先。
- `KIN_CODEX_GATEWAY_INTERNAL_TOKEN` 与 `KIN_CODEX_GATEWAY_CREDENTIAL_BUNDLE_KEY` 未配置时由控制面生成并保存在 `data/runtime-secrets.json`，重启沿用。
- 崩溃按 1s、2s、5s、10s、30s、60s 退避重启（稳定运行 1 分钟后重新计数），Worker 日志带 `[codex-gateway]` 前缀并入控制面日志；控制面关停时停止子进程。
- amd64 与 arm64 控制面镜像都从源码编译 `kin-codex-gateway`（发版冒烟检查确认 `bin/` 下存在且为 amd64 ELF），控制面入口把它复制到 `bin/`；面板升级或 `docker compose up -d` 重建控制面时，Worker 随之换成新版本，不需要另外的侧车、overlay 或 systemd 单元。
- Gateway Worker 页面显示托管状态（运行中、退避重启、未找到二进制等）、进程号、重启次数与最近一次退出。
- Worker 子进程只继承以下控制面环境变量（中期技术债 M2 复审 P2-4）：`KIN_CODEX_GATEWAY_*`（其中 `KIN_CODEX_GATEWAY_INTERNAL_TOKEN` 换成托管器为这个子进程生成的会话密钥，第 2 节）、`KIN_CREDENTIAL_MASTER_KEY_FILE`（原值传递；没有设置时托管器补上与控制面相同的默认位置）、`CODEX_CA_CERTIFICATE`、`SSL_CERT_FILE`、`SSL_CERT_DIR`、`HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` / `ALL_PROXY`（含小写）、`PATH`、`HOME`、`TZ`、`TMPDIR`、`LANG`、`LC_ALL`、`LC_CTYPE`、`GODEBUG`、`GOMAXPROCS`、`GOMEMLIMIT`、`GOTRACEBACK`。
  - 数据库字段密钥 `TAPMODELS_DB_SECRET` / `KIN_DB_SECRET` 只在事实直读开启时传（`KIN_CODEX_GATEWAY_FACTS_DB` 有值且 `KIN_CODEX_GATEWAY_FACTS` 不是 `off`；托管时控制面默认补齐 `FACTS_DB`，所以默认会传）：只读读取器要解密事实视图里的字段密文，这是事实直读的前提；设 `KIN_CODEX_GATEWAY_FACTS=off` 后不再传。
  - 这份白名单与 Worker 代码里读取的全部环境变量一一对应（`KIN_CODEX_GATEWAY_*`、`KIN_CREDENTIAL_MASTER_KEY_FILE`、`TAPMODELS_DB_SECRET` / `KIN_DB_SECRET`、`CODEX_CA_CERTIFICATE` / `SSL_CERT_FILE`），其余是 Go 运行时与标准库使用的通用变量。管理员密码、API Key 等不再传给 Worker；托管 Worker 需要的其他配置请用 `KIN_CODEX_GATEWAY_*` 设置。

### B. 外部管理（同机）

在控制面设置 `KIN_CODEX_GATEWAY_SUPERVISE=0` 停止托管，再用下面的脚本或 systemd 在**同一台主机**启动 Worker（它要直读控制面数据库，见第 14 节）。外部 Worker 与控制面必须使用同一个 `KIN_CODEX_GATEWAY_INTERNAL_TOKEN` 与 `KIN_CODEX_GATEWAY_CREDENTIAL_BUNDLE_KEY`，请在 `.env` 里显式写出；回连地址必须是本机环回。

```bash
sh scripts/codex-gateway-start.sh
```

脚本从 `.env` 取默认值（已 export 的同名变量优先），补齐实例 ID、监听、数据目录和回连地址，按 Go 侧 `Config.Validate` 的规则提前报错，建好 0700 的数据目录后 exec 二进制。

systemd 单元（按实际路径替换 `/opt/tapmodels`）：

```ini
[Unit]
Description=tapmodels Codex Gateway Worker
After=network-online.target tapmodels.service
Wants=network-online.target

[Service]
Type=exec
WorkingDirectory=/opt/tapmodels
ExecStart=/bin/sh /opt/tapmodels/scripts/codex-gateway-start.sh
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

### C. 本机开发

```bash
npm run build:codex-gateway
```

之后启动控制面即由控制面托管；需要单独调试 Worker 时设置 `KIN_CODEX_GATEWAY_SUPERVISE=0` 再运行：

```bash
npm run start:codex-gateway
```

需要 Go 1.25 工具链。二进制落在 `bin/kin-codex-gateway`。

## 4. 验证

Worker 的每个内部接口都校验 HMAC 时间窗、body hash 和 nonce，裸 `curl` 必然是 `401 invalid_internal_auth`。用带签名的探测：

```bash
npm run health:codex-gateway
```

```bash
node scripts/codex-gateway-health.mjs http://127.0.0.1:8790 --capabilities
```

`health` 返回 `health_state`、`drain_state`、`active_concurrency`、`account_count`。然后打开管理台**资源管理 → Gateway Worker**，实例卡片应在 15 秒内出现，可用"健康检查 / Drain / 恢复"按钮操作。

## 5. Codex 请求何时走 Worker

没有全局开关：API Key 所在分组绑定了 Gateway 账号时，该分组的 Codex 请求走 Worker；未绑定的分组保持现有 Codex VM 行为。需要临时让所有分组都回到 VM 时，在「设置 → OpenAI → Codex 执行设置 → 执行通道」选“Codex VM”（控制面设置 `gateway_worker.preference`，第 11 节）。

## 6. 添加 Codex 账号

令牌以控制面凭据库为准（第 10 节）。Worker 从控制面数据库直读账号的配置、分组与凭据（第 14 节），数据目录的 `accounts.json` 只是本地缓存。

1. 非超管身份还需要先放开供应商执行策略（目前没有界面）：

```bash
curl -X PUT "http://127.0.0.1:8787/api/panel/gateway-execution-policies?vendor_id=<供应商ID>" -H 'Content-Type: application/json' -d '{"platform":"openai","execution_kind":"gateway_worker","allow_create":true,"allow_runtime":true}'
```

2. 到**供应商门户**新建账号：平台选 OpenAI（固定由 Gateway Worker 执行，表单不再显示执行方式）→ 自有代理 → 选授权分组 → OAuth 或账号文件授权。名称留空时自动使用授权邮箱。建好的账号与虚拟机账号一起出现在供应商门户与运营端「供应商平台 → 账号池」，额度、套餐、费用等列同样显示；凭据失效时在账号池行菜单「授权」重新授权（需开放 `allow_runtime`）。

   超管的"供应商平台 → 账号池"表单没有"执行方式"字段，提交时固定 `execution_kind=vm`，在那里建出来的是 Codex VM，不会出现在 Codex 账号页。

3. 账号会以 `resource_kind=gateway_worker_account` 写入 `group_resources`，客户 API Key 必须绑定同一个分组才能调到它。一把 Key 同时要走 Claude VM 和 Codex Worker，就得在同一个分组里授权两类账号和模型。

   之后调整分组有两个入口，规则相同：「Codex 账号」页编辑账号（或批量编辑），或「分组」页「管理资源」的「Codex 账号」页签（2026-11-06 起，与 VM 槽位、API 地址一次保存）。两个入口都只写 `group_resources`（迁移 128 起账号配置不再存分组），Worker 约 0.5 秒内直读生效。VM 槽位与 Codex 账号同属账号池、可以同组，账号池与 API 地址不能同组。账号已在的分组之后被停用时，编辑账号可以保留它；已删除的分组会自动从账号上去掉。

没有可用实例时创建会直接失败（`gateway_worker_unavailable`），所以第 3 节必须先完成。授权在控制面完成（2026-11-07 起，与 VM 槽位相同）：授权链接、换码（经账号出站代理）、只有刷新令牌时的首次刷新都由控制面做，令牌与账号在同一事务写进凭据库，Worker 约 0.5 秒内直读生效、不参与授权。账号列表的“Worker 加载”在 Worker 心跳确认读到最新事实后显示“已同步”（约 15 秒）。

### BPS 授权（2026-11-07 删除）

BPS（Excel Basispoints）通道已于 2026-11-07 停止运营，代码与数据一并删除，Codex 账号只走原生授权与原生通道：

- 删除 BPS 授权（授权链接、授权文件、撤销）、账号 BPS 设置与「设置 → OpenAI → BPS」默认模板、BPS 图片策略、403 停用/恢复探测/自动移组、BPS 模型目录与定时补查、测试链接的通道选择与严格探测、批量编辑与账号文件导入导出里的 BPS 部分、Key 的「Codex 通道策略」（自动 / 只走原生 / 只走 BPS）、账号列表的 `+BPS` 后缀与供应商门户的「BPS 授权」菜单。
- 环境变量 `KIN_CODEX_GATEWAY_BPS_BASE_URL`、`KIN_CODEX_GATEWAY_BPS_CLIENT_ID`、`KIN_CODEX_GATEWAY_BPS_AUTHORIZE_URL`、`KIN_CODEX_GATEWAY_BPS_REDIRECT_URI`、`KIN_CODEX_GATEWAY_BPS_STREAM_IDLE_SECONDS` 不再读取，可以从 `.env` 删除；Worker 数据目录里的 `bps_state/`（以及更早的 `bps_state.json`）不再读取，可以删除。
- 数据由迁移 133 删除（破坏性，只能前滚，见第 14 节“删除 BPS（迁移 133）”）。历史使用记录的「授权方式」与请求尝试的通道仍按原值只读展示，旧的 BPS 请求照常显示 BPS 标记。

## 7. 多 Worker 与跨主机部署（已删除）

2026-11-07（Gateway 事实直读 G4b）删除了多 Worker（`KIN_CODEX_GATEWAY_MULTI_WORKER`、实例间错误保护冻结转发、定时预刷新指派）、mTLS（`REQUIRE_MTLS`、`TLS_*`、内部 mTLS 监听、受信反代证书头、`scripts/gateway-mtls-certs.sh`）与跨主机部署。Worker 只支持与控制面同机的单个实例，内部接口是环回明文 + HMAC（托管 Worker 用会话密钥，第 2 节）。替换实例按第 1 节的接替流程。

## 8. 执行事件发件箱（结算与账号运行态的唯一通道）

Worker 把每次分发的最终结果（`request.finalized`）、账号凭据终态（`account.state`）与额度变化（`account.quota`）写成事件，追加到数据目录 `events/`（分段日志，逐条 fsync 后才算产生）。控制面按事件流游标拉取并确认，写回执表与对账、账号终态与额度，并在 60 秒后按事件补齐请求尝试；已确认的整段保留 24 小时后删除。设计见 [ARCHITECTURE_CONTROL_PLANE_EXECUTORS_20261105.md](ARCHITECTURE_CONTROL_PLANE_EXECUTORS_20261105.md) 5.6。

2026-11-07 S2 起这是唯一通道：回执推送（`KIN_CODEX_GATEWAY_RECEIPT_URL` 与本地 spool）、回执补拉与确认接口、心跳里的账号凭据、额度与 BPS 探测字段、shadow 比对都已删除；开关 `KIN_EXECUTOR_EVENTS` 删除（`.env` 里残留时启动告警并忽略）。回执表保留，作为对账证据与账号详情、额度回执的数据来源。升级时数据目录里旧的回执 spool 不再读取，可以删除（升级前留在里面、还没推送的回执，其事件已在 `events/` 中，由控制面照常拉取）。

运维注意：

- 「Gateway Worker」页每个实例显示事件发件箱状态：控制面是否在消费、未确认条数与积压大小。Worker 健康接口与心跳里的 `events` 有同样的 `required`、`head`、`acked`、`backlog_bytes`、`healthy`。
- Worker 重启后到收到第一份心跳策略之前，`required_known` 为假（“未知”）：此时既不自行确认事件（控制面可能还没拉取重启前的事件），也不因事件拒单；“未知”超过 24 小时（心跳一直拿不到策略）按不消费处理。
- 事件日志写入失败或未确认积压超过 512 MiB 时，Worker 显示 `degraded` 并以 503 `executor_event_log_unavailable` 拒绝新请求（请求未发出）。单通道下没有回执推送兜底，这是有意的：结算写不下去就不接单。写入故障会在 10 秒维护周期内自动尝试恢复。先查磁盘空间与控制面拉取是否正常。
- 同一事件连续处理失败 5 次后记为 `failed` 并跳过；序号缺口连续 5 轮仍在才接受。两者都会告警，并计入对账工具 `scripts/executor-replay-diff.mjs` 的问题数（第 12 节）。
- Worker 数据目录从旧备份或快照恢复、或 Worker 重启时丢了尾部事件后，控制面会发现事件流回退（日志 `went back … reprocessing from N`），逐页比对找到第一处不同的序号，从那里重新处理；内容不同的同号事件以派生 ID 入库，已处理过的按 `event_id` 去重。
- Worker 启动恢复只去掉事件日志最后一段里的坏记录（日志 `dropped N damaged record(s)`），其后的有效记录保留；序号缺口保留并记日志，控制面按缺口处理。已确认序号高于恢复后的位置时降下来（日志 `acknowledged … is beyond the recovered head`）。
- 控制面日志中的 `executor events:` 警告表示无效事件、处理失败、序号缺口、积压超过 256 MiB 或 Worker 日志不健康。
- 删除或重建 Worker 数据目录会生成新的事件流，控制面自动从新流的第 1 条开始。
- 控制面宕机或它的数据库写不进去时，Worker 沿用最后一次心跳策略：事件留在本地、不自行确认，恢复后全部补交（演练见 `docs/control-plane/ACCEPTANCE.md` 第 5 条）。控制面数据库写不进去时就绪接口 `/readyz` 返回 503（`/healthz` 仍返回 200 存活，`degraded` 为 `true`）、新的计费请求返回 503 `database_unavailable`（带 `Retry-After`），可写后自动恢复，不需要重启；控制面以只读连接打开数据库时拒绝启动。降级中停机时，没写进去的推理收口写入 `data/request-logs/pending-commits.jsonl`，启动日志会提示，用 `node scripts/replay-pending-commits.mjs --data-dir data` 预览、加 `--apply` 补写（按 request_id 幂等）。

## 9. 凭据刷新与写回（2026-11-07 起，对齐 CPR / sub2api）

OpenAI 的刷新令牌每次刷新都会轮换，旧令牌随即失效。只支持同机单个 Worker（第 14 节），同一账号的刷新在 Worker 进程内单飞；原刷新租约与轮换报告已删除（开关 `KIN_REFRESH_LEASE` 仍写在 `.env` 里时启动告警并忽略，表 `credential_refresh_leases` 在迁移 130 删除）：

- Worker 刷新原生授权后，新令牌先同步落到本地账号表（`accounts.json`，加密），再按代次 CAS 直接写回凭据库 `executor_credentials`（与控制面同一加密格式，来源记为 `refresh`、实例 ID）。
- 原生授权：本地凭据记着它来自凭据库的哪个代次；库里仍是这个代次（或记录已丢失）才写入，否则期间控制面重新授权或导入过，这次刷新作废，Worker 随即换入库里的凭据。
- 写库失败（例如数据库写锁被占）不影响本次刷新结果：令牌已在本地，后台每 30 秒补写一次，重启后同样补写；Worker 日志记 `writing ... credentials ... failed; retrying later`。
- 换票请求已发出却没有拿到响应（超时、断连）时，上游可能已经轮换了刷新令牌：按刷新失败退避，不会被判为“恢复窗口耗尽而过期”以外的其他终态。

## 10. 凭据托管（统一控制面重构 P3.4–P3.9、P3.11）

账号令牌以控制面凭据库为准（2026-11-06 起固定，原开关 `KIN_CREDENTIAL_CUSTODY` 已移除，仍写在 `.env` 里时启动告警并忽略）：

- 令牌加密保存在 `executor_credentials` 表。主密钥文件与数据库同目录，文件名 `credential-master-keys.json`（权限 0600），也可用 `KIN_CREDENTIAL_MASTER_KEY_FILE` 指定位置；首次使用时自动生成。
- **主密钥文件必须与数据库分开备份。** 只有数据库备份时，令牌无法还原。
- Worker 直读凭据库（只读主密钥文件、不创建，第 14 节），控制面不再向 Worker 投影或封装令牌；按实例公钥封装的托管通道与 `custody-key.json` 已于 2026-11-06（G4a）删除。
- 授权、导入由控制面直接写凭据库，刷新由 Worker 按代次写回（第 9 节）；控制面不再从 Worker 导出收录，凭据包与 `scripts/migrate-worker-credentials.mjs` 已删除。Worker 本地 `accounts.json` 仍用 `KIN_CODEX_GATEWAY_CREDENTIAL_BUNDLE_KEY` 加密，托管部署自动生成并保存这个密钥。

主密钥轮换（先备份主密钥文件；轮换后重启控制面）：

```bash
node scripts/rotate-credential-master-key.mjs --data-dir data --rotate
```

```bash
node scripts/rotate-credential-master-key.mjs --data-dir data --status
```

```bash
node scripts/rotate-credential-master-key.mjs --data-dir data --retire
```

主密钥丢失诊断与重置（最终审计 U7）：

```bash
node scripts/credential-master-key-doctor.mjs --data-dir data
```

- 只读诊断：报告主密钥文件是否存在、可读、格式是否合法（以及权限、active 与各主密钥 ID）；凭据库每条记录由哪个主密钥 ID 包裹、用现有主密钥能否解开；解不开的记录能否用退役归档（`credential-master-keys.retired/`）里的密钥解开。报告不含任何密钥、令牌或令牌指纹。结论 `status`：`ok`、`no_records`、`recoverable_from_archive`（把报告里 `recoverable_from` 指向的归档中的密钥加回主密钥文件即可，不要重置）、`key_file_unreadable`（文件存在但读不出，先修权限）、`master_key_file_missing`（有记录、但这个路径上没有主密钥文件：多半是脚本看的路径与控制面不一致，报告的 `master_key_file_source` 说明路径来自 `--key-file`、环境变量还是默认值）、`master_key_lost`。全部正常时退出码 0，否则 1。
- 主密钥文件位置与控制面一致（`KIN_CREDENTIAL_MASTER_KEY_FILE`，否则数据库同目录），也可用 `--key-file` 指定。容器部署在控制面容器内执行。
- 重置只在诊断结论为 `master_key_lost`、并且确认主密钥找不回来时执行；结论是 `master_key_file_missing` 时必须用 `--key-file` 明确指定控制面实际使用的主密钥文件路径、确认它确实不在了，否则脚本拒绝重置（`key_file_missing_unconfirmed`），避免因路径不一致误删全部凭据。先停控制面，预览（不改动）：

  ```bash
  node scripts/credential-master-key-doctor.mjs --data-dir data --reset
  ```

  确认后执行：

  ```bash
  node scripts/credential-master-key-doctor.mjs --data-dir data --reset --confirm
  ```

  - 先把数据库快照与主密钥文件备份到 `data/backups/credential-master-key-reset-<时间>/`（目录 0700、文件 0600）；
  - 在一个事务里删除用现有主密钥与归档都解不开的凭据记录，写审计 `gateway.credentials.master_key_reset`；
  - 主密钥文件缺失或格式不合法时生成新的主密钥文件；文件本身合法（只是部分记录引用的旧主密钥丢了）时保留现有文件；
  - 有记录能用归档密钥解开、或主密钥文件读不出时拒绝重置。
- 重置后启动控制面：凭据库里被删的账号由 Worker 补写（本地仍有令牌的账号，下一次刷新或后台补写时写回；可在账号页“刷新”触发）；Worker 上也没有的账号逐个重新授权。

密钥泄露的影响：

- 共用内部令牌（`KIN_CODEX_GATEWAY_INTERNAL_TOKEN`）：托管的实例只接受会话密钥，只泄露共用令牌时对方不能冒充托管 Worker；托管 Worker 不在运行（退避重启中）或改为外部管理时，持有共用令牌的一方可以以任意实例 ID 注册与上报（单 Worker 检查仍拒绝在线实例之外的第二个实例）。凭据包密钥只加密 Worker 本地落盘的账号库。Worker 同机直读数据库与主密钥文件（第 14 节），主机本身失陷即等于全部账号的令牌泄露；这些密钥都按机密保管。

主密钥文件：

- 数据库里已有凭据时，主密钥文件缺失会直接报错，不会自动生成新密钥。
- 在线轮换可用：轮换前会自动备份为 `credential-master-keys.json.bak-<时间>`，轮换后重启控制面，再执行 `--retire`。
- 容器部署时，建议用 `KIN_CREDENTIAL_MASTER_KEY_FILE` 把主密钥文件放到单独的卷上，并单独备份。
- `--retire` 只看当前数据库：把当前没有记录引用的旧主密钥从主密钥文件去掉，去掉前归档到主密钥文件同目录的 `credential-master-keys.retired/<时间>.json`（目录 0700、文件 0600，内容为退役时间与 `keys`），不删除（最终审计 U6）。轮换时生成的 `credential-master-keys.json.bak-<时间>` 同样留着。只要还保留着轮换前的数据库备份（面板备份 `kin-backup-*.tar.gz`、数据库快照），就不要删归档与这些 `.bak-<时间>` 文件；归档与主密钥文件一样按机密保管、单独备份。
- 恢复轮换前的数据库备份（最终审计 U6）：备份里的凭据记录仍由旧主密钥包裹，直接恢复时读取报 `master_key_missing`，Worker 读不出这些账号的凭据（事实读取出错，绑定标为 drifted）。`credential-master-key-doctor.mjs` 会报告哪些记录可以用哪份归档解开。先把归档（或 `.bak-<时间>`）里的旧主密钥 ID 与密钥加回当前主密钥文件的 `keys`（`active` 保持当前值，权限保持 0600），再恢复：
  - 用面板恢复时不用停控制面：控制面遇到不认识的主密钥 ID 会重读主密钥文件；
  - 手工替换数据库文件时，先停控制面，合并后再启动。
  - 恢复后可以再执行一次 `--rotate`，让全部记录改由新主密钥包裹，确认后 `--retire`。
- 面板备份（「备份」页与 `kin-backup-*.tar.gz`；「备份」页有同样的提示）包含数据库快照、`vms/*.json` 与 `src/config/*.json`，**不包含**：主密钥文件、`runtime-secrets.json`（自动生成的数据库字段加密密钥、API Key、管理员初始密码、内部令牌与凭据包密钥；没有在 `.env` 显式配置 `TAPMODELS_DB_SECRET` 时，恢复必须带上它，否则数据库里的加密字段读不出来）、Worker 数据目录（`data/codex-gateway/`）。这三样另行备份；只用面板备份恢复时，需要主密钥文件才能解开凭据库。

其他变化：

- 账号导出只读凭据库（Worker 的明文凭据接口与导出接口已删除）。
- 授权会话（state、PKCE verifier）由控制面生成并保存（配置了数据库密钥 `TAPMODELS_DB_SECRET` / `KIN_DB_SECRET` 时加密，否则明文；10 分钟过期，完成或过期后清空），Worker 不再写 `oauth-sessions.json`，启动时会删除旧文件。
- 凭据库不保存代理地址：代理归账号配置，Worker 从账号配置直读。
- 凭据库读不出（主密钥文件缺失或记录被篡改）时，Worker 保留该账号上一份完好的配置与凭据，「Gateway Worker」页“事实直读”显示读取出错的账号；先恢复主密钥文件。
- Worker 对事件页响应签名，控制面验签；Worker 必须与控制面同一版本（第 12 节）。

## 11. Codex 执行设置与配置版本（统一控制面重构 P4、P6）

账号调度、预热、重置卡、点数超额，不再写进 `routing.json`（原有的 BPS 开关、BPS 默认模板和 BPS 图片策略随 BPS 下线删除，迁移 133 清掉库里的旧值）：

- 这些设置保存在控制面数据库（`executor_settings`），每次修改都会推进配置版本并写审计。
- 首次启动新版本时，在加载 `routing.json` 之前自动导入原有值。原文件先备份为同目录的 `routing.json.bak-<时间>`，再删除这些键，`routing.json` 回到上游格式。
- 回滚到旧版本：停止控制面，把最近的 `routing.json.bak-<时间>` 复制回 `routing.json`，然后启动旧版本。之后在新版本里改过的设置不会带回，需要在旧版本里重新设置。`.bak` 是整文件，升级后改过的其他 `routing.json` 键（例如故障转移）也会一起回到升级前，复制前先对比。
- 再次升级时保守合并回滚期间的修改（最终审计 U1）：数据库已有设置、`routing.json` 又带这些键时逐键比较（按新版本规范化，键顺序不算改动）。每份备份带顶层标记 `_tapmodels_backup`（值为这份备份自己的时间戳），把备份复制回去后旧版本改写文件时保留它：再次升级时文件带有效标记，就只与那一份备份比较，与它不同的键即回滚期间改过（改回默认值、改回其他备份里的值也能识别），数据库仍等于合并基线时导入，否则视为冲突。标记读出后立即从 `routing.json` 去掉（导入出错也不残留），起点另存在本次备份里供失败重试使用。文件没有标记、或标记指向的不是存在的有效时间戳备份时（手工改的文件、本功能之前的备份），按下面的保守规则。手工拼装或大改 `routing.json` 时请删掉 `_tapmodels_backup`：保留标记时，与那份备份不同的键都会被当作回滚期间的修改导入。参照值：上一次导入或合并之后数据库里的设置（合并基线，与设置同库保存，从面板备份恢复时随数据库恢复）、所有带时间戳的 `routing.json.bak-<时间>`、默认值。文件值等于任一参照或等于数据库当前值，视为回滚期间没改，保留数据库的值：旧版本的起点只可能是恢复的某一份备份，或者对着已删键的文件补出的默认值。与三者都不同的键是回滚期间改的：数据库仍等于合并基线时导入，推进设置版本并写审计（操作人 `migration:routing.json-rollback`，审计里有改前的值）；新版本里也改过时视为冲突，保留数据库的值，并在日志里列出两边的值。保守规则下，在旧版本里改回默认值或改回任何一份备份里的值无法与上面区分，不导入，日志会列出这些键，需要在新版本里重新设置。写回 `routing.json` 时去掉标记。非法值逐键跳过。合并基线和时间戳备份都没有时（本功能之前就已升级、备份又被清理），维持忽略并告警。导入出错（数据库故障等）时不清理文件，本次备份改名为 `.failed`；同一次启动里上游加载 `routing.json` 时可能已把本地键删掉，下一次启动会从比最近有效备份更新的 `.failed` 备份取回本地键重试，成功后改名为 `.failed.retried`；之后又有正常导入写出更新的备份时，旧的 `.failed` 改名为 `.superseded`、不再重试。备份先以 `.pending` 写出、导入成功后才改成时间戳名，导入提交前进程被杀时，下一次启动照常合并、不会把这份备份当作参照。标记已从 `routing.json` 去掉、导入还没提交时进程被杀（或导入出错而上游没有改写文件），下一次启动文件仍带本地键却已没有标记：比最近有效备份更新的 `.pending` / `.failed` 与文件的本地键一致时，借用其中存的起点（最终审计 N1b）；不一致（之后旧版本或手工又改过文件）时不借，按保守规则。从面板备份恢复时不做合并，以恢复的数据库为准：恢复的 `routing.json` 已删键时，启动时留下的失败导入保留到下一次启动重试；恢复的文件仍带本地键时，恢复写出新备份，之前未重试的失败导入随之作废（改名 `.superseded`）。恢复时出错的备份后缀为 `.restore-failed`，不参与重试。面板恢复写出的备份带来源标记 `_tapmodels_backup_source: "restore"`：恢复中途进程被杀留下的 `.pending`，下一次启动按恢复语义完成（以恢复的数据库为准、不合并），不论之后 `routing.json` 里的本地键被手工删掉还是仍在文件里（最终审计 N4）；运维把这样的备份复制回 `routing.json` 时，来源字段与标记一起被去掉，不影响之后的合并。
- 在「设置 → OpenAI → Codex 执行设置」修改：表单按设置描述生成，保存时服务端按同一描述校验，非法值会标出字段。
- Worker 在下一次心跳（约 15 秒）内收到新设置。
- 每个请求依据的设置版本记在请求尝试（`request_attempts.settings_revision`）和 Worker 回执中，用于诊断“按哪一版设置执行”。
- 每个 Worker 的健康接口会报告它已应用的 `settings_revision`。
- 多人同时修改时，后保存的人会收到提示，页面会重新载入最新值。

## 12. 已移除的开关、升级与版本回滚

统一控制面重构期间的开关已全部移除，对应能力固定为最终形态。`.env` 里仍写着下列键时，控制面启动告警一次 `control plane switch … has been removed and is ignored` 并忽略，可以删除：

| 已移除的键 | 移除时间 | 现在的行为 |
| --- | --- | --- |
| `KIN_CREDENTIAL_CUSTODY` | 2026-11-06 | 凭据固定由控制面凭据库托管（第 10 节） |
| `KIN_REFRESH_LEASE` | 2026-11-07 S1b | Worker 刷新后直接按代次写回凭据库，没有刷新租约（第 9 节） |
| `KIN_EXECUTOR_EVENTS` | 2026-11-07 S2 | 结算与账号运行态只走事件通道（第 8 节） |
| `KIN_REDIS_URL`、`KIN_REDIS_PREFIX` | 2026-11-07 S3 | 单个 Worker，运行态与协议状态留在本地数据目录（第 13 节） |
| `KIN_CODEX_GATEWAY_INSTANCE_KEYS`、`KIN_CODEX_GATEWAY_BOOTSTRAP_WINDOW_SECONDS` | 2026-11-07 S4 | 托管 Worker 用会话密钥，外部 Worker 用共用令牌（第 2 节） |
| `KIN_CODEX_GATEWAY_MULTI_WORKER`、`KIN_CODEX_GATEWAY_REQUIRE_MTLS` | 2026-11-07 | 只支持同机单个 Worker，环回 HTTP + HMAC |

升级到 2026-11-07 S1–S4 的版本：

1. 控制面与托管的 Worker 在同一镜像里，整体换镜像即可；外部管理的 Worker 必须同时换成同一版本（新控制面不再接受旧版 Worker 的授权、回执推送与实例密钥）。没有数据库迁移。
2. 升级后从 `.env` 删除上表中的键（生产为 `KIN_EXECUTOR_EVENTS=primary`、`KIN_REDIS_URL`、`KIN_REFRESH_LEASE`、`KIN_CREDENTIAL_CUSTODY`），停掉 Redis 容器（`docker rm -f tapmodels-redis`）。Worker 数据目录里的 `instance-key.json` 与回执 spool 目录不再读取，可以删除。
3. 升级那一刻正在进行的账号授权要重新开始（授权链接改由控制面生成）。
4. 迁移 130（S5）单独发版：破坏性、只能前滚，升级前手工快照数据库并备份主密钥文件（第 14 节“数据库收缩（S5）”）。

与开关无关、升级即生效的变化（最终审计 F3、F4）：

- `routing.json` 被改写：Codex 执行设置导入 `executor_settings` 后从文件删除，原文件先备份为同目录的 `routing.json.bak-<时间>`（第 11 节）。
- 设置改从控制面数据库读取，请求路径缓存 1 秒；修改后 Worker 在下一次心跳（约 15 秒）内收到。
- Worker 启动时删除数据目录里的 `oauth-sessions.json`，授权会话改存控制面数据库；以数据库密钥（`TAPMODELS_DB_SECRET` / `KIN_DB_SECRET`，经标准入口启动时自动生成）加密，只有绕过入口直接启动且没有配置时才明文保存（第 10 节“其他变化”）。
- 账号导出不再调用 Worker 的明文凭据接口（已删除），读凭据库（第 10 节）。
- Worker 总会写数据目录 `events/` 并逐条 fsync，已确认的整段保留 24 小时（第 8 节）。
- Worker 从控制面数据库直读账号（第 14 节），控制面不再推送投影；旧版本生成的 `custody-key.json` 不再使用，可以删除。
- 刷新：Worker 自行定时刷新，结果直接写回凭据库（第 9 节）。
- `/v1/models` 只读控制面缓存（上游目录同步），不在请求路径上实时查询 Worker。
- 心跳时间按控制面收到的时刻记录，面板健康探测失败不再刷新心跳。

运行状态：

- 「Gateway Worker」页顶部的“控制面状态”卡片（接口 `GET /api/panel/gateway-workers` 的 `control_plane` 字段，仅超级管理员）显示事件收件箱近 24 小时：已处理（含只记录、已过时）、差异（含缺失）、失败或无效的条数，尝试补齐失败与重试中的条数，各实例未拉取的事件数（Worker 写到的位置减去控制面已处理与 Worker 已确认中较大的一个）。
- 汇总结果在控制面缓存 60 秒；收件箱统计走迁移 121 的覆盖索引（`idx_executor_event_inbox_stats`），只做近 24 小时的索引范围扫描、不扫整张收件箱。读取失败时显示“读取失败”，不影响实例列表。
- 对账（只读）：`node scripts/executor-replay-diff.mjs --db data/kin.db --since-hours 24` 检查收件箱的问题状态、回执是否都有对应事件，以及回执与账本的用量可信度、token 与成本是否一致；有问题时退出码为 1。

版本回滚：

- 回到 2026-11-07 S1–S4 之前的版本（例如 v1.4.048.10）：整体换回镜像（外部 Worker 同步换回），回滚前在 `.env` 写回 `KIN_EXECUTOR_EVENTS=primary`、`KIN_REFRESH_LEASE=on`、`KIN_CREDENTIAL_CUSTODY=control`（旧版本的默认值是 `off`/`off`/`worker`，不写会改变结算与凭据行为），需要 Redis 时重新启动 Redis 容器并写回 `KIN_REDIS_URL`。没有数据库迁移需要回退；新版本授权或刷新写入凭据库的令牌，旧版本照常读取。旧版托管 Worker 会重新经引导领取实例密钥（数据目录里还在的 `instance-key.json` 照常使用）。
- 回到不含本重构的版本（例如 `v1.4.038.14`）：

1. 先按上一条回到仍有托管与租约开关的版本，确认运行正常；再把开关逐个改回默认并重启：`KIN_CREDENTIAL_CUSTODY=worker`、`KIN_REFRESH_LEASE=off`、`KIN_EXECUTOR_EVENTS=off`，删除 `KIN_REDIS_URL`。**control 托管下必须先切回 `worker` 再换版本**：旧版 Worker 会自己刷新令牌，凭据库在回滚期间不再更新。
2. 停止控制面，按第 11 节把一份 `routing.json.bak-<时间>` 复制回 `routing.json`，然后启动旧版本。新增的数据库表与列旧版本不读取，迁移不需要回退。
   - 一般用最近的一份。如果上一次回滚没有恢复备份就启动了旧版本，那次再升级留下的最新备份里是旧版本补出的默认值，可以改用更早、内容正确的一份。
   - 恢复哪一份都不会在再次升级时覆盖新版本里的设置：与任何一份时间戳备份、合并基线或默认值相同的值都按“没改”处理（第 11 节）。
3. 不可逆或有损的项（回滚前评估）：
   - 升级时 Worker 删除了数据目录的 `oauth-sessions.json`，授权会话改存控制面数据库；升级那一刻正在进行的账号授权需要重新开始，回滚后旧版本看不到升级期间创建的授权会话。
   - 回滚期间在旧版本改过的 Codex 执行设置，再次升级时保守合并（第 11 节）：改回默认值或备份里原值的修改不会导入，与新版本冲突的修改以数据库为准；日志列出这些键，需要在新版本里重新设置。
4. 再次升级到含迁移 133 的版本时，凭据库里的 BPS 记录会被整体删除（第 14 节“删除 BPS（迁移 133）”），不需要再手工清理回滚期间旧版 Worker 刷新过的 BPS 令牌。

## 13. 共享运行态（Redis，2026-11-07 S3 删除）

只支持同机的单个 Worker（第 7 节）后，Redis 只在替换实例的约 45 秒接替窗口里有用，已整体删除：账号并发、冷却与冻结只在 Worker 进程内计数；原生密文签发账号记录写数据目录（配置凭据包密钥时加密），Worker 重启后都保留。Worker 健康接口与「Gateway Worker」页不再有“共享运行态”。升级后删除 `.env` 里的 `KIN_REDIS_URL`、`KIN_REDIS_PREFIX` 并停掉 Redis 容器（第 12 节）。

## 14. Gateway 事实直读（设计第 19 节）

Worker 同机以只读方式直读控制面数据库（`kin.db`），账号的配置、分组与凭据都以库为准（用户 2026-11-06 决定，只支持同机部署）。2026-11-06 起（G4a）控制面不再向 Worker 推送投影（PATCH、导入、逐实例删除、心跳对账）。

- **读取契约**：迁移 124 定义的视图 `gateway_account_facts_v1`、`gateway_account_groups_v1` 与契约版本表（迁移 133 起契约版本为 2，Worker 只接受 2）；触发器在与账号事实相关的写入后推进事实版本。Worker 固定一条只读连接（`mode=ro`、`query_only`），每 0.5 秒查一次 `PRAGMA data_version`，有变化才在短事务里增量读取，解密在事务外；每 10 分钟全量对账。
- **库文件被替换与陈旧**（审计阶段 1 W4）：每轮比对 `kin.db` 的设备号与 inode，恢复备份或重建库换掉文件后关闭并重开只读连接与凭据写回连接，按新库全量重读；面板恢复备份后托管器还会排空并重启 Worker。距最近一次成功读取超过 2 分钟时 Worker 拒绝调度（`/internal/v1/execute` 返回 503 `gateway_facts_stale`，未发送），健康与心跳 `facts.status` 带 `stale_seconds`、`stale`，实例标为 degraded。
- **解密**：`secret_json` 用数据库字段密钥（`TAPMODELS_DB_SECRET` / `KIN_DB_SECRET`），凭据库用主密钥文件。Worker 只读主密钥文件、不创建；文件缺失时这些账号标为读取出错。
- **配置**：控制面托管的同机 Worker 自动得到 `KIN_CODEX_GATEWAY_FACTS_DB`（数据库绝对路径）与 `KIN_CREDENTIAL_MASTER_KEY_FILE`（与控制面相同的解析规则）；数据库字段密钥随环境继承。外部启动的同机 Worker 需自行设置这三个变量，否则读不到任何账号。`KIN_CODEX_GATEWAY_FACTS` 只接受 `primary`（默认）与 `off`（只用于不接控制面的本机调试）；G2/G3 过渡用的 `shadow` 已删除，`.env` 里仍写 `shadow` 时 Worker 拒绝启动，删除该行或改为 `primary`。
- **合并规则**（Worker 每次读到事实变化）：
  - **配置与分组以库为准**：启停、并发、RPM、权重、模型范围、分组（`group_resources`）、自动重置卡、代理与 WS 上限、请求位置、安装身份。复制分组、改分组、暂停等修改约 0.5 秒内生效。
  - **凭据只前进不后退**：库里原生代次更高（重新授权、刷新报告已写库）时换入；本地更高（本实例刚刷新、报告还没写库）时保留本地令牌。
  - **运行态留在 Worker**：在途、冷却、额度、错误保护、Cookie 等不受影响；`accounts.json` 继续作为本地缓存（事实短暂读不到时照常接单，超过 2 分钟拒绝调度）。
  - 库里读不出的账号（主密钥缺失、密文校验失败）保留上一份完好的配置与凭据；库里没有的本地账号停止接单（不删除）；墓碑账号（永久删除）从本地删除，控制面不再逐实例调用删除接口。
- **凭据写入**：授权与账号文件导入由控制面直接写凭据库（2026-11-07 S1）；刷新由 Worker 按代次写回（第 9 节）。
- **同步状态**：绑定每个账号一行（迁移 128；迁移 130 起不记实例），是账号的运行态：运行账号 ID、Worker 是否读到最新事实（「Codex 账号」页“Worker 加载”）、在途、凭据终态、额度。健康、接单中的实例读到当前事实序列后把绑定标为“已同步”，读取出错的账号为“同步异常”；心跳里的这些运行态只采信健康、接单中的实例，替换实例（含实例 ID 变化）的接替窗口里 Drain 或不健康的旧实例不能覆盖；旧实例的回执与额度按运行账号记到同一账号。控制面向 Worker 发请求（账号测试、额度、刷新等）一律发给当前接单的实例。永久删除的账号在 Worker 确认读到墓碑后去掉绑定。「Gateway Worker」页实例卡片的“事实直读”显示已加载的账号数与读取出错数，悬停列出出错账号与字段。
- **上线前检查**（从更早版本升级时）：

  ```bash
  node scripts/gateway-facts-preflight.mjs --data-dir data
  ```

  只读检查（不写库、不创建主密钥文件）：逐个账号检查运行账号 ID、安装身份、凭据库原生记录（能否解开、代次是否不低于绑定记录）与出站代理（分组只以 `group_resources` 为准）。有问题时退出码为 1；缺凭据或安装身份的账号需要重新授权（原 `--apply` 从 Worker 收录的路径随 S1 删除）。
- **安装身份**：账号的安装身份（授权链接的 stable id、出站关联 ID 隔离）记在 `config.installation_id`：新账号授权时由控制面生成，重新授权沿用（生产存量账号已于 2026-11-06 由 preflight 回填）。
- **数据库收缩（G5，迁移 128，破坏性）**：删除投影任务表 `gateway_worker_projection_jobs` 与 `gateway_worker_scopes`；账号绑定改为每个账号一行（同一账号原有多行时保留已同步、最近更新的一行，凭据代次取最高）；删除回执的 `projection_revision`、实例的托管公钥与证书列；删除 Gateway 账号 `config_json` 里的 `group_ids`、`projection_revision`、`config_fingerprint`。控制面启动时自动执行。**入口不会自动快照数据库**（`data/backups/auto/` 里的快照是此前部署时手工做的；迁移 128 文件头的“自动快照”说法有误，已应用的迁移不能改文件），升级前要手工停写快照数据库并备份主密钥文件。
- **供应商门控（迁移 129，只增不删）**：供应商（或其上级）停用、平台授权不含 OpenAI 时，它的 Codex 账号不再接单；供应商收回某个分组的授权（或按名称授权的分组改了名）后，账号在该分组里不再被调度。`group_resources` 里的成员关系不动，重新授权后自动恢复，与 VM 槽位选号时的供应商核对一致。读取契约版本不变（只增列 `vendor_active`），旧版 Worker 忽略新列，回滚镜像不受影响。
- **数据库收缩（S5，迁移 130，破坏性）**：账号绑定与授权会话重建为不含 `gateway_instance_id`（授权会话的幂等键改为全局唯一，同一幂等键原有多行时保留最近更新的一行；绑定投影时期的 `blocked`、`archived` 状态改为 `pending`，下一次心跳重新标记）；删除表 `gateway_worker_instance_keys`、`gateway_worker_bootstrap_grants`、`gateway_worker_receipt_offsets`、`credential_refresh_leases`；删除实例表的 `approval_state`、`shared_state_json`。控制面启动时自动执行；入口不会自动快照数据库，升级前手工停写快照数据库并备份主密钥文件。账号授权不再要求有在线的 Worker（写库后由 Worker 直读加载）。
- **删除 BPS（迁移 133，破坏性）**：BPS 通道停止运营后删除其数据：凭据库 `grant_kind='bps'` 的记录；Gateway 账号 `config_json` 里的 `bps`、`bps_grant`、`bps_catalog`、`bps_verification`、`bps_moved`；账号绑定的 `bps_*` 运行态列与恢复探测表 `gateway_bps_probes`；Codex 执行设置的 `bps_enabled`、`bps_images`、`bps_defaults`；API Key 的 `codex_route` 列；收件箱里的 `probe.recorded` 事件。事实视图 `gateway_account_facts_v1` 重建为不含 BPS 列、触发器 `gateway_facts_account_update` 不再比对 BPS 配置，读取契约版本 1 → 2。新版 Worker 只接受 2、旧版 Worker 读到 2 拒绝加载事实，控制面与 Worker 必须同批升级（托管 Worker 随镜像一起换即可，外部管理的 Worker 同时换成同一版本）。`usage_logs.authorization_mode` 与 `request_attempts.route`、`stage` 的历史值保留，日志详情只读展示。控制面启动时自动执行；入口不会自动快照数据库，升级前手工停写快照数据库并备份主密钥文件。
- **回滚**：迁移 128、130、133 只能前滚。迁移 133 部署后回滚到更早的镜像，要先用部署前的数据库快照恢复（快照之后的使用记录与账号修改会丢失）：旧版 Worker 只接受契约版本 1，删掉的 BPS 数据也无法还原。迁移 130 部署后回滚到更早的镜像（含 S1–S4），要先用部署前的数据库快照恢复（快照之后的使用记录与账号修改会丢失）：旧版本仍读写被删除的表与列。部署 G5 之前的版本（G4a、G4b）只删代码、不改数据库，可以把镜像换回 v1.4.048.8；G5 部署后回滚到更早的镜像，要先用部署前的数据库快照恢复（快照之后的使用记录与账号修改会丢失），旧版本读不到删除的列与配置键（例如账号分组）。
