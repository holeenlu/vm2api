# CPR 研究证据索引

## 基线

本轮核对命令使用本机工作树：

```text
CPR root:     /Users/luhonglin/Git/codex-proxy-rs
CPR commit:   958e13c3 (main, v3.35.0)
tapmodels:    /Users/luhonglin/Git/vm2api
tapmodels:    51955eb3 (main)
date:         2026-10-29
```

两边工作区在研究开始时均无未提交差异。本轮只读研究，没有修改 CPR。

## Gateway Worker 对齐基线

Gateway Worker（Go `kin-codex-gateway` + Node 控制面）按 CPR 行为用 Go 重写，没有共同 git 历史，只能逐提交盘点后移植。本节是增量盘点的唯一起点记录，规则、结论分类、验证与交付要求见[交付规范](../CHANGE_DELIVERY.md)第 4 节“CPR（Gateway Worker）同步”。取得待盘点提交：在 CPR 检出执行 `git fetch origin main && git log --first-parent <已对齐到>..origin/main`，聚焦 `backend/crates/providers/openai`、`gateway-core` 重试与路由、互联（peer link）被接入方、代理探测，再逐个提交读取实际 diff，判定已移植 / 已具备 / 部分采用 / 不适用 / 待决定并更新本节。

```text
已对齐到:    fb4ae8c9 (main, 2026-11-07)
盘点起点:    e0b7a841 (Gateway Worker 开工时本机 CPR 检出)
```

