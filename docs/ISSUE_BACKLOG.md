# Issue 待办清单（2026-10-28 复核）

本清单记录 2026-10-28 对全部 open issue 的复核结论中**暂不修复**的部分；其中 P2 已于 2026-11-06 处理，见下表。P0（#738 / #763 Key 记账）与 P1（#722–#725 Codex 可靠性、#768 槽终端 claude 崩溃）已另开 PR，不在此列。

复核方式：`omp -p --model antigravity/gemini-3.8-flash-tiered` 只读（read / grep / glob）逐个审阅 23 个 issue，基于 main `f149ef02`（1.4.016）；报在 1.4.x 上的和严重度高的再人工对照代码、`git blame` 与复现。下文「已复核」表示人工核对过代码；「Gemini」表示仅有模型结论，动手前需先核实。行号以 `f149ef02` 为准，之后的提交可能使其偏移。

结论：除 #741（1.4.009 已修）外，没有 1.4.x 新引入的问题；下列均为 1.3.x 遗留。

## P2：已处理（2026-11-06，td-m4）

下表 6 项在 main `a4f860c8` 上逐项复核后修复；「复核」列为动手前核实到的现状（行号以 `a4f860c8` 为准）。

| Issue | 问题 | 复核 | 修法 | 验证 |
|---|---|---|---|---|
| #737 | GPT 约 50 并发卡死，面板也打不开 | 属实：`pickCodexCandidates` 每次选槽（含每次等待唤醒、每次换号）都同步遍历并读写全部 `vms/*.json` 做 `syncCodexQuotaSchedule`；`markVmRestriction` 对每个受限槽每次都不经缓存重读文件。选槽本身按 extra 与当前策略实时判定停放，并不依赖这份回写（只服务面板状态与旧版「额度关调度」迁移） | 新增 `src/lib/pool/codex-quota-sweep.mjs`：选槽只登记一次回写，同一项目目录最多每 5 秒在请求之外执行一轮；额度头变化（`persistCodexUsage`）、策略保存、用量探测仍各自即时回写单槽。调度语义不变 | `codex-quota-sweep.test.mjs`；`handle-codex.test.mjs` 唤醒轮次的 `readdir` 由 2 次降为 1 次。本机复现 `scripts/bench-codex-admission.mjs`（进程内真实 `handleCodexProtocol` + 假流式内核，50 并发）：各 3 轮取均值：21 槽、每槽 2 并发时 ELU 0.39→0.24、事件循环延迟 p99 88→34 ms、CPU 3.2→2.1 ms/请求、吞吐 95→118 rps；60 槽、每槽 1 并发时 ELU 0.65→0.43、延迟 p99 316→111 ms、CPU 6.3→3.5 ms/请求、吞吐 77→127 rps，每请求槽文件 `readFileSync` 41.5→2 次。Claude 路径压测（`bench.mjs` 3000 请求 / 16 并发，流式与非流式）前后持平。剩余开销是 `listVms` 每轮按槽 `stat`，未改 |
| #689 | 流式偶发 `job stream overflow`，报成 502，控制面无日志 | 属实：内核帧 `kernel_error` / `api_error` 经 `mapUpstreamError` 报成 `upstream_error`；控制面没有任何日志；错误帧不带 `request_id`。256 帧 / 2 MiB 上限在闭源 kin-kernel 内，本次不改 | `errors.mjs` 识别该错误并归为新码 `kernel_stream_overflow`（502，`type: api_error`，`details.owner: gateway`），先于所有状态映射；`error-class.mjs` 归入平台侧「其它」，旧行按消息同样归类；流式错误帧补网关 `request_id`；请求结束时写一行结构化日志 `{"event":"kernel_stream_overflow","request_id","vm_id","account_id","forwarded_bytes","forwarded_frames",…}`；请求日志 `error_code` 记新码；`docs/API.md` 补错误码 | `stream-truncation.test.mjs` 4 项；e2e `errors.e2e`（CRS mock 新场景 `job_stream_overflow`）覆盖错误帧、request_id、stderr 日志与请求日志 |
| #684 | 正文为空的 403 让账号暂停 5 分钟；内核日志丢失 | 属实：`codexFailureHold` 对所有 403 一律 5 分钟；`ensureCodexKernel` 以 `stdio: 'ignore'` 启动内核 | 只有状态、没有可识别详情的 403（消息为空或只是 `upstream status 403:` / `HTTP 403` / `Forbidden`，且错误码为空或通用的 `upstream_auth` 等）改为 30 秒（`CODEX_UNEXPLAINED_403_HOLD_MS`，与 5xx 一致，也与原生内核自身约 30 秒的凭据冷却对齐；同一凭据随后可用），原因 `upstream_403_no_detail`；带封禁 / 权限详情的 403 仍 5 分钟。内核 stderr 写到 `<数据目录>/logs/codex-kernel/<vmId>.log`（可用 `KIN_CODEX_KERNEL_LOG_DIR` 改目录）：内核直接持有追加写的文件描述符，控制面重启不断；超过 4 MiB 复制为 `.log.1` 后原地截断（每 60 秒检查，启动时也检查），每槽最多两份；目录不可写时退回丢弃，不阻止内核启动 | `handle-codex.test.mjs`（无详情 / 有详情两组）；`codex-kernel-log.test.mjs`（路径、权限、轮转、真实子进程 stderr 落盘） |
| #681 | KVM 槽升级后 `kin-worker` SIGSEGV（exit 139） | 属实：payload 以 9p `cache=loose` 挂载并直接软链执行；宿主 `refreshSlotGuestBinDir` 升级时以 rename 换掉暂存目录里的二进制，loose 缓存从不重新校验，guest 可能执行新旧混杂的页 | `kin-guest-setup` 把 payload `usr/local/bin` 下的每个文件按 sha256 复制到 guest 本地 `/var/lib/kin-payload/bin/<name>-<sha>`，校验后以一次 rename 把 `/usr/local/bin/<name>` 指过去，只保留当前哈希；复制失败退回指向 9p。`kin-kernel.service` 增加 `ExecStartPre=-+/usr/local/sbin/kin-guest-setup payload`：每次内核（重）启动先 `drop_caches` 再按哈希刷新。`kin-guest-setup` 每次开机从 seed 同步已变化的 guest 脚本与 unit，此后脚本更新不必重建 overlay。`/opt/kin` 仍直接走 9p（未改） | `kin-guest-setup.test.mjs`（本地副本、升级换哈希且不改写运行中的旧副本、损坏副本重拷、缓存不可用退回、unit 文本）。KVM 实机复现与验证：测试服务器没有 `/dev/kvm`（中期 M3 核实），需要生产 KVM 主机，尚未授权；修复在 kin-kvm 镜像重建或手动安装 overlay 后才生效 |
| #524 | 换号后长会话 rewrite 丢掉调用方稳定缓存断点 | 属实：非 zero、非已组装模板的默认 rewrite 路径里 `officialMessageMarker` 先清掉全部调用方消息断点，再只打尾部与上一条 user 两处；#778 只修了 zero 档无标记时的补点 | 调用方消息断点与我们的尾部断点放得进 system 模板之后剩下的预算（总数 ≤ 4）时原位保留，我们的第二个断点只占仍空着的位置；保留的断点统一用本请求 TTL，保证 1h 不在 5m 之后；放不下时维持原行为。与 #778 一致：不移动调用方断点 | `cli-hop-caller-breakpoints.test.mjs`：issue 的 915 条复现（保留 910）、与尾部重合、无 system 时三处、超额回退、thinking 块不带断点 |
| #772 | GPT 槽界面上没有可调的优先级 | 属实：Codex 选槽只看 `weight`（越大越先），后端 `PATCH /api/panel/vms/:id` 早已接受 `weight`（1–100，`null` 回到 1），批量编辑也有，但单槽调度弹窗没有；列表页对 Codex 仍显示调度等级 | 单槽「调度配置」弹窗与调度块对 Codex 增加「选槽权重」（1/2/3/5/10/20/50/100，保留非档位现值）；列表页对 Codex 隐藏「优先级」；四语文案。复用现有 PATCH，无新路由 | e2e `panel-api.e2e`（保存、1–100 校验、`null` 复位）；`handle-codex.test.mjs`（权重高的槽先选）；web `scheduling-steps.test.ts`、`tsc --noEmit` |

