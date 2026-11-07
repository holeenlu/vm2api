# 全业务流程与数据逻辑审计及优化方案（2026-11-07）

> 2026-11-07：BPS 通道停止运营，相关代码与数据已删除（迁移 133），本文 BPS 相关条目仅作历史记录；尚未完成的 BPS 待办已标为“已作废（BPS 下线）”。

审计对象：main `6368af24`（上游 v1.4.051 `4c9a9392` 之上的单一定制提交）。阶段 0 修复在 main `08ee6830` 上开发、合入 `f58e2fe1` 后交付，行号可能有偏移。范围包括 Claude VM、GPT/Codex VM、Codex Gateway Worker（Go）、协议转发与转换、账号池调度与会话、计费结算、运营管理与数据层，共七个领域。

方法：七个领域各由一个独立的只读审计代理，逐文件追踪调用链；主会话再亲自复核全部 P0 和关键 P1 的代码证据（标 ✔）。已在 `docs/control-plane/reviews/AUDIT.md` 中处置的条目不重复列出。“已确认”指已读代码核实，“推测”指代码路径成立，但后果取决于上游或运行环境。本文行号以 `6368af24` 为准。

---

## 一、结论摘要

| 级别 | 数量 | 主要集中在 |
| --- | --- | --- |
| P0（资损、封号、越权、全站停摆） | 6（阶段 0 复核后 5：P0-3 降为观察项） | 计费漏收 2、BPS 封号扩散 2、主线程 DoS 1、管理员越权 1 |
| P1（明显错误或高概率故障） | 33 | 凭据刷新、重放判定、协议转换、计费一致性、调度名额、运维与安全 |
| P2 | 约 40 | 性能热点、背压、保留策略、口径、可观测性 |
| DOC/债务 | 约 8 | 死代码、配置不生效、文档与实现不符 |

最需要优先处理的五件事：

1. **计费存在三条稳定的漏收路径**：价目缺失或档位缺价时直接按免费放行；客户端在收到终态后、收尾前断开时整单不计费；并发请求可以把钱包透支，且没有上限。前两条任何持 Key 的用户都能主动利用。
2. **BPS 封号会被系统自身放大**：非流式请求遇到 usage-policy 403 后换号重放，最多连续打 4 个账号；对客户端返回 503，又引发客户端重试。系统没有按账号的用量预算，而永久 403 的账号每分钟被探测一次。这与生产上“约 300–400 次请求后逐个被永久封”的现象吻合。
3. **凭据刷新的入口太多，而且对不可重放的轮换做了重试或取消**：Claude 路径遇到上游 401 就强制换票（与 `docs/OAUTH.md` 的契约相反）；Go 刷新器在上游已轮换成功后，会因为上下文取消丢掉新票；BPS 刷新绑在请求上下文上。这些路径最终都表现为 `invalid_grant` 或 `refresh_token_reused`，账号只能重新授权。
4. **事件循环可以被单个请求打停**：蒸馏否定检测的耗时随文本长度二次增长，1.15 MB 的文本就会冻结主线程约 20 秒。此外，登录用同步 scrypt、无效凭据触发全表扫描、保留期清理一次性整批删除，都在主线程上执行。
5. **同域管理员可以互相改密码**，从而拿到 super_admin 授给对方的资源权限，包括 VM root 终端和凭据明文导出。

---

## 二、业务全景与数据所有权

### 2.1 请求主链路

```
客户端 ─► server.mjs 路由 ─► handleProtocol / executeProtocol
          │  读体解压 → 鉴权(会话/主密钥/托管 Key) → Key 准入(只读额度+内存并发)
          │  → 官方形状校验 → 模型/分组白名单 → authorizeRelayBilling(内存冻结报价)
          │  → 拦截(distill / JEV / 拒答相似度) → apiKeyStore.acquire
          ├─► Claude 模型：toClaudeMessages → persona/身份改写 → FailoverRunner
          │      → scheduler.selectAndReserve(粘性/席位/打分/排队) → kernel-router.runHop
          │      → Unix socket(远端经 kin-slot-gate TLS) → 槽内 Rust kernel → 官方 CLI → Anthropic
          └─► GPT 模型：handleCodexProtocol(统一转 Responses)
                 ├─ Gateway：dispatchCodexGateway → 签名环回 HTTP → Go Worker
                 │     → BPS 阶段 → 原生阶段(选号/Redis 并发租约/刷新租约) → OpenAI
                 └─ VM 直连：pickCodexCandidates → tryAcquireOpenAISlot → kernel unix socket → OpenAI
收尾：SSE 改写/转换 → commitRelayLog(一个事务：billing_charges 抢占 → 钱包扣减 → Key 用量
      → usage_logs → 触发器维护小时汇总 → vendor_usage_facts)
      Gateway 用量不完整：settlement_pending + reconciliation_jobs → receipt-reconciler 按回执结算
```

### 2.2 数据所有权

| 数据 | 写方 | 读方 | 备注 |
| --- | --- | --- | --- |
| `kin.db`（SQLite WAL） | Node 主线程唯一写连接（同步 `DatabaseSync`） | 读池 1–4 个 worker；Go Worker 以 `mode=ro` 读 `gateway_account_facts_v1` | 启动时自动迁移，迁移前不做快照 |
| Claude RT | 槽内 `cli-home/.claude/credentials.json`（Go `oauth refresh`，Node 导入时也写） | kernel、CLI | 唯一副本；面板备份不包含 |
| Codex VM 凭据 | `vms/<id>/codex-credentials.json`（kernel 与控制面都写） | kernel、控制面 | 写入无锁 |
| Gateway 凭据 | 控制面 `executor_credentials`（按代次 CAS） | Worker 经租约取用 | Worker 本地 `accounts.json` 写入无 fsync |
| 调度状态 | 内存（inflight、席位、队列、熔断）+ `sticky_sessions` + `account_runtime` + `vms/*.json` | 单进程调度器 | 重启后丢失内存态 |
| Redis | Worker（并发租约、冷却、续接） | Worker | 内容可丢，不可用时退回本地 |
| 计费 | `billing_charges`（request_id 主键互斥）、钱包、`usage_logs`、小时汇总 | 面板、结算 | 准入阶段只在内存，没有持久化的在途账本 |

---

## 三、P0 问题（6 项）

### P0-1 价目缺失或档位缺价时按免费放行 ✔
- **证据**：`relay-billing.mjs:465` 中 `resolvePrice(model)` 返回 null 也不拒绝；结算时 `actual=null`，记为 `unmetered`（`:93`、`:106`）。`pricing.mjs:209` 的 `!price.modes?.[mode]` 和 `:221` 的长上下文 `unpriced` 也会落到未定价。`service_tier` 只做字符串规范化（`codex-hop-shared.mjs:28`），没有白名单；遇到未知档位，`normalizeOpenaiServiceTier` 返回 null（`pricing.mjs:33-40`）。分组 `models` 为空时放行全部模型（`key-scope-policy.mjs:25`）；保存分组时只用标准档、1 个 input token 校验定价（`groups-repo.mjs:136-138`）。
- **触发**：新模型尚未收录，或 models.dev 刷新失败；`gpt-5.5-pro` 带 `service_tier: priority`（该模型没有 priority 档，见 `builtin-rates.mjs:172-174`）；`service_tier` 填任意字符串；超过 272k 且使用 flex/priority 的长上下文。
- **影响**：以 gpt-5.5-pro 为例，200k 输入加 20k 输出单次约 $9.6，实收 0。客户端可以主动利用。
- **修复**：倍率大于 0 时，只要拿不到报价或缺少对应档位，在准入阶段就返回 402/400 `model_unpriced`；入站 `service_tier` 只接受 `default/auto/priority/flex`（以目录中实际存在的档位为准），其余改写为标准档；保存分组时校验所有档位。

