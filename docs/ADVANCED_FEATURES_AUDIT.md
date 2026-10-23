# 默认关闭功能的启用评审

2026-10-21；基于本地 main b0198954（上游基点 eee8f6ec）。仅评审当前默认关闭或尚未配置启用的可选能力，已开启的基础能力不纳入本轮改动。未查询生产配置或最新远端。

评审建议：可以将「官方 Claude Code 家族透传」设为默认开启，其余维持按需开启。按用户最新要求，本次只保留评审文档，全部代码和配置修改已撤销；该功能当前仍默认关闭，建议未实施。

设置路径是登录控制台后的站内路由。设置页通常须点底部「保存」；账号池弹窗先应用到草稿，再保存整页。标为 API/配置的项目没有对应的现成页面开关。路由配置默认位于 src/config/routing.json，有 KIN_ROUTING_FILE 时以其为准。

| 编号 / 功能 | 设置路径、位置 / 配置字段 | 当前默认与建议 | 功能、用途与建议 |
| --- | --- | --- | --- |
| 01 官方 Claude Code 家族透传 | 设置 → 协议 → 入站准入 →「官方 Claude Code 家族透传」；`/settings/protocol`；`compatibility.official_cc_passthrough` | 关；建议开启，**未实施** | 对被识别的官方直连/中转客户端保留其 system；HTTP/API 链避免强制换成全局 persona，官方缓存标记先严格校验。建议默认开启；需要统一替换官方客户端提示词时才显式关闭。第三方客户端不因此被当成官方。 |
| 02 只允许 Claude Code | 同页 →「仅允许 Claude Code」对应准入开关；`compatibility.claude_code_only` | 关 → 保留 | 限制 Claude 入站客户端族；开启会拒绝普通兼容客户端。公共多客户端中转不宜默认开，专门提供 Claude Code 服务时再开。 |
| 03 签名修复 | 设置 → 探测 →「签名修复」；也在账号池 → 重试与切号；`failover.signature_repair` | 关 → 保留 | 只对可修复的 thinking 签名 400 清理思考历史及顶层 thinking，再重试一次；可能成功，但并非保证 200。会改变请求上下文，默认不自动开；确有跨账号签名故障且接受该语义损失时启用。其他修复不受此开关控制。 |
| 04 Agent 常驻约束 | 同页 → 各档常驻约束；`agent_standing_presets[档位]`、`agent_standing` | 各档默认关；保留 | 在系统模板内附加管理员约束；内置文字涉及蒸馏、思维链、内容限制。会影响正常任务与提示词语义，不宜作为通用默认。保存文字本身不等于启用各档。 |
| 05 Overlay / system 停放 | **当前提示词页无专用开关**；路由 API/配置 `compatibility.overlay_preset`、`persona_park`、`overlay_templates` | `off` / `false`；保留 | 对调用方 system 做包裹或停放，改变消息结构与优先级。只有明确需要该适配时启用，不能仅因叫高阶就叠加。协议页保存会固定 overlay 为 off。 |
| 06 hello 后常驻 | 同页 → hello 后常驻；`official_cc.resident` | 关；保留 | hello 会话不退出，增加长期驻留进程与内存。正常推理已有自己的 kernel/CLI 生命周期，不必额外默认常驻初装会话。 |
| 07 初装成功后同步遥测 | 同页 → 同步遥测；`official_cc.sync_telemetry` | 关；保留 | 初装完成后可能开启槽内遥测并同步身份/worker 配置；不是只读取状态。需要主动接受上送行为再开。 |
| 08 槽位 Claude 遥测 | 设置 → 遥测 `/settings/telemetry`；或虚拟机 → 槽位 → 种子；`seed_policy.telemetry_disabled` | 新槽为 `true`，即遥测关；保留 | 可单槽或批量启停遥测。唯一开关语义是 `telemetry_disabled === false` 才开；DNT/非必要流量为派生状态，不能单独拨成矛盾组合。上传历史默认不主动拉取也是独立的 UI 行为。 |
| 09 Codex 安装标识上送 | 设置 → OpenAI `/settings/openai` → 客户端画像 → 安装标识；`codex.client_features.enabled` | 关；保留 | 推理请求携带槽位持久 UUID 与会话 client_metadata；不是下游电脑原始指纹，也不是单独 analytics 请求。增加关联元数据；没有当前必需兼容证据，默认不打开。 |
| 10 Codex 环境 Analytics | 同页 → 环境 Analytics；`codex.analytics.enabled` | 关；保留 | 每个观察到的会话发送初始化事件，含 kernel 版本、系统/架构、会话、模型和时间；不含 prompt/文件/主机名/MAC。仍是额外外发请求，按隐私策略单独启用，不保证防封效果。 |
| 11 Fable 七日额度分桶 | 设置 → 配额 → 周额度分配；`quota.weekly_split.enabled`、`fable_share` | 关，开启后默认份额 0.5；保留 | 为 Fable 保留部分周额度，可能牺牲其它模型的可用容量。只有有明确产品分配要求时启用。 |
| 12 健康探测缓存 | 设置 → 探测 → 健康缓存；`health_probe.enabled` | 关；保留 | 定时跑真实对话，再给匹配的 hi/ping 请求回放结果；有额外额度消耗和缓存陈旧风险。只适合确有大量外部探活的中转，不能当实时 SLA 证据。 |
| 13 全号轮询 | 同页 → 健康缓存 → 全号轮询；`health_probe.probe_all_slots` | 关；保留 | 在健康缓存启用后，遍历所有可调度槽而不是首个成功即停止；增加调用数量。仅故障排查/巡检窗口按需启用。 |
| 14 主动额度探测 | **无专用前端开关**；路由 API/配置 `usage_probe.enabled`；手动检查在 VM 用量/检查入口 | 关；保留 | 60 秒检查是否需要刷新，健康新样本保持被动；缺样本、窗口重置、活跃账号样本陈旧时查询。**调用链可能再试探 Fable 权益，发起真实 Messages**，不是保证零推理/零费用的只读轮询；暂不默认启用。手动/429 事件触发另有入口，关定时器不等于禁止一切查询。 |
| 15 VM 定时测试对话 | 虚拟机 `/vm` → 测试对话/详情测试页 → 定时测试；每 VM 的 `vm_test_schedule` 配置 | 新建默认关；保留 | 按时执行真实模型对话，持续消耗额度；不同于读取额度。只为指定槽、指定巡检目标配置。 |
| 16 决策模型 | 风险审计 → 决策模型；`/api/panel/jev-intercept` → `enabled`，provider/base_url/API keys | 关；保留 | Jev/Laya/ModernBERT 对文本评分，增加延迟、外发内容、依赖与可能费用。未配置服务、阈值和数据边界前不默认启用；默认 fail-open 不代表一定拦住风险。 |
| 17 OpenAI 风控参与 | 风险审计 → 硬正则/范围相关开关；`openai_platform_enabled` | 关；保留 | 允许适用的公共拦截策略覆盖 OpenAI 平台；蒸馏层仍有其独立排除契约。跨平台误报语料未验证，不自动扩大覆盖。 |
| 18 Anthropic→Codex 转换 | 设置 → OpenAI /settings/openai → 客户端/协议；codex.protocols、codex.convert.anthropic_to_codex | 关；保留 | 将 Anthropic 请求转换后投向 GPT，会改变平台语义与客户预期；保持按需启用。已开启的 OpenAI Chat/Completions 转换不在本次调整范围。 |
| 19 IPv6 SOCKS5 | 设置 → SOCKS5 `/settings/socks5`；`proxy_pool_config.ipv6_enabled` | 关；保留 | 允许探测/绑定/使用 IPv6 代理；先具备实际 IPv6 网络、代理和出口验证，不能默认开即获得 IPv6 能力。 |
| 20 异常时拆出口/停槽 | 代理池 API/配置 `proxy_pool_config.disconnect_on_error`；无专用设置页开关 | 关；保留 | 实验性运行错误处理，可能停止槽并拆 SOCKS 路径；不能把暂时错误变成更大范围断流。维持关闭。 |
| 21 DNS SVCB/HTTPS 过滤 | 代理池 `/proxies` → 管理/网络设置；`proxy_pool_config.dns_disable_svcb_https` | 关；保留 | 遇到具体代理/DNS 兼容问题时过滤相应记录。一般网络保留默认解析行为；不是必须开启的安全强化。 |
| 22 集群节点直连 | 集群 `/cluster` → 节点 SSH/连接面板 → 直连配置；`/api/panel/cluster/nodes/{id}/direct-link` | 未配置，不启用；保留 | 配置节点地址/端口和 TLS 路径，绕开部分 SSH 转发开销；依赖实际节点、防火墙与证书。按节点部署验证，不能用全局默认替代。 |
| 23 通知、Telegram/企业微信/邮件 | 设置 → 通知 `/settings/notify` 提供 Telegram/企业微信；SMTP 邮件经路由 API/配置设置；`notify.enabled`、各 channel.enabled | 总开关与渠道关；保留 | 推送缺号、恢复、失效和摘要等。**生产建议配置好真实收件目标后启用**；出厂配置没有目标/凭据，本轮未核查生产渠道，不设置一个无效的默认 true。事件子项有 true 但总开关关时不自动发送。 |

