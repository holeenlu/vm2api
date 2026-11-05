# Codex Gateway Worker 启动配置

适用于 `main`（2026-11-03 起包含 `worker/cmd/kin-codex-gateway` 与"Codex 账号 / Gateway Worker"页面）。

状态：灰度。真实 OpenAI OAuth、真实 mTLS 证书链、真实代理出口、生产滚动升级和多 Worker 压测都未在目标环境验收，不要直接接生产流量。

## 1. 角色与边界

| 对象 | 是什么 | 谁启动 |
| --- | --- | --- |
| 控制面（Node） | 对外入口与鉴权、分组与模型范围、协议转换、计费与 Receipt 对账、续接归属、账号管理与投影、策略下发 | `docker compose up -d` / `npm start` |
| Gateway Worker（Go `kin-codex-gateway`） | 一个进程承载全部 Codex 账号：持有凭据，选号、重试与换号，额度与错误保护，上游 HTTP/WS 连接与指纹，出站改写 | 默认由控制面托管启动，见第 3 节 |

控制面入口（`scripts/docker-entrypoint.sh`）把镜像内的 `kin-codex-gateway` 复制到 `bin/`，控制面启动时随之托管启动 Worker，不需要额外开关。"Gateway Worker"页面显示"暂无已注册 Gateway Worker"时，先看页面上的托管状态：`missing_binary` 表示 `bin/` 下没有二进制，`backoff` 表示 Worker 反复退出（原因见控制面日志里的 `[codex-gateway]` 行），`external` 表示托管已关闭、需要外部启动。

实例不在页面上新建：Worker 启动后按 `KIN_CODEX_GATEWAY_CONTROL_PLANE_URL` 自己 POST 注册，之后每 15 秒心跳一次。

**默认拓扑：一个控制面 + 一个同机 Worker，由控制面托管（第 3 节 A）。** 账号的并发、RPM、冷却与错误保护计数都在 Worker 进程内，单实例时只有一份。控制面默认处于单 Worker 模式：已有在线接单的实例时，另一个实例的注册与心跳返回 409 `gateway_single_worker`，Worker 日志会打印一次原因并继续重试。替换实例时先 Drain 或停止旧实例，旧实例 drain 或 45 秒无心跳后新实例即可接单。确需多 Worker（例如出口必须分布在多台机器）时在控制面设置 `KIN_CODEX_GATEWAY_MULTI_WORKER=1`，见第 7 节。

## 2. 密钥

控制面托管（默认）时不需要手工准备：两个密钥未配置时由控制面生成并保存在 `data/runtime-secrets.json`。只有外部管理的 Worker（多 Worker、跨主机，见第 3 节 B）才需要在 `.env` 里显式写出，两侧使用同一个值。两个密钥都用高熵随机值，互不复用：

```bash
openssl rand -hex 32
```

写进仓库根目录的 `.env`（没有就 `cp .env.example .env && chmod 600 .env`）：

- `KIN_CODEX_GATEWAY_INTERNAL_TOKEN` — 控制面与 Worker 共用的内部 HMAC token。两侧必须一致。
- `KIN_CODEX_GATEWAY_CREDENTIAL_BUNDLE_KEY` — 账号凭据 bundle 的 AES-GCM 派生密钥。**所有可互相投影账号的 Worker 必须是同一个值**；配了 `CONTROL_PLANE_URL` 而没配它，进程会拒绝启动。它同时派生账号库落盘密钥：数据目录的 `accounts.json`（OAuth token、代理地址与 Cookie）以 AES-256-GCM 加密保存，旧的明文账号库在首次启动时自动改写为密文。**更换或丢失这个值后 Worker 会拒绝启动**（不会以空账号库覆盖原有凭据），只能换回原值或重新授权账号。回滚到不支持落盘加密的 Worker 前，先停止 Worker，再用新版本执行 `kin-codex-gateway -unseal-accounts`（读取同样的环境变量）把账号库改回明文。

`.env.example` 已给出其余键的默认值（实例 ID、监听、回连地址、容量）。控制面读取 `SUPERVISE / MULTI_WORKER / INTERNAL_TOKEN / CREDENTIAL_BUNDLE_KEY / REQUIRE_MTLS / ALLOW_INSECURE / TLS_CLIENT_*`；其余键由 Worker 进程读取，托管时控制面把自己的环境（含这些键）原样传给 Worker。

`KIN_CODEX_GATEWAY_ALLOW_INSECURE` 保持留空：Node 与 Go 两侧的默认都是"只接受环回明文"。设成 `1` 会让控制面对任意主机都允许明文回连，跨主机场景请改配 mTLS 而不是打开这个开关。

## 3. 启动方式

### A. 控制面托管（默认，推荐）

不需要单独启动 Worker。`bin/kin-codex-gateway` 存在时，控制面以子进程拉起同机的一个 Worker：