### P0-2 客户端断开（含终态之后）整单不计费 ✔
- **Codex VM 路径**：`handle-codex.mjs:1428-1431` 一看到 `gone.signal.aborted` 就记为 `cancelled` 并返回，这一步早于 `ingestCodexHop`（`:1446`）和用量写入（`:1456-1475`）。Codex CLI 读到 `response.completed` 就断开；WS 关闭时 `responses-ws.mjs:808-812` 还会主动 abort。
- **Claude 路径**：`meterableResult`（`handle-protocol.mjs:254`，在 `:281`、`:2336` 使用）只认 `ok===true`；`errors.mjs:318` 的注释说取消时会保留 usage 供计费，但没有被使用。收到 `message_delta` 后、`message_stop` 之前断开，就能免费拿到全文。
- **影响**：已交付的内容不收费，可稳定复现、可主动利用。Gateway 路径有 `gateway_await_receipt` 兜底，这两条路径没有。
- **修复**：分开判断“已交付”和“已取消”。只要已见终态，或上游已报 usage，或已提交过输出，就按已收到的 usage 结算（最少按下限）。取消判定放到计费之后。

### P0-3 BPS usage-policy 403 在非流式路径换号重放，并以 503 诱发客户端重试（阶段 0 复核后降为 P2 观察项，未改；已作废（BPS 下线））
- **复核更正（2026-11-07 阶段 0）**：`bpsStream` 区分的是失败发生在 BPS 上游流开始之前还是流内，与客户端是否用流式请求无关。流开始前的 HTTP 403 换号是有意对齐 sub2api 的设计，并且有按账号的 usage-policy 退避（30/60/120/240/300 秒），连续多个会话失败后停用该账号的 BPS（`TestBPSUsagePolicy403BacksOffTheAccountAndBlocksAfterSeveralSessions` 锁定）。生产上的封号模式（每账号约 300–400 次后永久 403）更像按账号用量触发，而不是同一内容在多个账号间扩散。因此本条不按 P0 修改，留作观察项；按账号用量预算见 P0-4。以下为原始描述。
- **证据**：不带 code 的 usage-policy 403 被归为 `categoryPermissionDenied`（`worker/internal/codexgateway/bps.go:659-667`）。`classify.go:436` 在非流式时把它判为可重放，于是换号（`attempt.go:235-245`），一次请求最多打 4 个 BPS 账号（`classify.go:48`、`bps.go:836-842`）。流式分支（`classify.go:428-434`）的注释写明要“避免被拒的内容撞到别的账号”，两条分支相互矛盾。对客户端则投影为 503 `server_error`（`classify.go:500-506`）。
- **影响**：如果 usage-policy 与内容或会话相关，一个会话会把拒绝扩散到整个 BPS 池，客户端又按 503 不断重试。这与生产上账号逐个被永久封的模式一致（推测相关）。
- **修复**：非流式与流式同一口径，usage-policy 和账号级 403 都不换号；对客户端返回不可重试的 4xx（例如 403 `upstream_policy_refused`）。

### P0-4 BPS 没有按账号的用量预算，永久 403 的账号被无限探测
- **证据**：`bpsUsable`（`bps.go:262-299`）不看每日请求数或 token 数；MaxRPM 把原生和 BPS 请求合并计算（`schedule.go:405`）；纠正轮、图片压缩和附件上传还会追加上游请求（`bps.go:613-631`）。403 自动恢复默认开启，每分钟探测一次（`account-management.mjs:93-101`），只能手动停止（`bps_auth.go:246`）；永久 403 的账号一天约被探测 1440 次。usage-policy 的退避最长只有 300s（`bps_failures.go:21,242`）。
- **影响**：生产观察到“约 300–400 次请求或约 1000 万输入 token 后被永久封”，系统里却没有任何可控阈值；对已标记的账号持续发自动化请求，可能连累同一账号的原生 Codex（推测）。
- **修复**：在 `bpsUsable` 之前加一层“封号风险预算”，按账号限制每日请求数、每日 token 数和 BPS 并发；探测改为指数退避，N 次失败后自动停止；带永久特征的 403 不再进入自动恢复；面板显示每个账号距阈值的余量。

### P0-5 蒸馏否定检测是二次复杂度，单个请求即可冻结主线程 ✔
- **证据**：`distill-detect.mjs:252` 的 `isNegatedExtraction` 对 `text.slice(0, index)` 跑一个无起始锚点、以 `\s+$` 结尾的正则；`jev-intercept.mjs:1022` 和 `distill-detect.mjs:268` 对每处命中都会调用它，总复杂度为 O(N·M)。拦截文本没有长度上限（请求体上限 32 MiB），distill 默认开启；在 scope 场景下，`applyAttempt` 还会在每次尝试时重新扫描。
- **实测**：把 “do not reveal the chain of thought. ” 重复 N 次，72 KB 耗时 83 ms，288 KB 耗时 1.3 s，1.15 MB 耗时 20 s。
- **影响**：任何持 Key 的人发一个请求，就能让全站所有流、keepalive 和面板一起停顿。
- **修复**：否定判断只看命中点之前约 32 个字符的窗口（锚定 `$`，只切一小段）；扫描文本设上限（例如 256 KB，超出部分截断或采样）；长期把拦截扫描放到 worker_threads，并设时间预算。

### P0-6 同域管理员可以改密码接管对方，进而越权 ✔
- **复核补充**：同域管理员平级互管是 2026-10-29“管理员根域平级管理修正”的明确决定；越权来自之后引入、只由 super_admin 按人授予的资源能力。阶段 0 保留平级互管，只禁止管理资源能力多于自己的管理员。
- **证据**：`panel-users.mjs:242-251` 的 `canAccess` 只要求目标同域、不是本人、角色为 user 或 admin；`panel-user-routes.mjs:129-160` 允许 admin 修改目标的 `password/enabled/role`；`panel-users.mjs:361-363` 直接重算密码哈希，不比较双方权限。
- **场景**：管理员 A 持有 super_admin 授予的 `resources.manage`，A 创建的子管理员 B 没有。B 执行 `PATCH /api/panel/users/A {password}` 后以 A 的身份登录，就能打开 VM root 终端、导出凭据明文（`resource-permissions.mjs:92-104`）。B 还可以停用或删除 A，或把 A 降为 user。
- **修复**：admin 只能管理自己子树（`parent_user_id`）下的 user；修改管理员账号只允许 super_admin，或者至少禁止修改资源能力多于自己的账号；补充越权回归测试。

---

## 四、P1 问题（33 项，按主题）

### 4.1 凭据与账号存活（直接关系到掉号和封号）