| CPR 提交 | 内容 | 结论 |
| --- | --- | --- |
| `79083a56` | WS 连接首包未声明托管搜索时，后续声明需新连接 | 已移植：识别补上 Lite `input` 中的 `additional_tools` / `tool_search_output` 声明（`ws.go`、`compat.go`） |
| `2016bda0` | 透传 trace 与 `x-openai-fedramp`；按账号发送 `x-codex-installation-id` | 已移植（`correlation.go`、`server.go`、`profile.go`、`gateway-execution.mjs`） |
| `e7c24781` | 账号路由覆盖头只取部署配置 | 已具备（`profile.go` 只从画像写入，调用方值丢弃） |
| `790f3147` | 归属不明的全量请求凭证明回传已验证 turn state | 已被 `1daa0623` 取代：证明缓存（原 `turn_state.go`）已删除，见下 |
| `0ff1a729` | Retry-After 等待上限，超限不截短 | 行为已具备；对齐显式 0 不接受正数等待（`attempt.go`、`config.go`），配置为环境变量/配置文件而非面板设置 |
| `7b05b14a` | 模型拒绝冷却只认 `model_not_found` + 400/403/404，`unsupported_value` 为请求错误 | 已具备（`classify.go`） |
| `6f71b27c` | 互联池摘要计入只由额度提供的套餐 | 不再适用：互联协议已于 2026-11-07 整体下线（`cpr-peer-link.mjs` 删除） |
| `a92b95c4` | 代理延迟按选中的地址族计 | 不适用：延迟只由 IPv4 一次查询计时，无双栈并发拉长问题 |
| `5100f633` | 请求记录补错误分类、WS 关闭码、续接不可用与连接退出原因、`recovered`，详情投影结构化上游错误 | 已移植（迁移 092、Worker 诊断头与 trailer、日志详情“网关诊断”）；`recovered` 无数据来源未做 |
| `1915806b` | 主题预览加载顺序 | 与网关无关 |
| `187af363`、`be35f8a6`、`d22ec298` | 接入方同步、上游池展示、请求记录 CPR 标记 | 不适用：接入方逻辑从未实现；被接入方 `/v1/cpr/link` 已于 2026-11-07 下线 |
| `26de6712` | PostgreSQL 配置快照 revision 竞争 | 不适用：无该快照发布机制 |
| `c73e7126` | OAuth 授权码交换与令牌刷新：连接 30 秒、总时长 60 秒；区分连接失败与结果不确定并保留脱敏原因 | 部分采用：令牌请求总期限统一为 60 秒（`refresher.go` 的 `refreshRequestTimeout` 由 30 秒放宽，`oauth.go` 授权码交换新增同一期限，原先无单独上限）；连接阶段超时沿用共享传输的 TLS 握手期限。错误分类只影响 CPR 管理端提示，不采用 |
| `1d88c9a4` | 上游连接结束时以 1000 关闭空闲下游 WS，促使客户端重连并完整重放 | 不适用：同 `49cee239` 的结论，下游 WS 在 Node `responses-ws.mjs`，自行按 `previous_response_id` 展开重放 |
| `3e33e84a` | CPR 统计口径：未完成计为错误，已恢复与取消不计入成功率 | 不适用：本地统计沿用官方上游 vm2api 的 `usage-log-preds.mjs` 口径，按 CPR 改会扩大与上游的差异 |
| `4527db7b`、`1655ecc9`、`04a48e84` | CPR 用量页把取消与未完成请求分系列显示并整理成功率提示格式；Rust 依赖 `mio` 升级到 1.2.4 | 与网关无关：只改 CPR 自身的前端图表、图例与 i18n、`Cargo.lock`；Gateway Worker 没有对应逻辑，统计口径沿用官方上游（见 `3e33e84a` 的结论） |
| `26dbc120`、`0c07aac1`、`2b7a64da` | CPR 账号目录完整模型名显示、发版、贡献指南 | 与网关无关 |
| `68595209` | Chat Completions 兼容大幅放宽：`file` 块接受 `file_id` / `file_data` / `file_url`；`input_audio`；custom 工具与结果；推理摘要投影 `reasoning_content`；`message.images` 图片扩展；`logprobs`；流式 `delta.annotations`；保留 `max_output_tokens`；入口失败诊断 `api/http_ingress` | 部分采用：`file` 块放宽已移植（`codex-convert.mjs` 的 `chatFilePart`，替代上一轮只放行内联 PDF 的 `inlinePdfPart`）；其他角色的 `name` 本地本就忽略。待决定：音频、推理摘要投影、图片扩展、logprobs、流式引用、`max_output_tokens`——都会改变发往官方 Codex 后端的报文或新增 Chat 扩展字段，需真实账号验证；入口失败诊断为 CPR 自身观测表，本地失败请求已记入请求日志 |
| `a9a77f5f` | 账号模型成功率按请求结果计算 | 已具备：`vendor-account-usage.mjs` 的 `success_rate` 按成功数 / 请求数计算 |
| `6f7d9259`、`9039cef3`、`b9bcb4e0`、`272534a3`、`37749001`、`f7f64ead`、`2dc6bf01` | CPR 前端表单校验时机、发版、CI、启动与重启延迟、依赖升级 | 与网关无关 |
| `1daa0623` | 撤销 `790f3147` 的进程内 turn-state 证明缓存：归属不明的全量请求原样回传客户端 turn-state；只在明确换号时清理（头、正文、`client_metadata`、turn metadata），Live 请求按换号清理 | 已移植（删除 `turn_state.go` 与 `rememberTurnState`；`account_scope.go`、`attempt.go`、`server.go`、`live.go`）：`resetKeys` 不再含 turn-state 字段，turn-state 只在 `scopeDifferent` 时删除；归属不明与同账号取客户端 token（请求头优先，否则 `client_metadata`）；`previous_response_id` 等账号绑定状态在归属不明时照常清理 |
| `46b4665c` | Client Key 可设置固定 `installationId`（带连字符 UUID），换账号仍沿用；通用设置不接受该字段 | 不采用（用户 2026-11-05 决定暂不做）：同一 Key 跨账号共用一个安装身份会让多个账号呈现为同一设备，涉及风控取舍。按 Key 的 `codex_client_profile` 覆盖也已于 2026-11-07 下线（只保留设置页的通用画像），以后有明确需求时需重新实现，并只允许运营方配置；之后的增量盘点不再把它列为待决定 |
| `21d84af2`、`d604adfb`、`311e4d22` | CPR 自身提示文案、登录页移动端布局、贡献指南 | 与网关无关（Worker 的错误文案为本项目自有） |
| `19ef4849` | 互联协议升到 schema 3（接入端只接受 3），新增能力 `key_limits`：当前密钥公开的并发上限与 RPM，0 表示不限 | 曾移植，2026-11-07 随互联协议整体下线：`cpr-peer-link.mjs`、`server.mjs` 的 `/v1/cpr/link` 与 `api-keys.mjs` 的 `effectiveLimits` 均已删除 |
| `6b362a50` | 冻结恢复探测不能回写 Cookie 或刷新凭据，解冻只由恢复任务按上游结果决定 | 已移植（`cookies.go`、`protection.go`）：`probeAccount` 的请求（含取探测模型目录）带恢复探测标记，`accountCookieTransport` 只回放已存 Cookie、不回写 Set-Cookie；探测本就不刷新凭据、不计入保护证据 |
| `bdfc2017` | 上游明确关闭共享（`403 peer_sharing_disabled`）或不支持协议时，接入方清除互联身份 | 不再适用：互联协议已于 2026-11-07 下线，本实例不再响应该端点；接入方逻辑从未实现 |
| `10e25ce2` | Chat Completions 兼容扩展：tool 消息 `name`、PDF `file` 内容块、`web_search_options`、URL 引用投影，以及 Responses 编码保留 `max_output_tokens` | 部分采用（`codex-convert.mjs`、`handle-codex.mjs`、`handle-codex-gateway.mjs`；Gateway Worker 与虚拟机 Codex 槽位共用）：已移植 tool 消息 `name` → `function_call_output.name`、user 内联 PDF → `input_file`、`web_search_options` → 强制 `web_search` 工具（与函数工具或非 `auto` 的 `tool_choice` 同用时返回 400 `unsupported_parameter`）、非流式 Chat 的 `url_citation` → `message.annotations`。不采用：保留 `max_output_tokens`（会改变发往官方 Codex 后端的报文，真实账号验证前继续剥离）；CPR 对其他非法形状的严格拒绝（本地转换保持宽松，`file_id`、非 PDF 文件不映射）。流式引用与 CPR 一致只保留正文行内链接 |
| `f5c5a6e5` | 账号出口测试、按代理批量分配账号、服务器直连出口探测 | 部分已具备：Codex 账号详情「代理」页签已能测通与测地理；按代理批量分配账号属于平台代理池的产品功能，待决定 |
| `13374e2a`、`789609dd`、`860fb396` | 部署就绪检查 `/readyz`（PostgreSQL、Redis、运行时快照）、发版、前端格式 | 不适用：Worker 没有这些依赖，健康检查由控制面托管；其余与网关无关 |
| `242ffb23` | 账号模型白名单增加独立“清理未列出模型”按钮：列出当前目录未返回的已选 ID，默认不选，确认后只改表单、保存账号生效；目录未就绪/失败/为空时不能清理，也不能清空白名单 | 已移植（`web/src/features/gateway-worker/model-access-field.tsx`、`accounts-model.ts` 的 `missingAllowlistModels` / `removeAllowlistModels`、四语 `codexModelAccessCleanup*`）；目录来源为面板 `test-models?platform=openai`，不是 CPR 的按账号上游目录，所以只作为清理候选，不据此判定模型失效 |
| `239def9a`、`53a09bbf` | PostgreSQL 客户端 Key 账本在删 Key 后保留；CPR 自身 PR 标题规则 | 不适用：本项目没有 CPR 的 Key 预算账本存储，计费在 Node 控制面；技能文档与网关无关 |
| `5eaca14a` | Responses 明确换号时清理 `traceparent`、`tracestate`、`sentry-trace`、`baggage`、`x-openai-fedramp`，含正文、`client_metadata`、turn metadata 与 `ws_request_header_*` 副本；同账号及归属未知时保留 | 已移植（`account_scope.go`、`guardian.go`）：HTTP 头、WS 握手头与三处正文字段统一按 `scopeDifferent` 清理；`client_metadata` 内再嵌套 `client_metadata` 的递归未做，没有已知来源 |
| `49cee239` | 完整新链按线程在 15.5 MiB 转 HTTP、低于 13.5 MiB 才回 WS；预热/增量成功不清大小偏好；大包 HTTP 后下游 WS 空闲时正常关闭，让客户端重连发全量 | 部分采用：阈值与回差、成功不清偏好已移植（`ws.go`、`ws_budget.go`，原固定 15 MiB 且对所有请求生效）；带 `previous_response_id` 的请求只看 15.5 MiB，不更新线程偏好。下游关闭重连不采用：下游 WS 在 Node `responses-ws.mjs`，自行展开 `previous_response_id` 重放，没有该协议提示。入站 WS 的 `wsRequired` 请求不做大小回退，沿用既有差异 |
| `0663df14` | 大包回退后的下游重连不再限定 Codex CLI 客户端 | 不适用：依赖 `49cee239` 的下游关闭机制，本项目没有按客户端类型限定的同类逻辑 |
| `7a60bc6d`（盘点起点之前，2026-11-05 补移植） | 独立 Search（`/alpha/search`）正文只按账号映射顶层 `id`，其余字段原样转发（`scope_search_body`） | 已移植（`correlation.go` `scopeSearchBody`、`guardian.go`）：Worker 此前对 Search 套用 Responses 的正文收敛，追加 `client_metadata` 并映射 `session_id`，生产上走 Worker 的 Search 全部 400；现与 CPR 一致只映射 `id`。Images 仍沿用原收敛逻辑，生产调用成功，未改 |
| 其余 6 个（`78e943f4`、`39aa20a1`、`621b1fac`、`28eb4708`、`aa003f7d`、`4c57a040`） | 插件用量数据、插件账号级画像、PostgreSQL 16 兼容、在线更新解压、迁移换行、xAI 额度快照 | 与网关无关 / 本项目无对应机制 |
| 其余 15 个 | 依赖升级、Windows 构建与在线更新、插件、部署文档、发版、前端徽标与 OAuth 通知、PostgreSQL 代理删除锁 | 与网关无关 |
| `09b22a95` | 账号白名单精确命中的模型 ID 不受目录排除，交给上游验证；账号编辑与连接测试支持自定义 ID | 已移植（`background.go` `accountEligible`）：套餐目录不含该模型时，只有账号白名单精确列出的 ID 才越过目录排除，白名单本身仍在候选集合阶段按调用方模型过滤。前端已具备：`ModelAccessField` 本就把已选 ID 与目录合并展示，Enter 可添加自定义 ID |
| `e3904178`、`1240f225` | 无会话请求按调用方范围偏向同一账号：显式 `prompt_cache_key`，否则用模型、instructions、开头 system/developer 消息与第一条 user 消息的摘要；只参与选号，不是会话、轮次或传输身份；沿用配置的亲和模式（优先可分流，严格排队等待，宽松不启用）；已有会话、后代线程、续接、Guardian、指定账号不生成 | 已移植（新增 `cache_preference.go`，`schedule.go` 的 `sessionKey`、`attempt.go`、`server.go`）：键含调用方范围与来源前缀，不与真实会话键相撞；只用于 responses / chat；字符串 `input` 按一条 user 消息处理；本地绑定为进程内存，没有 CPR 的绑定存储读写失败路径 |
| `6de1beb1` | 调度读取收敛（Postgres / Redis 候选投影缓存、冷却批量读取）与会话亲和稳定：优先模式主账号删除、停用、凭据明确失效，或额度耗尽且恢复时间未知/超过排队时限时迁移绑定 | 部分采用：绑定迁移已移植（`schedule.go` `bindingStaleLocked`，只看原生通道，短于排队时限的冷却不迁移）。不适用：候选投影与冷却读取缓存只服务 CPR 的外部存储，Worker 调度读进程内存；分流用会话派生的稳定游标未采用，本地沿用评分选号 |
| `4e4cd964` | 排队等待者低频重查跨账号容量，固定归属者才缩小范围 | 已具备：`Acquire` 每个 `waitRecheckInterval` 重新执行完整选号，排队票据随结果换到其他账号的队列，固定归属（指定账号、严格跟随）只等待目标账号 |
| `55526973`、`ac010a84` | Codex OAuth 拒绝的客户端选项统一移除（采样、`user`、`metadata`、`safety_identifier` 等；`stream_options.include_usage`；无实际效果的 `truncation` / `stop_sequences` / `prompt_cache_options`），Chat 的 `max_completion_tokens` / `max_tokens` 只在没有原生上限时补成 `max_output_tokens`；测试夹具改用 `client_metadata` | 已移植（`compat.go` `normalizeOAuthOptions`，随 `normalizeCodexOAuthBody` 只对 OAuth 账号的 responses / chat 生效；`client_metadata` 与工具参数里的同名属性不动）。既有测试里借顶层 `metadata` 校验“嵌套 store 不算”的用例改用 `client_metadata` |
| `ee7e837d` | 密钥与账号排队时限拆成两项；新增默认关闭的“排队失败后换号”：账号队满或超时后在发送前再选一次可立即准入的账号 | 待决定：需要同时新增 Codex 调度设置字段、Worker 排队失败后的一次不排队重选和面板设置项；默认关闭时行为不变。本地密钥并发在 Node 控制面单独排队，账号排队时限沿用 `wait_timeout_ms` |
| `90ecac97` | 点数放行改为按账号开启（默认关闭），上游确认 `hasCredits` / `unlimited` 才放行，关闭立即撤销依据 | 部分具备：Worker 已有全局“允许点数超额”开关（未允许时靠点数出量的账号与额度耗尽同样停放，`creditOverageGateLocked`）。按账号粒度需要新增账号字段、批量更新接口与面板入口，待决定 |
| `e97b1faf` | Key 的 `installationId` 改为 `installationSeed`：由种子、Key ID 与账号 ID 派生每个 Key × 账号独立的安装身份，换账号即换身份 | 待决定：承接 2026-11-05 暂不做的 `46b4665c`；新设计不再让多个账号共用一个安装身份，但仍是新增 Key 配置与身份派生，需要运营方明确要求再做 |
| `2a8d5d86`、`4326eb1e`、`f169733e` | 发版后发布更新通道索引、在线更新用索引限定 GitHub 查询并从已验证发布资产发现通道 | 与网关无关（CPR 自身在线更新与发版） |
| `e907f419`、`b7fa5872`、`e3f1299a` | CPR 前端：账号分组名称弹窗、复用按钮组件、自定义模型选项保存前保留 | 与网关无关 |
| `ba3baddb`、`13d3236f`、`0d25061e`、`d03d8408`、`228eea90`、`086aa542`、`fb4ae8c9` | 发版、文档、迁移整合、插件崩溃测试与发版标签保留 | 与网关无关 / 本项目无对应机制 |