- 监听 `127.0.0.1:8790`，实例 ID `gw-01`，数据目录 `data/codex-gateway`（0700），回连地址按控制面自己的 `PORT` 补齐为环回明文 + HMAC；`.env` 里显式写了的同名键优先。
- `KIN_CODEX_GATEWAY_INTERNAL_TOKEN` 与 `KIN_CODEX_GATEWAY_CREDENTIAL_BUNDLE_KEY` 未配置时由控制面生成并保存在 `data/runtime-secrets.json`，重启沿用。
- 崩溃按 1s、2s、5s、10s、30s、60s 退避重启（稳定运行 1 分钟后重新计数），Worker 日志带 `[codex-gateway]` 前缀并入控制面日志；控制面关停时停止子进程。
- amd64 与 arm64 控制面镜像都从源码编译 `kin-codex-gateway`（发版冒烟检查确认 `bin/` 下存在且为 amd64 ELF），控制面入口把它复制到 `bin/`；面板升级或 `docker compose up -d` 重建控制面时，Worker 随之换成新版本，不需要另外的侧车、overlay 或 systemd 单元。
- Gateway Worker 页面显示托管状态（运行中、退避重启、未找到二进制等）、进程号、重启次数与最近一次退出。

### B. 外部管理（多 Worker / 跨主机）

在控制面设置 `KIN_CODEX_GATEWAY_SUPERVISE=0` 停止托管，再用下面的脚本或 systemd 在本机或其他主机启动 Worker；多实例同时接单还需要 `KIN_CODEX_GATEWAY_MULTI_WORKER=1`（见第 7 节）。外部 Worker 与控制面必须使用同一个 `KIN_CODEX_GATEWAY_INTERNAL_TOKEN`，多个 Worker 共用同一个 `KIN_CODEX_GATEWAY_CREDENTIAL_BUNDLE_KEY`，请在 `.env` 里显式写出。

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

账号不在"Codex 账号"页面新建，那个页面是控制面侧的只读投影（凭据只存在 Worker 运行时）。

1. 非超管身份还需要先放开供应商执行策略（目前没有界面）：

```bash
curl -X PUT "http://127.0.0.1:8787/api/panel/gateway-execution-policies?vendor_id=<供应商ID>" -H 'Content-Type: application/json' -d '{"platform":"openai","execution_kind":"gateway_worker","allow_create":true,"allow_runtime":true}'
```

2. 到**供应商门户**新建账号：平台选 OpenAI（固定由 Gateway Worker 执行，表单不再显示执行方式）→ 自有代理 → 选授权分组 → OAuth 或账号文件授权。名称留空时自动使用授权邮箱。建好的账号与虚拟机账号一起出现在供应商门户与运营端「供应商平台 → 账号池」，额度、套餐、费用等列同样显示；凭据失效时在账号池行菜单「授权」重新授权（需开放 `allow_runtime`）。

   超管的"供应商平台 → 账号池"表单没有"执行方式"字段，提交时固定 `execution_kind=vm`，在那里建出来的是 Codex VM，不会出现在 Codex 账号页。

3. 账号会以 `resource_kind=gateway_worker_account` 写入 `group_resources`，客户 API Key 必须绑定同一个分组才能调到它。一把 Key 同时要走 Claude VM 和 Codex Worker，就得在同一个分组里授权两类账号和模型。

没有可用实例时创建会直接失败（`gateway_worker_unavailable` / `gateway_account_projection_pending`），所以第 3 节必须先完成。

### BPS 授权（Excel Basispoints，OAuth 账号上的附加授权）

BPS 是同一付费 ChatGPT 账号上的第二份授权（Excel 插件客户端 `app_fnr0pYvVwwFDocDumLG3H2Bp`），与 sub2api 相同：一个 OAuth 账号同时持有原生授权与 BPS 授权，不另建账号。

1. 先按上文用 OAuth 或账号文件建好账号。新建对话框在授权成功后进入“添加 BPS 授权（可选）”，也可以跳过，之后在「编辑账号 → BPS 授权」里添加。
2. 添加方式有两种：
   - **授权链接**：浏览器经账号代理打开链接，用同一 ChatGPT 账号登录（Free 套餐会被拒绝）。授权后浏览器停在 `https://bps.openai.com/basispoints/extension/.../auth/callback?code=...&state=...`，复制地址栏完整链接粘回。
   - **授权文件**：粘贴 Excel 授权 JSON（`access_token`、`refresh_token`、`id_token`）。

   两种方式都要求与原生授权是同一 ChatGPT 账号。
3. 在「编辑账号 → BPS 授权」中：
   - 打开「启用 BPS」，勾选「BPS 模型」（最多 100 个）。只有勾选的模型走 BPS，其余照常走原生。
   - 「高级设置」：省略不支持的工具、忽略加密内容、缓存写入按输入计费（默认开）、403 自动停用（默认开）、自动恢复（探测间隔 1–10080 分钟，默认 60）、403 自动移组（目标分组或退出所有分组）。
   - 撤销授权会保留设置。
4. 「设置 → OpenAI → BPS（Excel Basispoints）→ 启用 BPS」是总开关（默认开），关闭后所有请求只走原生通道。