| 编号 | 问题 | 证据 | 修复要点 |
| --- | --- | --- | --- |
| P1-C1 ✔ | Claude 上游任何 401 都强制换票，与 `docs/OAUTH.md` 第 9 条“上游 401 不 force-refresh”相反 | `rust-kernel-client.mjs:187`（`status===401` 即需刷新）；`kernel-router.mjs:286-295` 调用 `ensure(exec,{force:true})` | 只对 kernel 明确返回的 `needs_refresh` 或临期令牌做非强制 Ensure；401 交给 failover 冷却。复核：e2e `credential-rotation` 明确覆盖“上游提前判定过期→强制换票后成功”，阶段 0 改为按槽 5 分钟最多强制一次 |
| P1-C2 ✔ | Go 刷新器对不可重放的 RT 轮换做重试；上游已轮换成功后，若上下文已取消则丢弃新票 | `worker/internal/oauth/refresher.go:164`（成功后检查 `ctx.Err()` 即返回）、`:179-205`（5xx 或传输错误用旧 RT 重试 3 次）；`slot-oauth.mjs:207` 超时时跳过 `afterRefresh` | 换票与落盘用 `context.WithoutCancel`，拿到 200 必须先落盘；传输错误和 5xx 不重放，先 Load 比对 generation。`OAUTH.md` 第 7 条“迟到响应不落盘”本身需要改写 |
| P1-C3 | Go 的隐式换票绕过 Node 刷新锁和登录保护窗；Node 写凭据不取 flock，会被 Go 的 Save 覆盖 | `oauthcmd.go:112-143` → `upstream/client.go:217`；`oauth-credentials.mjs:132`、`:417-497`；`refresher.go:121/168` | 非 refresh 操作一律只读，临期时报 `needs_refresh`；Node 写凭据走 Go 子命令或同一把 flock；Save 前做 generation CAS |
| P1-C4（推测） | Codex VM 控制面在 search/images 路径自行刷新 RT（遇 403 也刷新），且读改写凭据文件不加锁 | `handle-codex.mjs:1714-1733,1782`；`codex-slot.mjs:280-305` | 由 kernel 独占刷新，控制面只读 |
| P1-C5 | BPS 刷新绑在请求上下文上，调用方一断开就可能丢掉新 RT；且全局一把锁串行化所有账号的刷新 | `bps_failures.go:158-170`；`refresh_lease.go:367`；`bps.go:195`、`bps_auth.go:393-399`；恢复日志默认关闭（`config.go:148`） | 与原生刷新一致，用 `context.Background` 加独立超时；按账号单飞；默认开启恢复日志 |
| P1-C6 | 凭据库补收录只靠一次尽力而为的 release；租约 TTL（60s）等于刷新超时（60s） | `refresh_lease.go:253-269`；`refresh-lease.mjs:24,181`；`refresher.go:33`（注释误写 30s） | 心跳上报每个账号的代次，落后时自动补收录；过期未 release 的租约按 ambiguous 处理；TTL 大于刷新超时加申请耗时。复核：main `08ee6830`（S1/S1b）已删除刷新租约，改为 Worker 刷新后按代次 CAS 直接写凭据库、失败每 30 秒补写，本条已被取代 |
| P1-C7 | 面板恢复备份后，Go Worker 继续读旧库，已停用的账号仍被调度 | `backup-service.mjs:316-331`；`src/server.mjs:671-674`；`facts_db.go:115-124` | 每轮检查 inode，变化时重开连接；恢复钩子重启 Worker；事实数据超过最大陈旧期就拒绝调度 |
| P1-C8（已作废（BPS 下线）） | BPS 自称 Excel 插件，网络特征却是 Codex：UA 写死 `Mozilla/5.0`、TLS 用原生画像且只走 HTTP/1.1、与原生共用 Cookie 和出口；刷新请求的 UA 是 `Go-http-client/1.1` | `bps.go:494-507`；`fingerprint.go:203-205`；`server.go:724-737`；`cookies.go:14-15`；`bps_auth.go:306-312` | 给 BPS 独立的客户端画像（浏览器 TLS、h2、完整 UA、独立 Cookie 罐）；评估是否分开出口 |
| P1-C9 | Claude 槽的 RT 是唯一副本，却不在任何备份里；写入也没有 fsync | `backup-core.mjs:104-135`（只备份 `vms/*.json` 和配置）；`vm-file.mjs:195-217` | 每次轮换后把加密副本写入凭据库；写文件时 fsync 文件和目录；备份页写明范围 |

### 4.2 重放、换号与调度名额

| 编号 | 问题 | 证据 | 修复要点 |
| --- | --- | --- | --- |
| P1-R1 ✔ | kernel 层遇到传输错误，只要没提交就立即重发，不看 `sendState`（首字节超时、idle 超时都算） | `kernel-router.mjs:281-284`；`go-worker-client.mjs:861,1149` | 只在 `sendState==='not_sent'` 时重发，其余交给 failover 判定 |
| P1-R2 | 图片 VM 路径失败后换号重发，没有次数上限和总截止时间，也不传播取消 | `handle-codex.mjs:2192-2221,1793-1796,2013` | 已发送后的 5xx 或超时不重放；加尝试预算、总截止时间和 signal |
| P1-R3 ✔ | 占用名额之后、进入 try/finally 之前的 await 抛错，名额永久泄漏 | `failover-runner.mjs:922` 拿到名额后，`:944-976`（resolve、snapshotPins、bindAll、attemptsRepo.begin）在 `:997` 的 try 之外，唯一释放在 `:1333`；`pool-scheduler.mjs:1087,1799,657,842`；`handle-codex.mjs:1067-1133` | 拿到名额后立刻进入 try/finally；引入调度租约账本，并用 `res.on('close')` 兜底释放 |
| P1-R4 | Claude 529 没有池级判定：逐个账号停放 10 分钟导致整池停摆，到期又同时涌入 | `rate-limit-service.mjs:150-153,190-195` | 复用 OpenAI 侧的池相对离群判定；短冷却、指数退避加抖动；到期后先放一个探针 |
| P1-R5 | 排队期间每 2 秒全量重扫 O(等待数×VM 数)，每个候选还重读一次 Key 作用域 | `pool-scheduler.mjs:74,828,1104,1147` | 每次扫描只刷新一次作用域；按调度时刻共享资格快照，由事件使其失效 |

### 4.3 协议转换与流

| 编号 | 问题 | 证据 | 修复要点 |
| --- | --- | --- | --- |
| P1-P1 ✔ | SSE 按数据块做 `toString('utf8')`，块边界上的中文和 emoji 变成乱码，进入正文和计费文本 | `go-worker-client.mjs:1012`；`api-protocol.mjs:250` | 改用 `StringDecoder` 或 `setEncoding('utf8')` |
| P1-P2 | 流已经发出 200 后失败，Chat/Completions/Responses 客户端既收不到 error 也收不到 `[DONE]`；Anthropic 流开始后遇到 timeout 也不发 error | `handle-protocol.mjs:2347-2364,1668` | 统一的流失败收口函数，按协议写 error 帧和终止符 |
| P1-P3 | GPT 的推理摘要被当成正文 `text_delta` 发给 Anthropic 客户端，并在多轮对话中逐轮累积 | `codex-convert.mjs:744` | 转成 thinking 块（不回放）或丢弃 |
| P1-P4 | Anthropic→Codex 转换丢失 base64 图片、thinking/effort、`tool_result` 中的图片和 `is_error` | `codex-convert.mjs:59,404` | 补齐映射；无法转换时返回 400，不要静默丢弃 |
| P1-P5 | Responses↔Claude（API 后端的 Anthropic 端点）工具调用完全失效：请求变成空文本、流中没有 function_call、缺 `call_id` | `convert.mjs:409,539` | 补齐 item 映射，状态机按块类型分开处理；修好前禁用这个组合 |
| P1-P6（推测客户端行为） | 截断补尾会给半截的 tool_use 补上收尾，以 `max_tokens` 正常结束，agent 可能执行半截参数 | `stream-truncation.mjs:14,140-155` | 开着的块是 tool_use 时改发 error 事件 |
| P1-P7 | 会话所绑账号的凭据失效时，上游 401 原样返回客户端，客户端误以为自己的 Key 失效 | `failover-runner.mjs:1318-1323`；`errors.mjs:555` | 账号侧的凭据错误统一映射为 503/529 `account_unavailable` |
| P1-P8 | Codex 预压缩按 JSON 字节数÷4 估算 token，base64 截图会被估成几十万 token，导致静默删除历史、前缀缓存反复失效 | `codex-context-budget.mjs:54-56`；`handle-codex.mjs:1200` | 图片和 `encrypted_content` 按固定或近似的 token 数计 |
| P1-P9 | 分组的 Fast 三态（`codex_fast_mode`）只在 Gateway 路径生效，VM 路径（含 Gateway 回退到 VM）照发客户端的 priority | `gateway-execution.mjs:351`；`handle-codex.mjs:1465` | 档位策略移到分流之前，两条路径共用 |

### 4.4 计费一致性