生效边界：官方透传复用现有 HTTP/API 处理路径；Rust cli-hop 已有独立的 native wire 保留逻辑。鉴权、商业授权、风控、身份替换和协议校验继续执行。非法 caller 缓存标记可能在调度前返回 400 invalid_cache_control；透传不是请求字节完全不变。

代码证据：[路由配置](../src/config/routing.json)、[persona/官方识别](../src/lib/identity/crs-persona.mjs)、[管理接口](../src/lib/admin/panel-api.mjs)、[健康探测](../src/lib/admin/health-probe.mjs)、[额度探测](../src/lib/oauth/usage-probe-monitor.mjs)、[Fable 调用](../src/lib/oauth/crs-usage-probe.mjs)、[初装](../src/lib/oauth/official-cc-bootstrap.mjs)、[种子](../src/lib/protocol/seed-policy.mjs)、[Codex](../src/lib/protocol/codex-route.mjs)、[风控](../src/lib/protocol/jev-intercept.mjs)、[代理池](../src/lib/vm/proxy-pool.mjs)。

执行状态：代码、配置、测试、Release Note、协议文档及文档索引修改均已撤销，仅保留本文。此前对试验修改运行的测试不代表启用建议已经交付；本次以 Git 差异核验撤销结果。未执行生产配置修改、提交、推送、发版、部署或数据处置。
