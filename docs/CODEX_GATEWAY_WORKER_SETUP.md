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

没有全局开关：API Key 所在分组绑定了 Gateway 账号时，该分组的 Codex 请求走 Worker；未绑定的分组保持现有 Codex VM 行为。需要临时让所有分组都回到 VM 时设置 `routing.codex.gateway_worker.preference = "vm"`。

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
- 请求模型在某账号的 BPS 名单内、且请求可由 BPS 承载时，先走 BPS 通道。可承载指 Responses/Chat 流式、不续接上一轮响应、不强制使用生图或外部联网搜索；托管工具与加密内容按对应开关决定。图片只用 BPS 原生附件上传（不做临时 HTTPS 中转）：远程图片链接由 Worker 经账号代理下载后与内嵌图片一样上传为附件再引用，下载失败返回 400 `invalid_image_url`；结构化输出在本地校验；compaction 触发项照常转发。
- BPS 失败可安全重放时，先换其他账号的 BPS；BPS 都不可用、满载或换号用尽后走原生通道，同一账号也可以。
- BPS 的限流、模型无权、授权失效与 403 停用只影响该账号的 BPS 通道。额度耗尽是同一 ChatGPT 账号的共享结论，两条通道一起跳过。
- 原生授权失效时，账号仍可走 BPS。

**状态与记录**：
- 账号列表套餐后显示 `+BPS`（生效中）或 `+BPS!`（需重新授权或 403 停用）；详情页「账号」页签有 BPS 卡片。
- 使用记录的「授权方式」（超管诊断）显示实际承接的通道。
- 供应商门户「账号池」与运营端「供应商平台 → 账号池」的 Gateway 账号行菜单有「BPS 授权」，功能同上（需开放 Gateway 运行控制 `allow_runtime`）。
- 发给 Codex 客户端的模型清单中，经 BPS 的模型窗口收窄到 922k、自动压缩阈值 830k，并且不声明多智能体。
- 工具回放与会话目录保存在 Worker 数据目录 `bps_state.json`，重启后保留（不在多个 Worker 实例之间共享）。
- 403 自动恢复的每次探测（时间、模型、结果、token）显示在账号详情的 BPS 卡片和 BPS 对话框中，不进使用记录、不计费。

Worker 的 BPS 端点与客户端可用环境变量覆盖（一般不需要）：`KIN_CODEX_GATEWAY_BPS_BASE_URL`（默认 `https://bps.openai.com/basispoints/api`）、`KIN_CODEX_GATEWAY_BPS_CLIENT_ID`、`KIN_CODEX_GATEWAY_BPS_AUTHORIZE_URL`、`KIN_CODEX_GATEWAY_BPS_REDIRECT_URI`。

## 7. 多 Worker 与跨主机部署

多 Worker 需要在控制面设置 `KIN_CODEX_GATEWAY_MULTI_WORKER=1`。此时每个账号会投影到所有接单实例，账号的并发、RPM、冷却与错误计数按实例各算一份，实际可用上限约为配置值 × 实例数；错误保护冻结经心跳共享，传播延迟为一个心跳周期。所有 Worker 必须使用同一个 `KIN_CODEX_GATEWAY_CREDENTIAL_BUNDLE_KEY`。

本文的配置只覆盖同机环回明文 + HMAC。跨主机必须：

- `KIN_CODEX_GATEWAY_REQUIRE_MTLS=1`，并配齐 `TLS_CERT_FILE / TLS_KEY_FILE / TLS_CA_FILE`
- 回连控制面改成 `https://`，并配 `TLS_CLIENT_CERT_FILE / TLS_CLIENT_KEY_FILE`
- `ADVERTISE_URL` 用 `https://`（明文模式下 Go 会直接拒绝 https 的 advertise 地址）

真实双向证书链仍待目标部署环境验收；控制面当前仍由部署层反代终止公网 TLS。