| 编号 | 问题 | 证据 | 修复要点 |
| --- | --- | --- | --- |
| P1-B1 | 并发请求可以透支钱包，没有上限：只判断 `balance<=0`，结算无条件扣减；Key 额度和套餐窗口也只读检查 | `relay-billing.mjs:142-147,459-462,520`；`api-keys.mjs:519-540,671-674` | 持久化在途账本：按 `max_tokens` 预占，可用额度 = 余额 − 冻结；至少设负余额下限 |
| P1-B2 | 请求成功但 usage 缺失或不完整时，按 0 或部分用量记为 settled（VM/API 路径没有 Gateway 那样的“未证实的 0 不结算”保护） | `handle-protocol.mjs:254-256,283-285,1647,2269` | 用量不完整时转为 pending，或按下限结算并告警 |
| P1-B3 | 进程重启或崩溃导致漏扣，且没有持久化补偿：准入只在内存；停机只等 25s；重试队列只在内存；对账任务只在收尾时创建 | `relay-billing.mjs:468`；`graceful-shutdown.mjs:17,99-105`；`commit-retry.mjs:27`；`server.mjs:413`；`handle-protocol.mjs:300` | 准入时写 pending charge，启动时扫描兜底；重试队列先写文件；部署先排空再停进程 |

### 4.5 安全、运维与数据层

| 编号 | 问题 | 证据 | 修复要点 |
| --- | --- | --- | --- |
| P1-S1 | 远程图片抓取存在 SSRF：任意 http(s) 地址、跟随重定向、读完整个响应才判断 8 MB，每次重试都重新抓取（Claude 和 Codex 共用） | `images.mjs:113-153`；`handle-protocol.mjs:1955` | 禁止私网、回环、链路本地和元数据地址；逐跳校验重定向；流式限长；传入 signal；同一请求内缓存结果 |
| P1-S2 ✔ | 登录没有限速；scrypt 同步执行会阻塞主线程；用户不存在时立即返回，可以枚举用户名 | `panel-routes.mjs:3837-3843`；`server.mjs:866,887`；`panel-users.mjs:19-22,90,277-280` | 按 IP 加用户名限速并锁定；改用异步 scrypt；用户不存在时也计算一次假哈希 |
| P1-S3 | 无效凭据会触发 `api_keys` 全表扫描（历史明文迁移循环一直没删），以及同步重读 `panel-sessions.json` | `api-keys.mjs:227-245`；`security.mjs:174-178`；`server.mjs:906-918` | 启动时一次性完成迁移并删除该循环；会话未命中时不重读文件；未鉴权请求统一限速 |
| P1-S4 | 保留期清理在主线程同步整批删除，再执行 `wal_checkpoint(TRUNCATE)` | `usage-logs-repo.mjs:269-270,1809-1826`；`request-attempts-repo.mjs:72,224` | 按 `LIMIT 500` 分批删除，批次之间让出事件循环；检查点改为 PASSIVE |
| P1-S5（需确认意图） | 普通用户可以解除管理员施加在 Key 上的管控（状态、额度、到期时间、并发、`reset_quota`） | `panel-tenant.mjs:8-10`；`panel-routes.mjs:2181-2201`；`api-keys.mjs:314-337` | 对不是自己创建的 Key，user 只能改名称和 IP；增加 `admin_disabled` 状态 |
| P1-S6 | 高危操作不写审计：VM/节点终端票据、Docker 容器启停、代理凭据明文回显、主机升级、熔断重置 | `panel-vm-runtime-routes.mjs:34-50`；`cluster-routes.mjs:85`；`route-table.mjs:72-80,270,326`；`panel-routes.mjs:4385,6476-6488` | 路由表强制每条非 GET 路由声明 audit；终端会话记录操作者、IP 和起止时间 |
| P1-S7 ✔ | 启动时自动执行迁移，迁移前不做快照（破坏性迁移 128 也是如此） | `database.mjs:168,333-395` | 有待执行迁移时，先 `VACUUM INTO data/backups/auto/pre-migrate-<版本>.sqlite` 并校验，失败则拒绝启动 |

---

## 五、P2 问题（摘要）

| 领域 | 问题（证据） |
| --- | --- |
| Codex VM | WS 回放快照单条超过 8 MB 时会把新条目一起淘汰（`responses-ws.mjs:226,696`）；WS 假 res 的 `write` 恒返回 true，没有背压（`:422,447`）；WS 中断时无活动响应也回 accepted，且不发终态帧（`:688,763-768`）；排队期间取消会丢失使用记录（`handle-codex.mjs:1073-1076`）；白名单入口按原名、选号按映射名，口径不一（`handle-protocol.mjs:1109`、`handle-codex.mjs:349,1218`）；账号错误保护 CAS 失败时丢更新（`codex-account-protection.mjs:78-85`）；每条 SSE 行被 JSON.parse 3–5 次，每个 `response.*` 事件都同步读凭据并写库（`handle-codex.mjs:1304,1377-1388`） |
| Claude VM | 请求路径同步读 `routing.json` 4–6 次，并与配置快照混用（`handle-protocol.mjs:1311/1502/1506/1548/1917`）；kernel.json 同步在请求线程里执行（`rust-kernel-supervisor.mjs:1005`）；`loadVmIdentity` 每次尝试调用两次、每次同步读 4 个文件（`:1886,:2167`）；`x-kin-debug/log/rewrite` 不鉴权，可暴露 vm_id、落盘完整请求体或关闭日志（`handle-protocol.mjs:2393,1307`、`request-log.mjs:398-403,582-598`）；迁移排空不等换票（`slot-migration.mjs:71-82`）；`kin-slot-gate` 遇到 Accept 错误即退出（`slotgate.go:96-108`）；凭据软链修复存在 TOCTOU（`oauth-credentials.mjs:147-216`）；anthropic-beta 从入站请求学习，导致指纹漂移（`crs-headers.mjs:204-224`） |
| Gateway | `Store.persist` 不做 fsync，每次轮换都在请求路径上同步重写整份账号文件（`store.go:1095-1127`、`bps_store.go:14-33`）；`seenNonce` 在全局写锁下线性扫描（`server.go:996-1010`）；事件日志的读和写共用一把锁并逐行解析（`events.go:409-466`）；回执 spool 没有 TTL，被拒的回执永不 ack，`dispatch_id` 未校验就拼进路径（`server.go:859-890,1048`）；Worker 重启时在途流拿不到回执，最终转为不计量（`server.go:1148-1166`、`receipt-reconciler.mjs:217-219`） |
| 协议 | `response.incomplete` 没有处理，`stop_reason` 无法映射为 `max_tokens`（`codex-convert.mjs:545,760,916`）；Chat 流的 `prompt_tokens=0`（`convert.mjs:867`）；`finish_reason` 映射不全（`convert.mjs:140`）；Claude 路径没有背压，且每个流都完整组装一份（`handle-protocol.mjs:2201/2210`、`go-worker-client.mjs:1043`）；上游错误原文（含组织 UUID 和 request_id）透传（`errors.mjs:451-466`、`api-protocol.mjs:550`） |
| 调度 | 资格扫描的读路径带写副作用（`pool-scheduler.mjs:1262-1270,2232`）；VM 队列队头阻塞（`seat-planner.mjs:447`）；直连路径惊群且不保证 FIFO（`pool-scheduler.mjs:509,2151-2170`）；冷却到期集中唤醒、没有抖动（`:2016`）；面板为取一个计数读整张 sticky 表（`sticky-router.mjs:673-684`）；熔断半开可能长期停在单探针（unit-circuit） |
| 计费 | `settlement_pending` 孤儿记录无人清理（`handle-protocol.mjs:300-302`、`gateway-repo.mjs:119`）；回执回填按实时价重算，与冻结报价不一致（`gateway-repo.mjs:1139-1141`）；供应商结算与客户计费口径不对称（`vendor-usage.mjs:16-22`、`pricing-repo.mjs:16-20`）；网页搜索按次计费会吞掉 token 计价（`media-pricing.mjs:93-105`）；免费分组加生图倍率时，零余额可无限生图（`relay-billing.mjs:92,462`）；统计保留期默认 7 天、DELETE 触发器会同步扣减小时汇总（`127_money_micros_rollups.sql:142,326`）；结算重放会重复计 Key 用量（`settlement-replay.mjs:77`） |
| 运营与数据 | 追加型表没有保留策略：`gateway_worker_receipts`、`gateway_worker_dispatches`、`billing_charges`、`operation_audit`、`vendor_audit_events`、`config_revisions`、`gateway_worker_dead_letters`、`gateway_worker_oauth_sessions`；会话令牌存在 localStorage，且没有绝对过期时间（`web/src/lib/session.ts:59-65`、`security.mjs:198-203`）；VM 导入接口不校验 `vm_id`（`panel-vm-import-routes.mjs:36-45`）；密钥回退链最终落到硬编码的开发密钥，`npm start` 绕过 `prepareRuntimeSecrets`，缺 DB_SECRET 时数据库里存明文（`api-keys.mjs:155-165`、`secure.mjs:54-57`）；面板备份不包含 Claude 槽凭据、主密钥和 `runtime-secrets.json` |