**调度**：
- 请求模型在某账号的 BPS 名单内、且请求可由 BPS 承载时，先走 BPS 通道。可承载指 Responses/Chat 流式、不强制使用生图或外部联网搜索；托管工具与加密内容按对应开关决定。图片只用 BPS 原生附件上传（不做临时 HTTPS 中转）：远程图片链接由 Worker 经账号代理下载后与内嵌图片一样上传为附件再引用，下载失败返回 400 `invalid_image_url`；结构化输出在本地校验；compaction 触发项照常转发，`/v1/responses/compact` 也转成带 compaction 触发项的普通请求。
- 续接：BPS 响应完整交付后 Worker 保存快照（2 小时），下一轮带 `previous_response_id` 时在原账号上展开为完整历史。历史来源不锁定通道（对齐 sub2api）：BPS 产生的历史在 BPS 不可用时改走原生，原生产生的历史也可走 BPS；上游在生成前读不了历史里的密文时，同一账号先去掉推理与回放密文、再替换 compaction 后重发（最多两步）。原生输出密文记录签发账号，原生选号优先回到该账号。
- 图片策略「设置 → OpenAI → Codex 执行设置 → BPS 图片策略」（控制面设置 `bps_images`）：自动压缩历史（默认，仅官方 Codex 客户端；其他客户端超限改走原生）/ 仅提醒 / 关闭，张数与单张、合计大小上限可调。
- 勾选 `gpt-image-2` 后，`/v1/images/generations` 与 `/v1/images/edits`（单张 data URL、无蒙版、png）先走 BPS 图片端点，格式被拒时改走原生。
- BPS 失败可安全重放时，先换其他账号的 BPS；BPS 都不可用、满载或换号用尽后走原生通道，同一账号也可以。
- BPS 的限流、模型无权、授权失效与 403 停用只影响该账号的 BPS 通道。额度耗尽是同一 ChatGPT 账号的共享结论，两条通道一起跳过。
- 原生授权失效时，账号仍可走 BPS。

**状态与记录**：
- 账号列表套餐后显示 `+BPS`（生效中）或 `+BPS!`（需重新授权或 403 停用）；详情页「账号」页签有 BPS 卡片。
- 使用记录的「授权方式」（超管诊断）显示实际承接的通道。
- 供应商门户「账号池」与运营端「供应商平台 → 账号池」的 Gateway 账号行菜单有「BPS 授权」，功能同上（需开放 Gateway 运行控制 `allow_runtime`）。
- 发给 Codex 客户端的模型清单中，经 BPS 的模型窗口收窄到 922k、自动压缩阈值 830k，并且不声明多智能体。
- 工具回放与会话目录保存在 Worker 数据目录 `bps_state/`（每个条目一个文件，只重写有变动的条目），重启后保留（不在多个 Worker 实例之间共享）。早期版本的单文件 `bps_state.json` 在启动时自动迁入并删除。
- 403 自动恢复的每次探测（时间、模型、结果、token）显示在账号详情的 BPS 卡片和 BPS 对话框中，不进使用记录、不计费。状态行显示下次探测时间与暂停原因；停用后可「手动解除停用」（同时清除 BPS 冷却）或「停止本次恢复」。
- 429 按上游声明的范围冷却（整个 BPS 通道 / 模型 / 端点），附件 429 同号等 1–5 秒重试一次；usage-policy 403 按账号 + 模型从 30 秒退避到 5 分钟，不停用账号；401 刷新 BPS 授权后同号重发一次；`invalid_encrypted_content` 不重试，提示重发明文历史。
- 「获取 BPS 可用模型」查询官方目录（受限模型、推理强度），并把目录中可用（未冷却）且在账号模型范围内的模型追加勾选（保存后生效）；`/models` 按目录声明推理强度；「测试」可选通道并做严格探测（精确模型 + 工具往返），结果记在 BPS 卡片。
- 批量编辑支持 BPS 设置；「导出账号文件 / 导入账号文件」带原生与 BPS 授权令牌（明文，导出有审计）。「设置 → OpenAI → BPS」可编辑新增 BPS 授权时的默认设置；Key 可设「Codex 通道策略」（自动 / 只走原生 / 只走 BPS，仅超级管理员）。

Worker 的 BPS 端点与客户端可用环境变量覆盖（一般不需要）：`KIN_CODEX_GATEWAY_BPS_BASE_URL`（默认 `https://bps.openai.com/basispoints/api`）、`KIN_CODEX_GATEWAY_BPS_CLIENT_ID`、`KIN_CODEX_GATEWAY_BPS_AUTHORIZE_URL`、`KIN_CODEX_GATEWAY_BPS_REDIRECT_URI`；`KIN_CODEX_GATEWAY_BPS_STREAM_IDLE_SECONDS`（默认 120）是 BPS 流空闲超时。

## 7. 多 Worker 与跨主机部署

多 Worker 需要在控制面设置 `KIN_CODEX_GATEWAY_MULTI_WORKER=1`。此时每个账号会投影到所有接单实例，账号的并发、RPM、冷却与错误计数按实例各算一份，实际可用上限约为配置值 × 实例数；错误保护冻结经心跳共享，传播延迟为一个心跳周期。所有 Worker 必须使用同一个 `KIN_CODEX_GATEWAY_CREDENTIAL_BUNDLE_KEY`。

本文的配置只覆盖同机环回明文 + HMAC。跨主机必须：

- `KIN_CODEX_GATEWAY_REQUIRE_MTLS=1`，并配齐 `TLS_CERT_FILE / TLS_KEY_FILE / TLS_CA_FILE`
- 回连控制面改成 `https://`，并配 `TLS_CLIENT_CERT_FILE / TLS_CLIENT_KEY_FILE`
- `ADVERTISE_URL` 用 `https://`（明文模式下 Go 会直接拒绝 https 的 advertise 地址）

真实双向证书链仍待目标部署环境验收；控制面当前仍由部署层反代终止公网 TLS。