### 2026-11-04 功能级对照

增量提交盘点之外，按传输与身份、凭据与额度、执行与调度、数据面接口四个方向逐项比对了 CPR 源码与 Worker（CPR `1915806b`）。本轮已修复：WS 空闲池按会话锚点与握手画像分键、复用连接不重放握手 turn-state、提交后流不受总时长截断（上游正文 300s 空闲）、额度访问结论与按证据解除、额度/目录接口只认 402、凭据 2 小时恢复窗口与无请求内刷新、`cyber_policy` 会话排除、严格亲和的后代线程跟随与续接迁移、preferred 主账号越过权重层、会话绑定按调用方隔离、重置卡账号锁与自动使用。同日第二档继续对齐：上游 WS 连接管理（读循环与空闲 Ping、800ms 快路径、按出口的半开熔断、建连名额、语义边界前恢复、终态回池、必须走 WS 的请求、`stream:true`、握手 turn-state、`codex.rate_limits` 过滤与 metadata turn-state、发布核验调度）、请求头黑名单透传与身份头推导、API Key 画像头与按账号出口隔离的客户端、OAuth 授权 URL/回调校验/刷新报文/刷新失败诊断/恢复日志、客户端重试抑制、Cloudflare 挑战与 Retry-After: 0、排队关闭 503、健康分闭集、建连退避、具名额度桶、额度拒绝回读、目录 ETag、套餐归一、人工恢复、头像来源与请求诊断字段。仍保留的差异见 [Gateway Worker 实施状态](../supplier-platform/18-gateway-worker-node-go-implementation.md) 的“已知差异”。