## 六、DOC 与技术债

- Claude 的 HTTP hop 分支不可达（`slot-engine.mjs:70-86` 恒返回 rust）：`handle-protocol.mjs:2003-2085` 与 `official_cc.inference` 配置都是死代码，应按清理规则删除。
- Codex 的 gpt-6-astra 历史回退和 5xx 同号重试在生产不可达（`codex-replay.mjs:8-24`，`replaySafe` 只在测试里注入）。
- `req.retryBudget` 只计数、不约束，实际生效的是 `AttemptCoordinator` 的 `max_total_attempts`（`failover-runner.mjs:747`）。
- `before_client` 拦截只作用于非流式响应（`handle-protocol.mjs:2408`）。
- 面板上的 `seat_grace_ms` 可以编辑但不生效（`pool-scheduler.mjs:298`）；`strategy` 拼错会静默变成 balanced；`normalizePoolConfig` 透传未知键；`worker_health_ttl_ms` 为非数字时会退化成紧循环（推测）。
- 事实契约在迁移 129 新增 `vendor_active` 时没有升版本；Worker 用 `SELECT *` 按列名解码；设计文档仍按多实例描述，实际只支持单实例。
- 套餐和 Key 的“日/周/月”实际是 24h/7d/30d 滚动窗口，而统计按 Asia/Shanghai 自然日。
- `refresher.go:223,298` 的注释写 30 秒，实际是 60 秒。

---

## 七、横切根因

把八十多条问题归并后，大多出自以下七个共同原因。只修单点，问题会在别的路径上复发：

1. **计费以“请求是否 ok”为准，而不是“是否已交付、上游是否报了 usage”**，导致 P0-1、P0-2、P1-B2 和多条 P2。另一个原因是准入只冻结在内存，没有持久化的在途账本（P1-B1、P1-B3）。
2. **不可重放的操作被当作可重放**：RT 轮换被重试或取消（P1-C2、P1-C5）；已发送的请求被重发（P1-R1、P1-R2）；usage-policy 拒绝被换号重放（P0-3）。缺少一个全局统一的“发送状态 × 失败类别 → 是否可重放”判定表。
3. **凭据有多个写入者和多个刷新入口**：Node、Go、kernel、控制面 search/images 都可能换票或写文件，锁和保护窗分散在三处（P1-C1 至 C4）。
4. **两条（或三条）执行路径各自实现同一策略**：VM 与 Gateway 的 Fast 策略、白名单口径、取消计费、错误投影、流式与非流式的重放口径都已出现漂移（P1-P9、P0-3）。
5. **主线程承担重活**：正则扫描、scrypt、同步读文件、整批删除、全表扫描、全量重扫队列都在主线程上（P0-5、P1-S2 至 S4、P1-R5）。这与生产 ELU 达到 0.4–0.6 的画像一致。
6. **资源生命周期没有账本**：并发名额、席位、租约都靠代码路径正确地成对调用（P1-R3），一旦出现异常分支就会泄漏，而且无法巡检。
7. **数据生命周期没有清单**：追加型表没有保留策略，迁移前不做快照，备份范围不完整（P1-S7、P1-C9 等）。

---

## 八、优化调整方案

原则：遵循 AGENTS.md 的“上游优先、最小定制差异”。涉及上游文件（如 `handle-protocol.mjs`、`relay-billing.mjs`、`pricing.mjs`）时，先确认上游有没有同类方案；本地差异要记录依据、范围和移除条件。每个阶段都按交付规范归入单一定制提交，生产部署另行授权。

### 阶段 0：止血（1–3 天，每项都是小改动，可独立交付）

| 项 | 对应问题 | 验收标准 |
| --- | --- | --- |
| 0.1 未定价拒绝与 `service_tier` 白名单 | P0-1 | 缺价、缺档位或未知档位时返回 402/400；单测覆盖 gpt-5.5-pro + priority、未知档位和长上下文缺档；`unmetered` 计数接入告警 |
| 0.2 断开不免单 | P0-2 | Codex VM 和 Claude 两条路径上，“已见终态、已有 usage 或已提交输出”时取消按已收到的 usage 结算；新增 e2e：在 completed 之后断开，仍会扣费 |
| 0.3 BPS 拒绝不扩散（已作废（BPS 下线）） | P0-3 | 非流式 usage-policy 和账号级 403 不换号；对客户端返回不可重试的 4xx；Go 单测锁定流式与非流式行为一致 |
| 0.4 BPS 探测与临时预算 | P0-4 | 探测改为指数退避，N 次失败后自动停止；每账号每日请求数和 token 数上限可配置（默认保守值），超限时把账号移出 BPS |
| 0.5 蒸馏检测限时 | P0-5 | 否定判断只看窗口；扫描文本上限 256 KB；用 1.15 MB 用例回归，耗时小于 50 ms |
| 0.6 管理员越权 | P0-6 | admin 不能改其他 admin；越权回归测试 |
| 0.7 Claude 换票契约 | P1-C1、P1-C2 | 401 不再 force；Go 拿到 200 后用 WithoutCancel 先落盘；传输错误和 5xx 不重放；同步修订 `OAUTH.md` 第 7、9 条 |
| 0.8 重发只限 `not_sent` | P1-R1、P1-R2 | kernel 层与图片路径共用 sendState 判定；图片路径加预算和 signal |
| 0.9 名额泄漏 | P1-R3 | 拿到名额后立即 try/finally；注入异常的单测证明 inflight 归零 |
| 0.10 SSE 解码、SSRF、登录 | P1-P1、P1-S1、P1-S2 | StringDecoder；出网黑名单与限长；登录限速、异步 scrypt、假哈希 |
| 0.11 迁移前快照 | P1-S7 | 有待执行迁移时自动 `VACUUM INTO` 并做 quick_check，失败则拒绝启动 |

### 阶段 1：可靠性（1–2 周）

1. **凭据单一所有者**：Claude 只由 Go `oauth refresh` 换票，其他子命令一律只读；Node 写凭据走 Go 子命令；Codex VM 由 kernel 独占刷新；BPS 刷新与请求脱钩、按账号单飞；所有凭据写入都 fsync；Claude RT 每次轮换后把加密副本写入凭据库；心跳上报代次，控制面自动补收录（P1-C1 至 C6、C9）。
2. **在途账本（计费）**：准入时写 `billing_holds`（冻结报价、预估上限），收尾时转为 `billing_charges`；启动扫描器兜底超时的 hold（按 Worker 回执或下限结算）；可用余额 = 余额 − 冻结；设负余额下限（P1-B1、B3、P2 孤儿记录）。
3. **流失败收口与转换修复**：统一的 `writeStreamFailure(protocol)`；推理摘要转为 thinking；补齐 Anthropic→Codex 的图片和 effort 映射；Responses↔Claude 在修好前禁用；截断补尾避开 tool_use；账号侧 401 映射为 503（P1-P2 至 P7）。
4. **Gateway 事实与恢复**：检测 inode 变化并设最大陈旧期；恢复备份后重启 Worker；Worker 重启前先 drain，中断的流写出带部分用量的回执（P1-C7、P2）。
5. **调度健康**：Claude 529 做池级判定，冷却加抖动，到期先放探针；排队时每次扫描只刷新一次作用域（P1-R4、R5）。
6. **主线程减负**：保留期清理分批执行；删除 `api_keys` 明文迁移循环；`routing.json` 统一取快照；`loadVmIdentity` 按 mtime 缓存（P1-S3、S4、P2）。
7. **审计与权限**：路由表强制声明 audit；终端会话写审计；Key 的管控字段只允许创建者或管理员修改（P1-S5、S6，需先确认产品意图）。
8. **数据生命周期清单**：新增 `docs/data-retention.md`，登记每张追加型表的保留期；dispatches、oauth_sessions、receipts、dead_letters 定期清理；`billing_charges` 按月做余额检查点后归档；小时汇总不随明细删除而扣减（P2）。