## 8. 执行事件发件箱（统一控制面重构 P1）

Worker 把每次分发的最终结果（与回执相同）、账号凭据与 BPS 终态、额度变化、BPS 恢复探测写成事件，追加到数据目录 `events/`（分段日志，fsync 后才算产生）。控制面按事件流游标拉取并确认，已确认的整段保留 24 小时后删除。设计见 [ARCHITECTURE_CONTROL_PLANE_EXECUTORS_20261105.md](ARCHITECTURE_CONTROL_PLANE_EXECUTORS_20261105.md) 5.6。

控制面开关 `KIN_EXECUTOR_EVENTS`：

| 值 | 行为 |
| --- | --- |
| `off`（默认） | 不拉取事件，沿用回执与心跳；Worker 从心跳策略得知控制面不消费，自行确认事件、只保留 24 小时，不会因事件积压或日志故障拒单 |
| `shadow` | 拉取事件并与回执、探测记录比对，结果写入 `executor_event_inbox`，不改变任何业务数据；Worker 保留事件等待拉取，但不因事件日志故障或积压拒单 |
| `primary` | 以事件为主来源写回执与对账、账号终态、额度、探测，并在 60 秒后按事件补齐请求尝试；事件链路健康时心跳中的同类字段停写，链路异常时自动回到心跳写入；回执重放保留为幂等兜底 |

启用顺序：

1. 设为 `shadow` 并重启控制面，运行一段时间后执行比对（只读）：

   ```bash
   node scripts/executor-replay-diff.mjs --db data/kin.db --since-hours 24
   ```

   比对三个方向：事件与回执逐字段一致；已开始消费事件的实例，每张回执都有对应事件（最近 5 分钟内的记为待到达）；有使用记录的分发，账本的用量可信度、token 与成本与回执一致。输出 `differing 0`、`inbox problems 0`（状态统计中没有 `diff`、`missing`、`failed`、`invalid`），退出码为 0，才进入下一步。
2. 设为 `primary` 并重启控制面；观察一个发布周期（使用记录、结算、账号状态与 BPS 探测正常）。
3. 回滚：任何时候改回 `off` 并重启即可，回执与心跳通道一直保留；Worker 在下一次心跳后恢复自行确认。再次开启时控制面从 Worker 已确认的位置继续，不重放关闭期间的历史。

运维注意：

- 「Gateway Worker」页每个实例显示事件发件箱状态：控制面是否在消费、未确认条数与积压大小。Worker 健康接口与心跳里的 `events` 有同样的 `required`、`head`、`acked`、`backlog_bytes`、`healthy`。
- Worker 重启后到收到第一份心跳策略之前，`required_known` 为假（“未知”）：此时既不自行确认事件（控制面可能还没拉取重启前的事件），也不因事件拒单；“未知”超过 24 小时（心跳一直拿不到策略）按不消费处理。
- 控制面为 `primary` 时，若事件日志写入失败或未确认积压超过 512 MiB，Worker 显示 `degraded` 并以 503 `executor_event_log_unavailable` 拒绝新请求（请求未发出，控制面可换实例）；`shadow` 只告警不拒单。写入故障会在 10 秒维护周期内自动尝试恢复。先查磁盘空间与控制面拉取是否正常。
- 同一事件连续处理失败 5 次后记为 `failed` 并跳过；序号缺口连续 5 轮仍在才接受。两者都会告警，并计入比对工具的问题数。
- Worker 数据目录从旧备份或快照恢复后，控制面会发现事件流回退（日志 `went back`），从 Worker 已确认的位置重新处理；期间心跳继续写入账号状态。
- 控制面不消费事件（`off`）时，Worker 写事件日志不逐条 fsync，日志只供排障。
- 控制面日志中的 `executor events:` 警告表示无效事件、处理失败、序号缺口、积压超过 256 MiB 或 Worker 日志不健康。
- 删除或重建 Worker 数据目录会生成新的事件流，控制面自动从新流的第 1 条开始。

## 9. 凭据刷新租约（统一控制面重构 P3.1–P3.2）

OpenAI 的刷新令牌每次刷新都会轮换，旧令牌随即失效。同一账号投影到多个 Worker 时，如果各实例各自刷新，只有第一个成功，其余实例的令牌随即失效。控制面设置 `KIN_REFRESH_LEASE=on` 并重启后：

- Worker 刷新原生授权或 BPS 授权前，先向控制面申请租约。同一账号、同一授权类别，同一时刻只有一个实例能拿到。
- 拿到租约的实例刷新完成后报告结果。刷新成功时，控制面把新凭据投影到其他实例。
- 没拿到租约的实例不会使用手里的刷新令牌，最多等 20 秒，看投影能否送来新凭据；等不到时本次刷新失败，下次再试。
- 控制面不可达时，Worker 本次不刷新。
- Worker 把最近一次收到的租约策略保存在数据目录（`refresh-lease-policy`），重启后沿用。全新数据目录的 Worker 在收到第一份心跳策略前按“需要租约”处理：不做定时刷新；请求内需要刷新时先申请租约，控制面是不支持租约的旧版本时才自行刷新。
- 定时预刷新由控制面指派：每个账号只由一个在线实例（凭据代次最高者）定时刷新，其他实例跳过定时刷新、等投影；该实例离线后，下一次心跳（约 15 秒）改派。
- 以上两种失败都不会让账号被判为“恢复窗口耗尽而过期”。
- 默认 `off`，或者控制面是旧版本（不下发策略）时，Worker 照旧自行刷新。单 Worker 部署开启后没有可见变化。
- 控制面数据库表 `credential_refresh_leases` 记录每个账号、每类授权最近一次的持有者、结果与令牌指纹（SHA-256 前 8 字节，不可逆）。
- 换票请求已发出却没有拿到响应（超时、断连）时，上游可能已经轮换了刷新令牌。该账号的租约保持 10 分钟，期间任何实例都不会刷新它；10 分钟后的第一次刷新会得到明确结果。日志与租约表中记为 `ambiguous`。
- 回滚：改回 `off` 并重启即可，Worker 在下一次心跳后恢复自行刷新。

