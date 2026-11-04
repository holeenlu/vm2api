# Gateway Worker Node/Go 实施状态

更新日期：2026-11-03。实现基线为 `codex-gateway` 分支，运行时不依赖 Rust 或 codex-proxy-rs；协议与调度行为以 codex-proxy-rs 为对照逐项对齐。

## 职责划分

- 选号、同实例重试与换号、并发等待、冷却和凭据刷新都在 Go Worker 内完成：Worker 持有账号的在途计数、RPM、额度和凭据，避免控制面复制一份选号器。
- 控制面负责分组授权与模型目录、协议转换、计费与结算、续接归属和 Receipt 对账；调度策略（`routing.codex.scheduling`）与等待预算按请求冻结后随 envelope 下发。
- 控制面只在 Worker 明确未发送（`X-Kin-Gateway-Send-State: not_sent`，如容量满、无可用账号、未连上）时换实例；已发送或结果不明的请求不跨实例重放。
- 15 号规划中“vm2api 唯一选号”的表述按上述划分执行：vm2api 决定分组与可用账号范围，具体账号由 Worker 在范围内选择。

## 与 codex-proxy-rs 的对齐

- 错误分类：按 CPR 判定顺序识别 `flex_unavailable`（终止）、`turn_rate_limit_exceeded`、容量拒绝（`server_is_overloaded`/`slow_down`）、429 仅 `usage_limit_reached` 判额度耗尽、`model_not_found`、身份验证与封禁、401 凭据过期、Cloudflare 挑战与空 404 路径封禁、402 额度。
- 重试与换号：上游过载（`server_is_overloaded`/`slow_down`）与 VM 路径同一规则——不同号重试，直接换号；因过载换号超过 1 次且全池近期失败率中位数 ≥30% 时停止换号，交付 503 并带 `Retry-After: 3`；失败率 ≥70% 且高出其余账号 25 个百分点的离群账号停放 60 秒。503 `server_error` 同号退避 5 次加抖动且耗尽不换号。提交前同号重试与换号总时长不超过 30 秒（不含首次排队等待），可安全重放的拒绝最多换号 3 次、总尝试 32 次，`Retry-After` 上限默认 240s（显式 0 表示不接受正数等待；服务器建议超过上限时不截短，放弃同号等待改走换号或原错误出口）；流式先窥视前导事件，前导内的 `response.failed` 仍可重试；发送结果不明不重放。最终交付的容量错误投影为 503 `server_error`。每次尝试写入 `request_attempts` 与 Receipt 的 `attempts`。
- 账号处置：额度耗尽冷却到重置时间，429 默认 60s，Cloudflare 挑战 10/30/90/120s，路径封禁连续 3 次判失效，模型拒绝按账号×模型冷却 30 分钟；成功推理解除限流冷却。
- 凭据：提前 5 分钟并按账号稳定错峰自动刷新，单飞加凭据代次 CAS，失败 5s×3^n 退避上限 300s、五次后每 10 分钟；`refresh_token_expired/reused/invalidated` 判终态；发送前刷新过期凭据，401 刷新后同号重试一次。
- 续接：只钉原账号，不钉凭据代次；原账号额度耗尽返回 400 `previous_response_not_found`，由客户端带完整历史重试。
- 调度：最高权重层内按 smart（负载、额度、健康 EWMA、首输出延迟、重置）或 `quota_reset_priority`/`round_robin`/`sticky` 选号；会话亲和 strict/preferred/relaxed，TTL 默认 24 小时；账号满载时按账号 FIFO 有界等待（每账号 10、全进程 1024，返回 429 `concurrency_queue_full`/`concurrency_queue_timeout`）；Guardian 请求使用独立并发池（默认 5）。
- 额度：解析 `x-codex-*` 窗口、credits、active-limit、plan 与流内 `codex.rate_limits`，这些头不下发给调用方；账号动作 `test`/`quota` 读取 `/wham/usage` 与重置卡列表，`reset-credits` 以 UUIDv4 幂等键消费重置卡，结果不明时复用原键。
- 传输：OAuth 账号上游默认 WebSocket（`openai-beta: responses_websockets=2026-02-06`、permessage-deflate），按账号池化、55 分钟寿命、空闲 300s、Ping 25s、origin 熔断；首个事件前断线同号恢复 5 次，耗尽或 426 回退 HTTP；终态前关闭（含 Close 1000）不计成功。连接以首个请求是否声明托管搜索（顶层 `tools`，或 Lite 请求 `input` 中 `additional_tools` / `tool_search_output` 携带的 `web_search`/`web_search_preview*`）定型，后续请求需要搜索而连接首包未声明时不复用该连接（CPR #570）。HTTP 正文按 Codex 合同 zstd 压缩。会话、线程、窗口等关联 ID 与 `prompt_cache_key` 按账号 installation id 映射为稳定 UUID；trace 字段（`traceparent`、`tracestate`、`sentry-trace`、`baggage` 及 WS `ws_request_header_*` 副本）原样透传。
- 入站 Responses WebSocket：每条连接固定 connection key 并回到同一 Worker，绑定同一条上游 WS；连接内续接原生发送 `previous_response_id`（顶层字段沿用控制面清洗与模型映射后的结果，只取原始帧的增量 input），原连接失效时改发展开的完整历史；`response.interrupt` 转发到上游，无控制通道时返回 `response.interrupt.failed`。
- 模型目录：Worker 用 OAuth 账号读取上游 `/models`（最多 3 个账号、缓存 5 分钟、失败 503 `model_catalog_unavailable`）；没有 Codex VM 槽时 GPT 目录同步改由 Worker 拉取。分组只绑定 Gateway 账号时 `/v1/models` 正常列出 OpenAI 模型。
- 计量：流式 usage 逐行观察不受长度限制；实时日志与 Receipt 回填统一按 VM 口径（input 扣除缓存、reasoning 作为 output 子集）。`upstream_model` 记实际发送的模型（与 VM 同一契约），上游回显只记 `response_model`；回执回填不覆盖实时日志已按完整 usage 计好的成本，只在实时 usage 不完整时计价。生图按张与网页搜索按次的分组计费规则见分组配置。只有终态为 `verified` 或 `ambiguous` 且 usage 不完整的请求标记 `settlement_pending` 等回执补齐；已确定失败、截断或提交前取消的请求与 VM 路径一样不计量；提交后调用方在终态前断开记为 `cancelled`（`client_cancelled`，不计费、单独统计），等回执确认：Worker 已收到终态且回执带完整用量时按实际用量结算，回执终态为 `cancelled` 时记为不计量。对账时回执终态为 `upstream_error`、`incomplete`、`cancelled` 的任务直接记为不计量（`request_not_completed`），没有计费上下文的任务记为 `billing_context_missing`，都不进入 dead-letter；使用记录 `attempt_count` 记 Worker 内的上游尝试次数（含同号重试与换号）。
- Drain：排空期间的 503 `gateway_worker_draining` 带 `X-Kin-Gateway-Send-State: not_sent`，控制面换实例或按回退规则改走 VM；带截止时间时到期取消在途请求，Receipt 标 `drain_deadline`；心跳上报截止时间。
- TLS 指纹：上游 HTTPS 用 utls 复现官方 Codex 的 native-tls（OpenSSL）ClientHello（30 个套件、扩展固定顺序 `65281,0,11,10,35,22,23,13,43,45,51`、X25519MLKEM768+X25519 key share、不声明 ALPN，走 HTTP/1.1）；上游 WS 复现 rustls ClientHello（扩展每连接随机排列、SCSV、无 ALPN）。经 HTTP CONNECT/SOCKS5 代理时先建隧道再由 Worker 完成指纹握手，明文目标经 HTTP 代理仍为 absolute-form 转发。用例以抓取的 ClientHello 对照 CPR 基线，并与 Go TLS 1.3 服务端完成真实握手。
- WS 握手：自行写出 opening，线级顺序为 `Host, Connection, Upgrade, Sec-WebSocket-Version, Sec-WebSocket-Key`，随后小写的 `chatgpt-account-id, authorization, user-agent, originator, openai-beta, version, x-codex-beta-features, x-client-request-id, session-id, thread-id, x-codex-window-id, x-codex-turn-metadata, x-codex-routing-hint`，最后 `sec-websocket-extensions: permessage-deflate; client_max_window_bits`；服务端回应 `client_max_window_bits` 只接受 15。压缩消息合并为单帧（FIN+RSV1），与 tungstenite 一致。`x-codex-routing-hint` 由 Worker 按实际正文生成（`model=<m>`，带 `service_tier` 时追加 `;tier=<t>`），HTTP 与 WS 都发送。
- 账号错误保护：沿用系统设置 `account_error_protection` 的规则（provider/status/code/type/message，message 只看前 8 KiB），Node 随信封下发策略与指纹；Worker 按账号×凭据代次×策略指纹逐次尝试计数（窗口自最后一次命中起算），达到阈值冻结，冻结账号不参与选号。到期后探测开启时每 30 秒以最小 Responses 请求探测（模型取冻结快照、策略或上游目录首项），成功解冻、失败按冻结时长顺延；关闭保护或探测时到期直接解冻；凭据代次变化使旧冻结失效。完整成功的普通调用清除期间无新增失败的证据；预热（`generate:false`、`request_kind=prewarm`）与探测不计数。账号页“恢复冷却”同时解除冻结，详情显示各 Worker 实例的冻结、命中规则与最近探测结果（只读 `status` 动作）。
- 额度预测：`GET /api/panel/codex-accounts/:id/quota-forecast` 按 CPR 算法估算周窗口与 30 天（周窗口折算，标记 extrapolated）的 Token 与美元容量：Receipt 中逐请求的额度观测切成至少 5 个百分点的连续块，取最近 3 块及尾部，`(本周期已记录 + 样本用量 × (100 − 已用%) / 样本进度%) × 目标秒 / 窗口秒`；reset 漂移超过 2 秒或回落超过 1 个百分点视为不连续，周期中途加入且无配对样本、进度不足 5 个百分点时给出原因；样本不足 10 个百分点或少于 2 块标记 low_sample。只读展示，不参与计费与调度。
- Guardian 路由 Cookie：上游 WS 握手 `Set-Cookie` 中的 `__oailb`/`__cflb`（每个名字恰好一条且不超过 8 KiB）作为连接 pin；响应开始时按（调用方范围, response_id）记住归属账号与 pin（30 分钟、最多 4096 条，不持久化）。Guardian 请求的 `client_metadata.parent_response_id` 指向同账号父响应时保留该字段并用独立连接带上 pin（只对握手的 origin 与路径生效）；父响应属于其他账号或归属未知时删除该字段。调用方范围由 Node 以与续接归属相同的 Key 哈希下发。
- 观测：Worker 响应头 `X-Kin-Gateway-Outbound-Session` 回传实际发往上游的会话 ID，控制面记为出站 Session；流式请求按 VM 同口径记录首字节、首 Token 与生成时间。心跳上报瞬时在途 `active_concurrency`、两次心跳之间的峰值 `peak_concurrency` 与各运行账号在途 `account_inflight`（迁移 088 落库），实例卡片与 Codex 账号列表据此显示并发；同时上报凭据终态 `account_credentials`（expired/invalid/banned/unverified 与 Worker 最近错误，完整集合，未列出即可用；迁移 089 落库），没有请求的账号也在列表与详情显示「刷新失败」「凭证吊销」等状态。回执回填不改写交付给调用方的状态码，只在实时日志终态未知时补全。
- 取消、排除与回退：调用方在 Worker 返回前取消（HTTP 断开、WS 中断或关闭）时，控制面断开到 Worker 的请求，Worker 随请求上下文停止排队、重试与换号，使用记录记为 `cancelled`。某实例上未同步（pending/drifted/blocked）的账号经信封 `pool_scope.exclude_accounts` 逐个排除，不再因单个账号未同步而跳过整个实例。Worker 明确未发出请求（无可用实例或账号）、不是 Gateway 续接、调用方尚未收到任何内容、路由未强制 Gateway（`preference` 不为 `gateway_worker`）且分组也绑定了 Codex VM 时，改走 VM，使用记录 `via=codex-kernel-fallback`；分组只有 Gateway 账号时仍返回 503。流内 `response.failed` 交付为标准错误对象，WS 错误帧保留上游错误码、提示与 `retry-after`。
- Cookie 与续接状态：OAuth 账号只保存 CPR 白名单 Cookie（`__Secure-next-auth.session-token`、`__Secure-authjs.session-token`、`oai-did`、`cf_clearance`、`__cf_bm`、`_cfuvid`，域为 chatgpt.com/openai.com），随凭据代次失效；`x-codex-turn-state` 在请求确认属于同一账号时回放；归属不明（未钉住账号、会话记录缺失或过期）时，只有已证明由本账号交给同一 Client Key、会话、线程与 turn 的 token 才回传（成功与失败响应下发的 token 都记录摘要证明，保留时长同会话亲和、最多 4096 项），证明不放行 `previous_response_id`。上游失败响应的 `x-codex-turn-state` 同样交还客户端。跨账号尝试删除续接与身份字段并改写 `client_metadata` 的 installation id；WS 首帧投影 responses-lite、turn-state 与 `x-codex-ws-stream-request-start-ms`。HTTP 不发送 `openai-beta`、`x-codex-turn-id`；HTTP、WS 握手与 Live 都以本账号安装身份写 `x-codex-installation-id`（与 `client_metadata` 同值），不继承调用方的值。
- 后台任务：额度按 CPR 节奏刷新（启动 10 分钟内随机首批、每批 100；耗尽后 10 秒宽限、5 分钟内每 30 秒、之后每 5 分钟；已用窗口过重置 2 分钟后复查，30 分钟节流）；预热按 UTC+8 时刻只交给一个在线实例（实例 ID 最小者）；套餐模型目录每 15 分钟刷新、30 分钟有效。OAuth 账号不服务 grok，Images 与 Live 排除 Free，未指定模型的 Search/Images 只用不受限账号。分组 `codex_fast_mode`（default/enabled/disabled）在选号后按账号套餐目录改写档位，计费按实际发送的档位（`X-Kin-Gateway-Service-Tier` 与 Receipt `usage.service_tier`）。会话级 WS 失败预算 5 次（空闲 8 小时、最多 16384 个会话），代理 `max_websocket_connections` 限制同一出口的上游 WS 物理连接（空闲淘汰后排队）。
- Live 语音：`/v1/live`、`/v1/realtime`、`/v1/realtime/calls` 经 Worker 发往 `{base}/realtime/calls?intent=quicksilver&architecture=avas`，call id 钉住创建账号 1 小时；sideband WS 与 hangup 发往 `api.openai.com/v1`（`KIN_CODEX_GATEWAY_LIVE_API_BASE_URL` 可改），同一调用方、同一时刻只允许一条 sideband；不支持的 Realtime 端点返回 501。
- 上游客户端画像：设置页“上游客户端画像”保存通用选择（默认 Desktop · macOS · 自动最新），API Key 可单独覆盖（超管，`api_keys.codex_client_profile`）。预设为 desktop/cli × macos/linux/windows，自动最新可滞后 1～10 个已观察版本，或固定 Core/Desktop 版本与构建号，CLI 可选 tui/exec 入口；自定义 User-Agent 识别官方前缀并解析 originator 与 Core 版本。部署配套头 `x-openai-internal-codex-residency`、`x-openai-account-routing-override` 未配置时不发送。Worker 每 24 小时核验官方稳定发布：CLI 取 npm `@openai/codex` 且六个平台依赖一致；macOS 取 appcast（须带签名）并按 HTTP Range 读取 ZIP 内 Core（Mach-O arm64）；Windows 读取 MSIX 的 AppxManifest、app.asar 的 package.json 与 codex.exe（PE）；Linux 读取 DEB 的 data.tar.xz（按 XZ 索引随机解码，纯 Go LZMA2）中的 app.asar 与 codex（ELF）。构建号回退拒绝，size+ETag 未变时复用已核验结果，失败沿用同组合上次版本；结果写入数据目录 `client_releases.json`（最多 11 个历史版本）。模型、WS、Live、目录、额度、探测与刷新请求都使用画像身份；`/wham` 账号请求只带 UA、认证与账号 ID。官方 Desktop Git 上下文的 `appServerVersion`/`appVersion` 随画像同步，其中 `sessionId`/`threadId` 按账号映射。
- 隐私规则：设置页“隐私规则”保存有序规则（最多 32 条、合计 32 步，路径最多 16 层，表达式与替换各 4096 字节，单次执行 10000 步），作用范围 turn_metadata（头、正文与 `client_metadata` 的字符串或对象）、Desktop Git 上下文、环境文本（替换前后 XML 结构必须一致）、请求正文与请求头，动作 regex_replace（RE2，支持 `$1`/`${name}`）、set_value（保持原类型）、rename_key、remove_field（可按正则条件）。Worker 在全部宿主头、画像与 WS 投影之后、压缩之前执行；每条规则的步骤同成同败，失败按设置跳过该规则或以 400 `privacy_policy_rejected` 拒绝（未发送、不重试，不回显规则内容）。保存时由在线 Worker 编译确认，设置页可用样本试运行。
- 账号资料：账号详情显示 `/wham/profiles/me` 的昵称、累计/峰值 tokens、最长任务、连续天数、会话数、Fast 占比与常用推理强度，`/backend-api/subscriptions` 的订阅到期与续订（失败只显示未知）；官方头像只接受 chatgpt.com Estuary（带账号凭据、走账号代理）与 cdn.auth0.com（公开、不带凭据），经 Worker 与控制面流式代理。
- 冻结共享：Worker 心跳上报本实例的保护冻结（等待探测的到期冻结以 90 秒窗口续报），控制面按账号资源记录并在其他实例的心跳策略中下发 `account_freezes`，同一上游账号在所有实例暂停接单；来源实例负责探测与解冻，解冻、到期或来源失联超过 90 秒后不再下发。
- TLS：配置 `CODEX_CA_CERTIFICATE`（优先）或 `SSL_CERT_FILE` 时，证书追加到系统根证书，HTTP 改用 rustls 指纹并声明 ALPN `h2,http/1.1` 走 HTTP/2（与官方换用 rustls 一致），文件无效时 Worker 启动失败；WS 仍为 rustls 无 ALPN。每个出口按指纹分开缓存 TLS 会话（64 条），复用时在最后追加 `pre_shared_key`。
- 流式保活：Gateway 路径的流式 HTTP 调用方在准入后 15 秒仍未拿到 Worker 响应（排队、重试、换号）时，提前建立 200 SSE 并每 15 秒写 `: keep-alive`；之后的 Worker 错误改为流内失败（Responses 为 `response.failed` 加 `[DONE]` 并保留 `retry-after`，Chat/Completions 为错误帧，Anthropic 为 `error` 事件）；15 秒内的失败仍保留原 HTTP 状态。入站 Responses WS 不走此保活。
- 额度解除：完整快照只在耗尽窗口滚动且新窗口用量低于 10%、同一窗口连续两次未触顶，或耗尽后记录的 reset 全部到期且快照明确未耗尽时解除额度冷却；单次未触顶的旧快照不解封。等待确认期间冷却至少保持到最早的待解除 reset，由后台额度刷新复查；成功推理、重置卡与人工恢复仍直接解除。
- 请求兼容：选定 OAuth 账号后，历史 `reasoning` 项去掉 `status`，有加密内容时去掉冗余明文 `content`；历史含 `web_search_call` 而本轮未声明搜索工具时补 `{"type":"web_search","external_web_access":false}`（Lite 请求追加 `additional_tools` 项且保留末尾 `compaction_trigger` 位置；原本无工具时 `tool_choice` 设为 `none`，强制选择时不改），续接请求不补（openai/codex#51962）。
- `GET /v1/models/{model_id}` 返回本 Key 可用目录中的单个模型（模型 ID 可含斜杠），不可用时 404 `model_not_found`。官方头像请求使用 Desktop UA `originator/desktopVersion (os; arch)`。
- 请求位置：设置页“请求位置”保存全局位置（国家两位大写代码、地区与城市 1～128 字符、IANA 时区，默认 US / Ohio / Piketon / America/New_York），开启后随信封下发；代理可选继承全局、手动指定或跟随代理池探测到的出口（IPv4 与 IPv6 时区不一致或信息不完整时不覆盖），有效位置随账号投影下发，账号经该代理出站时优先于全局位置。Worker 发送前只改写 user 消息 `environment_context` 与 developer 消息 `codex_apps_client_time_context` 里的 `<timezone>`（有 `content_item_kinds` 时以分类为准，日期不刷新），并为 `web_search`/`web_search_*` 工具写入 `user_location`（approximate）。
- 实现结构与开销：Gateway 分支位于 `src/lib/protocol/handle-codex-gateway.mjs`（`dispatchCodexGateway`），Codex 入口按返回的回退标记决定是否改走 VM；两条路径共用的小工具在 `codex-hop-shared.mjs`。Gateway 流逐行处理时每个事件最多解析一次，首个生成内容之后不再解析 `*.delta` 增量行；续接归属每个响应 ID 只写一次，仓储按数据库连接复用；尝试记录一次写入；回执只补齐已有的待结算任务。Worker 改写正文时，顶层成员按结构扫描界定边界、未改动的大字段原样透传，只读少数顶层字段的判定只取对应成员。
- 进程托管：`bin/kin-codex-gateway` 存在时，控制面以子进程拉起同机 Worker（环回明文 + HMAC，默认 `127.0.0.1:8790` / `gw-01` / `data/codex-gateway`，显式配置优先），崩溃按 1～60 秒退避重启，日志带 `[codex-gateway]` 前缀并入控制面输出，控制面关停时发送 SIGTERM；控制面异常退出遗留的 Worker 进程按 pid 文件清理。内部 token 与凭据 bundle 密钥未显式配置时由控制面生成并保存在 `data/runtime-secrets.json`。Worker 收到 SIGTERM 后最多等 8 秒让在途请求结束（托管强杀宽限 10 秒），再写出延迟落盘的运行时状态后退出。账号库以凭据 bundle 密钥派生的独立密钥加密落盘；额度、冷却、Cookie、保护计数与租约等运行时状态合并延迟（最多 2 秒）落盘，凭据与配置变更同步落盘。控制面升级即换新 Worker，原同机侧车 overlay（`docker-compose.codex-gateway.yml`）已删除；`KIN_CODEX_GATEWAY_SUPERVISE=0` 改由外部启动（`scripts/codex-gateway-start.sh`、systemd，用于多 Worker 或跨主机）。Gateway Worker 页面显示托管状态、进程号、重启次数与最近退出；发版镜像冒烟检查确认 `bin/kin-codex-gateway` 存在。
- 部署拓扑：默认一个控制面 + 一个同机 Worker。控制面处于单 Worker 模式，已有在线接单实例时拒绝其他实例注册与心跳（409 `gateway_single_worker`），原实例 drain 或 45 秒无心跳后可由新实例接替；`KIN_CODEX_GATEWAY_MULTI_WORKER=1` 才允许多实例同时接单，Gateway Worker 页面显示当前模式与多实例的限额提示。
- CPR 互联只读协议：`GET /v1/cpr/link`（schema_version 2）只接受推理 Key，Key 需在编辑对话框开启“CPR 互联共享”且绑定分组；不做预算放行、不计 RPM、不更新最近使用，预算耗尽后仍可查询。默认公开 `key_usage`（访问结论与已配置的总额度、5h/日/周消费窗口），可选公开账号池汇总（含套餐分布）与匿名账号额度窗口、模型可用性；池与额度只覆盖分组绑定的 Gateway 账号，账号 ID 按 Key 匿名化，不含邮箱、名称、代理或凭据。