### 阶段 2：结构性优化（1–2 个月）

1. **统一请求计划（Request Plan）**：模型映射、档位策略、Fast 三态、白名单口径、预压缩、计费报价在分流之前一次算好，VM 与 Gateway 共用，消除两条路径的漂移。
2. **单一 SSE 管线**：一个 UTF-8 安全的流式解码器，每个事件只解析一次 JSON，用量、终态、归属、改名、转换各自订阅；内置背压（等 drain，按 WS `bufferedAmount` 暂停读取）。
3. **转换器状态机 + 双向 golden 测试**：按“块类型 × 终态”组织转换器，覆盖工具调用、并行工具、thinking、incomplete/failed 和 usage；Anthropic↔Chat↔Responses 做往返校验。
4. **全局重放判定表**：用一张表定义“发送状态 × 失败类别 × 流式与否 → 是否重放、是否换号、对客户端的状态码、是否可重试”，Go 与 Node 共用同一份定义（生成代码或契约测试），并加流式与非流式一致性测试。
5. **调度租约账本 + 只读资格快照**：所有 reservation、lease、seat 按 requestId 登记；定期巡检 inflight 与实际在途请求是否一致，不一致就告警；资格计算按调度时刻共享快照，修复类写入移到 `maintain()`。
6. **BPS 风险治理**（已作废（BPS 下线））：封号风险预算层（每日请求数、token 数、并发、探测频次）、独立客户端画像、每账号用量看板。同时请业务方评估 BPS 的投入产出，是否继续运营（见第九节）。
7. **每日自动对账**：校验“充值 − 实扣 = 余额”，检查 `billing_charges`、`usage_logs`、`vendor_usage_facts` 三方行数与金额是否一致，统计 unmetered 金额占比，结果接入告警（扩展 `scripts/audit-money-micros.mjs`）。
8. **ELU 守护**：主线程只做 IO 编排；正则扫描、哈希、清理、统计放到 worker 线程；CI 加压测，确认 ELU 和最坏停顿不回退。
9. **配置 schema 化**：未知键报错；面板上的每个字段都有测试证明它确实生效；删除不生效的字段。

### 度量指标（每个阶段交付后复测）

- 计费：unmetered 金额占比、`settlement_pending` 超过 1 小时的数量、负余额钱包数和最低余额、三方对账差额。
- 账号：每日 `invalid_grant` / `refresh_token_reused` 次数、403 探测次数（BPS 每账号存活请求数已作废（BPS 下线））。
- 稳定性：ELU p50/p99、超过 500 ms 停顿的窗口占比、inflight 账本偏差、客户端可见的 503 比例。
- 数据：kin.db 体积的日增量、各追加型表的行数。

---

## 阶段 0 处置记录（2026-11-07，基于 main `08ee6830`）

| 项 | 对应 | 处置 | 回归测试 |
| --- | --- | --- | --- |
| 0.1 | P0-1 | 推理准入（Claude/GPT 主入口与 API 后端）在倍率大于 0 时要求可计价：未收录模型 `model_unpriced`、未知档位 `invalid_service_tier`、模型没有该档位 `service_tier_unpriced`，均 400；免费分组与 super_admin 不受影响 | `relay-operations.test.mjs` |
| 0.2 | P0-2 | Codex VM：已见终态或已有用量时，客户端断开照常计费；Claude：已提交输出后断开按已收到的上游用量计费 | `codex-failure-regression.test.mjs`、`customer-billing-slot.test.mjs` |
| 0.3 | P0-3 | 复核后不改（见上文更正）；已作废（BPS 下线） | — |
| 0.4 | P0-4 | 403 停用后的恢复探测按恢复间隔 × 2^失败次数退避（上限 6 小时），连续失败 8 次自动停止恢复；每账号每日请求/token 预算需定阈值并接面板，移到阶段 1 | `TestBPSFailedProbesBackOffAndStopAutomatically` |
| 0.5 | P0-5 | 否定判断只看命中点前 64 个字符：1.15 MB 从约 20 秒降到约 4 毫秒 | `distill-detect.test.mjs` |
| 0.6 | P0-6 | 管理员不能管理资源能力多于自己的管理员 | `panel-users.test.mjs` |
| 0.7 | P1-C1、C2、C5 | 上游 401 引起的强制换票按槽 5 分钟一次；Claude Go 刷新器与 BPS 请求内刷新的换票请求与调用方取消脱钩，拿到 200 必落盘（落盘前代次被改过则放弃）；`OAUTH.md` 第 7、9 条同步修订 | `kernel-router.test.mjs`、`refresher_test.go` |
| 0.8 | P1-R1、R2 | kernel 层只在请求未送达（`not_sent` 或连接阶段错误）时隐式重发；生图只在上游明确拒绝或请求未发出时换号，最多 4 次，客户端断开即停 | `kernel-router.test.mjs`、`handle-codex-images.test.mjs` |
| 0.9 | P1-R3 | failover、Codex VM 占座、调度器 `followStickyWinner` 与席位直接授予：占用后、进入 try/finally 前的等待抛错时归还名额 | `failover-runner.test.mjs` |
| 0.10 | P1-P1、S1、S2 | SSE 流式 UTF-8 解码；远程图片只抓公网地址、逐跳校验重定向、流式限长；登录按用户名（10 次）与来源 IP（30 次）15 分钟限速，scrypt 改异步，不存在的用户名同样计算一次哈希 | `go-worker-client.test.mjs`、`images-materialize.test.mjs`、`login-throttle.test.mjs` |
| 0.11 | P1-S7 | 已有库存在待执行迁移时，先 `VACUUM INTO data/backups/auto/kin-pre-migrate-<时间>.sqlite` 并 quick_check，失败拒绝启动，保留最近 3 份；`KIN_DB_PREMIGRATE_SNAPSHOT=0` 关闭 | `database-premigrate-snapshot.test.mjs` |

## 阶段 1 处置记录（2026-11-07 起）

用户决定：BPS 默认每账号每天 200 次请求、600 万输入 token；钱包补崩溃漏扣并加低余额保护、不预占；管理员替用户创建的 Key，用户只能改名称与 IP 名单。