## 10. 凭据托管（统一控制面重构 P3.4–P3.9、P3.11）

控制面设置 `KIN_CREDENTIAL_CUSTODY=control` 后，账号令牌以控制面凭据库为准，默认值 `worker` 保持原行为：

- 令牌加密保存在 `executor_credentials` 表。主密钥文件与数据库同目录，文件名 `credential-master-keys.json`（权限 0600），也可用 `KIN_CREDENTIAL_MASTER_KEY_FILE` 指定位置。
- **主密钥文件必须与数据库分开备份。** 只有数据库备份时，令牌无法还原。
- 投影给 Worker 时，按各实例的托管公钥单独封装。Worker 在数据目录生成 `custody-key.json`，随注册与心跳提交公钥。
- 控制面必须配置与 Worker 相同的 `KIN_CODEX_GATEWAY_CREDENTIAL_BUNDLE_KEY`，用于解开 Worker 导出的凭据包和刷新后报告的新凭据。托管部署会自动生成并保存这个密钥。

启用步骤（多 Worker 部署建议同时开启 `KIN_REFRESH_LEASE=on`）：

1. 先升级控制面，再升级各 Worker。新版 Worker 的授权会话、事件页与导出响应签名依赖新版控制面。
2. 在「Gateway Worker」页逐个核对并确认外部 Worker 的托管公钥（见下文“实例托管公钥”）。未确认的实例在 control 模式下仍拿到共享凭据包，不能获得托管封装。同时核对已固定公钥的实例：早于本版本运行过时，当时首次登记的公钥是自动固定的，不认识的实例应删除。
3. 只读演练迁移，确认没有错误（演练以只读方式打开数据库，不创建主密钥文件，但会解开每个账号的凭据包，零错误才说明下一步能成功）。容器部署在控制面容器内执行，例如 `docker exec tapmodels node scripts/migrate-worker-credentials.mjs --data-dir /opt/tapmodels/data`：

   ```bash
   node scripts/migrate-worker-credentials.mjs --data-dir data
   ```

   - 内部令牌与凭据包密钥未通过环境变量给出时，脚本从 `<data-dir>/runtime-secrets.json`（托管部署自动生成）或 `.env` 只读取得，不会生成新密钥；都找不到时直接报错退出。
   - 脚本不执行数据库迁移：库结构落后于脚本所在版本时报 `schema_outdated`，先升级并启动一次控制面。
   - 导出失败的账号在 `export_failures` 中列出各实例的 HTTP 状态与错误码；报告开头的 `master_key_file` 是将要使用的主密钥文件。

4. 执行迁移。容器部署用 `KIN_CREDENTIAL_MASTER_KEY_FILE` 指定了主密钥文件时，执行脚本也必须带上同一个值，否则会在别处生成另一把主密钥：

   ```bash
   node scripts/migrate-worker-credentials.mjs --data-dir data --apply
   ```

5. 设置 `KIN_CREDENTIAL_CUSTODY=control` 并重启控制面。此后账号的授权、导入、重新授权与刷新轮换都会写入凭据库。
6. 回滚：改回 `worker` 并重启。Worker 上一直保留令牌副本，投影改回实例间共享凭据包；凭据库可保留，不影响运行。

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

实例托管公钥：

- Worker 上报的托管公钥一律先待确认，新实例的首个公钥也一样；控制面自己拉起的同机 Worker 由控制面从本机数据目录读出公钥，自动确认。
- 新实例登记、或数据目录被清空重建后，「Gateway Worker」页会显示“托管公钥待确认”，核对无误后点“确认替换公钥”。
- 确认前在 Worker 所在主机上核对指纹：查看该进程的启动日志（`codex-gateway: custody key fingerprint <指纹>`），或在该主机本机请求 `http://127.0.0.1:<端口>/internal/v1/health` 的 `custody_key_fingerprint`，与页面显示的“新指纹”一致才确认。不要通过页面登记的 `base_url` 远程查询来核对：冒充者可能已经改掉了这个地址。
- 确认之前，该实例照常工作，投影改用实例间共享凭据包。
- 注意：所有 Worker 共用内部令牌（`KIN_CODEX_GATEWAY_INTERNAL_TOKEN`）和凭据包密钥（`KIN_CODEX_GATEWAY_CREDENTIAL_BUNDLE_KEY`）。只泄露内部令牌时，对方能冒充实例调用内部接口，但拿到的凭据包需要凭据包密钥才能解开，托管封装也要管理员确认公钥后才会发出；两者同时泄露即等于全部账号的令牌泄露。两者都按机密保管。

主密钥文件：