## CPR 架构与 API

| 主题 | 文件 | 重点 |
| --- | --- | --- |
| 系统定位与运行拓扑 | `codex-proxy-rs/docs/architecture.md:14-96` | Core/Admin/API/Store/Host/Provider/Plugin 边界；PostgreSQL、Redis、S3/R2 的状态分工 |
| 插件职责与发布 | `codex-proxy-rs/docs/architecture.md:98-171` | SDK、Runtime、manifest、快照、实例隔离、故障处理和业务事实所有权 |
| 请求生命周期 | `codex-proxy-rs/docs/architecture.md:394-482` | snapshot、attempt、send state、delivery commit、retry/fallback 安全边界 |
| Provider 边界 | `codex-proxy-rs/docs/architecture.md:483-697` | OAuth、目录、额度、出站代理、导入和协议差异的 owner |
| 路由、continuation、排队 | `codex-proxy-rs/docs/architecture.md:698-880` | 智能调度、native continuation、会话亲和、队列、Key 预算和费用 |
| 控制面 revision | `codex-proxy-rs/docs/architecture.md:881-942` | 事务、审计、快照发布、Redis 通知和配置冲突 |
| 观测、预测和请求记录 | `codex-proxy-rs/docs/architecture.md:988-1085` | 有界观测、统计投影、quota forecast、attempt 完整性、费用来源 |
| Worker、错误保护和恢复 | `codex-proxy-rs/docs/architecture.md:1086-1196` | Worker 所有权、账号冻结、日志脱敏、在线更新、备份恢复 |
| 数据面协议 | `codex-proxy-rs/docs/api.md:15-80`, `208-380` | Client Key、版本门禁、Responses、Chat、Images、Search、模型目录 |
| Key/组/运行设置 | `codex-proxy-rs/docs/api.md:1473-1627`, `1757-1842` | 账号组、Client Key、并发、智能调度、亲和和限额 |
| 备份、更新、插件 | `codex-proxy-rs/docs/api.md:2068-2148`, `2423-2795` | 业务备份、系统更新、插件管理、实例和兼容性 |
| 部署与恢复 | `codex-proxy-rs/deploy/README.md:495-840` | 持久化、日志、在线更新、插件兼容、人工恢复 |