新增迁移 `083_api_key_peer_sharing.sql`（Key 的 `peer_sharing` 共享开关，默认全部关闭）、`084_codex_fast_mode_proxy_ws.sql`（分组 Fast 三态、代理 WS 连接上限）、`085_api_key_codex_client_profile.sql`（Key 画像覆盖）、`086_gateway_account_freezes.sql`（跨实例冻结）。新增迁移 `087_proxy_request_location.sql`（代理请求位置模式与手动位置）。Worker 数据目录新增 `account_protection_policy.json`（最近一次下发的保护策略，供重启后的到期探测使用）、`runtime_policy.json`（预热策略）与 `client_releases.json`（已核验的官方发布）。

Worker 新增配置：`KIN_CODEX_GATEWAY_UPSTREAM_TRANSPORT`（`http` 关闭上游 WS）、`KIN_CODEX_GATEWAY_MAX_RETRY_AFTER_SECONDS`（默认 240，0 表示不接受正数等待）、`KIN_CODEX_GATEWAY_GUARDIAN_CONCURRENCY`（默认 5，0 表示共用）、`KIN_CODEX_GATEWAY_MAX_WAITING_PER_ACCOUNT`（默认 10，0 关闭排队）、`KIN_CODEX_GATEWAY_SESSION_AFFINITY_TTL_HOURS`（默认 24）、`KIN_CODEX_GATEWAY_LIVE_API_BASE_URL`（默认 `https://api.openai.com/v1`）、`CODEX_CA_CERTIFICATE` / `SSL_CERT_FILE`（自定义 CA）；`KIN_CODEX_GATEWAY_ACCOUNT_CONCURRENCY` 现已生效。原 `KIN_CODEX_GATEWAY_CODEX_ORIGINATOR` / `CODEX_APP_VERSION` / `CODEX_USER_AGENT` 已由上游客户端画像取代并删除，设置后不再生效。