## P3：非网关缺陷

| Issue | 结论 |
|---|---|
| #777 | `service_tier: fast` 返回 `default`。网关（`codex-convert.mjs:255`）与 codex 内核都把 fast 改写为 `priority` 并带 `x-codex-routing-hint`，返回档位来自上游，应为账号无 Fast 权益。已处理：计费按发出档位，上游回显存 `upstream_service_tier`，日志标记「Fast 未生效」。 |

## 建议关闭

| Issue | 理由 |
|---|---|
| #741 | 1.4.009（#757）已修：`scripts/fleet-services.mjs` 改经控制面执行（`4b2d98aa`） |
| #702 | 已修：`request-rectifier.test.mjs:190` 有 #702 回归测试 |
| #678 | 已修：pricing / request-log / cache-ttl 三处有 #678 测试 |
| #714 | Gemini 判为 2 GB 内存、无 swap 的宿主机内存颠簸，非代码问题；与报告人确认后关闭 |

## 功能需求（不计入修复）

| Issue | 现状 | 量级 |
|---|---|---|
| #672 账号列表显示订阅到期 | 列表接口已下发 `chatgpt_subscription_active_until`，仅详情页「账号」Tab 显示 | M |
| #464 按会话分流 | 1.4.x 席位键已优先 `sessionId`，但 `pool-scheduler.mjs` 新会话仍先命中设备亲和 VM | M |
| #648 Kubernetes / 多副本 | 单进程 SQLite + 进程内并发 / RPM / 席位状态，需整体改造 | L |
| #647 PostgreSQL | 数据访问已改为异步 `DbClient`（定制 R6），底层仍是单连接 `node:sqlite` 与 SQLite 方言 | L |
| #376 控制面主备 | 无租约 / 摘流，SIGTERM 不排空在途连接 | L |