## CPR 关键源码

| 主题 | 文件 | 关键事实 |
| --- | --- | --- |
| Core 端口 | `backend/crates/gateway-core/src/lib.rs` | CoreStorePorts、ExecutionService、ProviderRegistry、SnapshotControl 和启动恢复 |
| Operation/能力 | `backend/crates/gateway-core/src/operation.rs` | Provider 无关 operation、Feature、opaque payload 和 continuation state |
| 客户准入 | `backend/crates/gateway-core/src/engine/admission.rs` | admission、lease maintain、abandon、release、启动恢复 |
| continuation | `backend/crates/gateway-core/src/engine/continuation.rs` | Client Key/Provider/账号 pin、opaque response ID、ownership mismatch |
| snapshot | `backend/crates/gateway-core/src/routing/snapshot.rs` | 配置事实、Key/组/账号、目录代次、模型能力和计划编译 |
| snapshot publisher | `backend/crates/gateway-core/src/runtime/publisher.rs` | committed refresh、后台刷新抢占、失败暂停和 revision 通知 |
| observation | `backend/crates/gateway-core/src/engine/observation.rs` | RequestObservation、WS observation、outcome、usage、cost、timing |
| diagnostics | `backend/crates/gateway-core/src/diagnostics/capture.rs`、`trace.rs` | 有界摘要、fingerprint、脱敏、evidence 预算和 trace 丢失计数 |
| error protection | `backend/crates/gateway-core/src/account/error_protection.rs` | 规则 DSL、校验、编译、fingerprint 和匹配 |
| metering | `backend/crates/gateway-core/src/metering/mod.rs`、`pricing.rs` | Decimal、Money、Usage、CostSource、价格覆盖和倍率 |
| Provider | `backend/crates/providers/openai/src`、`xai/src` | 凭据、目录、额度、transport、错误和上游适配 |
| plugin SDK | `backend/crates/gateway-plugin/sdk/docs/capabilities.md`、`upstream-adapters.md` | 中间件、目录、调度、重试、观测、服务和受管出站 |