- 数据库里已有凭据时，主密钥文件缺失会直接报错，不会自动生成新密钥。
- 在线轮换可用：轮换前会自动备份为 `credential-master-keys.json.bak-<时间>`，轮换后重启控制面，再执行 `--retire`。
- 容器部署时，建议用 `KIN_CREDENTIAL_MASTER_KEY_FILE` 把主密钥文件放到单独的卷上，并单独备份。

其他变化：

- 账号导出不再调用 Worker 的明文凭据接口（该接口已删除）：
  - control 模式读凭据库；
  - worker 模式解开 Worker 导出的凭据包。
- 授权会话（state、PKCE verifier）由控制面生成并保存（配置了数据库密钥 `TAPMODELS_DB_SECRET` / `KIN_DB_SECRET` 时加密，否则明文；10 分钟过期，完成或过期后清空），Worker 不再写 `oauth-sessions.json`，启动时会删除旧文件。
- 凭据库不保存代理地址：代理归账号配置，投影时取来源实例当前的代理。
- 没有在线来源时从凭据库重建：其他持有该账号的实例都超过 45 秒没有心跳（或已标记 offline）、或明确回答没有这个账号（唯一的 Worker 数据目录丢失也属于这种情况），且目标实例确实没有这个账号（Worker 返回 `account_not_found`、心跳回报里没有它，或没有绑定）时，control 托管直接用凭据库令牌与控制面账号资料（含控制面配置的代理）导入，日志有 `projected to <实例> from the vault`。有在线实例只是导出失败（超时、5xx、验签失败）时不重建，它可能持有更新的令牌。凭据库原生代次落后于绑定或刷新租约记录的代次时不重建、记为 drifted；只有 BPS 落后时只重建原生授权。重建不带回额度观测、冷却等运行状态，由后续请求重新观测。worker 托管下没有这条路径。
- control 模式下凭据库读不出（主密钥文件缺失或记录被篡改）时，该账号不投影到目标实例（记为 drifted），日志告警 `vault copy cannot be read`；先恢复主密钥文件。
- Worker 对事件页响应签名，控制面验签。控制面开启事件消费（`KIN_EXECUTOR_EVENTS=shadow|primary`）时，Worker 必须升级到同一版本，否则拉取会失败、回到心跳兜底。

## 11. Codex 执行设置与配置版本（统一控制面重构 P4、P6）

账号调度、预热、重置卡、点数超额、BPS 开关、BPS 默认模板和 BPS 图片策略，不再写进 `routing.json`：

- 这些设置保存在控制面数据库（`executor_settings`），每次修改都会推进配置版本并写审计。
- 首次启动新版本时，在加载 `routing.json` 之前自动导入原有值。原文件先备份为同目录的 `routing.json.bak-<时间>`，再删除这些键，`routing.json` 回到上游格式。
- 回滚到旧版本：停止控制面，把最近的 `routing.json.bak-<时间>` 复制回 `routing.json`，然后启动旧版本。之后在新版本里改过的设置不会带回，需要在旧版本里重新设置。`.bak` 是整文件，升级后改过的其他 `routing.json` 键（例如故障转移）也会一起回到升级前，复制前先对比。
- 再次升级时保守合并回滚期间的修改（最终审计 U1）：数据库已有设置、`routing.json` 又带这些键时逐键比较（按新版本规范化，键顺序不算改动）。参照值：上一次导入或合并之后数据库里的设置（合并基线，与设置同库保存，从面板备份恢复时随数据库恢复）、所有带时间戳的 `routing.json.bak-<时间>`、默认值。文件值等于任一参照或等于数据库当前值，视为回滚期间没改，保留数据库的值：旧版本的起点只可能是恢复的某一份备份，或者对着已删键的文件补出的默认值。与三者都不同的键是回滚期间改的：数据库仍等于合并基线时导入，推进设置版本并写审计（操作人 `migration:routing.json-rollback`，审计里有改前的值）；新版本里也改过时视为冲突，保留数据库的值，并在日志里列出两边的值。在旧版本里改回默认值或改回任何一份备份里的值无法与上面区分，保守起见不导入，日志会列出这些键，需要在新版本里重新设置。非法值逐键跳过。合并基线和时间戳备份都没有时（本功能之前就已升级、备份又被清理），维持忽略并告警。导入出错（数据库故障等）时不清理文件，本次备份改名为 `.failed`；同一次启动里上游加载 `routing.json` 时可能已把本地键删掉，下一次启动会从比最近有效备份更新的 `.failed` 备份取回本地键重试，成功后改名为 `.failed.retried`；之后又有正常导入写出更新的备份时，旧的 `.failed` 改名为 `.superseded`、不再重试。备份先以 `.pending` 写出、导入成功后才改成时间戳名，导入提交前进程被杀时，下一次启动照常合并、不会把这份备份当作参照。从面板备份恢复时不做合并，以恢复的数据库为准：恢复的 `routing.json` 已删键时，启动时留下的失败导入保留到下一次启动重试；恢复的文件仍带本地键时，恢复写出新备份，之前未重试的失败导入随之作废（改名 `.superseded`）。恢复时出错的备份后缀为 `.restore-failed`，不参与重试。
- 在「设置 → OpenAI → Codex 执行设置」修改：表单按设置描述生成，保存时服务端按同一描述校验，非法值会标出字段。
- Worker 在下一次心跳（约 15 秒）内收到新设置。
- 每个请求依据的设置版本记在请求尝试（`request_attempts.settings_revision`）和 Worker 回执中，用于诊断“按哪一版设置执行”。
- 每个 Worker 的健康接口会报告它已应用的 `settings_revision`。
- 多人同时修改时，后保存的人会收到提示，页面会重新载入最新值。
- 账号的 BPS 设置同样按描述生成表单。账号向导只在 Worker 支持 BPS 授权时提供“添加 BPS 授权”步骤。