| 工作包 | 对应 | 处置 | 回归测试 |
| --- | --- | --- | --- |
| W1 | P1-C3、P1-C4、P1-C9 | 槽内 Go 非 refresh 子命令只读，临期报 `needs_refresh`，Node 经带锁 ensure 后重试；Go 刷新落盘前区分“另一份授权”（放弃）与“同授权改元数据”（合并新票）；凭据写入 fsync；Codex 控制面换票按槽单飞、采用内核已轮换的令牌、只对 401；Claude 槽凭据加密副本写入凭据库（`claude_slot`）与只读恢复脚本 | `stage1-credentials.test.mjs`、Go `oauthcmd`、`oauth` |
| W2 | P1-B1、P1-B3、P2-5、P2-6、P2-9 | 迁移 131 在途记录、孤儿扫描补结算（已结算删除 / Gateway 补对账 / 其余记 interrupted）、低余额并发保护（默认 1 美元、1 个在途，面板可调）、对账入队不吞错、回执回填用冻结报价、独立生图倍率参与准入、停机排空 120 秒与 compose `stop_grace_period: 150s` | `billing-inflight.test.mjs`、`relay-operations.test.mjs` |
| W3 | P1-P2 至 P1-P8、P1-R4、P1-R5 | 流失败按协议补错误帧与 `[DONE]`；Codex 推理摘要不进 Anthropic 正文；Anthropic 图片与推理强度映射到 Codex；`response.incomplete` 三条路径按截断收尾；`model_context_window_exceeded` → `length`、Chat 流 prompt_tokens 合并 message_start；Responses 用工具或图片时拒绝转 Anthropic 端点；会话账号凭据失效回 503 `account_unavailable`；Claude 529 池级判定加抖动；扫描不再逐候选重读 Key；热路径改用配置快照、槽身份每 attempt 只读一次。P1-P6 复核为设计（半截工具 JSON 解析失败即重发），不改 | `stage1-protocol.test.mjs`、`rate-limit-service.test.mjs` |
| W4 | P0-4（余下）、P1-C5、P1-C7、P2-11 | BPS 每日上限（默认每账号每天 UTC 200 次请求、600 万输入 token，0 不限；到线当日改走原生、次日零点恢复，面板显示“今日 x/y”）；BPS 刷新改按账号单飞（删除全局 `refreshMu`）；事实直读按设备号与 inode 发现库文件被替换并重开连接，超过 2 分钟未读成功拒绝调度（503 `gateway_facts_stale`）并上报陈旧时长；恢复备份后托管器排空并重启 Worker；托管器停止前先排空（最长 120 秒）再 SIGTERM，Worker 停机时为仍在途的流写出带部分用量的 `worker_shutdown` 回执 | Go `audit_w4_test.go`、`gateway-worker-supervisor.test.mjs`、`gateway-account-management.test.mjs`、web `bps-section` |
| W5 | P1-S3、P1-S4、P2 保留策略 | 使用记录、调试明细、请求尝试按 500 行分批清理、批间让出事件循环，检查点改 PASSIVE，请求尝试改随 10 分钟周期；新增 Gateway Worker 保留期（回执、派发、终态对账、死信 30 天，授权会话过期 7 天）；迁移 132 `usage_prune_marker`：保留期清理不扣减小时汇总；`docs/data-retention.md` 保留清单；启动与恢复时明文 Key 一次性哈希化并删除全表比较循环；未知会话令牌最多每 5 秒回读一次会话文件 | `data-retention.test.mjs`、`api-keys.test.mjs`、`security.test.mjs` |
| W6 | P1-S5、P1-S6 | user 对管理员替其创建（或无创建者）的 Key 只能改名称与 IP 名单，其他字段与重置额度 403 `key_managed_by_admin`，面板置灰并提示；VM/节点终端票据与代理明文回显由处理器写审计（操作者、来源 IP、目标、时间，不含票据与明文，写入失败不返回），Docker 容器写操作、主机与整机队升级、熔断重置等改状态动作按路由写审计；路由表强制 write/auth/action/reveal 声明审计，豁免逐条写原因 | `panel-api-key-routes`、`route-table`、`route-audit`、`resource-permission-routes`、`cluster-edit-routes`、web `key-limit-fields` |

## 阶段 2 处置记录（2026-11-07 起）

用户决定：阶段 2 按工作包分别交付；额度周期保留按时长计算的窗口并在界面写明；`seat_grace_ms` 是上游原有字段，保留不删，只在文档标注不生效；供应商结算只按客户已扣费的请求结算（W10）；死代码删除本地造成的部分（gpt-6-astra 不可达回退、`retryBudget`，W13），上游部分（Claude HTTP hop、`seat_grace_ms`）保留并记录。