## 2026-11-02 超管自营开户与账号页修复

- 超管在资源管理 → Codex 账号直接新建平台自营账号，不要求供应商、门户登录或供应商执行策略。供应商仍通过原门户和原策略管理自有账号。
- 自营账号沿用 `vendor_resources`，`vendor_id=NULL`，不创建虚拟供应商、VM、容器或 KVM。迁移 `081_platform_gateway_accounts.sql` 只允许 OpenAI Gateway account 使用空供应商，保留既有资源 ID、外键、分组优先级，并修复 `group_resources` 未允许 `gateway_worker_account` 的数据库约束。
- 管理入口使用独立的 `GatewayAccountManagement` 服务；草稿按操作者隔离，30 分钟过期、固定 OAuth Worker、幂等创建。OAuth session 10 分钟过期，Node 保存 state hash，完成时必须提交含 code/state 的完整回调 URL。重授权重新读取现有配置，保留名称、代理、分组、容量及暂停状态。
- 编辑同步所有已绑定实例的分组、代理、并发和 RPM；失败保留配置并标记 drifted。存在未同步绑定的实例不接受新推理 Dispatch。离线 Worker 回来后按控制面最新配置恢复投影；单 Worker 不再错误要求第二个凭据来源。
- 存在 pending/drifted 绑定的实例不接受新推理 Dispatch（防止按旧配置接单）；已确认停用的归档绑定（`archived`）不阻塞。心跳投影跳过从未进入任何 Worker 的账号，归档账号只在原有实例上停用、不导入新实例，实例上已不存在视为已停用；本实例丢失账号时改从其他实例的绑定恢复。心跳带回各账号的凭据代次、投影版本与配置指纹（`account_revisions`），控制面只对绑定未同步、指纹（控制面按期望运行配置计算，含分组、状态、容量、模型、代理、代理 WS 上限与请求位置，随 PATCH 下发）或版本不一致的账号重新投影；已确认停用且版本不旧的归档账号不再重复停用；Worker 首次注册同样带回报按差量投影，手动触发或没有回报时全量投影；同一实例的投影在进程内不并发执行。投影载荷（期望配置、指纹与版本）由 `gatewayAccountPatch` 统一生成，心跳投影、运营编辑同步与供应商编辑共用；投影读取轻量账号列表（`listProjectableAccounts`），不做账号列表页的用量聚合。
- 供应商 Gateway 开户：必须配置代理（与自营一致）；导入开户把解析后的代理（含已有代理资源）下发 Worker 并加密保存，供心跳投影重放；编辑代理同样解析后下发。凭据来源实例只选一次并先落 pending 绑定，投影失败由心跳对账。OAuth 换票回到生成链接的实例，并校验会话属于当前操作者与草稿。
- 暂停、归档不受已撤销分组或失效代理阻碍；恢复仍重新校验。恢复冷却仅清除冷却及最近错误，不改变暂停状态。平台自营 Receipt 保留 usage，不产生供应商结算事实。
- 前端复用 VM 的 PageHeader、筛选控件、状态/身份/额度组件、列表与卡片、详情 Sheet、Dialog、操作菜单和四语文案；不再使用旧的独立原生账号表格布局。Worker 授权文案不再提示“一槽一号”。