## 12. 统一控制面开关一览与上线顺序

| 开关（控制面） | 默认 | 作用 | 回滚 |
| --- | --- | --- | --- |
| `KIN_EXECUTOR_EVENTS` | `off` | 执行事件发件箱：`shadow` 只比对，`primary` 以事件为主来源（第 8 节） | 改回 `off` 并重启 |
| `KIN_REFRESH_LEASE` | `off` | 刷新令牌租约，多 Worker 下同一账号只由一个实例刷新（第 9 节） | 改回 `off` 并重启 |
| `KIN_CREDENTIAL_CUSTODY` | `worker` | 令牌以控制面凭据库为准，按实例托管公钥封装投影（第 10 节） | 改回 `worker` 并重启 |
| `KIN_REDIS_URL` | 未设置 | 多个 Worker 经 Redis 共享并发、冷却与协议状态（第 13 节） | 删除该变量并重启 Worker |

Codex 执行设置迁入数据库（第 11 节）没有开关，升级后首次启动自动完成。

推荐顺序（每一步观察正常后再进行下一步）：

1. 升级控制面，再升级各 Worker。设置自动导入，三个开关保持默认，请求的调度、计费与凭据来源与升级前一致；与开关无关的变化见下文“版本回滚”的不可逆项。
2. `KIN_EXECUTOR_EVENTS=shadow`，运行一段时间后用 `scripts/executor-replay-diff.mjs` 确认零差异。
3. `KIN_EXECUTOR_EVENTS=primary`，观察一个发布周期。
4. 多 Worker 部署：`KIN_REFRESH_LEASE=on`。
5. 在「Gateway Worker」页确认外部 Worker 的托管公钥；备份数据库与主密钥文件，执行 `scripts/migrate-worker-credentials.mjs`（先演练、再 `--apply`），然后 `KIN_CREDENTIAL_CUSTODY=control`。

三个开关相互独立，任一步出现问题只回滚那一步。多 Worker 部署时可在任一步之后接入 Redis（第 13 节），它与这三个开关也相互独立。

运行状态（最终审计 U8）：

- 控制面启动时打印一次生效的开关值（`control plane switches: KIN_EXECUTOR_EVENTS=… KIN_REFRESH_LEASE=… KIN_CREDENTIAL_CUSTODY=… KIN_REDIS_URL=configured|unset`）。开关值拼错时按默认值运行，并告警 `control plane switch … is not one of …; running as …`。
- 「Gateway Worker」页顶部的“控制面状态”卡片（接口 `GET /api/panel/gateway-workers` 的 `control_plane` 字段，仅超级管理员）显示：
  - 四个开关的生效值，拼错的值标红并给出原值（疑似地址或密码时只显示前几个字符）；`KIN_REDIS_URL` 只显示控制面自己的环境是否配置（同机托管的 Worker 继承它），不显示地址，各实例实际是否在用 Redis 看实例上的“共享运行态”；
  - 事件收件箱近 24 小时：已处理（含只记录、已过时）、待比对、差异（含缺失）、失败或无效的条数，尝试补齐失败与重试中的条数，各实例未拉取的事件数（Worker 写到的位置减去控制面已处理与 Worker 已确认中较大的一个；`off` 时不显示）；
  - 刷新租约：持有中、结果不明与已过期的条数（到期后行不会被清理，下一次申请才覆盖），未到期的结果不明租约逐条列出（账号、授权类别、实例、到期时间）；控制面本次启动以来的租约冲突按原因计数（已被持有、代次落后、令牌已被轮换、结果不明期间），重启后清零。
- 汇总结果在控制面缓存 60 秒（收件箱统计在大表上要扫描，避免每次打开页面都让主线程停顿）；开关值实时。某一部分读取失败时只该部分显示“读取失败”，不影响其他部分与实例列表。

版本回滚（回到不含本重构的版本，例如 `v1.4.038.14`）：

1. 先把开关逐个改回默认并重启，确认运行正常：`KIN_CREDENTIAL_CUSTODY=worker`、`KIN_REFRESH_LEASE=off`、`KIN_EXECUTOR_EVENTS=off`，删除 `KIN_REDIS_URL`。**control 托管下必须先切回 `worker` 再换版本**：旧版 Worker 会自己刷新令牌，凭据库在回滚期间不再更新。
2. 停止控制面，按第 11 节把一份 `routing.json.bak-<时间>` 复制回 `routing.json`，然后启动旧版本。新增的数据库表与列旧版本不读取，迁移不需要回退。
   - 一般用最近的一份。如果上一次回滚没有恢复备份就启动了旧版本，那次再升级留下的最新备份里是旧版本补出的默认值，可以改用更早、内容正确的一份。
   - 恢复哪一份都不会在再次升级时覆盖新版本里的设置：与任何一份时间戳备份、合并基线或默认值相同的值都按“没改”处理（第 11 节）。