| 工作包 | 对应 | 处置 | 回归测试 |
| --- | --- | --- | --- |
| W7 | P2 安全与小修 | `x-kin-log/debug/rewrite` 与响应 `kin` 字段只认主 Key；面板会话签发后 30 天绝对上限；VM 导入按槽位 ID 校验 `vm_id`；生产缺 Key 哈希密钥或数据库密钥时拒绝回退（`npm start` 走 `start-server`）；上游错误原文抹掉组织 UUID 与 `org-…`；Codex 账号保护 CAS 落败重读重算；Worker 账号表 fsync 原子写；nonce 清理每分钟一次；面板粘性会话数改 COUNT。复核不改：网页搜索按次计价（计价规则待定）、P2-11（阶段 0 已复核）；槽位迁移不等换票待设计 | `request-log`、`security`、`panel-vm-route-handled`、`production-secrets-guard`、`errors-map`、`codex-scheduling`、Go `w7_audit_test.go` |
| W8 | 阶段 2 第 3 项（golden 部分） | 只加测试、不改转换器：10 个场景 × 三种入站（Anthropic / Chat / Responses）× 两个后端（Claude / Codex）的出站请求与流式、非流式客户端输出 golden，6 类往返校验与流契约检查，`UPDATE_GOLDEN=1` 重新生成。登记 7 个转换器缺陷为 `todo`，留给 W12/W15：G1 Claude→Responses 流无 usage；G2 Claude→Responses 丢 tool_use（已被 `responses_endpoint_incompatible` 挡住）；G3 `max_tokens` 转 Responses 报 completed；G4 Anthropic 推理预算 16384/32768 回映到 Codex 降一档；G5 Responses 工具项转 Claude 成空文本（已挡住）；G6 Codex→Anthropic 流正文块与工具块交叠；G7 Claude→Responses 流对 thinking/tool_use 块发多余 done | `convert-golden.test.mjs`（夹具 `test/fixtures/convert-golden/`） |
| W9 | 阶段 2 第 7 项、度量指标·计费 | 每日对账（`relay_billing.reconcile_at`，UTC+8 默认 03:30，Worker 线程只读快照）：充值 − 实扣 = 余额（以上次对账差额为基线，出现或变化判错）、结算扣费 ↔ 使用记录 ↔ 供应商用量事实三方行数与金额、近 24 小时 unmetered 金额占比（默认阈值 5%）、`settlement_pending` 超过 1 小时、负余额钱包；结果写 `operation_audit`（`billing.reconcile`），异常推送通知事件 `billing_reconcile`（面板可关）；`scripts/audit-money-micros.mjs` 复用同一检查，钱包差额改为判错。供应商事实的计入口径 SQL 与写入方放在一起（`vendorFactEligibleSql`），W10 改口径时同步 | `billing-reconcile.test.mjs`、`money-micros.test.mjs` |
| W11 | 阶段 2 第 9 项、第九节第 4、6 项 | `routing.json` 的 pool、sticky、quota、concurrency、failover 由 `src/shared/executor-schema/routing-pool.json` 描述（类型、范围、枚举），保存前复用 `validateAgainstSchema` 校验，未知键与非法值 400 `invalid_routing_config` 并列出字段；`pool.strategy` 枚举化（拼错不再静默变 balanced）；加载时超范围截断、其他非法值回默认、未知键删除，每个问题告警一次、不阻断启动；`worker_health_ttl_ms` 限定 1000–60000 ms，非数字不再使维护定时器变成约 1ms 紧循环。套餐额度标为“24 小时 / 7 天 / 30 天（滚动）”；Key 额度复核为首笔起算的固定时长窗口（不是逐笔滚动），标为“（首笔起算）”并改正说明，四种语言同步。`seat_grace_ms`、`heartbeat_stale_ms` 不生效写入 `docs/ROUTING_CONFIG.md` | `routing-schema.test.mjs` |
| W13 | 阶段 2 第 4 项、第九节第 6 项 | 新增 `replay-matrix.json` 重放判定契约（13 种失败 × Codex VM / Gateway Worker），Node 与 Go 表驱动契约测试共读，执行器差异必须写明原因（普通 403、已发出的 503 `server_error`、503 过载、404 模型不存在四处差异如实记录、不改行为）；删除本地造成不可达的 gpt-6-astra 历史裁剪重试、`replaySafe` 测试注入口与只计数不约束的 `retryBudget`；上游 HTTP hop、`seat_grace_ms` 保留 | `replay-matrix-contract.test.mjs`、Go `replay_matrix_test.go` |
| W14 | 阶段 2 第 5 项、P2 调度 | Claude 调度器名额账本：`reserveNow` 的名额按序号登记、释放注销，`maintain()` 比对账本与 `inflight` 并告警偏差，持有超 6 小时的名额经其幂等 `release` 回收；VM 队列队头因自身原因被拒不再挡住后续票；冷却到期唤醒加 0–20%（≤2 秒）抖动、释放唤醒加 0–20ms 抖动。复核后调整：仍唤醒全部等待者（只唤醒一个可能让其余等到超时）；读路径修复写入移到 `maintain()` 与 Codex 槽位、席位接入账本留作后续 | `stage2-scheduling.test.mjs` |
| W16 | 阶段 2 第 8 项、横切根因 5、度量指标·稳定性 | 余下三处同步 scrypt（改自己的密码、新手引导“管理员密码已改”、创建供应商登录账号）连同面板用户创建 / 改密统一改为异步 `hashPassword` / `verifyPassword`（删除重复的 `verifyPasswordAsync`，哈希格式不变；事务内建账号或改密的四处改为事务外先算哈希）；缓存前缀诊断复用 `prepareCachePrefix` 刚算过的消息哈希（每 attempt 少一遍整段历史的序列化与 sha256，本机 229KB 正文 1.82→1.25 ms）；出口启停与命令前缀回退路径的 `ss` 改异步 `execFile`；压测脚本收进 `scripts/bench/`（真实网关 + 进程内假上游，tiny / long 两种负载），新增 CI `perf`：5 轮中位数的 ELU 与 p99 对比同机器画像基线，超过 max(×1.15, +绝对余量) 失败、轮间波动大或无该画像基线只告警。测量到未改：`crs-persona` 每请求 3 次同步读 `routing.json`、请求体整体 `structuredClone`、成功后同步读凭据文件 | `panel-users`、`onboarding`、`cache-prefix`（等价性）、`bench-gate` |
| W10 | 第九节第 3 项（用户决定） | 供应商只按客户已扣费（`billing_status='settled'` 且实扣大于 0）的请求结算：未扣费请求不写供应商用量事实，Gateway 请求在对账结算后补写；结算兜底分支与每日对账漏记核对同口径，`SUPPLIER_CHARGED_ONLY_SINCE`（2026-11-07）之前的旧记录按原口径 | `vendor-admin`（口径用例）、`billing-reconcile` |
| W12 | 阶段 2 第 1 项 | 新增 `codex-request-plan.mjs`：分流前一次算出预压缩、白名单所用模型与分组 Fast 三态，VM 与 Gateway 共用；修复四处漂移——VM 路径执行分组 Fast（与 Worker `applyFastPolicy` 同规则）、VM 选号与发送前复核按客户端模型名查白名单（模型映射下不再误拒）、关闭 Fast 时准入按降档后档位核价、Gateway 也做预压缩；Gateway 的 Fast 仍由 Worker 按账号套餐执行 | `codex-request-plan.test.mjs` |
| W16 续 | 阶段 2 第 8 项、横切根因 5、度量指标·稳定性 | `crs-persona` 的 `routing.json` 读取经 `readFileCached` 校验后复用解析结果（每请求 6 次读盘解析 → `stat`，热改文件照旧生效）；`scrubUpstreamClientBody` 改浅拷贝（前置标准化调用前自行深拷贝）、`failover-runner` 去掉 `runOnce` 开头的整体克隆；成功后的冷却清理走 `readJsonCached`。修复调度器漏唤醒：`selectDirect` 在资格读取与登记等待之间错过释放通知，请求挂满 `sticky_wait_timeout_ms`（45 秒）后 529，同会话后续请求一起被拖住（`capacityEpoch`）；压测门槛改为网关 HTTP 错误即失败。GitHub 两种机型（EPYC 9V74 / 9V45）基线写入 `baseline.json`。本机 A/B：tiny ELU 0.076→0.057–0.064、long 0.084→0.066–0.074 | `stage2-scheduling`（漏唤醒）、`bench-gate`（分轮） |
| W15 | 阶段 2 第 2 项、P2 流式 | 新增 `sse-events.mjs`：每条 Responses SSE data 行只解析一次，解析结果传给终态、归属、档位、用量、生图与两种协议转换（转换器与事件命名增加可选的已解析事件参数）；VM 与 Gateway 写客户端时按 `res.write` 返回值等 `drain`（上限 10 秒）；WebSocket 协议响应按 `ws.bufferedAmount` 报告背压。复核不改：Claude 路径与 WS 桥内部再解析、WS 回放 8 MB 淘汰与中断终态帧留作后续 | `sse-pipeline.test.mjs` |

## 九、需要用户决定的事项

1. **BPS 是否继续运营**：生产上每个账号在约 300–400 次请求后被永久封。是只修 P0-3、P0-4 后继续观察，还是暂停 BPS 并评估替代方案？——已决定（2026-11-07）：BPS 停止运营，代码与数据一并删除（迁移 133）。
2. **未定价模型的默认行为**：直接拒绝（建议），还是按某个兜底价计费？
3. **供应商结算口径**：拒答、取消、unmetered 的请求，平台是否仍向供应商付费（P2，需写进合同）？——已决定（2026-11-07）：只按客户已扣费的请求结算（阶段 2 W10）。
4. **额度周期**：保留 24h/7d/30d 滚动窗口并在界面写明，还是改为自然日/周/月？——已决定（2026-11-07）：保留按时长计算的窗口并在界面写明（阶段 2 W11；复核发现 Key 窗口为首笔起算，文案按实际写明）。
5. **普通用户能否修改管理员为其创建的 Key 的额度和状态**（P1-S5）？
6. **死代码清理**：Claude 的 HTTP hop 分支、gpt-6-astra 历史回退、`seat_grace_ms`，是否按清理规则删除？——`seat_grace_ms` 已决定（2026-11-07）：上游原有字段，保留不删，在 `docs/ROUTING_CONFIG.md` 标注不生效；Claude HTTP hop 同为上游代码，保留；本地造成的 gpt-6-astra 不可达回退与 `retryBudget` 删除（阶段 2 W13）。

---

## 附：主会话亲自复核的证据（✔）

`handle-codex.mjs:1428-1431`（断开早于计费）、`codex-hop-shared.mjs:28` 与 `pricing.mjs:33-40`、`relay-billing.mjs:93-106,455-465`（未定价放行）、`rust-kernel-client.mjs:180-189` 与 `kernel-router.mjs:276-295`（401 强制换票、传输错误重发）、`worker/internal/oauth/refresher.go:155-205,240-250`（成功后取消即丢票、重试）、`distill-detect.mjs:249-268` 与 `jev-intercept.mjs:1015-1028`（二次复杂度）、`go-worker-client.mjs:1008-1016`（按块解码）、`codexgateway/classify.go:425-445,495-510`（非流式 403 可重放，投影为 503）、`failover-runner.mjs:915-1000,1325-1335`（名额在 try 外）、`panel-users.mjs:242-251` 与 `panel-routes.mjs:3837-3843`（同域互管、登录无限速）、`database.mjs:150-170,333-395`（迁移前无快照）、`backup-core.mjs:95-135`（备份范围）、全仓 `DELETE FROM` 统计（追加型表无保留）。

已核对、未发现问题的部分：金额整数化（`money.mjs`）；OpenAI 的 `cached_tokens` 从 input 中扣除；reasoning 不重复计费；Anthropic 缓存写入按 5m/1h 分价；冻结报价在结算与日志两边一致；面板角色门默认拒绝；Key 用 HMAC 存储、恒定时间比较；批量编辑逐项鉴权；备份与恢复只开放给 super_admin 且校验 sha256；SQL 没有拼接注入；Gateway 在 Redis 不可用时降级行为正确。