## CPR 近期演进证据

| 提交 | 主题 | 说明 |
| --- | --- | --- |
| `736eca65` | configurable account error protection | 从容量冻结升级为规则、策略 revision、Redis generation 和恢复探测 |
| `005466bc` | Chat Completions through Responses | 协议投影复用 Responses 执行链，新增大量 request/response contract tests |
| `3f95f8b0` | diagnostic evidence and ZIP bundles | 保留 evidence、导出 ZIP、统一可用性和缺口语义 |
| `2f3c1787` | WebSocket lifecycle | 心跳、连接归属、续接和回收边界持续修正 |
| `60e6bc01` | remove model catalog v1 | 插件目录合同主动收敛，旧版本不永久兼容 |
| `af9790ac` | managed HTTP replay safety | 只对证明安全的受管 HTTP 429 允许有限重放 |

## tapmodels 对照证据

| 主题 | 文件 | 当前能力 |
| --- | --- | --- |
| 产品与隔离目标 | `README.md:69-168` | VM/KVM、真实客户端、独立出口、风险审计、集群、Key/额度 |
| 运营模型 | `docs/RELAY_OPERATIONS.md:7-140` | VM/API 供给、商业分组、用户、Key、钱包、套餐、结算和权限设计 |
| 请求恢复 | `src/lib/pool/failover-runner.mjs` | 账号切换、重试 deadline、session queue、容量/限流错误和恢复动作 |
| kernel 错误恢复 | `src/lib/transport/go-worker-client.mjs:367-436` | committed、incomplete、错误状态恢复和空响应处理 |
| API 调度 | `src/lib/pool/api-scheduler.mjs` | endpoint/model/key 轮询和模型目录 |
| 代理池 | `src/lib/vm/proxy-pool.mjs:1-63` | 多协议代理、容量、探测、失败禁用、绑定 VM 和出口时区 |
| 请求日志与计费字段 | `src/lib/admin/request-log.mjs:1-220` | normal/debug、脱敏、usage、图片、搜索、价格来源和保留 |
| 备份 | `src/lib/admin/backup-service.mjs:1-36` | 在线一致性快照、manifest、SHA、worker、restore 期间 503 |
| 在线更新 | `src/lib/admin/release.mjs` | 版本解析、架构、下载、更新和发布信息 |
| 供应商平台 | `docs/supplier-platform/02-permission-matrix.md`、`07-implementation-and-acceptance.md` | 角色、能力范围、资源、结算、验收和回退边界 |

## 本轮核查命令

以下命令用于生成研究范围和现状索引；它们不是业务验证：

```text
git -C /Users/luhonglin/Git/codex-proxy-rs status --short --branch
git -C /Users/luhonglin/Git/codex-proxy-rs log -8 --date=short --pretty='%h %ad %s'
git -C /Users/luhonglin/Git/vm2api status --short --branch
git -C /Users/luhonglin/Git/vm2api log -8 --date=short --pretty='%h %ad %s'
rg --files /Users/luhonglin/Git/codex-proxy-rs
rg --files /Users/luhonglin/Git/vm2api
rg -n '^#{1,4} ' codex-proxy-rs/docs codex-proxy-rs/deploy
rg -n 'revision|snapshot|attempt|continuation|diagnostic|quota|backup|plugin' vm2api/src vm2api/docs
```

## 证据限制

- 研究依据是本地源码和文档，没有把 CPR 的远程 CI、生产配置或线上预览当作行为证明
- CPR 文档非常详细，但规划采用前仍需回到对应源码和测试确认边界
- tapmodels 的一些功能分散在 Node、Go、Rust、VM 和控制台，名称相同不代表语义等效
- 本目录没有执行真实供应商推理、生产数据库迁移、Docker 部署或远程节点操作