3. 不可逆或有损的项（回滚前评估）：
   - 升级时 Worker 删除了数据目录的 `oauth-sessions.json`，授权会话改存控制面数据库；升级那一刻正在进行的账号授权需要重新开始，回滚后旧版本看不到升级期间创建的授权会话。
   - BPS 协议状态已从 `bps_state.json` 改为 `bps_state/` 目录，旧版 Worker 读不到，回滚后进行中的 BPS 会话需要客户端带完整历史重来。
   - 旧版 Worker 改写 `accounts.json` 时会丢掉 BPS 令牌代次（`token_generation`）。
   - 回滚期间在旧版本改过的 Codex 执行设置，再次升级时保守合并（第 11 节）：改回默认值或备份里原值的修改不会导入，与新版本冲突的修改以数据库为准；日志列出这些键，需要在新版本里重新设置。
4. 再次升级后，如果要重新切到 `control` 或开启 `KIN_REFRESH_LEASE=on`：旧版 Worker 在回滚期间刷新过的 BPS 令牌代次从 0 重新计数，低于凭据库与刷新租约表里记录的代次。直接切换会把凭据库里过期的 BPS 令牌投影出去，租约也会把新令牌判为过期。切换前在 `worker` 托管、`KIN_REFRESH_LEASE=off` 下删除两张表里的 BPS 记录，再重跑迁移（演练、`--apply`），从 Worker 当前令牌重新收录：

   ```bash
   docker exec -i tapmodels node --input-type=module -e "import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync('/opt/tapmodels/data/kin.db'); console.log(db.prepare(\"DELETE FROM executor_credentials WHERE grant_kind='bps'\").run(), db.prepare(\"DELETE FROM credential_refresh_leases WHERE grant_kind='bps'\").run())"
   ```

## 13. 共享运行态（Redis，统一控制面重构 P5）

多个 Worker 承接同一批账号时，设置 `KIN_REDIS_URL` 后它们经 Redis 共享：

- **账号并发**：账号的并发上限在所有实例合计生效（不再是每个实例各自一份）；超出时按原有方式排队。
- **冷却与冻结**：一个实例上账号被冷却、被错误保护冻结、BPS 冷却或 BPS usage-policy 退避时，其他实例约 1 秒内也不再选它；提前解除同样约 1 秒传播。例外：错误保护冻结另有原有的心跳通道，提前解冻后，经心跳下发给其他实例的冻结要等下一次心跳（约 15 秒）才清掉。
- **协议状态**：BPS 工具回放、会话目录、续接快照、图片检查点与原生密文签发账号记录存进 Redis，同一会话落到另一个实例也能续接、优先回到原生密文签发账号。

配置：

- `KIN_REDIS_URL`：`redis://[:密码@]主机:端口/库号`，跨主机用 `rediss://`（TLS）。控制面托管的同机 Worker 继承控制面的环境变量，在控制面 `.env` 里设置即可；外部 Worker 各自设置同一个值。
- `KIN_REDIS_PREFIX`：键前缀，默认 `kin:gw:`。多套部署共用一个 Redis 时设成不同值。
- 协议内容以凭据包密钥（`KIN_CODEX_GATEWAY_CREDENTIAL_BUNDLE_KEY`）派生的密钥加密后写入；未配置凭据包密钥时协议内容不进 Redis，只共享并发、冷却与原生密文签发账号。签发记录只存（调用方范围 + 密文）的摘要、通道名与账号 ID。

部署（控制面容器为 host 网络，Redis 只监听本机回环地址）：

```bash
docker run -d --name tapmodels-redis --restart unless-stopped -p 127.0.0.1:6379:6379 redis:7-alpine redis-server --requirepass <密码> --maxmemory 512mb --maxmemory-policy volatile-lru --save "" --appendonly no
```

然后在 `.env` 加 `KIN_REDIS_URL=redis://:<密码>@127.0.0.1:6379/0` 并重启控制面。

- 所有键都带过期时间（协议状态空闲 2 小时、签发账号记录 24 小时、并发租约 1 分钟、冷却记录 24 小时），`volatile-lru` 在内存满时淘汰最久未用的键。
- 不需要持久化：Redis 数据全部可丢，丢失只会让续接或回放改为要求完整历史、并发与冷却短暂回到各实例各自计数，不影响计费与账号事实。

运行与故障：

- 「Gateway Worker」页每个实例显示“共享运行态”：Redis 正常时显示本实例持有的共享租约数与其他实例的限制条数；不可用时显示“已退回本地状态”。Worker 健康接口里有同样的 `shared_state`。
- Redis 不可用时，每个 Worker 退回单实例行为（本地并发计数、本地冷却、协议状态写数据目录），照常接单；每 5 秒探活，恢复后自动回到共享，日志分别有 `shared state (redis) unavailable` 与 `shared state (redis) is available`。
- `KIN_REDIS_URL` 格式写错（无法解析）时，Worker 不会因此停止：照常以本地状态接单，「Gateway Worker」页与健康接口报告共享运行态降级，`last_error` 写明原因（不含地址与密码），日志有 `shared state disabled`。改正后重启生效。
- 回滚：删除 `KIN_REDIS_URL` 并重启控制面（外部 Worker 各自重启），回到单实例行为；Redis 里的数据可直接清空。