本轮验证：Node 定向单测与真实 HTTP 入口 fixture 通过；前端类型检查、构建、供应商组件/i18n 测试及浏览器开户、编辑、暂停/恢复、列表三列、详情和 390px 窄屏验证通过。Go 使用目标服务器隔离的 `golang:1.25-bookworm` 容器验证修改包的 race 测试与 Linux amd64 二进制构建。本节的 OAuth 是 fixture 验证，真实用户 OAuth、付费推理及跨主机 mTLS 不算已验收；代码推送、部署镜像与生产迁移状态以交付记录分别确认。

## 已实现

- Node 控制面新增 Gateway Worker 迁移、实例/账号/Dispatch/Receipt 投影和内部签名协议。
- Go 新增 `kin-codex-gateway` 组合根，提供健康、能力、Drain、Resume、账号池、HTTP 执行和 Receipt spool。
- Codex 路径按分组灰度：分组绑定 Gateway 账号后才走 Worker，未绑定的分组保持现有 Codex VM 行为；`routing.codex.gateway_worker.preference=vm` 强制全部走 VM。2026-11-03 起取消 `gateway_worker.enabled` / `KIN_CODEX_GATEWAY_ENABLED` 总开关，控制面始终托管同机 Worker。
- Gateway Worker 账号资源使用 `execution_kind=gateway_worker`，不会创建 Claude VM、Docker 容器或 KVM guest。
- 供应商账号表单已增加 VM/Gateway Worker 执行方式字段；Worker 凭据写入运行时账号存储，不进入前端投影。
- Node 已把 Responses、Chat、Completions、Images、Search 接入 Worker；客户端断开会调用 Worker cancel。Responses/Chat/Completions（及显式开启的 Anthropic Messages）一律以 `stream=true` 发往上游，Node 按调用方协议转回 Chat chunk、Completions、Anthropic 事件，非流式调用方组装为单个 JSON；终态事件前断流记为 `incomplete`，不当作成功。
- Worker 按上游客户端画像重建 `Authorization`、`originator`、`User-Agent`、`version` 和 `chatgpt-account-id`（默认 Codex Desktop · macOS · 已核验的最新官方发布，见“上游客户端画像”）。Node 只转发会话、`x-codex-*`、trace（`traceparent`、`tracestate`、`sentry-trace`、`baggage`）与 `x-openai-fedramp` 头，丢弃调用方凭据与 `x-codex-installation-id`；`x-openai-account-routing-override` 只取部署配置。Search 发往 `/alpha/search`，SSE 逐块 Flush。
- 执行接口（含非流式生图、Search）超时与 Worker 上游超时一致为 900 秒；控制类接口仍为 15 秒。
- Worker 账号池支持多账号、分组/模型筛选、并发/权重/冷却、暂停/恢复、OAuth refresh、代理出口（HTTP CONNECT、带 URL 认证的 SOCKS5）和原子凭据文件写入；每次执行只释放一次账号在途计数。
- Worker 通过签名内部协议、nonce、防重放、Receipt durable spool、控制面回调和 ack 完成技术事实回收；推送失败或 ack 丢失的回执由对账器每 60 秒从在线实例 `/receipts/replay` 拉回，幂等入库后 ack（重复回执同样 ack，清理 spool）。迟到 Receipt 会补齐 usage、价格字段、供应商事实和 request attempt 投影。
- 供应商账号列表、详情、用量、修改、暂停、恢复、刷新、恢复冷却、重新授权和归档已按 `execution_kind=gateway_worker` 分支处理，且不会创建 VM 资源。
- 已提供 `kin-codex-gateway` 的本地、Linux amd64 和 Linux arm64 构建入口；Docker/ARM 控制面会打包对应 binary。
- Worker 可通过 `KIN_CODEX_GATEWAY_ADVERTISE_URL` 声明控制面可达地址，并通过 `KIN_CODEX_GATEWAY_CONTROL_PLANE_URL` 自动注册/心跳；`KIN_CODEX_GATEWAY_RECEIPT_URL` 用于 Receipt 回调。
- 新增迁移 `080_codex_gateway_completion.sql`，补充 mTLS/admission、投影 revision、Quota/Receipt evidence、Continuation owner、投影任务、结算任务和 dead-letter 事实。
- Go Worker 已增加 OAuth PKCE session、authorization-code exchange、refresh CAS、受保护 session 文件、OAuth identity 摘要和 credential revision。
- Node Gateway client 已支持 HTTPS client certificate、CA、server name、流式传输和多实例凭据投影；新 Worker 注册后会触发账号投影恢复。
- Gateway Worker Receipt 已保存 quota snapshot、headers evidence、sequence/offset、完整性状态和异步 reconciliation job；Node 后台作业按 request 幂等完成安全结算。
- Codex continuation owner 现在保存 Gateway Worker execution kind、instance、runtime account 和 credential revision；继续请求不会静默切换账号。
- Worker 账号池会读取 Codex `x-codex-*` quota headers，跳过明确耗尽或冷却账号，并将 5h/7d 状态投影到账号页。
- Node 到 Worker 的明文兼容模式默认仅允许回环地址；跨主机 HTTP 必须显式开启开发开关，生产配置应使用 HTTPS+mTLS。
- Worker 回调 Node 的 Receipt/register 请求同时带 HMAC 时间窗、nonce 和 body hash；Node 当前控制面仍由部署层反向代理终止公网 TLS，真实双向证书链要在目标部署环境验收。
- Worker 账号池现在在本地执行 RPM token bucket、并发闸门和 session affinity；Node 仅传递分组/账号/凭据代次/会话 scope，不在热路径复制选号器。
- generations 与 edits 使用独立的 Worker operation/capability。
- Worker 间账号投影的 export/import 使用 `KIN_CODEX_GATEWAY_CREDENTIAL_BUNDLE_KEY` 派生的 AES-GCM opaque credential bundle；所有可互相投影的 Worker 必须配置同一高熵共享密钥，不能用各自不同的内部 HMAC token 代替。控制面只中继密文和公开身份摘要，不把 token 写入 SQLite 或 Receipt。
- Worker 回调的 HMAC 和 Receipt payload hash 都基于发送方实际写出的原始 JSON 字节；Node 在解析前校验原始字节，Go 使用关闭 HTML 转义、稳定 map 排序的紧凑 JSON，避免字段重排或转义差异造成误拒。
- Receipt payload hash 在 Node 端校验，乱序/迟到/重复 Receipt 不重复应用账单；待结算请求（成功或结果不明）在 10 次重试后仍缺完整用量或结算出错时写入 dead-letter，等待运营处理。

## 仍需独立验收或后续增强

- 自动化验证覆盖：Go 单测（含假 ChatGPT HTTP/WS 上游）与 `test/e2e/gateway-worker-real.e2e.test.mjs`（真实 Go 二进制 + Node 控制面 + 本地代理）；均不调用真实 OpenAI。
- 与 CPR 的已知差异：默认单 Worker 时账号状态只有一份；显式开启多 Worker 后，账号的并发、RPM、冷却与错误计数按实例独立累计，冻结经控制面心跳共享（传播延迟为一个心跳周期）；native-tls 声明中的 DHE 套件、X448/FFDHE 组仅用于对齐，只在 TLS 1.3 下使用；官方发布核验依赖 Worker 能访问 registry.npmjs.org 与 persistent.oaistatic.com，不可达时沿用内置或上次核验的版本；Gateway 账号只支持 OAuth（无 API Key 上游账号）；未实现 CPR 的 OAuth 恢复日志（原始令牌另存）与插件中间件体系。CPR 互联的“上游互联快照”（把对端 `/cpr/link` 作为账号额度来源）在 vm2api 无适用账号：Gateway 账号只有 OAuth，没有带上游 API 前缀的 API Key 账号，因此只实现被观测端。
- 真实 OpenAI OAuth、真实 mTLS 证书链、真实代理出口和 Linux/Docker 构建仍需目标环境验收。
- 生产滚动升级、Drain 等待在途请求、多 Worker 压测和备份恢复仍需部署环境验收。
- 本地 Go 单测覆盖 mTLS 配置、OAuth session、CAS/RPM、opaque credential bundle、quota evidence、Receipt spool/完整性；真实证书链、真实 OAuth 和外部代理仍未验收。
- 生产接入以分组绑定 Gateway 账号为准；完成真实 OAuth、mTLS、Docker、Linux、账务和多 Worker 验收前，只给验收分组绑定 Gateway 账号。

## 安全边界

- 控制面只保存账号绑定、身份摘要、credential revision 和 Receipt 技术事实。
- Worker 内部 token 与 HMAC 只用于私有接口；客户端 API Key 不直接进入 Worker。
- Gateway Worker 不提供客户用户、API Key、钱包或供应商登录入口。
